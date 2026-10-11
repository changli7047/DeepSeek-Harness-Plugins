/**
 * llm-wiki selftest — runs the full deterministic workflow against a throwaway
 * workspace and asserts expectations. Host-independent: `node smoke.mjs`.
 */
import {
  initWorkspace, attachWorkspace, listSources, writePage, readPages, searchWiki,
  lintWiki, appendLog, readLog, estimateTokens, statusWorkspace, backupWorkspace,
  parsePage, rebuildIndex, TOOLS,
} from './core/llm-wiki.mjs'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ws = path.join(os.tmpdir(), 'llm-wiki-smoke-' + Date.now())
process.env.LLM_WIKI_POINTER = path.join(os.tmpdir(), 'llm-wiki-smoke-pointer.json')
let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name + (extra ? ' :: ' + extra : '')) }
}

try {
  // 1. init
  const initOut = initWorkspace(ws)
  ok('init returns initialized', initOut.includes('initialized') && initOut.includes('schema'))
  for (const f of ['AGENTS.md', '.gitignore', 'raw/.gitkeep', 'wiki/index.md', 'wiki/log.md', 'wiki/overview.md']) {
    ok('init creates ' + f, existsSync(path.join(ws, f)))
  }
  ok('init is idempotent (re-attach)', initWorkspace(ws).includes('already initialized'))
  ok('attach works', attachWorkspace(ws).includes('attached'))

  // 2. raw sources
  writeFileSync(path.join(ws, 'raw', 'note1.md'), '# Note1\nTransformer 是一种架构。\n')
  writeFileSync(path.join(ws, 'raw', 'note2.md'), '# Note2\n关于检索的笔记。\n')
  let sources = listSources(ws)
  ok('sources lists 2 files', sources.length === 2, 'got ' + sources.length)
  ok('sources all new', sources.every((s) => s.status === 'new'))

  // 3. write pages
  const w1 = writePage(ws, {
    path: 'sources/note1.md', title: '笔记一', body: '# 笔记一\n\n概述 [[Transformer 概念]]。\n',
    sourceFile: 'raw/note1.md', summary: '第一份笔记', tags: ['test'], log: 'ingest | 笔记一',
  })
  ok('write source page', w1.includes('created') && w1.includes('index rebuilt') && w1.includes('logged'))
  const w2 = writePage(ws, {
    title: 'Transformer 概念', dir: 'concepts', tags: ['ml'],
    body: '# Transformer 概念\n\n来自 [[笔记一]]。相关：[[不存在的页面]]\n', summary: '注意力架构概念',
  })
  ok('write concept page by title', w2.includes('created') && w2.includes('concepts/Transformer-概念.md'), w2)
  const idx = readFileSync(path.join(ws, 'wiki', 'index.md'), 'utf8')
  ok('index lists both pages', idx.includes('笔记一') && idx.includes('Transformer 概念') && idx.includes('第一份笔记'))
  const w2u = writePage(ws, { path: 'concepts/Transformer-概念.md', title: 'Transformer 概念', tags: ['ml'], body: '# Transformer 概念\n\n来自 [[笔记一]]。\n', summary: '注意力架构概念' })
  ok('write updates existing page', w2u.includes('updated'), w2u)

  // 4. sources status after ingest
  sources = listSources(ws)
  ok('note1 ingested', sources.find((s) => s.rel === 'raw/note1.md')?.status === 'ingested')
  ok('note2 still new', sources.find((s) => s.rel === 'raw/note2.md')?.status === 'new')
  writeFileSync(path.join(ws, 'raw', 'note1.md'), '# Note1\nTransformer 是一种架构。修订版。\n')
  sources = listSources(ws)
  ok('edited source shows changed', sources.find((s) => s.rel === 'raw/note1.md')?.status === 'changed')

  // 5. read
  const read = readPages(ws, ['sources/note1.md', 'concepts/Transformer-概念.md'])
  ok('read pages batch', read.includes('wiki/sources/note1.md') && read.includes('wiki/concepts/Transformer-概念.md'))
  let threw = false
  try { readPages(ws, ['nope/missing.md']) } catch { threw = true }
  ok('read missing page throws', threw)

  // 6. search
  const s1 = searchWiki(ws, 'Transformer', 10)
  ok('search latin hits concept', s1.includes('concepts/Transformer-概念.md'), s1.split('\n')[0])
  const s2 = searchWiki(ws, '笔记', 10)
  ok('search cjk hits source page', s2.includes('sources/note1.md'), s2.split('\n')[0])
  const s3 = searchWiki(ws, 'zzz_nothing_zzz', 10)
  ok('search empty result message', s3.includes('no match'))
  const sr = searchWiki(ws, 'Note1', 10, 'raw')
  ok('search scope raw hits source file', sr.includes('raw/note1.md'), sr.split('\n')[0])
  const sa = searchWiki(ws, 'Transformer', 20, 'all')
  ok('search scope all merges wiki+raw', sa.includes('concepts/Transformer-概念.md') && sa.includes('raw/note1.md'), sa.split('\n')[0])

  // 7. lint (links resolve by page title; add one deliberate orphan page)
  writePage(ws, { path: 'concepts/孤立页.md', title: '孤立页', body: '# 孤立页\n\n没有任何入链的页面。\n', summary: '孤儿测试页' })
  const l1 = lintWiki(ws)
  ok('lint links resolve by title (no broken-link)', !l1.includes('broken-link'), l1.split('\n').slice(0, 4).join(' / '))
  ok('lint flags orphan page', l1.includes('orphan') && l1.includes('孤立页'), l1)
  writePage(ws, { path: 'concepts/Transformer-概念.md', body: '# Transformer 概念\n\n来自 [[笔记一]]。[[幽灵页]] [[幽灵页]] [[幽灵页]]\n' })
  const l2 = lintWiki(ws)
  ok('lint detects broken link', l2.includes('broken-link'), l2.split('\n').slice(0, 4).join(' / '))
  ok('lint reports missing page (>=3 mentions)', l2.includes('missing-pages'), l2)
  const l3 = lintWiki(ws, { fix: true })
  ok('lint fix rebuilds index', l3.includes('index rebuilt'))

  // 8. safety
  for (const [desc, fn] of [
    ['write outside wiki blocked', () => writePage(ws, { path: '../evil.md', body: 'x' })],
    ['write index.md blocked', () => writePage(ws, { path: 'index.md', body: 'x' })],
    ['write log.md blocked', () => writePage(ws, { path: 'log.md', body: 'x' })],
  ]) {
    let t = false; try { fn() } catch { t = true }
    ok(desc, t)
  }

  // 9. log
  appendLog(ws, 'query | 测试问题')
  const log = readLog(ws, 3)
  ok('log append + read', log.includes('ingest | 笔记一') && log.includes('query | 测试问题'), log.split('\n')[0])

  // 10. status
  const st = statusWorkspace(ws)
  ok('status has pages line', st.includes('pages: '), st.split('\n')[0])
  ok('status has token estimate', /~\d+ tokens/.test(st))
  ok('status has sources line', st.includes('sources: 2'))

  // 10b. tokenizer: symbol-bearing latin phrases stay searchable
  writeFileSync(path.join(ws, 'raw', 'note3.md'), '# Note3\nB+ Tree 原理；O(log n) 复杂度。\n')
  const st1 = searchWiki(ws, 'B+ Tree', 10, 'raw')
  ok('search keeps symbol phrase (B+ Tree)', st1.includes('raw/note3.md'), st1.split('\n')[0])
  const st2 = searchWiki(ws, 'O(log n)', 10, 'raw')
  ok('search keeps symbol phrase (O(log n))', st2.includes('raw/note3.md'), st2.split('\n')[0])

  // 10c. raw cache: transparency + invalidation on change
  const c1 = searchWiki(ws, 'cacheprobe', 10, 'raw')
  ok('cache: token absent before write', c1.includes('no match'))
  writeFileSync(path.join(ws, 'raw', 'note4.md'), '# Note4\ncacheprobe content.\n')
  const c2 = searchWiki(ws, 'cacheprobe', 10, 'raw')
  ok('cache: new file found after write', c2.includes('raw/note4.md'), c2.split('\n')[0])
  await new Promise((r) => setTimeout(r, 60))
  writeFileSync(path.join(ws, 'raw', 'note4.md'), '# Note4\ncompletely different content now, longer than before.\n')
  const c3 = searchWiki(ws, 'cacheprobe', 10, 'raw')
  ok('cache: invalidated after file change', c3.includes('no match'), c3.split('\n')[0])

  // 11. backup
  const b1 = backupWorkspace(ws)
  const backupRoot = path.join(ws, '.backups')
  ok('backup creates snapshot', b1.includes('backup:') && readdirSync(backupRoot).length === 1, b1)
  backupWorkspace(ws); backupWorkspace(ws)
  ok('backup keeps multiple snapshots', readdirSync(backupRoot).length === 3)
  const b4 = backupWorkspace(ws, undefined, 1)
  ok('backup rotation keep=1', readdirSync(backupRoot).filter((e) => e.startsWith('llm-wiki-')).length === 1, b4)
  ok('backup excludes itself', !readdirSync(path.join(backupRoot, readdirSync(backupRoot).filter(e => e.startsWith('llm-wiki-'))[0])).includes('.backups'))

  // 12. parse + estimate + tools table
  const pr = parsePage('---\ntitle: A\ntags: [x, y]\n---\nbody')
  ok('frontmatter parse title', pr.fm.title === 'A' && Array.isArray(pr.fm.tags) && pr.fm.tags.length === 2, JSON.stringify(pr.fm))
  ok('token estimate positive', estimateTokens('中文abc') >= 2)
  ok('tools table complete', TOOLS.length === 12 && TOOLS.every((t) => t.name.startsWith('wiki_')), 'count=' + TOOLS.length)

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exitCode = fail ? 1 : 0
} finally {
  try { rmSync(ws, { recursive: true, force: true }) } catch { }
}
