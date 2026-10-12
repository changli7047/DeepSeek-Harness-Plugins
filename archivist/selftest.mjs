/**
 * archivist selftest — runs the full deterministic workflow against a throwaway
 * workspace and asserts expectations. Host-independent: `node smoke.mjs`.
 */
import {
  initWorkspace, attachWorkspace, listSources, writePage, readPages, searchWiki,
  lintWiki, appendLog, readLog, estimateTokens, statusWorkspace, backupWorkspace,
  commitWorkspace, parsePage, rebuildIndex, scanCorpus, runTool, TOOLS,
} from './core/archivist.mjs'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ws = path.join(os.tmpdir(), 'archivist-smoke-' + Date.now())
const cleanupPaths = [ws]
process.env.ARCHIVIST_POINTER = path.join(os.tmpdir(), 'archivist-smoke-pointer.json')
let pass = 0, fail = 0, skipped = 0
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

  // 9b. v2 discipline: trust tiers, supersede chain, retraction
  const wT = writePage(ws, { path: 'sources/trust-probe.md', title: 'Trust Probe', body: '# Trust Probe\n\n原文锚定测试。\n', sourceFile: 'raw/note1.md' })
  ok('trust: sourceFile page -> medium', readFileSync(path.join(ws, 'wiki', 'sources', 'trust-probe.md'), 'utf8').includes('trust: medium'), wT)
  const wL = writePage(ws, { path: 'syntheses/trust-low.md', title: 'Trust Low', body: '# Trust Low\n\n无出处派生。\n' })
  ok('trust: no sourceFile -> low', readFileSync(path.join(ws, 'wiki', 'syntheses', 'trust-low.md'), 'utf8').includes('trust: low'), wL)
  const wS = writePage(ws, { path: 'concepts/replacement.md', title: 'Replacement', body: '# Replacement\n\n替代测试。\n', supersedes: 'concepts/孤立页.md' })
  ok('supersede: new page records supersedes', readFileSync(path.join(ws, 'wiki', 'concepts', 'replacement.md'), 'utf8').includes('supersedes: concepts/孤立页.md'), wS)
  const oldTxt = readFileSync(path.join(ws, 'wiki', 'concepts', '孤立页.md'), 'utf8')
  ok('supersede: old page flipped to superseded', oldTxt.includes('status: superseded') && oldTxt.includes('superseded_by: concepts/replacement.md'))
  const supSearch = searchWiki(ws, '孤立页', 10, 'wiki')
  ok('supersede: search annotates replacement', supSearch.includes('已被'), supSearch.split('\n')[0])
  const wR = writePage(ws, { path: 'syntheses/trust-low.md', retract: true, retractReason: '测试撤回' })
  ok('retract: page marked retracted', readFileSync(path.join(ws, 'wiki', 'syntheses', 'trust-low.md'), 'utf8').includes('status: retracted'), wR)
  const retSearch = searchWiki(ws, 'Trust Low', 10, 'wiki')
  ok('retract: excluded from search', !retSearch.includes('trust-low'), retSearch.split('\n')[0])
  const lS = lintWiki(ws)
  ok('lint: supersede chain clean', !lS.includes('supersede-'), lS.split('\n')[0])
  const stT = statusWorkspace(ws)
  ok('status: trust/supersede counts', stT.includes('trust: ') && stT.includes('superseded:1'), (stT.split('\n').find((l) => l.startsWith('trust:')) || 'missing'))

  // 9c. exhaustive scan tool (exact counts, never top-K)
  writeFileSync(path.join(ws, 'raw', 'scan-probe.md'), '# Scan Probe\n\nzzscan 出现在这里。zzscan 第二次。zzscan 第三次。\n')
  const sc = scanCorpus(ws, 'zzscan', 'all')
  ok('scan: exact total count', /total occurrences: 3/.test(sc), sc.split('\n')[0])
  ok('scan: lists the matching file', sc.includes('raw/scan-probe.md'))
  ok('scan: coverage statement', sc.includes('覆盖声明'))
  const sc0 = scanCorpus(ws, 'zzscan-not-present', 'all')
  ok('scan: zero-match coverage note', sc0.includes('total occurrences: 0') && sc0.includes('未命中不等于不存在'), sc0.split('\n')[0])
  const hint = searchWiki(ws, '列出全部笔记', 5, 'wiki')
  ok('search: exhaustive-intent hint', hint.includes('穷尽/计数类意图检测'), hint.split('\n').slice(-1)[0])

  // 10. status
  const st = statusWorkspace(ws)
  ok('status has pages line', st.includes('pages: '), st.split('\n')[0])
  ok('status has token estimate', /~\d+ tokens/.test(st))
  ok('status has sources line', st.includes('sources: 3'))

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
  ok('backup rotation keep=1', readdirSync(backupRoot).filter((e) => e.startsWith('archivist-')).length === 1, b4)
  ok('backup excludes itself', !readdirSync(path.join(backupRoot, readdirSync(backupRoot).filter(e => e.startsWith('archivist-'))[0])).includes('.backups'))

  // 12. parse + estimate + tools table
  const pr = parsePage('---\ntitle: A\ntags: [x, y]\n---\nbody')
  ok('frontmatter parse title', pr.fm.title === 'A' && Array.isArray(pr.fm.tags) && pr.fm.tags.length === 2, JSON.stringify(pr.fm))
  ok('token estimate positive', estimateTokens('中文abc') >= 2)
  ok('tools table complete', TOOLS.length === 13 && TOOLS.every((t) => t.name.startsWith('archivist_')), 'count=' + TOOLS.length)

  // 13. coverage honesty: files skipped by scan/search must be disclosed (A1)
  writeFileSync(path.join(ws, 'raw', 'big-skip.md'), 'x'.repeat(2 * 1024 * 1024 + 1000) + '\nzzbig\nzzbig\n')
  writeFileSync(path.join(ws, 'raw', 'skip-probe.md'), '# skip probe\n\nzzbig once\n')
  writeFileSync(path.join(ws, 'raw', 'page.html'), '<p>zzbig</p>\n')
  const bigScan = scanCorpus(ws, 'zzbig', 'raw')
  ok('scan: skipped >2MB file is disclosed', bigScan.includes('超过 2MB') && bigScan.includes('raw/big-skip.md'), bigScan)
  ok('scan: skipped extension is disclosed', bigScan.includes('扩展名不在白名单') && bigScan.includes('raw/page.html'), bigScan)
  ok('scan: skipped files never yield a totality claim',
    !bigScan.includes('完整清单') && !bigScan.includes('以上为全部命中文件') && bigScan.includes('未扫描'),
    bigScan.split('\n').slice(-2).join(' / '))
  ok('scan: count stays exact over the files it did scan', /total occurrences: 1/.test(bigScan) && bigScan.includes('raw/skip-probe.md'), bigScan.split('\n')[0])
  const bigSearch = searchWiki(ws, 'zzbig', 10, 'raw')
  ok('search: skipped raw files are disclosed', bigSearch.includes('未纳入检索') && bigSearch.includes('raw/big-skip.md') && bigSearch.includes('raw/page.html'), bigSearch)

  // 13b. a 0-byte file is scanned-but-empty (not a gap); a non-empty filtered file still is
  const gapWs = path.join(os.tmpdir(), 'archivist-smoke-gap-' + Date.now())
  cleanupPaths.push(gapWs)
  initWorkspace(gapWs)                                          // raw/.gitkeep is 0 bytes
  writeFileSync(path.join(gapWs, 'raw', 'tiny.md'), '# tiny\nzzgap\n')
  writeFileSync(path.join(gapWs, 'raw', 'empty.png'), '')        // 0 bytes, extension not whitelisted
  const gapClean = scanCorpus(gapWs, 'zzgap', 'raw')
  ok('scan: 0-byte placeholder does not dilute the coverage statement',
    gapClean.includes('完整清单') && !gapClean.includes('扩展名不在白名单'), gapClean)
  ok('scan: 0-byte files count as scanned (empty), not as skips',
    /matched in 1 of 3 scanned file\(s\)/.test(gapClean) && !gapClean.includes('skipped'), gapClean.split('\n')[0])
  writeFileSync(path.join(gapWs, 'raw', 'notes.html'), '<p>zzgap</p>\n')   // non-empty, extension not whitelisted
  const gapDirty = scanCorpus(gapWs, 'zzgap', 'raw')
  ok('scan: non-empty filtered file is still disclosed as a coverage gap',
    gapDirty.includes('扩展名不在白名单') && gapDirty.includes('raw/notes.html') && !gapDirty.includes('完整清单'), gapDirty)

  // 13c. regressions: a truncated scan must not call its list complete; a
  // wiki-root page must be listed (else lint's "run archivist_index" is a dead
  // end); an undeclared argument must be rejected, not dropped silently.
  const capWs = path.join(os.tmpdir(), 'archivist-smoke-cap-' + Date.now())
  cleanupPaths.push(capWs)
  initWorkspace(capWs)
  for (let i = 1; i <= 61; i++) {
    writeFileSync(path.join(capWs, 'raw', `cap-${String(i).padStart(2, '0')}.md`), `# cap ${i}\nzzcap once\n`)
  }
  const capScan = scanCorpus(capWs, 'zzcap', 'raw')
  ok('scan: truncated list states the cut and never claims completeness',
    capScan.includes('清单截断') && capScan.includes('另有 1 个命中文件未显示') && !capScan.includes('以上为全部命中文件'),
    capScan.split('\n').slice(-2).join(' / '))
  ok('scan: truncated list keeps the exact file count',
    /matched in 61 of 62 scanned file\(s\)/.test(capScan), capScan.split('\n')[0])

  writePage(capWs, { path: 'RootNote.md', title: '根目录页', body: '# 根目录页\n' })
  const capIdx = readFileSync(path.join(capWs, 'wiki', 'index.md'), 'utf8')
  ok('index: wiki-root page is listed and lint reports no index-missing',
    capIdx.includes('RootNote.md') && !lintWiki(capWs).includes('index-missing'), capIdx.split('\n').slice(-3).join(' / '))
  ok('index: no Other section when every page is filed',
    !/^## Other/m.test(readFileSync(path.join(ws, 'wiki', 'index.md'), 'utf8')))

  // 截断 + 有跳过：计数声明必须限定在"已扫描"范围内
  writeFileSync(path.join(capWs, 'raw', 'cap-skip.html'), '<p>zzcap zzcap</p>\n')
  const capSkip = scanCorpus(capWs, 'zzcap', 'raw')
  ok('scan: truncation combined with a skipped file qualifies the count',
    capSkip.includes('清单截断') && capSkip.includes('只统计已扫描的文件') && !capSkip.includes('均准确'),
    capSkip.split('\n').slice(-2).join(' / '))

  // index 链接必须能被回读：带括号的文件名、含 ] 的标题都不许把 lint 逼进死路
  writePage(capWs, { path: 'Note(1).md', title: 'NoteOne', body: '# NoteOne\n' })
  writePage(capWs, { path: 'concepts/Deep(v2).md', title: 'See](also', body: '# Deep\n' })
  const parenLint = lintWiki(capWs)
  ok('index: parenthesised filename round-trips (no index-missing / index-broken)',
    !parenLint.includes('index-missing') && !parenLint.includes('index-broken'), parenLint.split('\n').slice(0, 4).join(' / '))

  // type 必须在工具层可用（曾因 schema 未声明而被 runTool 拒绝）
  const typeOut = writePage(capWs, { path: 'concepts/Typed.md', title: 'Typed', type: 'entity', body: '# Typed\n' })
  ok('write: declared type override is accepted',
    typeOut.includes('created') && readFileSync(path.join(capWs, 'wiki', 'concepts', 'Typed.md'), 'utf8').includes('type: entity'), typeOut)

  // 路径里的字面 % 必须能往返：编码若丢单射性，lint 会永久报缺页且 archivist_index 修不好
  writePage(capWs, { path: 'pct%20name.md', title: 'Pct', body: '# Pct\n' })
  writePage(capWs, { path: 'concepts/A%281%29.md', title: 'PctTwo', body: '# PctTwo\n' })
  const pctLint = lintWiki(capWs)
  ok('index: literal % in a filename round-trips exactly',
    !pctLint.includes('index-missing') && !pctLint.includes('index-broken'), pctLint.split('\n').slice(0, 4).join(' / '))

  // {title, type} 必须可用：type 只进 frontmatter，不再被当成目录名
  const typeOnly = writePage(capWs, { title: 'TypeOnly', type: 'entity', body: '# TypeOnly\n' })
  ok('write: {title, type} derives concepts/ and applies the type',
    typeOnly.includes('concepts/TypeOnly.md') && /type: entity/.test(readFileSync(path.join(capWs, 'wiki', 'concepts', 'TypeOnly.md'), 'utf8')), typeOnly)

  // 显式非法 type 必须被拒（与 trust / status 同级）
  let badTypeThrew = false
  try { writePage(capWs, { path: 'concepts/BadType.md', title: 'BadType', type: 'note', body: '# Bad\n' }) } catch { badTypeThrew = true }
  ok('write: explicit invalid type is rejected', badTypeThrew)

  // 含换行的 title / summary 不得撕裂 frontmatter
  const multiOut = writePage(capWs, { title: 'First\nSecond', summary: 'line1\nline2', body: '# Multi\n' })
  const multi = parsePage(readFileSync(path.join(capWs, 'wiki', /wiki\/(\S+\.md)/.exec(multiOut)[1]), 'utf8'))
  ok('write: newlines in title/summary collapse instead of splitting frontmatter',
    multi.fm.title === 'First Second' && multi.fm.summary === 'line1 line2', JSON.stringify(multi.fm))

  // index 的手工重排（换成 * 项目符号）不该被当成缺页
  const idxPath = path.join(capWs, 'wiki', 'index.md')
  const idxBackup = readFileSync(idxPath, 'utf8')
  writeFileSync(idxPath, idxBackup.replace(/^- \[/gm, '* ['))
  ok('index: alternative bullet markers are still parsed', !lintWiki(capWs).includes('index-missing'))
  writeFileSync(idxPath, idxBackup)

  // 第四轮：Unicode 空白文件名 / 方括号标题 / 未知 frontmatter 字段 / 带逗号的 tag / retract 日志单行
  // （这些文件只能由插件之外创建——slugify 会把 \s 折成 "-"，所以直接落盘再重建索引）
  writeFileSync(path.join(capWs, 'wiki', 'concepts', 'uni\u2028sep.md'), '---\ntitle: UniSep\ntype: concept\ntrust: low\n---\nbody\n')
  writeFileSync(path.join(capWs, 'wiki', 'concepts', 'uni sep.md'), '---\ntitle: PlainSep\ntype: concept\ntrust: low\n---\nbody\n')
  writeFileSync(path.join(capWs, 'wiki', 'concepts', 'nb\u00a0sp.md'), '---\ntitle: Nbsp\ntype: concept\ntrust: low\n---\nbody\n')
  rebuildIndex(capWs)
  const uniHrefs = [...readFileSync(path.join(capWs, 'wiki', 'index.md'), 'utf8').matchAll(/\]\(([^()]*)\)/g)].map((m) => m[1])
  ok('index: encoded hrefs are injective (two pages never share one)',
    uniHrefs.length >= 3 && new Set(uniHrefs).size === uniHrefs.length, `${uniHrefs.length} hrefs; ` + uniHrefs.filter((h, i) => uniHrefs.indexOf(h) !== i).join(', '))
  const uniLint = lintWiki(capWs)
  ok('index: unicode-whitespace filenames round-trip (no index-missing / index-broken)',
    !uniLint.includes('index-missing') && !uniLint.includes('index-broken'), uniLint.split('\n').slice(0, 4).join(' / '))

  writePage(capWs, { path: 'concepts/Brackets.md', title: '[draft]', body: '# Brackets\n' })
  const br1 = parsePage(readFileSync(path.join(capWs, 'wiki', 'concepts', 'Brackets.md'), 'utf8'))
  writePage(capWs, { path: 'concepts/Brackets.md', body: '# Brackets updated\n' })
  const br2 = parsePage(readFileSync(path.join(capWs, 'wiki', 'concepts', 'Brackets.md'), 'utf8'))
  ok('frontmatter: a bracketed title stays a string across an update',
    br1.fm.title === '[draft]' && br2.fm.title === '[draft]', JSON.stringify([br1.fm.title, br2.fm.title]))

  writeFileSync(path.join(capWs, 'wiki', 'concepts', 'Extra.md'),
    '---\ntitle: Extra\ntype: concept\ntags: ["a, b", plain]\naliases: [别名]\nreviewed: 2026-01-01\ntrust: low\n---\nbody\n')
  writePage(capWs, { path: 'concepts/Extra.md', body: '# Extra updated\n' })
  const extra = parsePage(readFileSync(path.join(capWs, 'wiki', 'concepts', 'Extra.md'), 'utf8'))
  ok('frontmatter: keys this build does not know about survive an update',
    Array.isArray(extra.fm.aliases) && extra.fm.aliases[0] === '别名' && String(extra.fm.reviewed) === '2026-01-01', JSON.stringify(extra.fm))
  ok('frontmatter: a quoted comma stays inside one tag',
    Array.isArray(extra.fm.tags) && extra.fm.tags.length === 2 && extra.fm.tags[0] === 'a, b', JSON.stringify(extra.fm.tags))

  const retractOut = writePage(capWs, { path: 'concepts/Extra.md', retract: true, retractReason: 'why\ninjected-line' })
  const logTail = readFileSync(path.join(capWs, 'wiki', 'log.md'), 'utf8').trimEnd().split('\n').slice(-1)[0]
  ok('retract: a newline in the reason cannot break the one-line log contract',
    !retractOut.includes('\n') && /^## \[/.test(logTail) && logTail.includes('why injected-line'), logTail)

  const writeTool = TOOLS.find((t) => t.name === 'archivist_write')
  let relIndexOk = true
  try { runTool(writeTool, { rel: 'concepts/ViaRel.md', title: 'ViaRel', body: '# ViaRel', index: false }) } catch { relIndexOk = false }
  ok('tools: rel and index are declared and reach writePage',
    relIndexOk && existsSync(path.join(capWs, 'wiki', 'concepts', 'ViaRel.md')), String(relIndexOk))
  rebuildIndex(capWs)

  const spaced = readFileSync(path.join(capWs, 'wiki', 'index.md'), 'utf8').replace(/^- /gm, '-  ')
  writeFileSync(path.join(capWs, 'wiki', 'index.md'), spaced)
  ok('index: extra spaces after the bullet are tolerated', !lintWiki(capWs).includes('index-missing'))
  rebuildIndex(capWs)

  // 第五轮：引号值必须逐次稳定（不能每更新一层反斜杠）、数组项含引号不丢、块状 frontmatter 保留
  const concDir = path.join(capWs, 'wiki', 'concepts')
  writePage(capWs, {
    path: 'concepts/Quoted.md', title: 'Quoted', summary: 'see the file "AGENTS.md"',
    tags: ['note", see also', 'he said "hi"', '"', 'plain'], body: '# Quoted\n',
  })
  const qRaw = () => readFileSync(path.join(concDir, 'Quoted.md'), 'utf8')
  const qSnapshots = [qRaw()]
  for (let i = 1; i <= 3; i++) { writePage(capWs, { path: 'concepts/Quoted.md', body: `# Quoted ${i}\n` }); qSnapshots.push(qRaw()) }
  const qLine = (t) => /^summary: .*$/m.exec(t)[0]
  const quoted = parsePage(qRaw())
  ok('frontmatter: a quoted value is byte-stable across repeated updates',
    new Set(qSnapshots.map(qLine)).size === 1 && quoted.fm.summary === 'see the file "AGENTS.md"', qLine(qRaw()))
  ok('frontmatter: array items containing quotes and a quoted comma round-trip exactly',
    Array.isArray(quoted.fm.tags) && quoted.fm.tags.length === 4 && quoted.fm.tags[0] === 'note", see also'
      && quoted.fm.tags[1] === 'he said "hi"' && quoted.fm.tags[2] === '"' && quoted.fm.tags[3] === 'plain',
    JSON.stringify(quoted.fm.tags))

  const dupKeys = (text) => {
    const f = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
    const seen = []
    for (const line of (f ? f[1] : '').split(/\r?\n/)) {
      const k = /^([A-Za-z_][\w-]*)\s*:/.exec(line)
      if (k) seen.push(k[1])
    }
    return seen.filter((k, i) => seen.indexOf(k) !== i)
  }

  writeFileSync(path.join(concDir, 'Blocky.md'),
    '---\ntitle: Blocky\ntype: concept\naliases_block:\n  - one\n  - two\nnested:\n  key: value\nnotes: |\n  line a\n  line b\na.b: dotted\n中文键: 值\n2026_plan: year\ntrust: low\n---\nbody\n')
  writePage(capWs, { path: 'concepts/Blocky.md', body: '# Blocky updated\n' })
  const blocky = readFileSync(path.join(concDir, 'Blocky.md'), 'utf8')
  const blockyPage = parsePage(blocky)
  ok('frontmatter: block lists, nested maps, block scalars and odd keys survive an update',
    dupKeys(blocky).length === 0
      && Array.isArray(blockyPage.fm.aliases_block) && blockyPage.fm.aliases_block.join(',') === 'one,two'
      && ['nested:\n  key: value', 'notes: |\n  line a', 'a.b: dotted', '中文键: 值', '2026_plan: year'].every((s) => blocky.includes(s)),
    blocky.split('\n').slice(0, 16).join(' / '))

  writeFileSync(path.join(concDir, 'Legacy.md'), '---\ntitle: Legacy2\ntype: concept\ntrust: HIGH\nstatus: Draft\n---\nbody\n')
  let legacyOk = true
  try { writePage(capWs, { path: 'concepts/Legacy.md', body: '# Legacy2 updated\n' }) } catch { legacyOk = false }
  ok('write: a legacy invalid trust/status does not block a body-only update', legacyOk)

  // 第六轮：裸 "key:" + 缩进块不得造成重复键；U+2028/2029 不得撕裂 frontmatter
  writeFileSync(path.join(concDir, 'Bare.md'),
    '---\ntitle:\n  My Real Title\ntype: concept\ntags:\n  - alpha\n  - beta\ntrust: low\n---\nbody\n')
  writePage(capWs, { path: 'concepts/Bare.md', body: 'body2\n' })
  const bare = readFileSync(path.join(concDir, 'Bare.md'), 'utf8')
  const barePage = parsePage(bare)
  ok('frontmatter: a bare "key:" block is parsed into the value, not duplicated',
    dupKeys(bare).length === 0 && barePage.fm.title === 'My Real Title'
      && Array.isArray(barePage.fm.tags) && barePage.fm.tags.join(',') === 'alpha,beta',
    `dupes=${JSON.stringify(dupKeys(bare))} title=${JSON.stringify(barePage.fm.title)} tags=${JSON.stringify(barePage.fm.tags)}`)

  writeFileSync(path.join(concDir, 'Nested.md'),
    '---\ntitle: Nested\ntype: concept\ntags:\n  nest: value\ntrust: low\n---\nbody\n')
  writePage(capWs, { path: 'concepts/Nested.md', body: 'body2\n' })
  const nested = readFileSync(path.join(concDir, 'Nested.md'), 'utf8')
  ok('frontmatter: an unparseable block keeps its key and is never duplicated',
    dupKeys(nested).length === 0 && nested.includes('tags:\n  nest: value'), `dupes=${JSON.stringify(dupKeys(nested))}`)

  writePage(capWs, { path: 'concepts/Sep.md', title: 'Sep', summary: 'a\u2028b\u2029c', body: '# Sep\n' })
  const sep = readFileSync(path.join(concDir, 'Sep.md'), 'utf8')
  ok('frontmatter: line separators are folded instead of splitting the record',
    dupKeys(sep).length === 0 && parsePage(sep).fm.summary === 'a b c', JSON.stringify(parsePage(sep).fm.summary))

  // 第七轮：YAML 指示符开头的值必须被引用（否则 flow 序列非法或被真 YAML 读成注释）
  const risky = ['#research', 'alpha', '-dash', '@at', '%pct', 'null', '~', 'true', '123', 'a: b', 'a #c']
  writePage(capWs, { path: 'concepts/Risky.md', title: 'Risky', tags: risky, body: '# Risky\n' })
  const riskyRaw = readFileSync(path.join(concDir, 'Risky.md'), 'utf8')
  const riskyLine = /^tags: .*$/m.exec(riskyRaw)[0]
  ok('frontmatter: YAML-indicator values are quoted so a flow list stays valid',
    ['"#research"', '"-dash"', '"@at"', '"%pct"', '"null"', '"~"', '"true"', '"123"', '"a: b"', '"a #c"'].every((q) => riskyLine.includes(q)),
    riskyLine)
  ok('frontmatter: quoted indicator values round-trip exactly and never duplicate a key',
    dupKeys(riskyRaw).length === 0 && parsePage(riskyRaw).fm.tags.join('|') === risky.join('|'),
    JSON.stringify(parsePage(riskyRaw).fm.tags))

  writeFileSync(path.join(concDir, 'SeqOdd.md'),
    '---\ntitle: SeqOdd\ntype: concept\ntags:\n  - alpha\n  - #x\ntrust: low\n---\nbody\n')
  writePage(capWs, { path: 'concepts/SeqOdd.md', body: 'body2\n' })
  const seqOdd = readFileSync(path.join(concDir, 'SeqOdd.md'), 'utf8')
  ok('frontmatter: a block sequence with a comment item is kept verbatim, not normalised',
    dupKeys(seqOdd).length === 0 && /tags:\n {2}- alpha\n {2}- #x/.test(seqOdd), seqOdd.split('\n').slice(0, 12).join(' / '))

  // 第八轮：显式传参必须赢过"原样保留的块"（否则静默写不进去）；控制字符必须明确拒绝
  writeFileSync(path.join(concDir, 'BlockOwned.md'),
    '---\ntitle: BlockOwned\ntype: concept\ntags:\n  - alpha\n  - #x\ntrust: low\n---\nbody\n')
  const beforeOwned = readFileSync(path.join(concDir, 'BlockOwned.md'), 'utf8')
  const ownedOut = writePage(capWs, { path: 'concepts/BlockOwned.md', tags: ['gamma'], body: 'body2\n' })
  const owned = parsePage(readFileSync(path.join(concDir, 'BlockOwned.md'), 'utf8'))
  ok('write: an explicit argument overrides a block-owned key instead of being dropped',
    JSON.stringify(owned.fm.tags) === JSON.stringify(['gamma']) && ownedOut.includes('updated')
      && dupKeys(readFileSync(path.join(concDir, 'BlockOwned.md'), 'utf8')).length === 0
      && beforeOwned !== readFileSync(path.join(concDir, 'BlockOwned.md'), 'utf8'),
    `tags=${JSON.stringify(owned.fm.tags)} out=${ownedOut.slice(0, 60)}`)

  let ctrlThrew = ''
  try { writePage(capWs, { path: 'concepts/Ctrl.md', title: 'a\u0000b', body: '# x\n' }) } catch (e) { ctrlThrew = e.message }
  ok('write: a control character in frontmatter is rejected with a named reason',
    ctrlThrew.includes('control character') && ctrlThrew.includes('U+0000'), ctrlThrew)

  const commaPage = writePage(capWs, { title: ',x', tags: [',x'], body: '# comma\n' })
  const commaRaw = readFileSync(path.join(concDir, ',x.md'), 'utf8')
  ok('frontmatter: a leading comma is quoted (flow/plain syntax stays valid)',
    /^title: "/m.test(commaRaw) && /^tags: \["/m.test(commaRaw) && parsePage(commaRaw).fm.title === ',x',
    commaPage + ' | ' + /^title: .*$/m.exec(commaRaw)[0])

  // 第九轮：C1 拒绝、继承坏值清洗（坏页不冻结）、retractReason 不删块、retract 的 status 生效、supersede 不留半成品
  const CTRL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u0084\u0086-\u009F\uFFFE\uFFFF]/
  let c1Threw = ''
  try { writePage(capWs, { path: 'concepts/C1.md', title: 'a\u0092b', body: '# x\n' }) } catch (e) { c1Threw = e.message }
  ok('write: C1 controls and noncharacters are rejected with a named code point',
    c1Threw.includes('U+0092'), c1Threw)

  writeFileSync(path.join(concDir, 'HealMe.md'),
    '---\ntitle: HealMe\ntype: concept\nsummary: bad\u0001summary\ntrust: low\n---\nbody\n')
  let healThrew = ''
  let healOut = ''
  try { healOut = writePage(capWs, { path: 'concepts/HealMe.md', body: '# healed\n' }) } catch (e) { healThrew = e.message }
  const healed = readFileSync(path.join(concDir, 'HealMe.md'), 'utf8')
  ok('write: a page carrying an inherited control character stays updatable, cleaned and disclosed',
    healThrew === '' && !CTRL.test(healed) && parsePage(healed).fm.summary === 'bad summary'
      && /cleaned \d+ control char/.test(healOut),
    healThrew || `${JSON.stringify(parsePage(healed).fm.summary)} | ${healOut}`)

  // 清洗必须用空格替换而非删除：删字符会把惰性垃圾行升格成活键（静默改检索语义）
  writeFileSync(path.join(concDir, 'Junk.md'),
    '---\ntitle: Junk\ntype: concept\n\u0092status: retracted\ntrust: low\n---\nfindme token\n')
  writePage(capWs, { path: 'concepts/Junk.md', body: 'findme token 2\n' })
  const junkRaw = readFileSync(path.join(concDir, 'Junk.md'), 'utf8')
  const junkPage = parsePage(junkRaw)
  ok('write: cleaning a junk line must not promote it into a live key',
    junkPage.fm.status === undefined && dupKeys(junkRaw).length === 0
      && junkRaw.includes('#  status: retracted')
      && searchWiki(capWs, 'findme', 5, 'wiki').includes('concepts/Junk.md'),
    `status=${JSON.stringify(junkPage.fm.status)} dupes=${JSON.stringify(dupKeys(junkRaw))}`)

  // 自我 supersede 会丢正文；插件自管文件不可作为 supersedes 目标
  writeFileSync(path.join(concDir, 'Self.md'), '---\ntitle: Self\ntype: concept\ntrust: low\n---\nORIGINAL\n')
  let selfThrew = ''
  try { writePage(capWs, { path: 'concepts/Self.md', supersedes: 'concepts/Self.md', body: 'REPLACEMENT\n' }) } catch (e) { selfThrew = e.message }
  ok('supersede: a page cannot supersede itself (the body would be silently reverted)',
    selfThrew.includes('itself') && readFileSync(path.join(concDir, 'Self.md'), 'utf8').includes('ORIGINAL'), selfThrew)

  let logTargetThrew = ''
  try { writePage(capWs, { path: 'concepts/LogTarget.md', title: 'LogTarget', supersedes: 'log.md', body: 'x\n' }) } catch (e) { logTargetThrew = e.message }
  ok('supersede: plugin-managed index.md/log.md are refused as targets',
    logTargetThrew.includes('plugin-managed'), logTargetThrew)

  let badPathThrew = ''
  try { writePage(capWs, { path: 'concepts/p\u0092q.md', title: 'BadPath', body: 'x\n' }) } catch (e) { badPathThrew = e.message }
  ok('write: a control character in the path is refused (it would land in a filename and in index.md)',
    badPathThrew.includes('U+0092'), badPathThrew)

  let emptyArgOk = true
  try { writePage(capWs, { path: 'concepts/HealMe.md', summary: '', body: '# healed twice\n' }) } catch { emptyArgOk = false }
  ok('write: an empty explicit argument falls back to the inherited value instead of tripping the gate', emptyArgOk)

  writeFileSync(path.join(concDir, 'Retain.md'),
    '---\ntitle: Retain\ntype: concept\nretractReason:\n  - old reason\n  - #c\ntrust: low\n---\nbody\n')
  writePage(capWs, { path: 'concepts/Retain.md', retractReason: 'new reason', body: 'body\n' })
  const retain = readFileSync(path.join(concDir, 'Retain.md'), 'utf8')
  ok('write: passing retractReason without retract does not delete the block owning it',
    retain.includes('- old reason') && !retain.includes('new reason'), retain.split('\n').slice(0, 8).join(' / '))

  writeFileSync(path.join(concDir, 'Retracted.md'),
    '---\ntitle: Retracted\ntype: concept\nstatus:\n  value: active\ntrust: low\n---\nbody\n')
  writePage(capWs, { path: 'concepts/Retracted.md', retract: true, retractReason: 'r' })
  const retractedPage = parsePage(readFileSync(path.join(concDir, 'Retracted.md'), 'utf8'))
  ok('retract: a block-owned status is overridden so retraction really takes effect',
    String(retractedPage.fm.status) === 'retracted' && dupKeys(readFileSync(path.join(concDir, 'Retracted.md'), 'utf8')).length === 0,
    JSON.stringify(retractedPage.fm.status))

  writeFileSync(path.join(concDir, 'BadOld.md'),
    '---\ntitle: BadOld\ntype: concept\nsummary: bad\u0001summary\ntrust: low\n---\nold\n')
  let supThrew = ''
  try { writePage(capWs, { path: 'concepts/NewPage.md', title: 'NewPage', supersedes: 'concepts/BadOld.md', body: 'n\n' }) } catch (e) { supThrew = e.message }
  const oldAfter = parsePage(readFileSync(path.join(concDir, 'BadOld.md'), 'utf8'))
  ok('supersede: a legacy bad page is cleaned and marked instead of leaving a half-written state',
    supThrew === '' && existsSync(path.join(concDir, 'NewPage.md')) && String(oldAfter.fm.status) === 'superseded'
      && !CTRL.test(readFileSync(path.join(concDir, 'BadOld.md'), 'utf8')),
    `${supThrew} new=${existsSync(path.join(concDir, 'NewPage.md'))} old=${JSON.stringify(oldAfter.fm.status)}`)

  const statusTool = TOOLS.find((t) => t.name === 'archivist_status')
  let unknownThrew = false
  try { runTool(statusTool, { workspace: ws, bogusUnknownParam: 42 }) } catch { unknownThrew = true }
  ok('tools: undeclared argument is rejected, not silently dropped', unknownThrew)
  ok('tools: declared arguments still reach the tool through runTool',
    runTool(statusTool, { workspace: ws }).includes('pages: '))

  // 14. backup rotation must never delete a look-alike user directory (A2)
  const bkTarget = path.join(os.tmpdir(), 'archivist-smoke-backups-' + Date.now())
  cleanupPaths.push(bkTarget)
  mkdirSync(path.join(bkTarget, 'archivist-1-userdata'), { recursive: true })
  writeFileSync(path.join(bkTarget, 'archivist-1-userdata', 'keep.txt'), 'user data\n')
  mkdirSync(path.join(bkTarget, 'archivist-20200101-000000000'), { recursive: true })
  const bkOut = backupWorkspace(ws, bkTarget, 1)
  ok('backup: look-alike user dir survives rotation', existsSync(path.join(bkTarget, 'archivist-1-userdata', 'keep.txt')), bkOut)
  ok('backup: unrecognized entry is reported, not deleted', bkOut.includes('archivist-1-userdata') && /skipped 1 unrecognized/.test(bkOut), bkOut)
  ok('backup: strict-format old snapshot is still rotated', !existsSync(path.join(bkTarget, 'archivist-20200101-000000000')), bkOut)

  // 15. path guards for sourceFile / supersedes (A4)
  const outsideSecret = path.join(os.tmpdir(), 'archivist-smoke-outside-' + Date.now() + '.txt')
  cleanupPaths.push(outsideSecret)
  writeFileSync(outsideSecret, 'secret outside the workspace\n')
  for (const [desc, args, pageAbs] of [
    ['sourceFile escaping the workspace is blocked',
      { path: 'sources/escape.md', body: '# x\n', sourceFile: '../' + path.basename(outsideSecret) },
      path.join(ws, 'wiki', 'sources', 'escape.md')],
    ['sourceFile outside raw/ is blocked',
      { path: 'sources/invisible.md', body: '# x\n', sourceFile: 'AGENTS.md' },
      path.join(ws, 'wiki', 'sources', 'invisible.md')],
    ['supersedes escaping wiki/ is blocked',
      { path: 'concepts/escape2.md', body: '# x\n', supersedes: '../../outside.md' },
      path.join(ws, 'wiki', 'concepts', 'escape2.md')],
  ]) {
    let t = false
    try { writePage(ws, args) } catch { t = true }
    ok(desc, t && !existsSync(pageAbs), 'threw=' + t)
  }

  // 16. a rejected write must not leave a half-written page behind (A5)
  writePage(ws, { path: 'sources/atomic.md', title: 'Atomic', body: '# Atomic\n\noriginal\n' })
  const atomicAbs = path.join(ws, 'wiki', 'sources', 'atomic.md')
  const atomicBefore = readFileSync(atomicAbs, 'utf8')
  const indexBefore = readFileSync(path.join(ws, 'wiki', 'index.md'), 'utf8')
  for (const [desc, args, pageAbs] of [
    ['rejected write (missing sourceFile) leaves no page',
      { path: 'sources/atomic-a.md', body: '# a\n', sourceFile: 'raw/never-existed.md' },
      path.join(ws, 'wiki', 'sources', 'atomic-a.md')],
    ['rejected write (missing supersedes target) leaves no page',
      { path: 'concepts/atomic-b.md', body: '# b\n', supersedes: 'concepts/ghost.md' },
      path.join(ws, 'wiki', 'concepts', 'atomic-b.md')],
  ]) {
    let t = false
    try { writePage(ws, args) } catch { t = true }
    ok(desc, t && !existsSync(pageAbs), 'threw=' + t)
  }
  let rejected = false
  try { writePage(ws, { path: 'sources/atomic.md', body: '# Atomic\n\nREWRITTEN\n', supersedes: 'concepts/ghost.md' }) } catch { rejected = true }
  ok('rejected write leaves the existing page untouched', rejected && readFileSync(atomicAbs, 'utf8') === atomicBefore)
  ok('rejected write leaves index.md untouched', readFileSync(path.join(ws, 'wiki', 'index.md'), 'utf8') === indexBefore)

  // 17. archivist_commit must not stage files outside the workspace (A3)
  const gitProbe = spawnSync('git', ['--version'], { encoding: 'utf8' })
  if (gitProbe.status === 0) {
    const outer = path.join(os.tmpdir(), 'archivist-smoke-outer-' + Date.now())
    cleanupPaths.push(outer)
    mkdirSync(outer, { recursive: true })
    const runGit = (...args) => spawnSync('git', args, { cwd: outer, encoding: 'utf8' })
    runGit('init')
    writeFileSync(path.join(outer, 'UNRELATED-USER-FILE.txt'), 'v1\n')
    runGit('add', '-A')
    runGit('-c', 'user.name=selftest', '-c', 'user.email=selftest@example.invalid', 'commit', '-m', 'init')
    const innerWs = path.join(outer, 'wiki-ws')
    initWorkspace(innerWs)
    writeFileSync(path.join(outer, 'UNRELATED-USER-FILE.txt'), 'v2 unrelated user edit\n')
    let commitOut = ''
    try { commitOut = commitWorkspace(innerWs, 'selftest: scoped commit') } catch (e) { commitOut = 'THREW: ' + e.message }
    const headFiles = (runGit('show', '--name-only', '--format=', 'HEAD').stdout || '')
      .split('\n').map((s) => s.trim()).filter(Boolean)
    ok('commit: workspace files are committed', headFiles.some((f) => f.startsWith('wiki-ws/')), commitOut + ' | ' + headFiles.join(','))
    ok('commit: unrelated file outside the workspace is not committed', !headFiles.includes('UNRELATED-USER-FILE.txt'), headFiles.join(','))
    // A file the user already staged in the parent repo must not ride along either.
    writeFileSync(path.join(outer, 'STAGED-USER-FILE.txt'), 'user staged work\n')
    runGit('add', 'STAGED-USER-FILE.txt')
    appendLog(innerWs, 'selftest | scoped commit probe')
    let commitOut2 = ''
    try { commitOut2 = commitWorkspace(innerWs, 'selftest: scoped commit 2') } catch (e) { commitOut2 = 'THREW: ' + e.message }
    const headFiles2 = (runGit('show', '--name-only', '--format=', 'HEAD').stdout || '')
      .split('\n').map((s) => s.trim()).filter(Boolean)
    ok('commit: workspace change lands while a pre-staged parent file stays out',
      commitOut2.includes('committed') && headFiles2.some((f) => f.startsWith('wiki-ws/')) && !headFiles2.includes('STAGED-USER-FILE.txt'),
      commitOut2 + ' | ' + headFiles2.join(','))
    ok('commit: pre-staged parent file is left staged, not committed',
      (runGit('diff', '--cached', '--name-only').stdout || '').includes('STAGED-USER-FILE.txt'), commitOut2)
  } else {
    skipped++
    console.log('SKIP commit scoping (' + (gitProbe.error?.code === 'ENOENT' ? 'git is not installed' : 'git cannot be spawned in this sandbox') + ')')
  }

  // 18. bench must fail loudly on a missing or empty library (A6)
  const benchScript = fileURLToPath(new URL('./bench/bench-queries.mjs', import.meta.url))
  const benchRun = (dir) => {
    const report = path.join(os.tmpdir(), 'archivist-smoke-bench-' + Date.now() + '.md')
    cleanupPaths.push(report)
    const r = spawnSync(process.execPath, [benchScript, dir, report], { encoding: 'utf8' })
    return { r, report }
  }
  const benchMissing = benchRun(path.join(os.tmpdir(), 'archivist-smoke-nolib-' + Date.now()))
  const emptyLib = path.join(os.tmpdir(), 'archivist-smoke-emptylib-' + Date.now())
  cleanupPaths.push(emptyLib)
  mkdirSync(path.join(emptyLib, 'raw'), { recursive: true })
  const benchEmpty = benchRun(emptyLib)
  if (benchMissing.r.status === null && benchEmpty.r.status === null) {
    // Same condition the commit group skips on: this environment forbids the child
    // process, so the assertion cannot observe anything — skip it, never report a failure.
    skipped += 2
    console.log('SKIP bench exit codes (cannot spawn a child process in this environment)')
  } else {
    ok('bench: missing library exits non-zero and writes no report',
      benchMissing.r.status !== 0 && !existsSync(benchMissing.report), 'status=' + benchMissing.r.status)
    ok('bench: empty library exits non-zero and writes no report',
      benchEmpty.r.status !== 0 && !existsSync(benchEmpty.report), 'status=' + benchEmpty.r.status)
  }

  // 19. numeric option 0 must not be treated as a missing option (A7)
  const zeroTarget = path.join(os.tmpdir(), 'archivist-smoke-zerokeep-' + Date.now())
  cleanupPaths.push(zeroTarget)
  for (const n of ['20200101-000000001', '20200101-000000002', '20200101-000000003']) {
    mkdirSync(path.join(zeroTarget, 'archivist-' + n), { recursive: true })
  }
  const keepZero = TOOLS.find((t) => t.name === 'archivist_backup').run({ workspace: ws, target: zeroTarget, keep: 0 })
  const keptSnapshots = readdirSync(zeroTarget).filter((e) => /^archivist-\d{8}-\d{9,}$/.test(e))
  ok('backup keep:0 is honoured (not silently the default 10)', keptSnapshots.length === 1, keepZero + ' | kept=' + keptSnapshots.length)
  const logAbs = path.join(ws, 'wiki', 'log.md')
  const logBeforeZero = readFileSync(logAbs, 'utf8')
  const readZero = String(TOOLS.find((t) => t.name === 'archivist_log').run({ workspace: ws, read: 0 }))
  ok('log read:0 reads instead of appending', readFileSync(logAbs, 'utf8') === logBeforeZero && !readZero.startsWith('logged:'), readZero)

  console.log(`\n${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped` : ''}`)
  process.exitCode = fail ? 1 : 0
} finally {
  for (const p of cleanupPaths) { try { rmSync(p, { recursive: true, force: true }) } catch { } }
}
