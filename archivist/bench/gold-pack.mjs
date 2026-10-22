/**
 * Evidence-pack evaluator — the口径 the P1/P2 doc gates on (contract §4 Retrieval / §5):
 * gold spans must be delivered into `buildEvidencePack(dir, query).blocks[].text`.
 *
 * Two pack hit rules (same ruling as metrics.mjs):
 *   A delivered (headline) — any delivered block of the gold page contains the quote.
 *   D best-block (secondary) — only the FIRST delivered block of that page counts.
 *
 * Dense两档: `--dense on|off` forwards `channels:{dense}` to hybridSearch through
 * buildEvidencePack (impl-tools added channel forwarding). Default = engine auto.
 * Abstention: pack.diagnostics.sufficient===false; blocks.length===0 is the fallback.
 * All engine calls awaited; `syncNow` runs once before scoring.
 *
 * Usage:
 *   node bench/gold-pack.mjs <workspace> <gold.json> [--md report.md] [--json out.json]
 *        [--dense on|off|auto] [--maxTokens 24000]
 *   node bench/gold-pack.mjs --scale --corpora <root> [--sizes 1m,3m,10m] [--md scale.md]
 */
import { readFileSync, writeFileSync, statSync } from 'node:fs'
import path from 'node:path'

const norm = (s) => String(s ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()
const normPath = (p) => norm(String(p ?? '').replace(/\\/g, '/')).replace(/^\.\//, '')
const pct = (x) => Math.round(x * 1000) / 10
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
const quantile = (arr, q) => { if (!arr.length) return 0; const a = [...arr].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(a.length * q))] }

async function loadPack() {
  const m = await import('../core/mod-evidence.mjs')
  if (typeof m.buildEvidencePack !== 'function') throw new Error('buildEvidencePack not exported')
  return m.buildEvidencePack
}

function blockHasQuote(b, anchor) {
  if (normPath(b.path) !== normPath(anchor.path)) return false
  if (!anchor.quote) return true
  return norm(b.text).includes(norm(anchor.quote))
}

async function packEval(gold, buildEvidencePack, dir, opts) {
  const rows = []
  for (const c of gold.cases) {
    const t0 = performance.now()
    let pack
    try {
      const callOpts = { maxTokens: opts.maxTokens, forceSync: true }
      if (opts.channels) callOpts.channels = opts.channels
      pack = await buildEvidencePack(dir, c.query, callOpts)
    } catch (e) {
      pack = { blocks: [], tokens: 0, diagnostics: { sufficient: false, sufficientReason: String(e?.message || e) } }
    }
    const ms = performance.now() - t0
    const blocks = pack.blocks || []
    const anchors = c.goldAnchors || []
    const firstByPath = new Map()
    for (const b of blocks) {
      const p = normPath(b.path)
      if (!firstByPath.has(p)) firstByPath.set(p, b)
    }
    const delivered = anchors.length > 0 && anchors.some((a) => blocks.some((b) => blockHasQuote(b, a)))
    const bestBlock = anchors.length > 0 && anchors.some((a) => firstByPath.has(normPath(a.path)) && blockHasQuote(firstByPath.get(normPath(a.path)), a))
    const pageHit = anchors.length > 0 && anchors.some((a) => blocks.some((b) => normPath(b.path) === normPath(a.path)))
    const diag = pack.diagnostics || {}
    const hasSufficient = typeof diag.sufficient === 'boolean'
    const abstained = hasSufficient ? diag.sufficient === false : blocks.length === 0
    rows.push({
      id: c.id, category: c.category, answerable: c.answerable !== false,
      delivered, bestBlock, pageHit, abstained, hasSufficient,
      sufficientReason: diag.sufficientReason || null,
      topScore: diag.topScore ?? null, scoreThreshold: diag.scoreThreshold ?? null,
      denseBlocks: Number(diag.channels?.dense) || 0,
      tokens: pack.tokens || 0, blocks: blocks.length, ms,
    })
  }
  const ans = rows.filter((r) => r.answerable)
  const unans = rows.filter((r) => !r.answerable)
  const cat = {}
  for (const r of ans) (cat[r.category] ||= []).push(r)
  return {
    overall: {
      cases: rows.length, answerable: ans.length, unanswerable: unans.length,
      sufficientField: rows.some((r) => r.hasSufficient),
      packRecall: pct(mean(ans.map((r) => (r.delivered ? 1 : 0)))),        // A headline
      packRecallBestBlock: pct(mean(ans.map((r) => (r.bestBlock ? 1 : 0)))), // D secondary
      packPageRecall: pct(mean(ans.map((r) => (r.pageHit ? 1 : 0)))),
      avgTokens: Math.round(mean(rows.map((r) => r.tokens))),
      avgBlocks: Math.round(mean(rows.map((r) => r.blocks))),
      p50Ms: +quantile(rows.map((r) => r.ms), 0.5).toFixed(1),
      p95Ms: +quantile(rows.map((r) => r.ms), 0.95).toFixed(1),
      correctAbstain: unans.length ? pct(mean(unans.map((r) => (r.abstained ? 1 : 0)))) : null,
      falseReject: ans.length ? pct(mean(ans.map((r) => (r.abstained ? 1 : 0)))) : null,
      packsWithDense: rows.filter((r) => r.denseBlocks > 0).length,
    },
    byCategory: Object.fromEntries(Object.entries(cat).map(([k, v]) => [k, {
      n: v.length,
      A: pct(mean(v.map((r) => (r.delivered ? 1 : 0)))),
      D: pct(mean(v.map((r) => (r.bestBlock ? 1 : 0)))),
      avgTokens: Math.round(mean(v.map((r) => r.tokens))),
    }])),
    rows,
  }
}

async function main() {
  const args = process.argv.slice(2)
  const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d }
  const pos = args.filter((a, i) => !a.startsWith('--') && !(args[i - 1] || '').startsWith('--'))
  const maxTokens = Number(flag('--maxTokens', 24000))
  const denseFlag = String(flag('--dense', 'auto')).toLowerCase()
  const channels = denseFlag === 'on' ? { dense: true } : denseFlag === 'off' ? { dense: false } : undefined
  const mdFile = flag('--md', null)
  const jsonFile = flag('--json', null)
  const { syncNow } = await import('../core/mod-retrieval.mjs')

  if (args.includes('--scale')) {
    const root = flag('--corpora', 'D:\\archivist-work\\corpora')
    const sizes = String(flag('--sizes', '1m,3m,10m')).split(',').map((s) => s.trim()).filter(Boolean)
    const { hybridSearch } = await import('../core/mod-retrieval.mjs')
    const out = []
    for (const size of sizes) {
      const dir = path.join(root, size)
      const goldFile = path.join(root, `gold-needles-${size}.json`)
      const gold = JSON.parse(readFileSync(goldFile, 'utf8'))
      const tSync = performance.now()
      try { await syncNow(dir) } catch (e) { console.error(`syncNow failed for ${size}: ${e?.message || e}`) }
      const syncMs = +(performance.now() - tSync).toFixed(0)
      let coldMs = 0
      const times = []
      const hitsOk = []
      for (let i = 0; i < gold.cases.length; i++) {
        const c = gold.cases[i]
        const t0 = performance.now()
        const res = await hybridSearch(dir, c.query, { limit: 20, scope: 'all', expand: 'parent', filters: { excludeRetracted: true }, ...(channels || {}), ...(i === 0 ? { forceSync: true } : {}) })
        const ms = performance.now() - t0
        if (i === 0) coldMs = ms; else times.push(ms)
        const hits = res.hits || []
        const a = c.goldAnchors[0]
        hitsOk.push(hits.some((h) => normPath(h.path) === normPath(a.path) && (norm(h.text).includes(norm(a.quote)) || (h.parent?.text && norm(h.parent.text).includes(norm(a.quote))))))
      }
      const dbBytes = (() => { try { return statSync(path.join(dir, '.index', 'archivist.db')).size } catch { return null } })()
      const row = {
        size, dir, needles: gold.cases.length, dense: denseFlag, syncMs,
        coldMs: +coldMs.toFixed(0),
        p50Ms: +quantile(times, 0.5).toFixed(1), p95Ms: +quantile(times, 0.95).toFixed(1),
        avgMs: +mean(times).toFixed(1), maxMs: +(times.length ? Math.max(...times) : 0).toFixed(1),
        needleRecall20: pct(mean(hitsOk.map((x) => (x ? 1 : 0)))),
        dbMB: dbBytes ? +(dbBytes / 1048576).toFixed(1) : null,
      }
      out.push(row)
      console.log(JSON.stringify(row))
    }
    if (mdFile) {
      let md = `# 合成语料规模曲线（bench/gold-pack.mjs --scale --dense ${denseFlag}；查询前 syncNow）\n\n| 规模 | 针数 | dense | syncNow ms | 首查 ms | p50 | p95 | avg | max | Recall@20 | db MB |\n|---|---|---|---|---|---|---|---|---|---|---|\n`
      for (const r of out) md += `| ${r.size} | ${r.needles} | ${r.dense} | ${r.syncMs} | ${r.coldMs} | ${r.p50Ms} | ${r.p95Ms} | ${r.avgMs} | ${r.maxMs} | ${r.needleRecall20}% | ${r.dbMB ?? '-'} |\n`
      writeFileSync(mdFile, md)
    }
    if (jsonFile) writeFileSync(jsonFile, JSON.stringify(out, null, 2))
    return
  }

  const [dir, goldFile] = pos
  if (!dir || !goldFile) {
    console.error('usage: node bench/gold-pack.mjs <workspace> <gold.json> [--md report.md] [--json out.json] [--dense on|off|auto] [--maxTokens 24000]')
    console.error('   or: node bench/gold-pack.mjs --scale --corpora <root> [--sizes 1m,3m,10m] [--dense on|off] [--md scale.md]')
    process.exit(2)
  }
  const gold = JSON.parse(readFileSync(goldFile, 'utf8'))
  const tSync = performance.now()
  try { await syncNow(dir) } catch { /* degraded below via empty packs */ }
  const syncMs = +(performance.now() - tSync).toFixed(0)
  const buildEvidencePack = await loadPack()
  const res = await packEval(gold, buildEvidencePack, dir, { maxTokens, channels })
  const o = res.overall
  const allEmpty = res.rows.filter((r) => r.answerable).every((r) => r.blocks === 0)
  const asyncMismatch = allEmpty && o.packRecall === 0
  let md = `# 证据包口径评测（A=交付 headline，D=页首块；dense ${denseFlag}）\n\n`
  md += `- 库: \`${dir}\`\n- 金标: \`${goldFile}\`（${o.cases} 条）\n- 预算 maxTokens=${maxTokens}；评测前 syncNow ${syncMs}ms；dense 档=${denseFlag}\n`
  md += `- 弃权：\`diagnostics.sufficient===false\`（${o.sufficientField ? '字段已提供' : '未提供 → 回退 blocks.length===0'}）\n`
  md += `- dense 证据块：${o.packsWithDense}/${o.cases} 个 pack 的 channels.dense>0\n`
  if (asyncMismatch) md += `> ⚠ 全部可回答问题 0 块：疑似 async/转发接口错配，本报告无效。\n`
  md += `\n| 指标 | 值 |\n|---|---|\n`
  md += `| **pack Recall@20 — A 交付** | **${o.packRecall}%** |\n`
  md += `| **pack Recall@20 — D 页首块（次要）** | **${o.packRecallBestBlock}%** |\n`
  md += `| pack 页面出现率（C） | ${o.packPageRecall}% |\n`
  md += `| pack 平均 token / 块数 | ${o.avgTokens} / ${o.avgBlocks} |\n`
  md += `| pack p50 / p95 ms | ${o.p50Ms} / ${o.p95Ms} |\n`
  md += `| **不可回答·正确弃权率** | **${o.correctAbstain === null ? '-' : o.correctAbstain + '%'}** |\n`
  md += `| **可回答·误拒率** | **${o.falseReject === null ? '-' : o.falseReject + '%'}** |\n\n`
  md += `## 按类别（A / D）\n\n| 类别 | 条数 | A 交付 | D 页首块 | 平均 token |\n|---|---|---|---|---|\n`
  for (const [k, v] of Object.entries(res.byCategory)) md += `| ${k} | ${v.n} | ${v.A}% | ${v.D}% | ${v.avgTokens} |\n`
  const unans = res.rows.filter((r) => !r.answerable)
  if (unans.length) {
    md += `\n## 不可回答 ${unans.length} 条逐条\n\n| id | 弃权 | sufficient | topScore | 阈值 | 理由 |\n|---|---|---|---|---|---|\n`
    for (const r of unans) md += `| ${r.id} | ${r.abstained ? '✅' : '❌'} | ${r.hasSufficient ? '有' : '回退'} | ${r.topScore ?? '-'} | ${r.scoreThreshold ?? '-'} | ${String(r.sufficientReason || '').replace(/\|/g, '/').slice(0, 60)} |\n`
  }
  const miss = res.rows.filter((r) => r.answerable && !r.delivered)
  if (miss.length) {
    md += `\n## 未交付的 gold（${miss.length} 条）\n\n| id | 类别 | 查询 |\n|---|---|---|\n`
    for (const r of miss) md += `| ${r.id} | ${r.category} | ${String(gold.cases.find((c) => c.id === r.id)?.query || '').replace(/\|/g, '/').slice(0, 50)} |\n`
  }
  if (mdFile) writeFileSync(mdFile, md)
  if (jsonFile) writeFileSync(jsonFile, JSON.stringify({ ...res, maxTokens, syncMs, dense: denseFlag, asyncMismatch }, null, 2))
  console.log(JSON.stringify({
    mode: 'pack', gold: goldFile, dense: denseFlag, cases: o.cases,
    A_packRecall: o.packRecall, D_packRecall: o.packRecallBestBlock, C_page: o.packPageRecall,
    avgTokens: o.avgTokens, p50Ms: o.p50Ms, p95Ms: o.p95Ms,
    correctAbstain: o.correctAbstain, falseReject: o.falseReject, packsWithDense: o.packsWithDense,
  }))
}

main().catch((e) => { console.error('gold-pack failed:', e); process.exit(1) })
