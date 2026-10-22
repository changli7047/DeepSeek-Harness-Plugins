/**
 * Ablation for the P1/P2 retrieval pipeline (contract §8.4 + Phase-2 dense ruling).
 *
 * Columns: A = delivered口径 (headline; same page any delivered block contains the gold
 * quote, text or parent.text) and D = best-chunk (only the first block of that page).
 * Both are reported per level and per category — the two answer different questions.
 *
 * Levels: sparse chain (lexical→+alias→+exact) plus Phase-2 dense levels:
 *   dense              — dense on, feature rerank off
 *   denseFeatureRerank — dense on + feature rerank (default rerank)
 *   denseCrossRerank   — dense on + cross-encoder rerank; meaningful only in a process
 *                        started with ARCHIVIST_ML_RERANK=1 (env is read by the ML
 *                        sidecar config). Without it the row is marked same-as-⑤.
 * `--levels=a,b,c` renders only requested rows (run twice: with/without RERANK=1).
 * dense rows are N/A when the channel is degraded/empty (never "0 gain → off").
 *
 * Usage:
 *   node bench/ablate.mjs <workspace> <gold.json> [--md report.md] [--json out.json]
 *                         [--levels=lexical,dense,denseFeatureRerank] [--limit 20]
 *                         [--dump hits.json] [--force-sync]
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { evaluate } from './metrics.mjs'

const ALL = { lexical: true, alias: true, exact: true, dense: true }
const SPARSE = { lexical: true, alias: true, exact: true, dense: false }
const CROSS = process.env.ARCHIVIST_ML_RERANK === '1'
const LEVELS = [
  { key: 'lexical', label: '① lexical-only（rerank off）', opts: { channels: { lexical: true, alias: false, exact: false, dense: false }, rerank: false } },
  { key: 'alias', label: '② +alias（rerank off）', opts: { channels: { lexical: true, alias: true, exact: false, dense: false }, rerank: false } },
  { key: 'exact', label: '③ +exact（稀疏全开，rerank off）', opts: { channels: { ...SPARSE }, rerank: false } },
  { key: 'dense', label: '④ lexical+alias+exact+dense（feature rerank off）', opts: { channels: { ...ALL }, rerank: false }, dense: true },
  { key: 'denseFeatureRerank', label: '⑤ dense + feature rerank', opts: { channels: { ...ALL }, rerank: true }, dense: true, production: true },
  { key: 'denseCrossRerank', label: `⑥ dense + cross rerank${CROSS ? '' : '（未开 ARCHIVIST_ML_RERANK=1，与⑤相同）'}`, opts: { channels: { ...ALL }, rerank: true }, dense: true, cross: CROSS },
  { key: 'rerankOnly', label: '⑦ rerank-only（仅 dense 候选）', opts: { channels: { lexical: false, alias: false, exact: false, dense: true }, rerank: true }, dense: true },
  { key: 'rerankOff', label: '⑧ dense off + rerank off（稀疏对照）', opts: { channels: { ...SPARSE }, rerank: false } },
]
const GATES = ['alias', 'exact', 'dense', 'denseFeatureRerank', 'denseCrossRerank']

async function loadEngine() {
  try {
    const m = await import('../core/mod-retrieval.mjs')
    if (typeof m.hybridSearch !== 'function') throw new Error('hybridSearch not exported')
    return { mode: 'hybrid', search: m.hybridSearch, syncNow: m.syncNow, note: `core/mod-retrieval.mjs hybridSearch${m.hybridSearch.constructor?.name === 'AsyncFunction' ? ' (async)' : ''}` }
  } catch (e) {
    const a = await import('../core/archivist.mjs')
    return {
      mode: 'legacy-adapter',
      search: async (dir, q, opts = {}) => {
        const out = String(await a.searchWiki(dir, q, opts.limit || 20, opts.scope || 'wiki'))
        const hits = []
        for (const line of out.split('\n')) {
          const m = /^(\d+)\. \[(\d+)\] (\S+)/.exec(line)
          if (m) hits.push({ path: m[3].replace(/[@#].*$/, ''), text: '', snippet: '', parent: null, score: Number(m[2]) / 100 })
        }
        return { hits: hits.slice(0, opts.limit || 20), diagnostics: { degraded: 'legacy-adapter: ' + (e?.message || e), channels: {} } }
      },
      syncNow: null,
      note: 'legacy adapter over searchWiki（无法做通道消融）',
    }
  }
}

const delta = (a, b) => Math.round((a - b) * 10) / 10

async function main() {
  const args = process.argv.slice(2)
  const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d }
  const pos = args.filter((a, i) => !a.startsWith('--') && !(args[i - 1] || '').startsWith('--'))
  const [dir, goldFile] = pos
  if (!dir || !goldFile) {
    console.error('usage: node bench/ablate.mjs <workspace> <gold.json> [--md report.md] [--json out.json] [--levels=a,b] [--limit 20] [--dump hits.json] [--force-sync]')
    process.exit(2)
  }
  const limit = Number(flag('--limit', 20))
  const forceSync = args.includes('--force-sync')
  const only = String(flag('--levels', '')).split(',').map((s) => s.trim()).filter(Boolean)
  const levels = only.length ? LEVELS.filter((l) => only.includes(l.key)) : LEVELS
  const gold = JSON.parse(readFileSync(goldFile, 'utf8'))
  const engine = await loadEngine()
  if (engine.mode !== 'hybrid') console.error('⚠ 适配层模式：通道开关无效。')
  if (typeof engine.syncNow === 'function') {
    const t = performance.now()
    try { await engine.syncNow(dir) } catch (e) { console.error('warn: syncNow failed: ' + (e?.message || e)) }
    console.error(`# syncNow ${Math.round(performance.now() - t)}ms`)
  }

  const byLevel = {}
  const productionHits = {}
  let denseContributed = false
  let denseDegraded = ''
  const syncModes = {}
  let syncMs = 0
  let degradedCount = 0
  let degradedWhy = ''
  for (const lvl of levels) {
    const byId = {}
    for (const c of gold.cases) {
      const opts = { limit, scope: 'wiki', expand: 'parent', filters: { excludeRetracted: true }, ...(forceSync ? { forceSync: true } : {}), ...lvl.opts }
      let res
      try { res = await engine.search(dir, c.query, opts) } catch (e) { res = { hits: [], diagnostics: { degraded: `search threw: ${e?.message || e}` } } }
      const d = res?.diagnostics || {}
      if (d.degraded) { degradedCount++; degradedWhy = d.degraded }
      if (Number(d.channels?.dense) > 0) denseContributed = true
      if (d.models?.dense?.degraded && !denseDegraded) denseDegraded = String(d.models.dense.degraded).slice(0, 180)
      const tm = d.timings || {}
      if (typeof tm.sync === 'number') syncMs += tm.sync
      const mode = tm.syncMode || (d.throttleActive ? 'throttled' : 'full')
      syncModes[mode] = (syncModes[mode] || 0) + 1
      byId[c.id] = res?.hits || []
      if (lvl.production && !Object.keys(productionHits).length) productionHits[c.id] = byId[c.id]
    }
    byLevel[lvl.key] = evaluate(gold, byId, { limit })
  }
  const denseUsable = denseContributed
  const now = new Date().toISOString()
  const cat = flag('--category', null)
  let md = `# 检索消融表（A=交付口径 headline，D=best-chunk 次要）\n\n`
  md += `- 库: \`${dir}\`\n- 金标: \`${goldFile}\`（${gold.cases.length} 条）\n- 引擎: ${engine.note}\n- 切点: Recall@${limit}；A（任一交付块）/ D（该页首块）\n`
  md += `- 环境: ARCHIVIST_ML_RERANK=${process.env.ARCHIVIST_ML_RERANK ?? '(unset)'}${CROSS ? ' → ⑥ 为真 cross rerank' : ' → ⑥ 与 ⑤ 相同'}\n`
  md += `- sync：${Math.round(syncMs)}ms，模式 ${JSON.stringify(syncModes)}\n`
  md += `- dense：${denseUsable ? '有效参与打分' : `未参与（${denseDegraded || 'channel 0/undefined'}）`}；引擎另有 meta 通道默认开，未单独消融。\n\n`
  md += `| 级 | A 交付 | D best-chunk | ΔA 较上级 | MRR(A) | nDCG@10 | Top-1 | 判定 |\n|---|---|---|---|---|---|---|---|\n`
  let prev = null
  const verdicts = []
  for (const lvl of levels) {
    const o = byLevel[lvl.key].overall
    const denseNA = lvl.dense && !denseUsable
    const d = prev ? delta(o.recallDelivered, prev.recallDelivered) : null
    let verdict = '—'
    if (denseNA) verdict = 'N/A（dense 降级/空）'
    else if (prev && GATES.includes(lvl.key)) {
      if (d >= 1) verdict = `保留（+${d} 点）`
      else { verdict = `**建议默认关闭**（${d > 0 ? '+' : ''}${d} 点 < 1）`; verdicts.push(`${lvl.key}：A ${d > 0 ? '+' : ''}${d} 点 (D ${delta(o.recallBestChunk, prev.recallBestChunk)})`) }
    }
    if (!denseNA && GATES.includes(lvl.key) && cat) {
      const cur = byLevel[lvl.key].byCategory[cat]
      const pv = prev.byCategory[cat]
      if (cur && pv) verdict += `〔${cat} A ${delta(cur.recallDelivered, pv.recallDelivered)} / D ${delta(cur.recallBestChunk, pv.recallBestChunk)}〕`
    }
    md += `| ${lvl.label} | ${o.recallDelivered}% | ${o.recallBestChunk}% | ${d === null || denseNA ? '—' : (d > 0 ? '+' : '') + d} | ${o.mrr} | ${o.ndcgAt10} | ${o.top1Page}% | ${verdict} |\n`
    prev = o
  }
  md += `\n## 按类别（A 交付 / D best-chunk）\n\n| 类别 | 条数 | ${levels.map((l) => l.key).join(' | ')} |\n|---|---|${levels.map(() => '---').join('|')}|\n`
  const cats = Object.keys(byLevel[levels[0].key].byCategory)
  for (const k of cats) {
    const n = byLevel[levels[0].key].byCategory[k].cases
    md += `| ${k} | ${n} | ${levels.map((l) => { const v = byLevel[l.key].byCategory[k]; return v ? `${v.recallDelivered}/${v.recallBestChunk}` : '-' }).join(' | ')} |\n`
  }
  const base = byLevel[levels[levels.length - 1].key].cases.filter((c) => c.answerable && !c.recallDelivered)
  if (base.length) {
    md += `\n## 末档仍未交付（${base.length} 条）\n\n| id | 类别 | 查询 |\n|---|---|---|\n`
    for (const c of base) md += `| ${c.id} | ${c.category} | ${String(c.query).replace(/\|/g, '/').slice(0, 46)} |\n`
  }
  md += `\n## 结论\n\n${verdicts.length ? verdicts.map((v) => `- ${v}`).join('\n') : '- 各级均有 ≥1 点增益。'}\n`
  if (!denseUsable) md += `- dense 档位无有效结论（${denseDegraded || 'channel 0'}），建好向量后重跑。\n`

  const mdFile = flag('--md', null)
  const jsonFile = flag('--json', null)
  if (mdFile) writeFileSync(mdFile, md)
  if (jsonFile) writeFileSync(jsonFile, JSON.stringify({ generatedAt: now, workspace: dir, goldFile, engine: engine.mode, limit, crossRerank: CROSS, denseUsable, denseDegraded, syncModes, syncMs: Math.round(syncMs), degradedCount, degradedWhy, byLevel, verdicts }, null, 2))
  const dump = flag('--dump', null)
  if (dump) writeFileSync(dump, JSON.stringify({ engine: engine.mode, goldFile, limit, cases: Object.entries(productionHits).map(([id, hits]) => ({ id, hits })) }, null, 2))
  console.log(JSON.stringify({
    engine: engine.mode, denseUsable, crossRerank: CROSS, levels: levels.map((l) => l.key),
    A: Object.fromEntries(levels.map((l) => [l.key, byLevel[l.key].overall.recallDelivered])),
    D: Object.fromEntries(levels.map((l) => [l.key, byLevel[l.key].overall.recallBestChunk])),
    mrr: Object.fromEntries(levels.map((l) => [l.key, byLevel[l.key].overall.mrr])),
  }))
}

main().catch((e) => { console.error('ablate failed:', e); process.exit(1) })
