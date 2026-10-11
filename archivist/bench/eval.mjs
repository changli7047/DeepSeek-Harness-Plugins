/**
 * Category-aware retrieval evaluator for archivist.
 *
 * Runs a golden eval set (bench/make-eval.mjs output, editable by hand) against
 * a workspace and reports Top-1 / Top-3 / count / correction behavior per
 * category, with a regression gate (non-zero exit below thresholds).
 *
 * Modes: top1 | top3 | top3all | nomatch | count | annotated
 * Usage: node bench/eval.mjs <workspaceDir> [eval-set.json] [report.md]
 * Env:   EVAL_MIN_TOP1 (default 0.9), EVAL_MIN_OVERALL (default 0.8)
 */
import { searchWiki, scanCorpus } from '../core/archivist.mjs'
import { readFileSync, writeFileSync } from 'node:fs'

const dir = process.argv[2]
const setFile = process.argv[3] || 'eval-set.json'
const reportFile = process.argv[4] || 'eval-report.md'
if (!dir) { console.error('usage: node bench/eval.mjs <workspaceDir> [eval-set.json] [reportFile]'); process.exit(1) }

const set = JSON.parse(readFileSync(setFile, 'utf8'))
const minTop1 = Number(process.env.EVAL_MIN_TOP1 ?? 0.9)
const minOverall = Number(process.env.EVAL_MIN_OVERALL ?? 0.8)

const results = []
for (const c of set.cases) {
  let pass = false
  let detail = ''
  try {
    if (c.mode === 'count') {
      const out = scanCorpus(dir, c.query, c.scope || 'all')
      const m = /total occurrences: (\d+)/.exec(out)
      const got = m ? Number(m[1]) : -1
      pass = got === Number(c.expect)
      detail = `count=${got} (expected ${c.expect})`
    } else if (c.mode === 'nomatch') {
      const out = String(searchWiki(dir, c.query, c.limit || 10, c.scope || 'wiki'))
      pass = out.includes('no match')
      detail = pass ? 'no match — correct' : out.split('\n')[0]
    } else if (c.mode === 'annotated') {
      const out = String(searchWiki(dir, c.query, 10, c.scope || 'wiki'))
      const lines = out.split('\n').filter((l) => /^\d+\. \[/.test(l)).slice(0, 3)
      const hit = lines.find((l) => (c.expect || ['已被']).some((e) => l.includes(e))) || ''
      pass = hit !== ''
      detail = (hit || lines[0] || '(no match)').slice(0, 100)
    } else {
      const out = String(searchWiki(dir, c.query, 10, c.scope || 'wiki'))
      const lines = out.split('\n').filter((l) => /^\d+\. \[/.test(l))
      const take = c.mode === 'top1' ? lines.slice(0, 1) : lines.slice(0, 3)
      const joined = take.join('\n')
      const expect = Array.isArray(c.expect) ? c.expect : [String(c.expect)]
      pass = c.mode === 'top3all'
        ? expect.every((e) => joined.includes(e))
        : expect.some((e) => joined.includes(e))
      detail = (take[0] || '(no match)').slice(0, 110)
    }
  } catch (error) {
    pass = false
    detail = 'error: ' + String(error instanceof Error ? error.message : error).slice(0, 90)
  }
  results.push({ ...c, pass, detail })
}

const cats = {}
for (const r of results) {
  const c = cats[r.category] || (cats[r.category] = { pass: 0, total: 0 })
  c.total++
  if (r.pass) c.pass++
}
const overall = results.filter((r) => r.pass).length
const top1Cases = results.filter((r) => r.mode === 'top1')
const top1Rate = top1Cases.length ? top1Cases.filter((r) => r.pass).length / top1Cases.length : 1

let md = `# 检索评测报告\n\n- 库: \`${dir}\`\n- 评测集: ${setFile}（${results.length} 用例，生成于 ${set.generatedAt || 'n/a'}）\n\n`
md += `| 类别 | 通过/总数 | 通过率 |\n|---|---|---|\n`
for (const [k, v] of Object.entries(cats)) md += `| ${k} | ${v.pass}/${v.total} | ${Math.round((v.pass / v.total) * 100)}% |\n`
md += `| **总计** | **${overall}/${results.length}** | **${Math.round((overall / results.length) * 100)}%** |\n`
md += `\nTop-1 严格命中率（lookup/phrase 类）: **${Math.round(top1Rate * 100)}%**\n\n## 明细\n\n`
md += `| # | 类别 | 查询 | 结果 | 详情 |\n|---|---|---|---|---|\n`
const esc = (s) => String(s).replace(/\|/g, '/').replace(/\s+/g, ' ')
for (const r of results) md += `| ${r.id} | ${r.category} | ${esc(r.query).slice(0, 40)} | ${r.pass ? '✅' : '❌'} | ${esc(r.detail).slice(0, 110)} |\n`
writeFileSync(reportFile, md)

const summary = {
  total: `${overall}/${results.length}`,
  overall: Math.round((overall / results.length) * 100) + '%',
  top1: Math.round(top1Rate * 100) + '%',
  byCategory: Object.fromEntries(Object.entries(cats).map(([k, v]) => [k, `${v.pass}/${v.total}`])),
  gate: top1Rate >= minTop1 && overall / results.length >= minOverall ? 'PASS' : 'FAIL',
  report: reportFile,
}
console.log(JSON.stringify(summary))
if (summary.gate === 'FAIL') process.exitCode = 1
