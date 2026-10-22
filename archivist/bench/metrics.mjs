/**
 * Retrieval metrics for the hand-written archivist gold set (P1 §8.3 / P2 §4).
 *
 * Hit口径 — four rules, per Lead's ruling (2026-10-22):
 *   delivered (A, HEADLINE) — a gold span was DELIVERED to the model: some hit whose
 *                path is the gold page has the quote inside hit.text OR hit.parent.text.
 *                This mirrors "recall of gold spans in the final evidence pack"; a page
 *                can be delivered through more than one block.
 *   bestChunk (D, SECONDARY) — only the FIRST returned block of that page may match
 *                (per-page best-chunk precision; stricter).
 *   strictText (B) — quote inside hit.text only (no parent rescue).
 *   page (C) — the page appears anywhere in top-K (page recall upper bound).
 * Extra honesty column: allAnchors — multihop cases, EVERY gold anchor delivered
 * (gold cases marked requireAll). Headline A does not require this (Lead's A doesn't).
 *
 * MRR/nDCG@10 are computed on the delivered口径. Input is a gold JSON plus a hits JSON
 * (contract §4 Hit shape). Nothing here re-implements retrieval.
 *
 * Usage:
 *   node bench/metrics.mjs <gold.json> <hits.json> [--md report.md] [--json out.json]
 *                          [--limit 20] [--selftest] [--no-gate]
 * Env: GOLD_MIN_RECALL (default 0.90) gates the headline delivered Recall@20.
 */
import { readFileSync, writeFileSync } from 'node:fs'

const norm = (s) => String(s ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()
const normPath = (p) => norm(String(p ?? '').replace(/\\/g, '/')).replace(/^\.\//, '')
const pct = (x) => Math.round(x * 1000) / 10
const r3 = (x) => Math.round(x * 1000) / 1000
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)

/** field-level quote match for one hit; mode selects which delivered text counts. */
export function hitHasQuote(hit, anchor, mode = 'delivered') {
  if (!hit) return false
  if (normPath(hit.path) !== normPath(anchor.path)) return false
  if (!anchor.quote) return true
  const q = norm(anchor.quote)
  if (typeof hit.text === 'string' && norm(hit.text).includes(q)) return true
  if (mode === 'delivered' && typeof hit.parent?.text === 'string' && norm(hit.parent.text).includes(q)) return true
  return false
}

/** Backwards-compatible helper (old callers used mode names page/strict/withParent). */
export function hitMatchesAnchor(hit, anchor, mode = 'delivered') {
  const m = mode === 'page' ? 'page' : mode === 'strict' || mode === 'text' ? 'text' : 'delivered'
  if (m === 'page') return !!hit && normPath(hit.path) === normPath(anchor.path)
  return hitHasQuote(hit, anchor, m)
}

/** Map path -> first hit of that path in rank order (for the best-chunk rule). */
function firstBlockPerPath(top) {
  const m = new Map()
  for (const h of top) {
    const p = normPath(h.path)
    if (!m.has(p)) m.set(p, h)
  }
  return m
}

export function scoreCase(goldCase, hits, opts = {}) {
  const limit = opts.limit ?? 20
  const anchors = Array.isArray(goldCase.goldAnchors) ? goldCase.goldAnchors : []
  const top = (hits || []).slice(0, limit)
  const top1 = top[0] || null
  const first = firstBlockPerPath(top)

  const perAnchor = anchors.map((a) => ({
    anchor: a,
    delivered: top.some((h) => hitHasQuote(h, a, 'delivered')),
    strictText: top.some((h) => hitHasQuote(h, a, 'text')),
    bestChunk: first.has(normPath(a.path)) && hitHasQuote(first.get(normPath(a.path)), a, 'delivered'),
    page: top.some((h) => normPath(h.path) === normPath(a.path)),
    rank: (() => { const i = top.findIndex((h) => hitHasQuote(h, a, 'delivered')); return i < 0 ? 0 : i + 1 })(),
  }))
  const tag = (k) => perAnchor.some((x) => x[k])
  const allTag = (k) => anchors.length > 0 && perAnchor.every((x) => x[k])
  const firstRank = perAnchor.reduce((m, x) => (x.rank > 0 && (!m || x.rank < m) ? x.rank : m), 0)

  const row = {
    id: goldCase.id, category: goldCase.category, query: goldCase.query,
    answerable: goldCase.answerable !== false, goldAnchors: anchors,
    hits: (hits || []).length,
    top1Path: top1 ? top1.path : null,
    recallDelivered: tag('delivered') ? 1 : 0,           // A (headline)
    recallBestChunk: tag('bestChunk') ? 1 : 0,           // D (secondary)
    recallStrictText: tag('strictText') ? 1 : 0,         // B
    recallPage: tag('page') ? 1 : 0,                     // C
    recallAllAnchors: allTag('delivered') ? 1 : 0,       // multihop 严格补充
    firstGoldRank: firstRank,
    mrr: firstRank > 0 ? 1 / firstRank : 0,
    ndcgAt10: ndcg(top, anchors, opts),
    top1Page: top1 && anchors.some((a) => normPath(a.path) === normPath(top1.path)) ? 1 : 0,
    missedAnchors: anchors.filter((a) => !top.some((h) => hitHasQuote(h, a, 'delivered'))),
  }
  if (!row.answerable) {
    row.recallDelivered = row.recallBestChunk = row.recallStrictText = row.recallPage = row.recallAllAnchors = 0
    row.mrr = 0; row.ndcgAt10 = 0; row.top1Page = 0
  }
  return row
}

/** Binary-relevance nDCG@10 on delivered口径; IDCG fills one slot per gold anchor. */
export function ndcg(hits, anchors, opts = {}) {
  const k = opts.k ?? 10
  if (!anchors.length) return 0
  const rel = (hit) => (anchors.some((a) => hitHasQuote(hit, a, 'delivered')) ? 1 : 0)
  const dcg = hits.slice(0, k).reduce((sum, h, i) => sum + (rel(h) ? 1 / Math.log2(i + 2) : 0), 0)
  const ideal = Math.min(anchors.length, k)
  let idcg = 0
  for (let i = 0; i < ideal; i++) idcg += 1 / Math.log2(i + 2)
  return idcg ? dcg / idcg : 0
}

function aggregate(rows) {
  const ans = rows.filter((r) => r.answerable)
  return {
    cases: rows.length, answerable: ans.length, unanswerable: rows.length - ans.length,
    recallDelivered: pct(mean(ans.map((r) => r.recallDelivered))),        // A headline
    recallBestChunk: pct(mean(ans.map((r) => r.recallBestChunk))),        // D secondary
    recallStrictText: pct(mean(ans.map((r) => r.recallStrictText))),      // B
    recallPage: pct(mean(ans.map((r) => r.recallPage))),                  // C
    recallAllAnchors: pct(mean(ans.map((r) => r.recallAllAnchors))),      // multihop strict
    mrr: r3(mean(ans.map((r) => r.mrr))),
    ndcgAt10: r3(mean(ans.map((r) => r.ndcgAt10))),
    top1Page: pct(mean(ans.map((r) => r.top1Page))),
    missed: ans.filter((r) => !r.recallDelivered).length,
  }
}

export function evaluate(gold, hitsById, opts = {}) {
  const rows = gold.cases.map((c) => scoreCase(c, hitsById[c.id] || [], opts))
  const byCategory = {}
  for (const r of rows) (byCategory[r.category] ||= []).push(r)
  const cats = {}
  for (const [k, v] of Object.entries(byCategory)) cats[k] = aggregate(v)
  return {
    generatedAt: new Date().toISOString(),
    limit: opts.limit ?? 20,
    overall: aggregate(rows),
    byCategory: cats,
    cases: rows.map((r) => ({
      id: r.id, category: r.category, query: r.query, answerable: r.answerable,
      recallDelivered: r.recallDelivered, recallBestChunk: r.recallBestChunk,
      recallStrictText: r.recallStrictText, recallPage: r.recallPage, recallAllAnchors: r.recallAllAnchors,
      firstGoldRank: r.firstGoldRank, mrr: r3(r.mrr), ndcgAt10: r3(r.ndcgAt10), top1Page: r.top1Page,
      top1Path: r.top1Path, hits: r.hits, missedAnchors: r.missedAnchors,
    })),
  }
}

export function renderMarkdown(result, meta = {}) {
  const o = result.overall
  let md = `# 金标检索评测报告（A=交付口径 headline，D=best-chunk 次要）\n\n`
  md += `- 金标集: \`${meta.goldFile || 'n/a'}\`（${o.cases} 条：可回答 ${o.answerable} / 不可回答 ${o.unanswerable}）\n`
  md += `- 命中源: \`${meta.hitsFile || 'n/a'}\`${meta.engine ? `（engine: ${meta.engine}）` : ''}\n`
  md += `- 口径：**A 交付口径** = 同页任一交付块（text 或 parent.text）含 gold quote；**D best-chunk** = 仅该页排名第一块；B=仅 hit.text；C=仅页面出现；allAnchors=多跳两页都交付。\n`
  md += `- 不可回答的弃权见 \`bench/gold-pack.mjs\`（pack.diagnostics.sufficient）。\n\n`
  md += `| 指标 | Recall@${result.limit} |\n|---|---|\n`
  md += `| **A 交付口径（headline / 门限）** | **${o.recallDelivered}%** |\n`
  md += `| **D best-chunk（次要）** | **${o.recallBestChunk}%** |\n`
  md += `| B 仅 hit.text | ${o.recallStrictText}% |\n| C 页面出现 | ${o.recallPage}% |\n| allAnchors（多跳两页） | ${o.recallAllAnchors}% |\n`
  md += `| MRR（A） | ${o.mrr} |\n| nDCG@10（A） | ${o.ndcgAt10} |\n| Top-1 页面准确率 | ${o.top1Page}% |\n| 未交付条数（A） | ${o.missed} |\n`
  md += `\n## 按类别\n\n| 类别 | 条数 | A 交付 | D best-chunk | B text | C page | MRR | nDCG@10 |\n|---|---|---|---|---|---|---|---|\n`
  for (const [k, v] of Object.entries(result.byCategory)) {
    md += `| ${k} | ${v.cases} | ${v.recallDelivered}% | ${v.recallBestChunk}% | ${v.recallStrictText}% | ${v.recallPage}% | ${v.mrr} | ${v.ndcgAt10} |\n`
  }
  md += `\n## 明细\n\n| id | 类别 | 查询 | A | D | 首个 A rank | 备注 |\n|---|---|---|---|---|---|---|\n`
  const esc = (s) => String(s).replace(/\|/g, '/').replace(/\s+/g, ' ')
  for (const c of result.cases) {
    const note = c.answerable
      ? (c.recallDelivered ? `top1=${esc(c.top1Path || '(none)')}` : `missed: ${esc((c.missedAnchors || []).map((a) => a.path).join(', '))}`)
      : 'anchorless（弃权见 gold-pack.mjs）'
    md += `| ${c.id} | ${c.category} | ${esc(c.query).slice(0, 36)} | ${c.answerable ? (c.recallDelivered ? '✅' : '❌') : '—'} | ${c.answerable ? (c.recallBestChunk ? '✅' : '❌') : '—'} | ${c.firstGoldRank} | ${note} |\n`
  }
  return md
}

export function loadHits(file, gold) {
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  const byId = {}
  const put = (id, hits) => { if (id != null) byId[String(id)] = Array.isArray(hits) ? hits : (hits?.hits || []) }
  if (Array.isArray(raw)) raw.forEach((r) => put(r.id, r.hits))
  else if (Array.isArray(raw.cases)) raw.cases.forEach((r) => put(r.id, r.hits))
  else if (Array.isArray(raw.results)) raw.results.forEach((r) => put(r.id, r.hits))
  else for (const [k, v] of Object.entries(raw)) put(k, Array.isArray(v) ? v : v?.hits)
  const missing = (gold?.cases || []).map((c) => c.id).filter((id) => !(id in byId))
  return { byId, missing }
}

// --- runnable check: A vs D differ exactly when a page's first block is wrong ---
function selftest() {
  let bad = 0
  const assert = (cond, msg) => { if (!cond) { console.error('SELFTEST FAIL: ' + msg); bad++ } }
  const hit = (p, text, parentText) => ({ path: p, text, snippet: text, parent: parentText ? { text: parentText } : null, score: 0.9 })
  const gold = {
    cases: [
      { id: 'c1', category: 'x', query: 'q1', goldAnchors: [{ path: 'wiki/a.md', quote: '答案在这里' }] },
      { id: 'c2', category: 'x', query: 'q2', goldAnchors: [{ path: 'wiki/b.md', quote: '另一段' }] },
      { id: 'c4', category: 'x', query: 'q4', goldAnchors: [{ path: 'wiki/c.md', quote: '父段里的证据' }] },
      { id: 'c5', category: 'x', query: 'q5', requireAll: true, goldAnchors: [{ path: 'wiki/d.md', quote: 'D1' }, { path: 'wiki/e.md', quote: 'E1' }] },
      { id: 'c6', category: 'x', query: 'q6', goldAnchors: [{ path: 'wiki/f.md', quote: '右块证据' }] },
      { id: 'c3', category: 'u', query: 'q3', goldAnchors: [], answerable: false },
    ],
  }
  const hits = {
    c1: [hit('wiki/x.md', '噪音'), hit('wiki/a.md', '… 答案在这里 …')],
    c2: [hit('wiki/b.md', '路径对但引用不对')],
    c4: [hit('wiki/c.md', 'leaf 没写', '父段落里确实有 父段里的证据 这句话')],
    c5: [hit('wiki/d.md', 'D1'), hit('wiki/x.md', 'noise')],
    c6: [hit('wiki/f.md', '左块无关'), hit('wiki/f.md', '右块证据在这里')],
    c3: [hit('wiki/x.md', '几乎不相关')],
  }
  const r = evaluate(gold, hits, { limit: 20 })
  const [c1, c2, c4, c5, c6] = r.cases
  assert(c1.recallDelivered === 1 && c1.recallBestChunk === 1, 'c1 A and D hit')
  assert(c1.mrr === 0.5, 'c1 mrr 0.5')
  assert(c1.top1Page === 0, 'c1 top-1 wrong page')
  assert(Math.abs(c1.ndcgAt10 - 0.6309) < 0.001, 'c1 ndcg ~0.631')
  assert(c2.recallPage === 1 && c2.recallDelivered === 0 && c2.recallBestChunk === 0, 'c2 page only')
  assert(c4.recallDelivered === 1 && c4.recallStrictText === 0, 'c4 delivered via parent, not strict text')
  assert(c5.recallDelivered === 1 && c5.recallAllAnchors === 0, 'c5 A=1 (one span) but allAnchors=0')
  assert(c6.recallDelivered === 1 && c6.recallBestChunk === 0, 'c6 A hits second block, D must miss — the A/D distinction')
  // A: c1,c4,c5,c6 = 4/5 = 80%; D: c1,c4,c5 = 3/5 = 60%; B: c1,c5(D1),c6 = 60%; C: 5/5 = 100%
  assert(r.overall.recallDelivered === 80, `A delivered should be 80, got ${r.overall.recallDelivered}`)
  assert(r.overall.recallBestChunk === 60, `D best-chunk should be 60, got ${r.overall.recallBestChunk}`)
  assert(r.overall.recallStrictText === 60, `B strict text should be 60, got ${r.overall.recallStrictText}`)
  assert(r.overall.recallPage === 100, `C page should be 100, got ${r.overall.recallPage}`)
  assert(r.overall.recallAllAnchors === 60, `allAnchors should be 60, got ${r.overall.recallAllAnchors}`)
  console.log(bad ? `selftest: FAILED (${bad})` : 'selftest: OK (A delivered headline / D best-chunk / B text / C page / allAnchors)')
  if (bad) process.exitCode = 1
}

if (process.argv[1]?.endsWith('metrics.mjs')) {
  const args = process.argv.slice(2)
  const flag = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt }
  if (args.includes('--selftest')) { selftest(); process.exit() }
  const pos = args.filter((a, i) => !a.startsWith('--') && !(args[i - 1] || '').startsWith('--'))
  const [goldFile, hitsFile] = pos
  if (!goldFile || !hitsFile) {
    console.error('usage: node bench/metrics.mjs <gold.json> <hits.json> [--md report.md] [--json out.json] [--limit 20] [--no-gate] [--selftest]')
    process.exit(2)
  }
  const opts = { limit: Number(flag('--limit', 20)) }
  const gold = JSON.parse(readFileSync(goldFile, 'utf8'))
  const { byId, missing } = loadHits(hitsFile, gold)
  if (missing.length) console.error(`warning: ${missing.length} gold case(s) have no hits: ${missing.slice(0, 8).join(', ')}`)
  const result = evaluate(gold, byId, opts)
  const mdFile = flag('--md', null)
  const jsonFile = flag('--json', null)
  if (mdFile) writeFileSync(mdFile, renderMarkdown(result, { goldFile, hitsFile, engine: flag('--engine', '') }))
  if (jsonFile) writeFileSync(jsonFile, JSON.stringify(result, null, 2))
  const o = result.overall
  console.log(JSON.stringify({
    gold: goldFile, hits: hitsFile, cases: o.cases,
    A_delivered: o.recallDelivered, D_bestChunk: o.recallBestChunk, B_text: o.recallStrictText, C_page: o.recallPage,
    allAnchors: o.recallAllAnchors, mrr: o.mrr, ndcgAt10: o.ndcgAt10, top1Page: o.top1Page,
    byCategory: Object.fromEntries(Object.entries(result.byCategory).map(([k, v]) => [k, `A ${v.recallDelivered}% D ${v.recallBestChunk}% (n=${v.cases})`])),
  }))
  const gate = Number(process.env.GOLD_MIN_RECALL ?? 0.9)
  if (!args.includes('--no-gate') && !missing.length && o.recallDelivered < gate * 100) {
    console.error(`gate FAIL: A delivered Recall@${opts.limit} ${o.recallDelivered}% < ${gate * 100}%`)
    process.exitCode = 1
  }
}
