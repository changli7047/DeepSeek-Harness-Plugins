/**
 * Per-stage cost decomposition for `hybridSearch` (P1-perf, contract §4 perf gates).
 *
 * READ-ONLY: imports only exported core functions; core/** is never modified.
 * Internal stages are not individually exported, so they are measured as PAIRED
 * measurements off the same base call and reported as additive deltas; whatever the
 * deltas cannot attribute is shown as an explicit residual. All engine calls are
 * awaited (Phase-2 async transition safe).
 *
 * sync column: read from `diagnostics.timings.sync` / `timings.syncMode` — the sync
 * cost the query ACTUALLY paid (throttled queries pay 0). The old version called
 * syncIndex standalone, which measured a fake per-query cost. A forced `syncNow(dir)`
 * runs once before scoring so throttling cannot hide real corpus changes.
 *
 * Usage:
 *   node bench/query-profile.mjs [--root D:\archivist-work\corpora] [--sizes 1m,3m,10m]
 *        [--samples 20] [--md ...md] [--json ...json]
 *   node bench/query-profile.mjs --fts-probe --probe-size 10m --samples 20
 */
import { readdirSync, statSync, writeFileSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { hybridSearch, syncNow } from '../core/mod-retrieval.mjs'
import { openIndex, searchLexical, getChunk, getDocChunks } from '../core/mod-indexdb.mjs'
import { tokenize } from '../core/mod-chunks.mjs'

const BASE = { limit: 20, scope: 'all', expand: 'parent', filters: { excludeRetracted: true } }
const pctile = (arr, q) => { if (!arr.length) return 0; const a = [...arr].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(a.length * q))] }
const stat = (arr) => ({ p50: +pctile(arr, 0.5).toFixed(2), p95: +pctile(arr, 0.95).toFixed(2), max: +(arr.length ? Math.max(...arr) : 0).toFixed(2) })

function profileWalk(dir) {
  const t0 = performance.now()
  let files = 0
  const walk = (d) => {
    let ents
    try { ents = readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else { try { statSync(p); files++ } catch { /* unreadable */ } }
    }
  }
  walk(path.join(dir, 'wiki'))
  walk(path.join(dir, 'raw'))
  return { ms: performance.now() - t0, files }
}

async function profileSize(root, size, samples, out) {
  const dir = path.join(root, size)
  const gold = JSON.parse(readFileSync(path.join(root, `gold-needles-${size}.json`), 'utf8'))
  const queries = gold.cases.slice(0, samples).map((c) => c.query)
  const db = openIndex(dir) // shared handle for the FTS/candidate side measurements
  const tSync = performance.now()
  try { await syncNow(dir) } catch { /* reported via syncModes below */ }
  const initialSyncMs = +(performance.now() - tSync).toFixed(0)

  const tCold = performance.now()
  await hybridSearch(dir, queries[0], { ...BASE, forceSync: true })
  const coldMs = performance.now() - tCold

  const acc = { total: [], dirWalk: [], sync: [], syncMode: [], fts: [], candidate: [], serialize: [], channels: [], rerank: [], parent: [], residual: [] }
  let candidates = 0
  for (const q of queries) {
    let t = performance.now()
    const res = await hybridSearch(dir, q, BASE)
    const hits = res?.hits || []
    acc.total.push(performance.now() - t)
    const tm = res?.diagnostics?.timings || {}
    acc.sync.push(Number(tm.sync) || 0)                       // what the query ACTUALLY paid
    acc.syncMode.push(tm.syncMode || (res?.diagnostics?.throttleActive ? 'throttled' : 'unknown'))
    acc.dirWalk.push(profileWalk(dir).ms)                     // reference lower bound only

    const tokens = tokenize(q)
    t = performance.now()
    const rows = searchLexical(db, tokens, { limit: 100, scope: 'all', filters: { excludeRetracted: true } })
    acc.fts.push(performance.now() - t)
    candidates += rows.length

    const docIds = [...new Set(rows.map((r) => r.docId))].slice(0, 20)
    const chunkIds = rows.slice(0, 20).map((r) => r.chunkId)
    t = performance.now()
    for (const id of docIds) getDocChunks(db, id)
    for (const id of chunkIds) getChunk(db, id)
    acc.candidate.push(performance.now() - t)

    t = performance.now()
    JSON.stringify(hits)
    acc.serialize.push(performance.now() - t)

    t = performance.now()
    await hybridSearch(dir, q, { ...BASE, rerank: false })
    acc.rerankRaw = acc.rerankRaw || []
    acc.rerankRaw.push(performance.now() - t)

    t = performance.now()
    await hybridSearch(dir, q, { ...BASE, expand: 'none', rerank: false })
    acc.lexOnlyRaw = acc.lexOnlyRaw || []
    acc.lexOnlyRaw.push(performance.now() - t)

    t = performance.now()
    await hybridSearch(dir, q, { ...BASE, expand: 'none', channels: { lexical: true, alias: false, exact: false }, rerank: false })
    acc.chanRaw = acc.chanRaw || []
    acc.chanRaw.push(performance.now() - t)

    t = performance.now()
    await hybridSearch(dir, q, { ...BASE, expand: 'none' })
    acc.parentRaw = acc.parentRaw || []
    acc.parentRaw.push(performance.now() - t)
  }
  for (let i = 0; i < queries.length; i++) {
    acc.rerank.push(acc.total[i] - acc.rerankRaw[i])
    acc.channels.push(acc.chanRaw[i] - acc.lexOnlyRaw[i])
    acc.parent.push(acc.total[i] - acc.parentRaw[i])
    const measured = acc.sync[i] + acc.fts[i] + acc.candidate[i] + acc.serialize[i] + Math.max(0, acc.channels[i]) + Math.max(0, acc.rerank[i]) + Math.max(0, acc.parent[i])
    acc.residual.push(acc.total[i] - measured)
  }
  const totalP50 = stat(acc.total).p50
  const stages = {}
  for (const key of ['dirWalk', 'sync', 'fts', 'candidate', 'channels', 'rerank', 'parent', 'serialize', 'residual']) {
    const s = stat(acc[key])
    stages[key] = { ...s, share: totalP50 ? Math.round((s.p50 / totalP50) * 1000) / 10 : null }
  }
  const rec = {
    size, dir, needles: gold.cases.length, samples: queries.length,
    coldOpenMs: +coldMs.toFixed(0), initialSyncMs,
    syncModes: acc.syncMode.reduce((m, k) => { m[k] = (m[k] || 0) + 1; return m }, {}),
    avgCandidates: Math.round(candidates / queries.length),
    total: stat(acc.total), stages, filesWalked: profileWalk(dir).files,
  }
  out.push(rec)
  console.log(JSON.stringify({ size, samples: rec.samples, coldOpenMs: rec.coldOpenMs, initialSyncMs, syncModes: rec.syncModes, total: rec.total, stages: Object.fromEntries(Object.entries(stages).map(([k, v]) => [k, `${v.p50}ms/${v.share}%`])) }))
  return rec
}

// --- FTS strategy probe: is the FTS cost bm25 scoring over a huge OR match set? ---
async function ftsProbe(root, size, samples) {
  const dir = path.join(root, size)
  const gold = JSON.parse(readFileSync(path.join(root, `gold-needles-${size}.json`), 'utf8'))
  const queries = gold.cases.slice(0, samples).map((c) => c.query)
  const db = openIndex(dir)
  const esc = (t) => '"' + String(t).replace(/"/g, '""') + '"'
  const stRanked = db.prepare(`SELECT c.chunk_id, bm25(chunks_fts) AS s FROM chunks_fts JOIN chunks c ON c.chunk_id = chunks_fts.rowid WHERE chunks_fts MATCH ? ORDER BY bm25(chunks_fts) LIMIT 100`)
  const stPlain = db.prepare(`SELECT c.chunk_id FROM chunks_fts JOIN chunks c ON c.chunk_id = chunks_fts.rowid WHERE chunks_fts MATCH ? LIMIT 100`)
  const t = {}
  const run = (key, fn) => { const t0 = performance.now(); try { fn() } catch { /* strategy may be unsupported */ } if (!(key in t)) t[key] = []; t[key].push(performance.now() - t0) }
  let tokCount = 0
  for (const q of queries) {
    const tokens = [...new Set(tokenize(q))]
    tokCount += tokens.length
    const or = tokens.map(esc).join(' OR ')
    const and = tokens.map(esc).join(' AND ')
    run('or_ranked_bm25', () => stRanked.all(or))
    run('or_plain_limit', () => stPlain.all(or))
    run('and_ranked_bm25', () => stRanked.all(and))
  }
  const out = { size, samples: queries.length, avgQueryTokens: +(tokCount / queries.length).toFixed(1) }
  for (const [k, arr] of Object.entries(t)) out[k] = stat(arr)
  const base = out.or_ranked_bm25?.p50 || 1
  out.andSpeedup = out.and_ranked_bm25 ? +(base / out.and_ranked_bm25.p50).toFixed(1) + '×' : null
  out.sortCostShare = Math.round(((base - (out.or_plain_limit?.p50 || 0)) / base) * 1000) / 10 + '%'
  console.log(JSON.stringify(out))
  return out
}

function suggest(recs) {
  const s = []
  const last = recs[recs.length - 1]
  const st = last.stages
  const g = (k) => st[k]?.share ?? 0
  if (g('sync') >= 8) s.push(`**查询实付 sync 占 ${g('sync')}%**（${st.sync.p50}ms/p50，${st.sync.p95}ms/p95，max ${st.sync.max}ms；mode 分布 ${JSON.stringify(last.syncModes)}；评测前初始 syncNow ${last.initialSyncMs}ms）。sync 已有 1500ms 节流 + 目录戳快路径；若 share 仍高，说明 full sync 次数偏多：检查 rt_SYNC_FULL_INTERVAL_MS / forceSync 调用，或库文件数低于 rt_SYNC_THROTTLE_MIN_FILES=400 未启用节流。`)
  if (g('fts') >= 25) s.push(`**FTS5 查询是大头**：占 **${g('fts')}%**（${st.fts.p50}ms/p50）。见 \`--fts-probe\`：OR+bm25 的排序占 FTS 成本 ~99%（10M：260.7→3.47ms 去掉 ORDER BY，AND 预过滤 0.28ms）→ 两段式候选预过滤是唯一能把 10M 压进 300ms 的做法（需改 core → 转派）。`)
  if (g('candidate') >= 15) s.push(`**候选装载是 N+1**：占 **${g('candidate')}%**。建议 searchLexical 的 SQL 直接 JOIN 出所需列或 batch \`IN (...)\`（需改 core）。`)
  if (g('channels') >= 10) s.push(`**alias+exact 通道打分**：占 **${g('channels')}%**。alias 映射随索引版本缓存、exact 只对 top-K 候选启用。`)
  if (g('parent') >= 10) s.push(`**父段展开**：占 **${g('parent')}%**。证据包本就会做相邻合并，建议 hybridSearch 默认 \`expand:'none'\`。`)
  if (g('rerank') >= 5) s.push(`**重排**：占 **${g('rerank')}%**；金标上 rerank 增益 ~0，Phase 3 换交叉编码器前保持默认关。`)
  if (g('residual') >= 25) s.push(`**未归属（融合/去重/组装）**：约 **${g('residual')}%**（${st.residual.p50}ms/p50，残差法估算）。需 core 在这些块内打点才能细分。`)
  if (!s.length) s.push('各阶段占比都不高，瓶颈较分散；先按上面最小的一档试。')
  return s
}

function render(recs, suggestions) {
  let md = `# 查询 p95 阶段分解（bench/query-profile.mjs；async 引擎）\n\n`
  md += `- 方法：**只读调用 core**；stage 用配对测量取差值；无法归因部分单列 residual。所有 hybridSearch 均 await（兼容 Phase 2 async）。\n`
  md += `- **sync 列 = \`diagnostics.timings.sync\`（查询实付，节流时为 0）**，不是脚本单独调 syncIndex 的假数字；评测前已 \`syncNow(dir)\` 一次并记录 initialSyncMs。\n`
  md += `- 形状：hybridSearch(limit=20, scope=all, expand=parent)；p50/p95/max 单位 ms，share=占该档 total p50。\n\n`
  for (const r of recs) {
    md += `## ${r.size}（${r.samples} 查询，${r.filesWalked} 文件，cold ${r.coldOpenMs}ms，initialSync ${r.initialSyncMs}ms，sync 模式 ${JSON.stringify(r.syncModes)}，候选均 ${r.avgCandidates} 条）\n\n`
    md += `**total：p50 ${r.total.p50}ms · p95 ${r.total.p95}ms · max ${r.total.max}ms**\n\n`
    md += `| 阶段 | p50 | p95 | max | 占 total p50 |\n|---|---|---|---|---|\n`
    for (const [k, v] of Object.entries(r.stages)) md += `| ${k} | ${v.p50} | ${v.p95} | ${v.max} | ${v.share === null ? '-' : v.share + '%'} |\n`
    md += `\n`
  }
  md += `## 1M→3M→10M 增长\n\n| 阶段 | 1M p50 | 3M p50 | 10M p50 | 10M/1M |\n|---|---|---|---|---|\n`
  const keys = ['total', ...Object.keys(recs[0].stages)]
  for (const k of keys) {
    const vals = recs.map((r) => (k === 'total' ? r.total.p50 : r.stages[k]?.p50 ?? 0))
    const ratio = vals[0] ? +(vals[vals.length - 1] / vals[0]).toFixed(1) : null
    md += `| ${k} | ${vals[0]} | ${vals[1] ?? '-'} | ${vals[vals.length - 1]} | ${ratio === null ? '-' : ratio + '×'} |\n`
  }
  md += `\n## 可执行优化建议\n\n${suggestions.map((x) => `- ${x}`).join('\n')}\n\n`
  md += `> 需要改 \`core/**\` 的建议不由本装置执行（写域仅 bench/**）；请 Lead 转派 owner。\n`
  return md
}

async function main() {
  const args = process.argv.slice(2)
  const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d }
  const root = flag('--root', 'D:\\archivist-work\\corpora')
  const sizes = String(flag('--sizes', '1m,3m,10m')).split(',').map((s) => s.trim()).filter(Boolean)
  const samples = Number(flag('--samples', 20))
  if (args.includes('--fts-probe')) { await ftsProbe(root, flag('--probe-size', '10m'), samples); return }
  const out = []
  for (const size of sizes) await profileSize(root, size, samples, out)
  const suggestions = suggest(out)
  const md = render(out, suggestions)
  const mdFile = flag('--md', 'D:\\archivist-work\\eval\\perf-profile.md')
  const jsonFile = flag('--json', 'D:\\archivist-work\\eval\\perf-profile.json')
  if (mdFile) writeFileSync(mdFile, md)
  if (jsonFile) writeFileSync(jsonFile, JSON.stringify({ generatedAt: new Date().toISOString(), root, samples, records: out, suggestions }, null, 2))
  console.log(JSON.stringify({ md: mdFile, json: jsonFile, sizes: out.map((r) => ({ size: r.size, totalP50: r.total.p50, totalP95: r.total.p95, syncShare: r.stages.sync.share, syncModes: r.syncModes, ftsShare: r.stages.fts.share, residualShare: r.stages.residual.share })) }))
}

main().catch((e) => { console.error('query-profile failed:', e); process.exit(1) })
