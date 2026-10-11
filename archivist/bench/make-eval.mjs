/**
 * Eval-set generator for archivist: mechanically derives a golden retrieval
 * set from any workspace (no LLM, no dependencies). Expectations are frozen
 * at generation time — regenerate after the corpus changes significantly.
 *
 * Categories: lookup / phrase / needle / multihop / aggregation / correction / mixed / unanswerable
 * Usage: node bench/make-eval.mjs <workspaceDir> [outJson]
 */
import { listPages, scanCorpus } from '../core/archivist.mjs'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const dir = process.argv[2]
const outFile = process.argv[3] || 'eval-set.json'
if (!dir) { console.error('usage: node bench/make-eval.mjs <workspaceDir> [outJson]'); process.exit(1) }

const pages = listPages(dir)
if (!pages.length) { console.error('workspace has no wiki pages: ' + dir); process.exit(1) }

const countIn = (q, scope = 'all') => {
  const m = /total occurrences: (\d+)/.exec(scanCorpus(dir, q, scope))
  return m ? Number(m[1]) : -1
}

const walkRaw = (base) => {
  const out = []
  const stack = ['']
  while (stack.length) {
    const rel = stack.pop()
    const cur = rel ? path.join(base, rel) : base
    let entries = []
    try { entries = readdirSync(cur, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      const child = rel ? rel + '/' + e.name : e.name
      if (e.isDirectory()) { stack.push(child); continue }
      if (!/\.(md|txt)$/i.test(e.name)) continue
      try { out.push({ rel: 'raw/' + child, text: readFileSync(path.join(cur, e.name), 'utf8') }) } catch { }
    }
  }
  return out
}

const cases = []
let n = 0
const add = (category, query, mode, expect, note, scope) => {
  cases.push({ id: 'g' + String(++n).padStart(3, '0'), category, query, mode, expect, ...(note ? { note } : {}), ...(scope ? { scope } : {}) })
}
const byTitle = new Map(pages.map((p) => [p.title.toLowerCase(), p]))
const linkRe = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g

// a. lookup: page title -> its own page, top-1 (active pages only; superseded/retracted are covered by correction cases)
for (const p of pages) {
  if (p.rel === 'overview.md' || p.title.length < 3) continue
  if (p.fm.status && p.fm.status !== 'active') continue
  add('lookup', p.title, 'top1', ['wiki/' + p.rel], 'title lookup')
}

// b. phrase: unique >=10-char CJK fragments from page bodies (up to 2 per page)
let phraseCount = 0
for (const p of pages) {
  let perPage = 0
  for (const run of p.body.match(/[\u4e00-\u9fff]{12,}/g) || []) {
    if (phraseCount >= 24 || perPage >= 2) break
    const frag = run.slice(0, 10)
    if (countIn(frag, 'all') === 1) {
      add('phrase', frag, 'top1', ['wiki/' + p.rel], 'unique body phrase')
      phraseCount++
      perPage++
    }
  }
}

// c. needle: unique long fragments inside raw files -> deep recall against raw/ scope
let needle = 0
for (const f of walkRaw(path.join(dir, 'raw')).sort((a, b) => a.rel.localeCompare(b.rel))) {
  if (needle >= 8) break
  for (const run of f.text.match(/[\u4e00-\u9fff]{14,}/g) || []) {
    const frag = run.slice(0, 12)
    if (countIn(frag, 'all') === 1) {
      add('needle', frag, 'top1', [f.rel], 'unique long fragment from raw', 'raw')
      needle++
      break
    }
  }
}

// d. multihop: two linked pages' titles -> both pages in top-3 (up to 2 per page)
let mh = 0
for (const p of pages) {
  let perPage = 0
  for (const m of p.body.matchAll(linkRe)) {
    if (mh >= 16 || perPage >= 2) break
    const target = byTitle.get(m[1].trim().toLowerCase())
    if (!target || target.rel === p.rel) continue
    add('multihop', p.title + ' ' + target.title, 'top3all', ['wiki/' + p.rel, 'wiki/' + target.rel], 'linked-pair coverage')
    mh++
    perPage++
  }
}

// e. aggregation: exact scan counts for distinctive tokens (regression-frozen)
const aggTokens = []
for (const p of pages) {
  const t = p.title.replace(/[\s\-–—._]+/g, '').slice(0, 4)
  if (t.length >= 3 && !aggTokens.includes(t)) aggTokens.push(t)
}
for (const p of pages) {
  for (const m of p.body.matchAll(/[A-Za-z][A-Za-z0-9_.-]{4,}/g)) {
    if (!aggTokens.includes(m[0])) aggTokens.push(m[0])
    if (aggTokens.length > 40) break
  }
}
let agg = 0
for (const t of aggTokens) {
  if (agg >= 10) break
  const c = countIn(t, 'all')
  if (c >= 2 && c <= 60) { add('aggregation', t, 'count', c, 'exact scan count (frozen)'); agg++ }
}

// f. correction: retracted must disappear; superseded must be annotated
const retracted = pages.filter((p) => p.fm.status === 'retracted')
const superseded = pages.filter((p) => p.fm.status === 'superseded')
for (const p of retracted.slice(0, 3)) add('correction', p.title, 'nomatch', 0, 'retracted page must not be returned')
for (const p of superseded.slice(0, 3)) add('correction', p.title, 'annotated', ['已被'], 'superseded must be annotated')

// g. mixed: page title + an ASCII token from the same page -> that page, top-3
let mixed = 0
for (const p of pages) {
  if (mixed >= 12) break
  const ascii = p.body.match(/[A-Za-z][A-Za-z0-9_.-]{3,}/g) || []
  if (!ascii.length) continue
  const token = ascii.find((t) => countIn(t, 'all') <= 6) || ascii[0]
  add('mixed', p.title + ' ' + token, 'top3', ['wiki/' + p.rel], 'mixed CN/EN query')
  mixed++
}

// h. unanswerable: gibberish queries with zero corpus occurrences -> no match
for (const d of ['zxqv-not-included-7788', '靐靐靐靐', 'qwerty-not-here-9911']) {
  if (countIn(d, 'all') === 0) add('unanswerable', d, 'nomatch', 0, 'must return no match')
}

const out = {
  generatedFrom: dir,
  generatedAt: new Date().toISOString(),
  note: 'Expectations are frozen at generation time; regenerate after significant corpus changes.',
  cases,
}
writeFileSync(outFile, JSON.stringify(out, null, 2))
const cats = {}
for (const c of cases) cats[c.category] = (cats[c.category] || 0) + 1
console.log(JSON.stringify({ file: outFile, total: cases.length, byCategory: cats }))
