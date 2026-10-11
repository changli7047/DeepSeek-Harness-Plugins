/**
 * Large-library query benchmark for the llm-wiki search path.
 * Usage: node bench-queries.mjs <workspaceDir> <reportFile>
 * Runs a fixed query battery (CJK / English / mixed) at scope=raw and writes
 * a UTF-8 markdown report with per-query latencies and top hits.
 */
import { searchWiki, listSources } from '../core/llm-wiki.mjs'
import { writeFileSync, statSync } from 'node:fs'
import { readdirSync } from 'node:fs'
import path from 'node:path'

const dir = process.argv[2]
const reportFile = process.argv[3] || 'bench-report.md'
if (!dir) { console.error('usage: node bench-queries.mjs <workspaceDir> <reportFile>'); process.exit(1) }

const battery = [
  '死锁', '虚拟内存', '进程调度', '页面置换算法',
  'TCP 三次握手', 'HTTP 状态码', 'HTTPS 加密', 'TCP/IP',
  'MySQL 索引', '事务隔离级别', 'Redis 缓存',
  'JVM 垃圾回收', 'synchronized 锁', 'HashMap',
  '动态规划', '二分查找', '消息队列', 'CORS 跨域',
  'B+ Tree', 'O(log n)',
]
const rounds = 3

const walkBytes = (root) => {
  let bytes = 0, files = 0
  const stack = ['']
  while (stack.length) {
    const rel = stack.pop()
    const cur = rel ? path.join(root, rel) : root
    let entries
    try { entries = readdirSync(cur, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      const childRel = rel ? rel + '/' + e.name : e.name
      if (e.isDirectory()) { stack.push(childRel); continue }
      if (!/\.(md|txt)$/i.test(e.name)) continue
      try { bytes += statSync(path.join(cur, e.name)).size; files++ } catch { }
    }
  }
  return { files, bytes }
}

const raw = walkBytes(path.join(dir, 'raw'))
let t0 = performance.now()
const sourceCount = listSources(dir).length
const msSources = performance.now() - t0

const rows = []
for (const q of battery) {
  const times = []
  let top = []
  for (let r = 0; r < rounds; r++) {
    const start = performance.now()
    const out = String(searchWiki(dir, q, 10, 'raw'))
    times.push(performance.now() - start)
    if (r === rounds - 1) {
      if (out.includes('no match')) top = ['(no match)']
      else {
        top = out.split('\n').filter((l) => /^\d+\. \[/.test(l)).slice(0, 3)
          .map((l) => l.replace(/\s+/g, ' ').slice(0, 110))
      }
    }
  }
  rows.push({ q, times, best: Math.min(...times), top })
}

const warm = rows.flatMap((r) => r.times.slice(1)).sort((a, b) => a - b)
const all = rows.flatMap((r) => r.times).sort((a, b) => a - b)
const pct = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(arr.length * p))]
const stats = {
  dir,
  files: raw.files,
  mb: +(raw.bytes / 1048576).toFixed(2),
  tokensEstimate: Math.round(raw.bytes / 3.3),
  sources: sourceCount,
  msSources: +msSources.toFixed(1),
  queries: battery.length,
  rounds,
  warmAvgMs: +(warm.reduce((a, b) => a + b, 0) / warm.length).toFixed(1),
  warmP50Ms: +pct(warm, 0.5).toFixed(1),
  warmP95Ms: +pct(warm, 0.95).toFixed(1),
  warmMaxMs: +warm[warm.length - 1].toFixed(1),
  allAvgMs: +(all.reduce((a, b) => a + b, 0) / all.length).toFixed(1),
}

let md = `# LLM Wiki 大库查询基准报告\n\n`
md += `- 库路径: \`${dir}\`\n`
md += `- 原始文件: **${stats.files} 个 / ${stats.mb} MB**（估算 ≈ ${(stats.tokensEstimate / 1000).toFixed(0)}K token）\n`
md += `- 查询: ${stats.queries} 条 × ${stats.rounds} 轮（scope=raw，每次全库扫描）\n`
md += `- 热身轮后延迟: **avg ${stats.warmAvgMs} ms | p50 ${stats.warmP50Ms} ms | p95 ${stats.warmP95Ms} ms | max ${stats.warmMaxMs} ms**\n`
md += `- 含冷启动: avg ${stats.allAvgMs} ms\n`
md += `- wiki_sources 全量哈希扫描: ${stats.msSources} ms\n\n`
md += `| # | 查询 | best ms | Top 命中 |\n|---|---|---|---|\n`
rows.forEach((r, i) => {
  md += `| ${i + 1} | ${r.q} | ${r.best.toFixed(1)} | ${r.top.map((t) => t.replace(/\|/g, '/')).join('<br>')} |\n`
})
writeFileSync(reportFile, md)
console.log(JSON.stringify(stats))
