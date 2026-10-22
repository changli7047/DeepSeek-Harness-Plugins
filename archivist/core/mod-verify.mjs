// mod-verify.mjs — Phase 1 引用核验（p1-contract §6）。owner: impl-tools
// 核验独立于索引：只用 node:fs 直接读文件 + node:crypto 算整文件 sha256，
// 绝不复用 .index 里的文本/状态——索引漂移（未同步 / 旧 chunk / 库损坏）不得掩盖引用的真伪。
// 本阶段限制：只做字符串存在性 / 锚点版本 / retract-supersede 状态核验，**不做 NLI / 蕴含判定**；
// 也不校验 chunk 边界是否与真实分块一致（那需要索引或重新分块，与"独立于索引"冲突）。
// v2 命名空间规则：本模块所有内部辅助符号统一带 vf_ 前缀。
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { parseAnchor } from './mod-chunks.mjs'

const vf_QUOTE_WARN_LEN = 8

/** 归一化：NFC + 全角→半角 + 去零宽 + 小写 + 空白折叠。 */
function vf_norm(s) {
  if (typeof s !== 'string') return ''
  return s
    .normalize('NFC')
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, ' ')
    .replace(/[\u00AD\u200B-\u200D\u2060\uFEFF]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

/** 剥离 frontmatter，返回正文（偏移与 core/parsePage 的 body 口径一致）。 */
function vf_splitFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!m) return { body: text, fm: '' }
  return { body: text.slice(m[0].length), fm: m[1] }
}

function vf_fmField(fm, key) {
  if (!fm) return ''
  const m = new RegExp('^' + key + ':\\s*(.*)$', 'm').exec(fm)
  if (!m) return ''
  return m[1].replace(/\s+#.*$/, '').trim().replace(/^["']|["']$/g, '').trim()
}

/** 工作区相对路径的安全解析：拒绝绝对路径、`..`、越界。 */
function vf_resolve(dir, relRaw) {
  if (typeof relRaw !== 'string') return null
  const rel = relRaw.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')
  if (!rel) return null
  if (rel.split('/').includes('..')) return null
  const base = path.resolve(dir)
  const abs = path.resolve(base, rel)
  if (abs !== base && !abs.startsWith(base + path.sep)) return null
  return { rel, abs }
}

/** 从 citation 解析目标：anchor（path@sha8#cN[s:e]）优先，其次 path / span。 */
function vf_targetOf(c) {
  const out = { anchorStr: '', path: '', sha8: '', ord: null, span: null, anchorParsed: false }
  if (typeof c.anchor === 'string' && c.anchor.trim()) {
    out.anchorStr = c.anchor.trim()
    let p = null
    try { p = parseAnchor(out.anchorStr) } catch { p = null }
    if (p && typeof p.path === 'string' && p.path) {
      out.anchorParsed = true
      out.path = p.path
      out.sha8 = typeof p.sha8 === 'string' ? p.sha8.toLowerCase() : ''
      if (p.ord != null && Number.isFinite(Number(p.ord))) out.ord = Math.trunc(Number(p.ord))
      const s = Number(p.start)
      const e = Number(p.end)
      if (Number.isFinite(s) && Number.isFinite(e) && e > s) out.span = [Math.trunc(s), Math.trunc(e)]
    }
  }
  if (!out.path && typeof c.path === 'string' && c.path.trim()) out.path = c.path.trim()
  if (!out.span) {
    const sp = c.span
    let s
    let e
    if (Array.isArray(sp)) { s = Number(sp[0]); e = Number(sp[1]) }
    else if (sp && typeof sp === 'object') { s = Number(sp.start); e = Number(sp.end) }
    if (Number.isFinite(s) && Number.isFinite(e) && e > s) out.span = [Math.trunc(s), Math.trunc(e)]
  }
  return out
}

function vf_verifyOne(dir, c, index, strict) {
  const id = c && c.id != null && c.id !== '' ? String(c.id) : `C${index + 1}`
  const checks = { exists: false, anchorValid: false, quoteFound: false, spanMatch: false, notRetracted: true, notSuperseded: true }
  const reasons = []
  const warnings = []
  const t = vf_targetOf(c)
  const finish = (ok) => ({ id, ok, checks, reasons, warnings, target: t.anchorStr || t.path || '' })

  if (!t.path) {
    reasons.push('citation 缺少 anchor.path 或 path')
    return finish(false)
  }
  if (t.anchorStr && !t.anchorParsed) reasons.push(`anchor 无法解析: ${t.anchorStr}`)
  checks.anchorValid = !t.anchorStr || t.anchorParsed

  const loc = vf_resolve(dir, t.path)
  if (!loc) {
    reasons.push(`path 越出工作区或非法: ${t.path}`)
    return finish(false)
  }
  let buf
  try {
    buf = readFileSync(loc.abs)
  } catch {
    reasons.push(`file not found: ${t.rel}`)
    return finish(false)
  }
  checks.exists = true
  const text = buf.toString('utf8')
  const { body, fm } = vf_splitFrontmatter(text)
  const curSha8 = createHash('sha256').update(buf).digest('hex').slice(0, 8)

  // 锚点版本：sha8 必须等于当前文件哈希（防"引用了早已改写的旧版本"）。
  if (t.sha8 && t.sha8 !== curSha8) {
    checks.anchorValid = false
    reasons.push(`anchor version mismatch: ${t.sha8} != current ${curSha8}`)
  }

  const status = vf_fmField(fm, 'status').toLowerCase()
  if (status === 'retracted') {
    checks.notRetracted = false
    const why = vf_fmField(fm, 'retractReason') || vf_fmField(fm, 'retract_reason')
    reasons.push(`target retracted${why ? ` (${why})` : ''}`)
  } else if (status === 'superseded') {
    checks.notSuperseded = false
    const by = vf_fmField(fm, 'superseded_by') || vf_fmField(fm, 'supersededBy')
    const msg = `target superseded${by ? ` → ${by}` : ''}`
    if (strict) reasons.push(msg)
    else warnings.push(`${msg}（非严格模式，仅告警）`)
  }

  if (t.ord != null && !t.span) {
    warnings.push(`anchor 只有 ord(#c${t.ord}) 没有 [start:end]：不读索引就无法定位 chunk，只能按整页 body 核验`)
  }

  // cited 文本：锚点/citation 的 span 切片；无 span 则整页 body。
  let citedText = body
  let spanOk = true
  if (t.span) {
    const [s, e] = t.span
    if (s < 0 || e > body.length || e <= s) {
      spanOk = false
      reasons.push(`span [${s}:${e}] out of range for body length ${body.length}`)
    } else {
      citedText = body.slice(s, e)
    }
  }
  checks.spanMatch = spanOk

  const quoteNorm = vf_norm(typeof c.quote === 'string' ? c.quote : '')
  if (!quoteNorm) {
    checks.quoteFound = false
    reasons.push('quote is empty')
  } else if (!spanOk) {
    checks.quoteFound = false
    reasons.push('cannot locate cited span: span invalid')
  } else {
    checks.quoteFound = vf_norm(citedText).includes(quoteNorm)
    if (!checks.quoteFound) {
      if (t.span) {
        reasons.push(`quote not found in span [${t.span[0]}:${t.span[1]}]`)
        if (vf_norm(body).includes(quoteNorm)) reasons.push('quote occurs in the page body but outside the cited span')
      } else {
        reasons.push('quote not found in page body')
      }
    } else if (quoteNorm.length < vf_QUOTE_WARN_LEN) {
      warnings.push(`short quote (${quoteNorm.length} 个归一化字符)：证据强度弱`)
    }
  }

  const ok = checks.exists && checks.anchorValid && checks.quoteFound && checks.spanMatch
    && checks.notRetracted && (strict ? checks.notSuperseded : true)
  return finish(ok)
}

export function verifyCitations(dir, citations, opts = {}) {
  const strict = opts.strict !== false
  let list = citations
  if (typeof list === 'string') {
    try {
      list = JSON.parse(list)
    } catch (err) {
      throw new Error(`citations 不是合法 JSON: ${err && err.message ? err.message : err}`)
    }
  }
  if (!Array.isArray(list)) throw new Error('citations 必须是数组，或 JSON 数组字符串')
  const results = list.map((c, i) => vf_verifyOne(dir, c && typeof c === 'object' ? c : {}, i, strict))
  const passed = results.filter((r) => r.ok).length
  const warnings = results.reduce((n, r) => n + r.warnings.length, 0)
  return { results, summary: { total: results.length, passed, failed: results.length - passed, warnings } }
}

/** 核验表（供 archivist_verify 工具输出）；summary 省略时按 results 现算。 */
export function formatVerifyReport(results, summary) {
  const lines = ['| 引用 | 结果 | 目标 | 原因 / 告警 |', '|---|---|---|---|']
  for (const r of results) {
    const notes = [...r.reasons, ...r.warnings.map((w) => '⚠ ' + w)].join('；')
    const cell = (s) => String(s == null ? '' : s).replace(/\|/g, '\\|')
    lines.push(`| ${cell(r.id)} | ${r.ok ? '✅ 通过' : '❌ 失败'} | ${cell(r.target)} | ${cell(notes) || '—'} |`)
  }
  const s = summary || { total: results.length, passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, warnings: results.reduce((n, r) => n + r.warnings.length, 0) }
  lines.push('', `summary: ${s.total} 条，通过 ${s.passed}，失败 ${s.failed}，告警 ${s.warnings}（只做字符串/版本/状态核验，不做语义蕴含判断）`)
  return lines.join('\n')
}
