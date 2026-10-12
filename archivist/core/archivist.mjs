/**
 * archivist core — single source of truth for the archivist plugin (zero dependencies).
 *
 * Plain ESM JavaScript so it runs directly with `node core/archivist.mjs <tool> '<json>'`
 * (host-independent self-test) and can be embedded into the OpenCode / dsh plugin
 * adapters by the build script.
 *
 * Design: the plugin owns the deterministic parts (scaffold / search / lint / index /
 * log / backup / git-optional commit); the host agent owns reading, writing and
 * synthesis. No network, no API keys, no external services.
 */

import { createHash } from 'node:crypto'
import {
  copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync,
  rmSync, statSync, writeFileSync,
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// ---------------------------------------------------------------- constants

export const PAGE_DIRS = ['sources', 'entities', 'concepts', 'syntheses']
const TYPE_BY_DIR = { sources: 'source', entities: 'entity', concepts: 'concept', syntheses: 'synthesis' }
const PAGE_TYPES = ['source', 'entity', 'concept', 'synthesis']
const WIKI = 'wiki'
const SCHEMA_FILE = 'AGENTS.md'
const MANIFEST = path.posix.join(WIKI, '.ingest-manifest.json')
const BACKUP_PREFIX = 'archivist-'
// Only directories this plugin created (stamp() + optional collision suffix) may be rotated away.
const SNAPSHOT_RE = /^archivist-\d{8}-\d{9,}(-\d+)?$/
const DEFAULT_KEEP = 10
const READ_CHAR_CAP = 120000
const EXCLUDE_RE = /(^|\/)(\.backups|\.git|node_modules)(\/|$)/
const RAW_EXTS = /\.(md|txt|json|csv|ya?ml)$/i
const RAW_SIZE_CAP = 2 * 1024 * 1024
// Files listed before the scan list is truncated; the counts stay exact either way.
const SCAN_ROW_CAP = 60

// ---------------------------------------------------------------- helpers

const today = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const stamp = () => {
  const d = new Date()
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${today().replace(/-/g, '')}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${p(d.getMilliseconds(), 3)}`
}
const sha16 = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 16)
const fwd = (p) => p.replace(/\\/g, '/')
// Frontmatter scalars live on one line each: an embedded line break would split the record
// and the trailing part would be dropped on re-parse. JS "." does not match U+2028/U+2029,
// so they are folded here explicitly along with NEL.
const oneLine = (v) => String(v).replace(/\s*[\r\n\u2028\u2029\u0085]+\s*/g, ' ').trim()

function walkFiles(dir) {
  const out = []
  if (!existsSync(dir)) return out
  const stack = [dir]
  while (stack.length) {
    const cur = stack.pop()
    for (const e of readdirSync(cur, { withFileTypes: true })) {
      const abs = path.join(cur, e.name)
      if (e.isDirectory()) stack.push(abs)
      else out.push(abs)
    }
  }
  return out.sort()
}

function pointerFile() {
  return process.env.ARCHIVIST_POINTER
    || path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'archivist', 'pointer.json')
}
function readPointer() {
  try { return JSON.parse(readFileSync(pointerFile(), 'utf8')) } catch { return null }
}
function writePointer(dir) {
  const f = pointerFile()
  mkdirSync(path.dirname(f), { recursive: true })
  writeFileSync(f, JSON.stringify({ dir, updated: new Date().toISOString() }, null, 2))
  return f
}
function resolveDir(explicit) {
  const dir = (explicit && String(explicit)) || process.env.ARCHIVIST_DIR || readPointer()?.dir
  if (!dir) {
    throw new Error('no wiki workspace configured: pass a path, set ARCHIVIST_DIR, or run archivist_init / archivist_attach first')
  }
  return path.resolve(dir)
}
function requireWiki(dir) {
  if (!existsSync(path.join(dir, WIKI, 'index.md'))) {
    throw new Error(`not a wiki workspace (missing ${WIKI}/index.md): ${dir} — run archivist_init or archivist_attach first`)
  }
}
function toPosixRel(root, abs) { return fwd(path.relative(root, abs)) }
function inside(root, rel) {
  const abs = path.resolve(root, rel)
  const r = path.relative(root, abs)
  return r === '' || (!r.startsWith('..') && !path.isAbsolute(r))
}
// Windows paths are case-insensitive and the file system normalizes "./", "//" and "..", so
// identity must be compared on the resolved path rather than on the raw string: "Log.md" IS
// "log.md", and "./concepts/A.md" IS "concepts/A.md".
function sameFile(dir, a, b) {
  const pa = path.resolve(dir, WIKI, String(a))
  const pb = path.resolve(dir, WIKI, String(b))
  return process.platform === 'win32' ? pa.toLowerCase() === pb.toLowerCase() : pa === pb
}

// ---------------------------------------------------------------- frontmatter

// A scalar shaped like "[...]" parses back as a list, and a surrounding quote is stripped,
// so serializePage quotes any value containing a quote, a backslash, or a bracket. The
// quoted form escapes exactly two characters and unquote() is its exact inverse, so an
// update rewrites the same bytes forever (JSON.stringify was not invertible here: the
// parser stripped quotes without decoding escapes, so backslashes accumulated per update).
const encValue = (v) => '"' + String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
// Values are emitted in the quoted form whenever our own parser would misread them, or a
// real YAML parser would read them differently: YAML indicators, ": ", " #", the empty
// string, and type-like scalars (null/~/booleans/numbers) that must stay strings.
const needsQuote = (s) => s === ''
  || /["'\\\[\]{},]/.test(s)
  || /^[\s#%&*!|>'"?@`-]/.test(s)
  || /:\s|:$|\s#/.test(s)
  || /^(~|null|true|false)$/i.test(s)
  || /^[-+]?(0[xX][0-9a-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|(\d[\d_]*)?(\.\d*)?([eE][-+]?\d+)?)$/.test(s)
  || /^[-+]?\.(inf|nan)$/i.test(s)
  || /^\d{4}-\d{2}-\d{2}([Tt ].*)?$/.test(s)
const quoteScalar = (v) => {
  const s = oneLine(v)
  return needsQuote(s) ? encValue(s) : s
}
const quoteItem = (v) => {
  const s = oneLine(v)
  return needsQuote(s) || s.includes(',') ? encValue(s) : s
}
function unquote(v) {
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    let out = '', esc = false
    for (const ch of v.slice(1, -1)) {
      if (esc) { out += ch; esc = false; continue }
      if (ch === '\\') { esc = true; continue }
      out += ch
    }
    return out
  }
  // legacy bare single-quoted scalar: '' is the YAML escape for a literal quote
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'")
  return v
}
// Position of the quote closing the one at `i`, or -1 when it is never closed. An unclosed quote
// is data, not syntax: `a',' # c` is a plain scalar, and its trailing comment must still be cut.
function closeQuoteAt(s, i) {
  const q = s[i]
  let k = i + 1
  while (k < s.length) {
    if (q === '"' && s[k] === '\\') { k += 2; continue }
    if (q === "'" && s[k] === "'" && s[k + 1] === "'") { k += 2; continue }
    if (s[k] === q) return k
    k++
  }
  return -1
}

// A `#` preceded by whitespace starts a YAML comment anywhere outside quotes — including inside a
// flow collection. Quoted content is scanned so "a # b", [a, "b #c"] and a quoted scalar followed
// by a trailing comment ("My Page" # note) all keep their value.
function stripComment(raw) {
  const s = String(raw ?? '').trim()
  if (/^["']/.test(s)) {
    const close = closeQuoteAt(s, 0)
    if (close < 0) return s                          // unterminated: leave it alone
    const rest = s.slice(close + 1).trim()
    if (rest.startsWith('#')) return s.slice(0, close + 1)
    const idx = s.indexOf(' #', close + 1)
    return idx >= 0 ? s.slice(0, idx).trim() : s
  }
  let quote = ''
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (quote) {
      if (quote === '"' && ch === '\\') { i++; continue }
      if (quote === "'" && ch === "'" && s[i + 1] === "'") { i++; continue }
      if (ch === quote) quote = ''
      continue
    }
    if (ch === '"' || ch === "'") {
      // A quote only starts a quoted scalar at the start of a node, and only when it is closed:
      // `it's # c` is a plain scalar with an apostrophe, so the comment after it must still be cut.
      if ((i === 0 || /[\s,\[{]/.test(s[i - 1])) && closeQuoteAt(s, i) > i) { quote = ch; continue }
    }
    if (ch === '#' && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i).trim()
  }
  return s
}

// Only an empty value, a block-scalar indicator (with optional indentation/chomping), or an
// unterminated flow collection opens a block. A plain scalar ("trust: low") followed by indented
// lines is NOT a block: a YAML parser would fold those lines into the scalar.
function opensBlockValue(rawInline) {
  const v = stripComment(rawInline)
  return /^$/.test(v) || /^[|>][+-]?\d*[+-]?$/.test(v) || /^(\[[^\]]*|\{[^}]*)$/.test(v)
}

// Split a flow list on commas outside quotes. Items are unquoted here; both YAML quote styles are
// recognised ("" and '' are the escapes for a literal quote inside their own style).
function splitItems(inner) {
  if (inner.trim() === '') return []
  const out = []
  let cur = ''
  let quote = ''
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]
    if (quote === '"') {
      if (ch === '\\') { cur += inner[++i] ?? ''; continue }
      if (ch === '"') { quote = ''; continue }
      cur += ch
      continue
    }
    if (quote === "'") {
      if (ch === "'" && inner[i + 1] === "'") { cur += "'"; i++; continue }
      if (ch === "'") { quote = ''; continue }
      cur += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      // A quote opens a quoted item only where an item starts: "it's" in [a, it's] is a plain
      // scalar whose apostrophe is data, not syntax.
      const sofar = cur.replace(/\s+$/, '')
      if (sofar === '' || /[\[{]$/.test(sofar)) { quote = ch; continue }
    }
    if (ch === ',') { out.push(cur); cur = ''; continue }
    cur += ch
  }
  out.push(cur)
  const items = out.map((s) => s.trim())
  // "[a, ]" is ["a"] in YAML 1.2: the empty tail left by a trailing comma is not an item. An
  // explicitly quoted empty item ("") is kept, because that one was authored on purpose.
  if (items.length > 1 && items[items.length - 1] === '' && !/["']\s*$/.test(inner.trim())) items.pop()
  return items
}

// A block-sequence item is only turned into a list element when it is a plain scalar:
// "- #x" is a comment, "- - x" a nested sequence, "- k: v" a mapping, "- |" a block scalar.
function isPlainItem(l) {
  if (!/^\s*-\s+\S/.test(l)) return false
  const body = l.replace(/^\s*-\s+/, '').trim()
  if (/^[-#?|>&*!%@`\[{]/.test(body)) return false
  // A hand-written quoted item may carry YAML escapes that unquote() does not decode.
  if (/^["']/.test(body) && body.includes('\\')) return false
  return !/^[^\s:]+:(\s|$)/.test(body)
}

// A block introduced by a bare "key:" line is parsed back into a value when its shape is
// simple (flow array, scalar list, one plain scalar); anything else is kept verbatim by the
// caller. Returning undefined means "keep the block intact".
function parseBlock(kv, cont) {
  const inline = stripComment(kv[2])
  const clean = cont.map((l) => stripComment(l))
  const joined = [inline, ...clean].filter(Boolean).join(' ')
  if (joined.startsWith('[') && joined.endsWith(']')) return splitItems(joined.slice(1, -1))
  const items = clean.filter((l) => l.trim() !== '')
  if (inline === '' && items.length && items.every(isPlainItem)) {
    return items.map((l) => unquote(l.replace(/^\s*-\s+/, '').trim()))
  }
  if (inline === '' && clean.length === 1 && clean[0].trim() && !/^\S+:(\s|$)/.test(clean[0].trim())) {
    return unquote(clean[0].trim())
  }
  return undefined
}

export function parsePage(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!m) return { fm: {}, extra: [], body: text, raw: text }
  const fm = {}
  // Lines this parser does not understand — nested maps, block scalars, keys outside
  // [A-Za-z_][\w-] — are kept verbatim (with their key name) so a rewrite cannot delete
  // them and cannot emit the same key twice.
  const extra = []
  const lines = m[1].split(/\r?\n/)
  const indentAt = (n) => n >= 0 && n < lines.length && /^\s+\S/.test(lines[n])
  // A block may start after blank lines ("raw: |" + blank + content), so skip them here — the
  // continuation scan below already does.
  const nextContentIndented = (n) => {
    let k = n
    while (k < lines.length && lines[k].trim() === '') k++
    return indentAt(k)
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line)
    // The inline value with any trailing comment removed: "raw: | # note" is still a block header,
    // and "tags: [a] # note" is still a flow list.
    const inline = kv ? stripComment(kv[2]) : ''
    if (kv && opensBlockValue(kv[2]) && nextContentIndented(i + 1)) {
      let j = i + 1
      while (j < lines.length && (indentAt(j) || (lines[j].trim() === '' && indentAt(j + 1)))) j++
      const cont = lines.slice(i + 1, j)
      const value = parseBlock({ ...kv, 2: inline }, cont)
      if (value === undefined) extra.push({ key: kv[1], lines: [line, ...cont] })
      else fm[kv[1]] = value
      i = j - 1
      continue
    }
    if (!kv) { extra.push({ key: null, lines: [line] }); continue }
    let v = inline
    // A VALID block-scalar indicator with nothing indented under it is an EMPTY scalar: storing
    // the indicator text as the value would silently turn "" into "|". Anything else that merely
    // starts with | or > (">= 0.9", "|x| < 1") is a plain scalar and stays as written.
    if (/^[|>][+-]?\d*[+-]?$/.test(v)) v = ''
    else if (v.startsWith('[') && v.endsWith(']')) v = splitItems(v.slice(1, -1))
    else v = unquote(v)
    fm[kv[1]] = v
  }
  return { fm, extra, body: text.slice(m[0].length), raw: text }
}

function serializePage(fm, body, extra = [], overrides = new Set()) {
  // A verbatim block owns its key, so the fm value is skipped to avoid duplicating the key —
  // unless the caller passed that field explicitly, in which case the argument wins and the
  // stale block is dropped (otherwise an explicit write would be silently discarded).
  const blocks = extra
    .map((e) => (typeof e === 'string' ? { key: null, lines: [e] } : e))
    .filter((b) => !(b.key && overrides.has(b.key)))
  const claimed = new Set(blocks.map((b) => b.key).filter(Boolean))
  const lines = ['---']
  for (const [k, v] of Object.entries(fm)) {
    if (v === undefined || v === null || claimed.has(k)) continue
    if (Array.isArray(v)) lines.push(`${k}: [${v.map(quoteItem).join(', ')}]`)
    else lines.push(`${k}: ${quoteScalar(v)}`)
  }
  for (const b of blocks) for (const line of b.lines) lines.push(line)
  lines.push('---', '')
  return lines.join('\n') + body.replace(/^\s*\n/, '')
}

function pageTitle(fm, body, rel) {
  if (fm.title) return String(fm.title)
  const h = /^#\s+(.+)$/m.exec(body)
  if (h) return h[1].trim()
  return path.basename(rel, '.md')
}

// ---------------------------------------------------------------- pages

/** All content pages: every .md under wiki/ except index.md and log.md. */
export function listPages(dir) {
  const pages = []
  for (const f of walkFiles(path.join(dir, WIKI))) {
    const rel = toPosixRel(path.join(dir, WIKI), f)
    if (!rel.endsWith('.md')) continue
    if (rel === 'index.md' || rel === 'log.md') continue
    if (rel.startsWith('.')) continue
    const text = readFileSync(f, 'utf8')
    const { fm, body } = parsePage(text)
    pages.push({ rel, abs: f, fm, body, raw: text, title: pageTitle(fm, body, rel), type: fm.type || '' })
  }
  return pages
}

export function wikilinks(text) {
  const out = []
  for (const m of text.matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)) out.push(m[1].trim())
  return out
}

// ---------------------------------------------------------------- workspace init / attach

const AGENTS_TEMPLATE = `# Archivist 知识库 — Schema & Workflows（由插件生成，可随需修改）

本目录是一份"自我维护的知识库"（Karpathy LLM Wiki 模式）。**所有内容由 AI Agent 读写维护**；
插件提供确定性工具（检索/校验/索引/日志/备份/纠错），Agent 负责阅读、写作与综合。

## 目录结构

\`\`\`
raw/                 # 不可变原始资料（Agent 只读，禁止修改）
  conversations/     # 对话蒸馏的原文（先说后编）
wiki/
  index.md           # 目录（由插件 archivist_write / archivist_index 自动重建，勿手改）
  log.md             # 追加式时间线，格式：## [YYYY-MM-DD] 动作 | 标题
  overview.md        # 全局综述（活文档）
  sources/           # 每份原始资料一页摘要
  entities/          # 人物/公司/项目实体页
  concepts/          # 概念/方法/框架页
  syntheses/         # 存档的问答/分析产物
\`\`\`

## 页面格式（frontmatter）

\`\`\`yaml
---
title: 页面标题
type: source | entity | concept | synthesis
tags: [标签1, 标签2]
sources: [来源 raw 文件路径]      # 页面结论的依据出处（有则必填）
summary: 一句话摘要（用于目录）
trust: high | medium | low       # 信任级别（见下）
status: active | superseded | retracted   # 替代/撤回时由插件维护，默认 active
supersedes: 页面相对路径（可选）   # 本页替代了哪一页
superseded_by: 页面相对路径（可选） # 本页被哪一页替代
last_updated: YYYY-MM-DD（由 archivist_write 自动填）
---
正文，用 [[页面名]] 建立 wikilink 交叉引用。
\`\`\`

### 信任级别（trust）
- \`high\`：用户明确确认或手工编写的内容
- \`medium\`：有 raw 原文出处（archivist_write 传了 \`sourceFile\` 时自动如此）
- \`low\`：模型派生、没有原文锚定（未传 \`sourceFile\` 的页默认此级）——检索会标注\`低信任\`，只作导航；**关键事实要回读 raw 原文验证**

## 工作流

### Ingest（摄入资料）
1. \`archivist_sources\` 看有哪些 new/changed 的 raw/ 文件
2. 完整阅读源文件；用 \`archivist_read\` 读取 index.md / overview.md 与相关页面
3. \`archivist_write\` 写 \`sources/<slug>.md\`（传 \`sourceFile: "raw/xxx.md"\` 登记摄入；trust 自动 medium）
4. 更新/新建涉及的 entities 与 concepts 页面；与旧内容矛盾时在新页 \`tags\` 加 \`contradiction\` 并在正文标注
5. 视需要更新 overview.md 综述
6. \`archivist_log\` 追加：\`ingest | <标题>\`
7. \`archivist_lint\` 跑后置校验，有问题就修

### Distill（对话蒸馏，raw 优先）
1. **先把对话落成 raw 原文**：把相关片段（保留用户与 AI 原话）存为 \`raw/conversations/YYYY-MM-DD-主题.md\`
2. 再按 Ingest 流程编译：\`archivist_write\` 传 \`sourceFile: "raw/conversations/..."\` → 页面 trust=medium
3. 只写决策/结论/方法，不搬运流水账；没有 raw 出处的页默认 trust=low

### Query（提问）
1. \`archivist_search\` 取前 10–15 个相关页；结果会标注 \`低信任\` / \`已被 xxx 替代\`，已撤回页自动排除；**穷尽/计数类问题（全部/从未/多少）改用 \`archivist_scan\`**（精确计数 + 命中文件清单：≤60 个全列，超出时明示截断与未显示条数、计数与文件数仍准确 + 覆盖声明：被跳过的文件与原因一并列出）
2. \`archivist_read\` 精读命中页（可顺 wikilink 多跳）；低信任页只作导航，关键事实回读 \`sources\` 指向的 raw 原文验证，或在回答中声明来源级别
3. 基于页面回答并引用页面路径；答案有价值时 \`archivist_write\` 存到 \`syntheses/\`
4. \`archivist_log\` 追加：\`query | <问题>\`

### 纠错（永不覆盖历史）
- 修正：用 \`archivist_write({ path: "新页.md", supersedes: "旧页.md" })\` 写替代页；旧页自动标记 \`superseded\`（检索降权并标注）
- 撤回：\`archivist_write({ path: "旧页.md", retract: true, retractReason: "原因" })\`（检索排除）
- 不要直接改写旧页结论了事；lint 会检查替代链完整性

### Lint（周期性体检）
- \`archivist_lint\` 查：断链、孤儿页、目录缺漏、缺 frontmatter、重复标题、非法 trust/status、替代链不完整
- 语义问题（矛盾、过时结论）由 Agent 阅读相关页后处理；高频提及未建页看 missingPages 提示

### 备份 / 版本
- \`archivist_backup\`：免 git 快照（默认存本目录 .backups/，建议 target 指向别的磁盘或云盘目录；轮转保留 10 份）
- 有 git 时可用 \`archivist_commit\`；无 git 不影响使用

## 规则
- \`raw/\` 永不修改；一切衍生内容写进 \`wiki/\`
- **能影响回答的事实都要能回到 raw 出处**；回流不了的标注 \`trust: low\`
- 修正用替代/撤回记录，不覆盖历史
- 穷尽/计数问题用 archivist_scan 的精确计数回答并声明覆盖范围；不要用 top-K 结果冒充全库
- 页面保持原子化（一页一主题），标题清晰，wikilink 至少连 2 个其他页
- **导航页/总览页只放链接，不得把各条目的描述正文抄进去**：一页装 N 个条目的摘要会变成"吸铁石"——实测 84 条语料下，这样的总览页霸占 81/84 条内容查询的第 1 名，真正该命中的页被挤到第 2（Top-1 命中率 23% → 去掉描述正文后 77%）。导航交给 \`index.md\`（它由插件维护、不参与检索）
`

const INDEX_HEADER = `# Wiki Index

> 本文件由插件自动生成（archivist_write / archivist_index）。请勿手改；页面摘要来自各页 frontmatter 的 summary 字段。
`
const LOG_HEADER = `# Wiki Log

> 追加式记录，格式：\`## [YYYY-MM-DD] 动作 | 标题\`。可用 \`grep '^## \\[' log.md | tail -5\` 查看最近条目。
`
const OVERVIEW_HEADER = `全局综述（活文档）：随着新资料摄入，这里应持续反映"当前所有已知内容的整体图景"——主要脉络、关键实体、开放问题、已标记的矛盾。`

function ensure(file, content) {
  if (!existsSync(file)) writeFileSync(file, content)
}
function ensureDir(p) { mkdirSync(p, { recursive: true }) }

// index.md links are parsed back by lintWiki. Escape "%", "(", ")", and every whitespace
// code unit to a FIXED-width escape: fixed width is what makes the encoding injective and
// exactly invertible. Only the 4-digit form is decoded — accepting bare two-digit escapes
// would mis-read a literal "%20" that an older index wrote verbatim.
// U+0085 (NEL) is valid YAML but is not matched by JS \s, so it is listed explicitly here and in
// slugify: otherwise it stays raw in a filename and in an index href.
const encodeHref = (rel) => String(rel).replace(/[%()\s\u0085]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0'))
const decodeHref = (h) => String(h).replace(/%([0-9a-f]{4})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
const indexLine = (p) => `- [${String(p.title).replace(/\[/g, '［').replace(/\]/g, '］')}](${encodeHref(p.rel)})${p.fm.summary ? ' — ' + p.fm.summary : ''}`

export function rebuildIndex(dir) {
  const pages = listPages(dir)
  const byDir = Object.fromEntries(PAGE_DIRS.map((d) => [d, []]))
  const other = []
  let overview = null
  for (const p of pages) {
    const top = p.rel.includes('/') ? p.rel.split('/')[0] : ''
    if (p.rel === 'overview.md') { overview = p; continue }
    // writePage accepts wiki-root pages ("or wiki root"); list them instead of
    // dropping them, or index coverage can never match what the workspace holds.
    if (byDir[top]) byDir[top].push(p)
    else other.push(p)
  }
  const lines = [INDEX_HEADER.trim(), '']
  if (overview) {
    lines.push('## Overview', indexLine(overview), '')
  }
  const sectionTitles = { sources: 'Sources', entities: 'Entities', concepts: 'Concepts', syntheses: 'Syntheses' }
  for (const d of PAGE_DIRS) {
    lines.push(`## ${sectionTitles[d]}`)
    for (const p of byDir[d].sort((a, b) => a.rel.localeCompare(b.rel))) {
      lines.push(indexLine(p))
    }
    lines.push('')
  }
  if (other.length) {
    lines.push('## Other（wiki 根目录 / 未归类）')
    for (const p of other.sort((a, b) => a.rel.localeCompare(b.rel))) {
      lines.push(indexLine(p))
    }
    lines.push('')
  }
  writeFileSync(path.join(dir, WIKI, 'index.md'), lines.join('\n'))
  return pages.length
}

// YAML 1.2 c-printable excludes C0 (except tab/LF/CR), DEL, the C1 block up to U+009F (U+0085 NEL
// IS allowed by YAML 1.2 and is folded to a space by oneLine instead), and U+FFFE/U+FFFF. Lone
// surrogates are included too: they cannot be encoded as UTF-8 (a valid pair is one code point and
// is only matched with the `u` flag, so emoji are unaffected).
const YAML_BAD = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u0084\u0086-\u009F\uD800-\uDFFF\uFFFE\uFFFF]/gu

// A value the caller supplied is rejected (loud); a value inherited from an older page is
// cleaned instead, so a page written by a buggy build stays updatable instead of frozen.
// Cleaning REPLACES a bad character with a space: deleting it would shift the characters
// around it, which can promote an inert junk line into a live YAML key or list item.
function cleanValue(s, key, strict, stats) {
  const bad = String(s).match(YAML_BAD)
  if (!bad) return s
  const code = 'U+' + bad[0].codePointAt(0).toString(16).toUpperCase().padStart(4, '0')
  if (strict) throw new Error(`frontmatter field "${key}" contains control character ${code}, which YAML cannot store — remove it`)
  if (stats) stats.cleaned += bad.length
  return String(s).replace(YAML_BAD, ' ')
}
function sanitizeFm(fm, strict = new Set(), stats) {
  for (const [k, v] of Object.entries(fm)) {
    if (Array.isArray(v)) fm[k] = v.map((x) => (typeof x === 'string' ? cleanValue(x, k, strict.has(k), stats) : x))
    else if (typeof v === 'string') fm[k] = cleanValue(v, k, strict.has(k), stats)
  }
  return fm
}
// Verbatim blocks are inherited text too, and the result must stay parseable by a real YAML
// parser without ever promoting junk into a live key:
//  - a KEYED entry is a real block ("raw: |", "meta:"): its lines keep their place, and a line
//    carrying an unstorable character is commented *in place* (indentation preserved, so the
//    following block lines keep their parent). Its column-0 header keeps its text with the
//    character merely replaced — commenting a header would detach the whole block.
//  - a KEYLESS line is outside any block (junk, a stray continuation, a document marker): it is
//    flattened to a column-0 comment. Left indented, the previous scalar absorbs it (a silent
//    value change); left with the replacement space, it can become a live key on the next parse.
function sanitizeExtra(extra, stats) {
  return extra.map((raw) => {
    const e = typeof raw === 'string' ? { key: null, lines: [raw] } : raw
    const keyed = Boolean(e.key)
    const lines = e.lines.map((l) => {
      const s = String(l)
      const hits = s.match(YAML_BAD)
      if (hits && stats) stats.cleaned += hits.length
      const cleaned = hits ? s.replace(YAML_BAD, ' ') : s
      if (!keyed) {
        if (s.trim() === '') return cleaned
        return ('# ' + cleaned.trim().replace(/^#\s*/, '')).trimEnd()
      }
      if (!hits) return s
      const indent = /^\s*/.exec(s)[0]
      return indent ? `${indent}# ${cleaned.slice(indent.length)}` : cleaned
    })
    return { ...e, lines }
  })
}

export function initWorkspace(dir, opts = {}) {
  if (!dir || !String(dir).trim()) {
    throw new Error('archivist_init requires an explicit workspace path (e.g. "D:/archivist" or "<Documents>/archivist"); recommend a non-system drive plus archivist_backup so an OS reinstall cannot lose it')
  }
  const abs = path.resolve(dir)
  const already = existsSync(path.join(abs, WIKI, 'index.md'))
  if (already && !opts.force) {
    const info = attachWorkspace(abs)
    return `workspace already initialized at ${abs} (pointer refreshed); ${info}`
  }
  ensureDir(path.join(abs, 'raw'))
  ensureDir(path.join(abs, WIKI))
  for (const d of PAGE_DIRS) ensureDir(path.join(abs, WIKI, d))
  ensure(path.join(abs, SCHEMA_FILE), AGENTS_TEMPLATE)
  ensure(path.join(abs, '.gitignore'), '.backups/\n*.tmp\n')
  ensure(path.join(abs, 'raw', '.gitkeep'), '')
  ensure(path.join(abs, WIKI, 'log.md'), LOG_HEADER)
  ensure(path.join(abs, WIKI, 'overview.md'), serializePage(
    { title: 'Overview', type: 'synthesis', tags: [], sources: [], summary: '全局综述', last_updated: today() },
    OVERVIEW_HEADER + '\n',
  ))
  const n = rebuildIndex(abs)
  const ptr = writePointer(abs)
  let gitNote = 'git: not initialized (optional)'
  if (opts.git) {
    const r = spawnSync('git', ['init'], { cwd: abs, encoding: 'utf8' })
    gitNote = r.error ? 'git: not available (skipped)' : 'git: initialized'
  }
  return [
    `initialized wiki workspace at ${abs}`,
    `pages: ${n} | pointer: ${ptr}`,
    gitNote,
    `schema: ${path.join(abs, SCHEMA_FILE)} — read it for the full workflows`,
  ].join('\n')
}

export function attachWorkspace(dir) {
  const abs = path.resolve(dir)
  requireWiki(abs)
  const ptr = writePointer(abs)
  const pages = listPages(abs).length
  return `attached ${abs} (pages: ${pages}, pointer: ${ptr}); schema: ${path.join(abs, SCHEMA_FILE)}`
}

// ---------------------------------------------------------------- sources

// Raw-file cache keyed by absolute path; entries stay valid while mtimeMs+size
// match, so searches stop re-reading unchanged files. Holds decoded text (roughly
// the corpus size in memory, tens of MB at a 10M-token corpus) and ingest hashes.
const rawCache = new Map()
export function clearRawCache() { rawCache.clear() }
function rawCacheEntry(abs) {
  let st
  try { st = statSync(abs) } catch { return null }
  let entry = rawCache.get(abs)
  if (!entry || entry.mtimeMs !== st.mtimeMs || entry.size !== st.size) {
    entry = { mtimeMs: st.mtimeMs, size: st.size }
    rawCache.set(abs, entry)
  }
  return { entry }
}

// A file that is left out must never disappear silently: search and scan both
// report how many files they skipped and by which rule, so no output can claim a
// complete corpus while quietly ignoring part of it.
const SKIP_LABEL = { extension: '扩展名不在白名单', size: '超过 2MB', unreadable: '无法读取' }
function skipCount(skips) { return Object.values(skips).reduce((n, files) => n + files.length, 0) }
function describeSkips(skips) {
  return Object.entries(skips)
    .filter(([, files]) => files.length)
    .map(([reason, files]) => `${SKIP_LABEL[reason] || reason} ${files.length} 个 (${files.slice(0, 3).join(', ')}${files.length > 3 ? ', …' : ''})`)
    .join('; ')
}

/**
 * Read every eligible raw/ document once, for both search and scan, and record why
 * each remaining file was left out (extension whitelist / 2MB cap / unreadable).
 *
 * 0-byte files are classified BEFORE those filters and counted as scanned-but-empty:
 * an empty file cannot contain any match, so leaving it out is not a coverage gap,
 * unlike a filtered non-empty file which may hide matches. This keeps placeholders
 * such as raw/.gitkeep (created by archivist_init) out of the skip list, so the
 * disclosure stays a real signal instead of permanent noise users learn to ignore.
 */
function readRawDocs(dir) {
  const docs = []
  const skips = { extension: [], size: [], unreadable: [] }
  for (const f of walkFiles(path.join(dir, 'raw'))) {
    const rel = toPosixRel(dir, f)
    const hit = rawCacheEntry(f)
    if (!hit) { skips.unreadable.push(rel); continue }
    if (hit.entry.size === 0) { docs.push({ rel, text: '' }); continue }
    if (!RAW_EXTS.test(rel)) { skips.extension.push(rel); continue }
    if (hit.entry.size > RAW_SIZE_CAP) { skips.size.push(rel); continue }
    if (!hit.entry.text) {
      try { hit.entry.text = readFileSync(f, 'utf8') } catch { skips.unreadable.push(rel); continue }
    }
    docs.push({ rel, text: hit.entry.text })
  }
  return { docs, skips }
}

export function listSources(dir) {
  const rawDir = path.join(dir, 'raw')
  const manifest = (() => {
    try { return JSON.parse(readFileSync(path.join(dir, MANIFEST), 'utf8')) } catch { return {} }
  })()
  const out = []
  for (const f of walkFiles(rawDir)) {
    const rel = toPosixRel(dir, f)
    if (rel.endsWith('.gitkeep')) continue
    const hit = rawCacheEntry(f)
    if (!hit) continue
    if (!hit.entry.sha) {
      try { hit.entry.sha = sha16(readFileSync(f)) } catch { continue }
    }
    const rec = manifest[rel]
    const status = !rec ? 'new' : (rec.hash === hit.entry.sha ? 'ingested' : 'changed')
    out.push({ rel, bytes: hit.entry.size, status, page: rec?.page || null })
  }
  return out
}

/**
 * Manifest write only: writePage validates the path and hashes the file before the
 * page is written, so a rejected ingest can no longer leave a page behind.
 */
function recordIngest(dir, rawRel, pageRel, sha) {
  const mf = (() => {
    try { return JSON.parse(readFileSync(path.join(dir, MANIFEST), 'utf8')) } catch { return {} }
  })()
  mf[rawRel] = { hash: sha, page: pageRel, at: new Date().toISOString() }
  writeFileSync(path.join(dir, MANIFEST), JSON.stringify(mf, null, 2))
}

// ---------------------------------------------------------------- write / read

function slugify(title) {
  return title.trim()
    .replace(/[\\/:*?"<>|#]+/g, '-')
    .replace(/[\s\u0085]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

export function writePage(dir, args) {
  // Reject undeclared parameters here too: the tool layer validates them, but a script calling the
  // core directly used to have them silently ignored (a typo'd "tag" would drop the tags).
  const declared = TOOLS.find((t) => t.name === 'archivist_write')?.schema?.properties ?? {}
  for (const k of Object.keys(args)) {
    if (!(k in declared)) throw new Error(`archivist_write: unknown parameter(s) "${k}" — declared: ${Object.keys(declared).join(', ')}`)
  }
  const pageRel = args.path || args.rel
  let body = String(args.body ?? '')
  let rel = pageRel ? fwd(String(pageRel)) : ''
  if (!rel) {
    if (!args.title) throw new Error('provide path (e.g. "concepts/Foo.md") or title')
    // `dir` picks the folder; `type` is frontmatter only (using it as a folder name
    // produced "<type>/<title>.md", which no PAGE_DIRS ever matches).
    const top = String(args.dir || 'concepts')
    rel = `${top}/${slugify(String(args.title))}.md`
  }
  // Normalize every path segment to the slug convention so titles and paths stay consistent.
  // "." and empty segments are dropped, so "./concepts/A.md" and "concepts//A.md" name the same
  // page as "concepts/A.md"; a segment that slugs to nothing still needs a real name.
  rel = rel.split('/').filter((seg) => seg !== '' && seg !== '.').map((seg) => slugify(seg) || 'untitled').join('/')
  // A path that names no file ("/" , "./", ".") must be refused: appending ".md" turned it into
  // "wiki/.md", which listPages hides — a page no tool could ever find again.
  if (pageRel && rel === '') {
    throw new Error(`page path must name a file (e.g. "concepts/A.md" or "A.md"), not a directory: ${pageRel}`)
  }
  if (!/\.md$/i.test(rel)) rel += '.md'
  if (rel === 'index.md' || rel === 'log.md' || sameFile(dir, rel, 'index.md') || sameFile(dir, rel, 'log.md')) {
    throw new Error(`${rel} is plugin-managed: use archivist_index to rebuild the index, archivist_log to append log entries`)
  }
  if (!inside(path.join(dir, WIKI), rel)) throw new Error('page path must stay inside wiki/: ' + rel)
  const parts = rel.split('/')
  if (parts.length === 2 && !PAGE_DIRS.includes(parts[0])) {
    throw new Error(`page must live in wiki/{${PAGE_DIRS.join(',')}} or wiki root: ${rel}`)
  }
  // A path carrying a control character cannot be stored in a filename or an index link.
  const badRel = rel.match(YAML_BAD)
  if (badRel) {
    const code = 'U+' + badRel[0].codePointAt(0).toString(16).toUpperCase().padStart(4, '0')
    throw new Error(`page path contains control character ${code}, which cannot be stored in a filename or index link — remove it`)
  }
  if (parts.length > 2) throw new Error('page path too deep: ' + rel)
  const abs = path.join(dir, WIKI, rel)
  const existingText = existsSync(abs) ? readFileSync(abs, 'utf8') : ''
  const existing = parsePage(existingText)

  // Retraction: flip status in place without touching the body (history stays auditable).
  if (args.retract === true) {
    if (!existingText) throw new Error(`cannot retract a page that does not exist: wiki/${rel}`)
    const fmRetract = {
      ...existing.fm,
      title: existing.fm.title || path.basename(rel, '.md'),
      type: existing.fm.type || (parts.length === 2 ? TYPE_BY_DIR[parts[0]] : 'synthesis'),
      status: 'retracted',
      retractReason: oneLine(args.retractReason ?? '(no reason given)'),
      last_updated: today(),
    }
    sanitizeFm(fmRetract, new Set(['retractReason']))
    writeFileSync(abs + '.tmp', serializePage(fmRetract, existing.body.trimEnd() + '\n', sanitizeExtra(existing.extra), new Set(['retractReason', 'status', 'last_updated'])))
    renameSync(abs + '.tmp', abs)
    if (args.index !== false) rebuildIndex(dir)
    appendLog(dir, `retract | wiki/${rel}${args.retractReason ? ' — ' + oneLine(args.retractReason) : ''}`)
    return `retracted wiki/${rel}${args.retractReason ? ' (' + oneLine(args.retractReason) + ')' : ''}`
  }

  // Validate only what the caller supplied: a page written before this check may hold a
  // legacy type, and an update that does not pass `type` must still be able to fix it.
  if (args.type !== undefined && !PAGE_TYPES.includes(String(args.type))) {
    throw new Error(`invalid type "${args.type}" — use ${PAGE_TYPES.join(' | ')}`)
  }
  const dirType = parts.length === 2 ? TYPE_BY_DIR[parts[0]] : 'synthesis'
  const trust = args.trust !== undefined
    ? String(args.trust)
    : (existing.fm.trust || (args.sourceFile ? 'medium' : 'low'))
  // Same rule as `type`: validate what the caller supplied, never the inherited record —
  // otherwise a hand-written `status: Draft` page could never be updated again.
  if (args.trust !== undefined && !['high', 'medium', 'low'].includes(trust)) {
    throw new Error(`invalid trust "${trust}" — use high | medium | low`)
  }
  const status = args.status !== undefined ? String(args.status) : (existing.fm.status || 'active')
  if (args.status !== undefined && !['active', 'superseded', 'retracted'].includes(status)) {
    throw new Error(`invalid status "${status}" — use active | superseded | retracted`)
  }
  const supersedes = args.supersedes !== undefined
    ? fwd(String(args.supersedes)).replace(/^wiki\//, '')
    : (existing.fm.supersedes || undefined)
  // Start from the existing record so keys this build does not know about (aliases,
  // reviewed, source_url, …) survive an update instead of being deleted silently.
  const fm = {
    ...existing.fm,
    title: oneLine(args.title || existing.fm.title || path.basename(rel, '.md')),
    type: args.type || existing.fm.type || dirType,
    tags: args.tags || existing.fm.tags || [],
    sources: args.sources || existing.fm.sources || [],
    ...(args.summary || existing.fm.summary ? { summary: oneLine(args.summary || existing.fm.summary) } : {}),
    trust,
    ...(supersedes ? { supersedes } : {}),
    ...(existing.fm.superseded_by ? { superseded_by: existing.fm.superseded_by } : {}),
    ...(existing.fm.retractReason ? { retractReason: existing.fm.retractReason } : {}),
    last_updated: today(),
  }
  // Only an explicit status may change it; "active" means "no status line in the record".
  if (args.status !== undefined) { if (status === 'active') delete fm.status; else fm.status = status }
  if (typeof fm.title !== 'string' || !fm.title.trim()) throw new Error('page title is required')
  if (!body.trim()) body = existing.body.trim() ? existing.body : `# ${fm.title}\n`

  // Validate every input before the first byte reaches the disk: sourceFile and
  // supersedes used to be checked after the page had been renamed into place, so a
  // rejected write left a half-finished page behind.
  let ingest = null
  if (args.sourceFile) {
    const rawGiven = fwd(String(args.sourceFile))
    // Resolve first, then guard the absolute path against raw/: that accepts the
    // documented "raw/foo.md" form and rejects both escapes and in-workspace paths
    // that listSources (raw/ only) could never see again.
    const rawAbs = path.resolve(dir, rawGiven)
    if (!inside(path.join(dir, 'raw'), rawAbs)) throw new Error('sourceFile must stay inside raw/: ' + rawGiven)
    let rawFile = null
    try { rawFile = statSync(rawAbs).isFile() ? rawAbs : null } catch { /* missing */ }
    if (!rawFile) throw new Error(`source file not found: ${rawGiven}`)
    ingest = { rel: toPosixRel(dir, rawFile), sha: sha16(readFileSync(rawFile)) }
  }
  let supersede = null
  if (args.supersedes !== undefined) {
    const oldRel = fwd(String(args.supersedes)).replace(/^wiki\//, '')
    if (sameFile(dir, oldRel, rel)) throw new Error(`cannot supersede a page with itself: wiki/${rel} — write the replacement body directly instead`)
    if (sameFile(dir, oldRel, 'index.md') || sameFile(dir, oldRel, 'log.md')) {
      throw new Error(`${oldRel} is plugin-managed and cannot be superseded`)
    }
    if (!inside(path.join(dir, WIKI), oldRel)) throw new Error('supersedes path must stay inside wiki/: ' + oldRel)
    // "concepts/Old" and "concepts/Old.md" name the same page: resolve the optional extension
    // before the self/managed checks so a shorthand cannot dodge them.
    const oldFileRel = existsSync(path.join(dir, WIKI, oldRel)) ? oldRel
      : existsSync(path.join(dir, WIKI, oldRel + '.md')) ? oldRel + '.md' : oldRel
    const oldAbs = path.join(dir, WIKI, oldFileRel)
    if (!existsSync(oldAbs)) throw new Error(`supersedes target not found: wiki/${oldRel}`)
    if (sameFile(dir, oldFileRel, rel)) throw new Error(`cannot supersede a page with itself: wiki/${rel} — write the replacement body directly instead`)
    if (sameFile(dir, oldFileRel, 'index.md') || sameFile(dir, oldFileRel, 'log.md')) {
      throw new Error(`${oldFileRel} is plugin-managed and cannot be superseded`)
    }
    const target = parsePage(readFileSync(oldAbs, 'utf8'))
    // Clean the supersede target here — before this write touches the disk — so a page with a
    // legacy control character cannot leave a half-finished replacement behind (validate
    // everything first; see the atomicity note above).
    supersede = { rel: oldFileRel, abs: oldAbs, page: { ...target, fm: sanitizeFm(target.fm), extra: sanitizeExtra(target.extra) } }
  }

  // Fields the caller passed explicitly must survive even when the old page kept them in an
  // unparsable block: the argument wins and the stale block is dropped. Strictness follows the
  // value actually written — passing an empty string falls back to the inherited value, which
  // is cleaned rather than rejected.
  const overridden = new Set(['title', 'type', 'tags', 'sources', 'trust', 'status', 'summary', 'supersedes', 'last_updated']
    .filter((k) => Array.isArray(args[k]) || Boolean(args[k]) || k === 'last_updated'))
  const stats = { cleaned: 0 }
  existing.extra = sanitizeExtra(existing.extra, stats)
  sanitizeFm(fm, overridden, stats)
  const cleanNote = stats.cleaned ? ` | cleaned ${stats.cleaned} control char(s)` : ''
  const text = serializePage(fm, body.trim() + '\n', existing.extra, overridden)
  const tmp = abs + '.tmp'
  ensureDir(path.dirname(abs))
  writeFileSync(tmp, text)
  renameSync(tmp, abs)
  let logNote = ''
  if (ingest) {
    recordIngest(dir, ingest.rel, fwd(path.posix.join(WIKI, rel)), ingest.sha)
    logNote = ' | source marked ingested'
  }
  let superNote = ''
  if (supersede) {
    const oldFm = { ...supersede.page.fm, status: 'superseded', superseded_by: rel, last_updated: today() }
    const oldText = serializePage(oldFm, supersede.page.body.trimEnd() + '\n', supersede.page.extra, new Set(['status', 'superseded_by', 'last_updated']))
    // Atomic like the page write above: a torn write here would leave the target half-marked.
    writeFileSync(supersede.abs + '.tmp', oldText)
    renameSync(supersede.abs + '.tmp', supersede.abs)
    appendLog(dir, `supersede | wiki/${rel} ← wiki/${supersede.rel}`)
    superNote = ` | superseded wiki/${supersede.rel}`
  }
  let idxNote = ''
  if (args.index !== false) { rebuildIndex(dir); idxNote = ' | index rebuilt' }
  if (args.log) appendLog(dir, String(args.log))
  return `${existingText ? 'updated' : 'created'} wiki/${rel} (trust:${trust})${idxNote}${logNote}${superNote}${cleanNote}${args.log ? ' | logged' : ''}`
}

function resolveRead(dir, relRaw) {
  const rel0 = fwd(String(relRaw)).replace(/^wiki\//, '')
  if (!inside(path.join(dir, WIKI), rel0)) throw new Error('page path escapes wiki/: ' + rel0)
  const direct = [rel0, rel0.replace(/\.md$/i, '').replace(/ /g, '-') + '.md']
  for (const c of direct) {
    const abs = path.join(dir, WIKI, c)
    if (existsSync(abs)) return { rel: c, text: readFileSync(abs, 'utf8') }
  }
  // Lenient fallback: match by title or filename ignoring spaces/dashes.
  const norm = (s) => s.toLowerCase().replace(/[\s-]+/g, '')
  const want = norm(path.posix.basename(rel0).replace(/\.md$/i, ''))
  const hits = listPages(dir).filter((p) => norm(p.title) === want || norm(path.posix.basename(p.rel, '.md')) === want)
  if (hits.length === 1) return { rel: hits[0].rel, text: readFileSync(hits[0].abs, 'utf8') }
  if (hits.length > 1) throw new Error(`ambiguous page "${relRaw}": ${hits.map((p) => 'wiki/' + p.rel).join(', ')}`)
  throw new Error(`page not found: wiki/${rel0}`)
}

export function readPages(dir, paths) {
  const list = Array.isArray(paths) ? paths : [paths]
  if (!list.length) throw new Error('provide path or paths')
  const parts = []
  let total = 0
  for (const p of list) {
    const hit = resolveRead(dir, p)
    const { fm } = parsePage(hit.text)
    const flags = []
    if (fm.status === 'superseded') flags.push(`已被替代${fm.superseded_by ? ' → wiki/' + fm.superseded_by : ''}（请优先读替代页）`)
    if (fm.status === 'retracted') flags.push(`已撤回${fm.retractReason ? '（' + fm.retractReason + '）' : ''}——不要作为事实依据`)
    if (fm.trust === 'low') flags.push('低信任（模型派生，未锚定 raw 原文）')
    if (fm.trust === 'high') flags.push('高信任（用户确认）')
    const banner = flags.length ? `〔状态：${flags.join('；')}〕\n` : ''
    const slice = hit.text.length > READ_CHAR_CAP / list.length ? hit.text.slice(0, Math.floor(READ_CHAR_CAP / list.length)) + '\n…(truncated)' : hit.text
    total += slice.length
    parts.push(`===== wiki/${hit.rel} =====\n${banner}${slice}`)
  }
  return parts.join('\n\n') + `\n\n(read ${list.length} page(s), ${total} chars)`
}

// ---------------------------------------------------------------- search

function tokenizeQuery(q) {
  const lower = String(q).toLowerCase()
  const weights = new Map()
  const add = (t, w) => {
    const cur = weights.get(t)
    if (cur === undefined || w > cur) weights.set(t, w)
  }
  for (const m of lower.matchAll(/[a-z0-9_][a-z0-9_-]{1,}/g)) add(m[0], 1)
  for (const run of lower.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]+/g) || []) {
    if (run.length === 1) add(run, 1)
    for (let i = 0; i < run.length - 1; i++) add(run.slice(i, i + 2), 1)
    if (run.length >= 3) {
      // Longer exact CJK phrases are far more discriminative than bigrams.
      add(run, run.length >= 10 ? 14 : run.length >= 6 ? 9 : 5)
    }
  }
  // Symbol-bearing latin segments stay whole and weigh more ("b+ tree", "o(log n)"):
  // dropping them degrades such queries to a generic word like "tree". A compact
  // variant (spaces removed) is added too — corpora often write "O(logn)".
  for (const seg of lower.split(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]+/)) {
    const phrase = seg.trim().replace(/\s+/g, ' ')
    if (phrase.length >= 3 && /[^a-z0-9\s]/.test(phrase)) {
      add(phrase, 5)
      const compact = phrase.replace(/\s+/g, '')
      if (compact !== phrase && compact.length >= 3 && /[^a-z0-9]/.test(compact)) add(compact, 5)
    }
  }
  return [...weights.entries()].map(([t, w]) => ({ t, w }))
}
function countOcc(hay, needle, cap) {
  let n = 0, i = 0
  while (n < cap) {
    const j = hay.indexOf(needle, i)
    if (j < 0) break
    n++
    i = j + needle.length
  }
  return n
}
function snippet(body, tokens) {
  const lower = body.toLowerCase()
  let pos = -1
  for (const t of tokens) {
    const j = lower.indexOf(t)
    if (j >= 0 && (pos < 0 || j < pos)) pos = j
  }
  if (pos < 0) pos = 0
  const start = Math.max(0, pos - 60)
  return body.slice(start, start + 180).replace(/\s+/g, ' ').trim()
}

/**
 * Two-pass scorer shared by both scopes: count term frequencies first so
 * inverse document frequency can discount generic tokens ("锁" appears in
 * dozens of files), then score with 6x name / 3x tag boosts, full-coverage
 * bonus, and per-token weighting (symbol/CJK phrases weigh 5x).
 */
function scoreDocuments(docs, tokens) {
  const N = docs.length
  const counts = []
  const df = new Map()
  for (const doc of docs) {
    const m = new Map()
    for (const { t } of tokens) {
      const c = countOcc(doc.lower, t, 20)
      if (c > 0) { m.set(t, c); df.set(t, (df.get(t) || 0) + 1) }
    }
    counts.push(m)
  }
  const idf = (t) => Math.log(1 + N / (1 + (df.get(t) || 0)))
  const results = []
  docs.forEach((doc, i) => {
    const m = counts[i]
    let score = 0
    let matched = 0
    for (const { t, w } of tokens) {
      const c = m.get(t) || 0
      if (c > 0) matched++
      if (doc.name !== undefined && doc.name.includes(t)) score += 6 * w
      if (c > 0) score += Math.min(20, c) * w * idf(t)
      if (Array.isArray(doc.tags) && doc.tags.some((tag) => String(tag).toLowerCase().includes(t))) score += 3 * w
    }
    if (score > 0) {
      if (tokens.length > 1 && matched === tokens.length) score += 8
      results.push({ ...doc, score, snippet: snippet(doc.text, tokens.map((x) => x.t)) })
    }
  })
  return results
}

export function searchWiki(dir, query, limit = 15, scope = 'wiki') {
  const tokens = tokenizeQuery(query)
  const results = []
  let skipNote = ''
  if (scope === 'raw' || scope === 'all') {
    const { docs, skips } = readRawDocs(dir)
    const skipped = skipCount(skips)
    if (skipped) {
      skipNote = `\n\n覆盖声明：raw/ 有 ${skipped} 个文件未纳入检索（${describeSkips(skips)}），结果只覆盖其余 ${docs.length} 个文件。`
    }
    results.push(...scoreDocuments(docs.map((d) => ({
      label: d.rel,
      title: path.posix.basename(d.rel, '.md'),
      text: d.text,
      lower: d.text.toLowerCase(),
      name: path.posix.basename(d.rel).toLowerCase(),
    })), tokens))
  }
  if (scope === 'wiki' || scope === 'all') {
    const docs = listPages(dir)
      .filter((p) => p.fm.status !== 'retracted')
      .map((p) => ({
        label: 'wiki/' + p.rel,
        title: p.title,
        summary: p.fm.summary,
        text: p.body,
        lower: p.body.toLowerCase(),
        name: p.title.toLowerCase(),
        tags: p.fm.tags || [],
        status: p.fm.status || 'active',
        trust: p.fm.trust,
        supersededBy: p.fm.superseded_by,
      }))
    const scored = scoreDocuments(docs, tokens)
    for (const r of scored) if (r.status === 'superseded') r.score = Math.round(r.score * 35) / 100
    results.push(...scored)
  }
  results.sort((a, b) => b.score - a.score)
  const top = results.slice(0, Math.max(1, Math.min(30, limit)))
  const exhaustHint = looksExhaustive(query)
    ? `\n\n⚠ 穷尽/计数类意图检测：top-K 结果不能代表全库；请用 archivist_scan 获取精确计数与完整文件清单，并在回答中声明覆盖范围。`
    : ''
  if (!top.length) {
    return `no match for "${query}" (scope: ${scope}). Try other keywords, widen scope to 'all', or read wiki/index.md / wiki/overview.md directly.${exhaustHint}${skipNote}`
  }
  return top.map((r, i) => {
    const marks = []
    if (r.status === 'superseded') marks.push(`已被 ${r.supersededBy ? 'wiki/' + r.supersededBy : '其他页'} 替代`)
    if (r.trust === 'low') marks.push('低信任')
    const mark = marks.length ? `（${marks.join('；')}）` : ''
    return `${i + 1}. [${Math.round(r.score * 10) / 10}] ${r.label} — ${r.title}${mark}${r.summary ? ' | ' + r.summary : ''}\n   ${r.snippet}`
  }).join('\n') + exhaustHint + skipNote
}

// ---------------------------------------------------------------- scan
// Deterministic full-corpus scan for exhaustive / counting questions: exact
// occurrence counts over every eligible file, never a top-K sample.

/** Exact (uncapped) count of a lowercase needle in a lowercase haystack. */
function countAll(hay, needle) {
  let n = 0
  let i = 0
  while (needle.length > 0) {
    const j = hay.indexOf(needle, i)
    if (j < 0) break
    n++
    i = j + needle.length
  }
  return n
}

/** Heuristic: does the question ask for exhaustive / counting coverage? */
function looksExhaustive(q) {
  return /(全部|所有|每一个?|每次|每一项|从未|从来没有|一共|总共|合计|数量|多少个?|几条|几项|几次|哪些|清单|count|how many|list all|\ball\b|\bevery\b|\btotal\b)/i.test(String(q))
}

/**
 * Scan raw/ and/or wiki/ for an exact substring and report EXACT totals plus
 * every matching file (counts stay exact even when the file list is truncated).
 */
export function scanCorpus(dir, query, scope = 'all') {
  const needle = String(query ?? '').toLowerCase()
  if (!needle.trim()) throw new Error('scan requires a non-empty query')
  if (!['raw', 'wiki', 'all'].includes(scope)) throw new Error(`invalid scope "${scope}" — use raw | wiki | all`)
  const rows = []
  let total = 0
  let scanned = 0
  let skips = {}
  if (scope === 'raw' || scope === 'all') {
    const read = readRawDocs(dir)
    skips = read.skips
    for (const doc of read.docs) {
      scanned++
      const c = countAll(doc.text.toLowerCase(), needle)
      if (c > 0) { total += c; rows.push({ label: doc.rel, count: c }) }
    }
  }
  if (scope === 'wiki' || scope === 'all') {
    for (const p of listPages(dir)) {
      if (p.fm.status === 'retracted') continue
      scanned++
      const c = countAll(p.body.toLowerCase(), needle)
      if (c > 0) { total += c; rows.push({ label: 'wiki/' + p.rel, count: c }) }
    }
  }
  rows.sort((a, b) => b.count - a.count)
  const scopeText = scope === 'raw' ? 'raw/' : scope === 'wiki' ? 'wiki/' : 'raw/ + wiki/'
  const skipped = skipCount(skips)
  const head = `scan "${query}" (scope ${scope}): matched in ${rows.length} of ${scanned} scanned file(s)`
    + `${skipped ? ` (+${skipped} raw file(s) skipped, see 覆盖声明)` : ''}; total occurrences: ${total}`
  // Never claim a complete list while part of the corpus was left out.
  const coverage = skipped
    ? `已扫描 ${scopeText} ${scanned} 个符合条件的文件；未纳入 ${describeSkips(skips)} —— 本清单与计数不覆盖这些文件。`
    : `已扫描 ${scopeText} 全部 ${scanned} 个符合扩展名的文件。`
  if (!rows.length) {
    return `${head}\n覆盖声明：${coverage}未命中不等于不存在——检查拼写、别名或其他工作区。`
  }
  const truncated = rows.length > SCAN_ROW_CAP
  const shown = rows.slice(0, SCAN_ROW_CAP)
  const list = shown.map((r) => `- ${r.label} × ${r.count}`).join('\n')
  const more = truncated ? `\n…(另有 ${rows.length - SCAN_ROW_CAP} 个命中文件未显示)` : ''
  // The claim must describe this list *and* the files it left out: neither "全部命中文件"
  // nor an unqualified "计数准确" may survive dropped rows or skipped files.
  const scopeNote = skipped ? `（只统计已扫描的文件；另有 ${skipped} 个文件未扫描，其中可能仍有命中）` : ''
  const listClaim = truncated
    ? `清单截断：上表仅列出命中次数最多的 ${SCAN_ROW_CAP} 个文件，命中文件共 ${rows.length} 个${skipped ? scopeNote : '；出现次数与命中文件数均准确'}`
    : (skipped
        ? `以上为已扫描文件中的全部命中${scopeNote}`
        : '以上为全部命中文件（完整清单）')
  return `${head}\n${list}${more}\n覆盖声明：${listClaim}。${coverage}穷尽/统计类问题以此计数为准，不要用 top-K 检索结果代替。`
}

// ---------------------------------------------------------------- lint

export function lintWiki(dir, opts = {}) {
  const pages = listPages(dir)
  const byStem = new Map()
  const byRel = new Map()
  const byTitle = new Map()
  for (const p of pages) {
    byStem.set(path.basename(p.rel, '.md').toLowerCase(), p)
    byRel.set(p.rel.replace(/\.md$/i, '').toLowerCase(), p)
    byTitle.set(p.title.toLowerCase(), p)
  }
  const resolveLink = (target) => {
    const t = target.toLowerCase()
    return byTitle.get(t) || byStem.get(t) || byRel.get(t) || null
  }
  const inbound = new Map()
  const issues = []
  const missingCount = new Map()
  const titleSeen = new Map()

  for (const p of pages) {
    if (!p.fm.title) issues.push({ type: 'missing-frontmatter', page: p.rel, message: 'missing title in frontmatter' })
    if (!p.fm.type) issues.push({ type: 'missing-frontmatter', page: p.rel, message: 'missing type in frontmatter' })
    const tl = p.title.toLowerCase()
    if (titleSeen.has(tl)) issues.push({ type: 'duplicate-title', page: p.rel, message: `duplicate title "${p.title}" (also ${titleSeen.get(tl)})` })
    else titleSeen.set(tl, p.rel)
    for (const link of wikilinks(p.body)) {
      const hit = resolveLink(link)
      if (hit) inbound.set(hit.rel, (inbound.get(hit.rel) || 0) + 1)
      else {
        issues.push({ type: 'broken-link', page: p.rel, target: link, message: `[[${link}]] has no matching page` })
        missingCount.set(link, (missingCount.get(link) || 0) + 1)
      }
    }
    if (!p.body.trim()) issues.push({ type: 'empty-page', page: p.rel, message: 'empty body' })
  }
  for (const p of pages) {
    if (p.rel === 'overview.md') continue
    if (!inbound.get(p.rel)) issues.push({ type: 'orphan', page: p.rel, message: 'no inbound wikilinks' })
  }
  const missingPages = [...missingCount.entries()].filter(([, n]) => n >= 3).map(([name, n]) => ({ name, mentions: n }))
  // index coverage
  let indexText = ''
  try { indexText = readFileSync(path.join(dir, WIKI, 'index.md'), 'utf8') } catch { }
  const hrefs = new Set()
  for (const line of indexText.split('\n')) {
    const m = /^[-*+]\s+\[[^\]]*\]\(([^()]*)\)/.exec(line.trim())
    if (m) hrefs.add(decodeHref(fwd(m[1])).replace(/^\.\//, '').replace(/\.md$/i, '').toLowerCase())
  }
  for (const p of pages) {
    if (!hrefs.has(p.rel.replace(/\.md$/i, '').toLowerCase())) issues.push({ type: 'index-missing', page: p.rel, message: 'page missing from index.md (run archivist_index)' })
  }
  const relSet = new Set(pages.map((p) => p.rel.replace(/\.md$/i, '').toLowerCase()))
  for (const h of hrefs) {
    if (!relSet.has(h)) issues.push({ type: 'index-broken', page: 'index.md', target: h, message: `index links to missing page: ${h}` })
  }
  // trust / status validity and supersede-chain integrity
  const relIndex = new Map(pages.map((p) => [p.rel.replace(/\.md$/i, '').toLowerCase(), p]))
  const lookRel = (v) => relIndex.get(fwd(String(v)).replace(/^wiki\//, '').replace(/\.md$/i, '').toLowerCase())
  for (const p of pages) {
    if (p.fm.trust && !['high', 'medium', 'low'].includes(String(p.fm.trust))) {
      issues.push({ type: 'invalid-frontmatter', page: p.rel, message: `invalid trust "${p.fm.trust}" (use high|medium|low)` })
    }
    if (p.fm.status && !['active', 'superseded', 'retracted'].includes(String(p.fm.status))) {
      issues.push({ type: 'invalid-frontmatter', page: p.rel, message: `invalid status "${p.fm.status}" (use active|superseded|retracted)` })
    }
    if (p.fm.type && !PAGE_TYPES.includes(String(p.fm.type))) {
      issues.push({ type: 'invalid-frontmatter', page: p.rel, message: `invalid type "${p.fm.type}" (use ${PAGE_TYPES.join('|')})` })
    }
    // Frontmatter the plugin tolerates but a generic YAML parser rejects: an indented line with no
    // key above it. Reported once per page, because a writer may silently keep writing such a file.
    const rawFm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(p.raw)?.[1]
    if (rawFm !== undefined) {
      const fml = rawFm.split(/\r?\n/)
      const orphanAt = fml.findIndex((l, i) => {
        if (!/^\s+\S/.test(l)) return false
        let p = i - 1
        while (p >= 0 && fml[p].trim() === '') p--          // a block may follow a blank line
        const prev = fml[p] ?? ''
        if (/^\s+\S/.test(prev)) return false
        const pk = /^[A-Za-z_][\w-]*\s*:(.*)$/.exec(prev)
        return !(pk && opensBlockValue(pk[1]))
      })
      if (orphanAt >= 0) {
        issues.push({ type: 'unparseable-frontmatter', page: p.rel, message: `frontmatter line ${orphanAt + 1} is indented with no block header above it — YAML parsers either reject the page or fold it into the value above; rewrite it to repair` })
      }
    }
    if (p.fm.status === 'superseded') {
      if (!p.fm.superseded_by) {
        issues.push({ type: 'supersede-incomplete', page: p.rel, message: 'superseded page without superseded_by' })
      } else {
        const target = lookRel(p.fm.superseded_by)
        if (!target) {
          issues.push({ type: 'supersede-target-missing', page: p.rel, target: String(p.fm.superseded_by), message: 'superseded_by points to a missing page' })
        } else if (fwd(String(target.fm.supersedes || '')).replace(/^wiki\//, '').replace(/\.md$/i, '').toLowerCase() !== p.rel.replace(/\.md$/i, '').toLowerCase()) {
          issues.push({ type: 'supersede-mismatch', page: target.rel, target: p.rel, message: `replacement page does not list supersedes back to wiki/${p.rel}` })
        }
      }
    }
    if (p.fm.supersedes) {
      const old = lookRel(p.fm.supersedes)
      if (!old) {
        issues.push({ type: 'supersede-target-missing', page: p.rel, target: String(p.fm.supersedes), message: 'supersedes points to a missing page' })
      } else if (old.fm.status !== 'superseded') {
        issues.push({ type: 'supersede-incomplete', page: old.rel, message: `wiki/${p.rel} claims to replace this page but status is not superseded` })
      }
    }
  }
  const counts = {}
  for (const i of issues) counts[i.type] = (counts[i.type] || 0) + 1
  const summary = `lint: ${pages.length} page(s), ${issues.length} issue(s)${Object.keys(counts).length ? ' — ' + Object.entries(counts).map(([k, v]) => `${k}:${v}`).join(', ') : ' — clean'}`
  if (opts.fix) {
    rebuildIndex(dir)
    return summary + ' | index rebuilt'
  }
  return summary + (issues.length
    ? '\n' + issues.slice(0, 40).map((i) => `- [${i.type}] ${i.page ? 'wiki/' + i.page : ''}${i.target ? ' -> ' + i.target : ''}: ${i.message}`).join('\n')
      + (missingPages.length ? '\n- [missing-pages] frequently linked but not created: ' + missingPages.map((m) => `${m.name}(${m.mentions})`).join(', ') : '')
    : '')
}

// ---------------------------------------------------------------- log

export function appendLog(dir, line) {
  const f = path.join(dir, WIKI, 'log.md')
  ensure(f, LOG_HEADER)
  const entry = `## [${today()}] ${line.trim()}\n`
  writeFileSync(f, readFileSync(f, 'utf8').replace(/\s*$/, '\n\n') + entry)
  return `logged: ${entry.trim()}`
}
export function readLog(dir, n = 5) {
  // `slice(-0)` would return the whole log, so 0 must be handled explicitly.
  const take = Number.isFinite(Number(n)) ? Math.max(0, Math.trunc(Number(n))) : 5
  if (take === 0) return 'log: 0 entries requested — nothing to show'
  try {
    const text = readFileSync(path.join(dir, WIKI, 'log.md'), 'utf8')
    const entries = text.split(/^## /m).slice(1).map((s) => '## ' + s.trim())
    return entries.slice(-take).join('\n\n') || 'log is empty'
  } catch { return 'log is empty' }
}

// ---------------------------------------------------------------- status / estimate

export function estimateTokens(text) {
  let cjk = 0, other = 0
  for (const ch of text) {
    const c = ch.codePointAt(0)
    if ((c >= 0x3040 && c <= 0x30ff) || (c >= 0x3400 && c <= 0x4dbf) || (c >= 0x4e00 && c <= 0x9fff) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0x3000 && c <= 0x303f) || (c >= 0xff00 && c <= 0xffef)) cjk++
    else other++
  }
  return Math.round(cjk + other / 4)
}

export function statusWorkspace(dir) {
  requireWiki(dir)
  const pages = listPages(dir)
  const byType = {}
  for (const p of pages) byType[p.type || '(none)'] = (byType[p.type || '(none)'] || 0) + 1
  let wikiChars = 0, wikiTokens = 0
  for (const p of pages) { wikiChars += p.raw.length; wikiTokens += estimateTokens(p.raw) }
  const sources = listSources(dir)
  const srcCounts = { new: 0, changed: 0, ingested: 0 }
  for (const s of sources) srcCounts[s.status]++
  const trustCounts = { high: 0, medium: 0, low: 0, untagged: 0 }
  const statusCounts = { superseded: 0, retracted: 0 }
  for (const p of pages) {
    const k = ['high', 'medium', 'low'].includes(String(p.fm.trust)) ? String(p.fm.trust) : 'untagged'
    trustCounts[k]++
    if (p.fm.status === 'superseded') statusCounts.superseded++
    if (p.fm.status === 'retracted') statusCounts.retracted++
  }
  const ptr = readPointer()
  return [
    `workspace: ${dir}`,
    `pointer: ${ptr ? ptr.dir : '(none)'}${ptr && ptr.dir === dir ? ' (matches)' : ''}`,
    `pages: ${pages.length} (${Object.entries(byType).map(([k, v]) => `${k}:${v}`).join(', ') || 'empty'})${wikiTokens ? ` | ~${wikiTokens} tokens (estimate)` : ''}`,
    `trust: high:${trustCounts.high} medium:${trustCounts.medium} low:${trustCounts.low} untagged:${trustCounts.untagged} | superseded:${statusCounts.superseded} retracted:${statusCounts.retracted}`,
    `sources: ${sources.length} (new:${srcCounts.new}, changed:${srcCounts.changed}, ingested:${srcCounts.ingested})`,
    ptr?.dir && ptr.dir !== dir ? `warning: pointer points elsewhere (${ptr.dir}); use archivist_attach to switch` : '',
    `schema: ${path.join(dir, SCHEMA_FILE)}`,
    srcCounts.new + srcCounts.changed > 0 ? `hint: ${srcCounts.new + srcCounts.changed} raw source(s) pending ingest — see the Ingest workflow in AGENTS.md` : '',
    `--- last log ---`,
    readLog(dir, 3),
  ].filter(Boolean).join('\n')
}

// ---------------------------------------------------------------- backup

export function backupWorkspace(dir, target, keep = DEFAULT_KEEP) {
  const base = target ? path.resolve(target) : path.join(dir, '.backups')
  ensureDir(base)
  // `keep: 0` is a number, not a missing option — but never below one snapshot:
  // deleting the snapshot we just wrote would make the receipt a lie.
  const requested = Number(keep)
  const keepN = Number.isFinite(requested) ? Math.max(1, Math.trunc(requested)) : DEFAULT_KEEP
  let name = BACKUP_PREFIX + stamp()
  let n = 1
  while (existsSync(path.join(base, name))) { n++; name = BACKUP_PREFIX + stamp() + '-' + n }
  const dest = path.join(base, name)
  // Manual recursive copy: fs.cpSync refuses to copy a directory into its own
  // subtree, and the default backup target lives inside the workspace.
  let files = 0, bytes = 0
  const stack = ['']
  while (stack.length) {
    const rel = stack.pop()
    const cur = rel ? path.join(dir, rel.split('/').join(path.sep)) : dir
    for (const e of readdirSync(cur, { withFileTypes: true })) {
      const childRel = rel ? rel + '/' + e.name : e.name
      if (EXCLUDE_RE.test(childRel)) continue
      const childAbs = path.join(cur, e.name)
      if (e.isDirectory()) { stack.push(childRel); continue }
      const outAbs = path.join(dest, childRel.split('/').join(path.sep))
      ensureDir(path.dirname(outAbs))
      copyFileSync(childAbs, outAbs)
      files++
      bytes += statSync(childAbs).size
    }
  }
  writeFileSync(path.join(dest, 'backup-manifest.json'), JSON.stringify(
    { source: dir, createdAt: new Date().toISOString(), files, bytes }, null, 2,
  ))
  // Rotate only directories that strictly match our own snapshot naming scheme:
  // the target directory is often the user's own space (another drive / cloud
  // folder), so a look-alike name must never be deleted.
  const snapshots = []
  const unrecognized = []
  for (const e of readdirSync(base, { withFileTypes: true })) {
    if (!e.name.startsWith(BACKUP_PREFIX)) continue
    if (e.isDirectory() && SNAPSHOT_RE.test(e.name)) snapshots.push(e.name)
    else unrecognized.push(e.name)
  }
  snapshots.sort()
  let rotated = 0
  while (snapshots.length > keepN) {
    rmSync(path.join(base, snapshots.shift()), { recursive: true })
    rotated++
  }
  const skipNote = unrecognized.length
    ? ` | skipped ${unrecognized.length} unrecognized entr${unrecognized.length === 1 ? 'y' : 'ies'} (not deleted): ${unrecognized.slice(0, 5).join(', ')}${unrecognized.length > 5 ? ', …' : ''}`
    : ''
  return `backup: ${dest} (files: ${files}, bytes: ${bytes})${rotated ? ` | rotated ${rotated} old snapshot(s), keep=${keepN}` : ''}${skipNote}`
}

// ---------------------------------------------------------------- git (optional)

export function commitWorkspace(dir, message) {
  const git = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: dir, encoding: 'utf8' })
  if (git.error && git.error.code === 'ENOENT') {
    throw new Error('git is not installed — optional feature. Use archivist_backup for no-git snapshots.')
  }
  if (git.status === null) {
    // The spawn itself failed (e.g. a sandbox that forbids piped child processes): the
    // repository state is unknown, so never claim this directory is not a repository.
    throw new Error(`git could not be run here (${git.error?.code ?? 'spawn failed'}) — cannot tell whether ${dir} is a git repository. Run git where child processes are permitted, or use archivist_backup instead.`)
  }
  if (git.status !== 0 || !/true/.test(git.stdout)) {
    throw new Error(`${dir} is not a git repository — run "git init" there first, or use archivist_backup instead`)
  }
  // Pathspec "." keeps the staging area inside the workspace: `git add -A` alone
  // covers the whole work tree, which would sweep in unrelated files when the wiki
  // is only a subdirectory of an existing repository.
  const add = spawnSync('git', ['add', '-A', '--', '.'], { cwd: dir, encoding: 'utf8' })
  if (add.status !== 0) throw new Error('git add failed: ' + (add.stderr || '').trim())
  const msg = String(message || `wiki: update ${new Date().toISOString()}`)
  // Same pathspec on the commit: with a nested workspace, `git commit` alone would
  // also commit whatever the user had already staged in the parent repository.
  const commit = spawnSync('git', ['commit', '-m', msg, '--', '.'], { cwd: dir, encoding: 'utf8' })
  const out = ((commit.stdout || '') + (commit.stderr || '')).trim()
  const nothing = /nothing to commit|no changes added to commit/i.test(out)
  if (commit.status !== 0 && !nothing) throw new Error('git commit failed: ' + out)
  return nothing ? 'git: nothing to commit' : `git: committed — ${msg}`
}

// ---------------------------------------------------------------- tool table

const WS_PROP = { type: 'string', description: 'Optional workspace override (default: the active workspace from archivist_init / archivist_attach).' }

export const TOOLS = [
  {
    name: 'archivist_init',
    description: 'Create a local LLM Wiki workspace (raw/ + wiki/ + AGENTS.md schema) at an explicit path and register it as the active workspace. Idempotent: an existing workspace is re-attached, never overwritten. Pick a non-system drive and pair with archivist_backup so an OS reinstall cannot lose the wiki.',
    schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace directory (explicit), e.g. "D:/archivist".' },
        git: { type: 'boolean', description: 'Also run git init when git is available (optional; never required).' },
        force: { type: 'boolean', description: 'Re-scaffold missing files in an existing workspace.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    run: (a) => initWorkspace(a.path, { git: !!a.git, force: !!a.force }),
  },
  {
    name: 'archivist_attach',
    description: 'Point the plugin at an existing wiki workspace (e.g. after an OS reinstall, a folder move, or on a new machine). Validates it contains wiki/index.md.',
    schema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Existing workspace directory.' } },
      required: ['path'],
      additionalProperties: false,
    },
    run: (a) => attachWorkspace(a.path),
  },
  {
    name: 'archivist_status',
    description: 'Workspace overview: page counts, token estimate, trust/supersede counts, raw source states (new/changed/ingested), pointer path, last log entries, schema path.',
    schema: { type: 'object', properties: { workspace: WS_PROP }, additionalProperties: false },
    run: (a) => statusWorkspace(resolveDir(a.workspace)),
  },
  {
    name: 'archivist_sources',
    description: 'List raw/ source documents with ingest status: new / changed (hash vs manifest) / ingested.',
    schema: { type: 'object', properties: { workspace: WS_PROP }, additionalProperties: false },
    run: (a) => {
      const dir = resolveDir(a.workspace)
      requireWiki(dir)
      const s = listSources(dir)
      if (!s.length) return 'raw/ is empty — drop source files there, then ingest per the workspace AGENTS.md workflow'
      return s.map((x) => `- [${x.status}] ${x.rel} (${x.bytes}B)${x.page ? ' -> ' + x.page : ''}`).join('\n')
    },
  },
  {
    name: 'archivist_search',
    description: 'Search the knowledge base by keyword (CJK bigram aware) with snippets. Scope: wiki (compiled pages, default), raw (original source documents), or all. Superseded pages are downranked and annotated with their replacement; retracted pages are excluded and low-trust pages are marked. Read the top hits with archivist_read (raw hits with the normal file read tool) before answering.',
    schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords (required).' },
        limit: { type: 'number', description: 'Max results (default 15, max 30).' },
        scope: { type: 'string', enum: ['wiki', 'raw', 'all'], description: 'Search scope: compiled wiki pages, raw source documents, or both.' },
        workspace: WS_PROP,
      },
      required: ['query'],
      additionalProperties: false,
    },
    run: (a) => searchWiki(resolveDir(a.workspace), String(a.query ?? ''), a.limit ? Number(a.limit) : 15, String(a.scope || 'wiki')),
  },
  {
    name: 'archivist_scan',
    description: 'Deterministic full-corpus scan (no top-K truncation): counts EXACT occurrences of a substring across raw/ and/or wiki/ and lists the matching files (up to 60 rows; beyond that the list is explicitly marked truncated with the number of files not shown, while the occurrence count and the matched-file count stay exact), plus a coverage statement. Use for exhaustive or counting questions ("all", "every", "how many", "list all") and state the coverage in the answer; use archivist_search for relevance-ranked lookup instead.',
    schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Exact substring to count (case-insensitive).' },
        scope: { type: 'string', enum: ['raw', 'wiki', 'all'], description: 'What to scan; defaults to all (raw/ + wiki/).' },
        workspace: WS_PROP,
      },
      required: ['query'],
      additionalProperties: false,
    },
    run: (a) => scanCorpus(resolveDir(a.workspace), String(a.query ?? ''), String(a.scope || 'all')),
  },
  {
    name: 'archivist_read',
    description: 'Read one or more wiki pages by path (e.g. "concepts/Foo.md"), including frontmatter. A status banner shows trust tier and superseded/retracted state. Batch to follow cross-references.',
    schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Page path relative to wiki/, e.g. "concepts/Foo.md".' },
        paths: { type: 'array', items: { type: 'string' }, description: 'Multiple page paths to read in one call.' },
        workspace: WS_PROP,
      },
      additionalProperties: false,
    },
    run: (a) => readPages(resolveDir(a.workspace), a.paths || a.path),
  },
  {
    name: 'archivist_write',
    description: 'Create or update a wiki page (or retract one). Validates and auto-fills frontmatter (title/type/tags/sources/summary/trust/status/last_updated); rebuilds index.md; sourceFile marks a raw source ingested (trust defaults to medium, otherwise low); supersedes marks the target page superseded (corrections never overwrite history); retract flips a page to retracted with a reason; log appends a log entry. raw/ stays read-only.',
    schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Wiki-relative page path, e.g. "concepts/Foo.md". Optional when title + dir are given.' },
        rel: { type: 'string', description: 'Alias of path (kept for scripts and older callers).' },
        title: { type: 'string', description: 'Page title (used to derive the filename when path is omitted).' },
        dir: { type: 'string', enum: ['sources', 'entities', 'concepts', 'syntheses'], description: 'Target folder (default: concepts) when path is omitted.' },
        type: { type: 'string', enum: ['source', 'entity', 'concept', 'synthesis'], description: 'Frontmatter type; defaults from the target folder (wiki-root pages default to synthesis).' },
        body: { type: 'string', description: 'Markdown body; use [[Page Title]] wikilinks for cross-references.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags.' },
        sources: { type: 'array', items: { type: 'string' }, description: 'Raw source references backing this page.' },
        summary: { type: 'string', description: 'One-line summary shown in index.md.' },
        trust: { type: 'string', enum: ['high', 'medium', 'low'], description: 'Trust tier; defaults to medium when sourceFile is given, otherwise low.' },
        status: { type: 'string', enum: ['active', 'superseded', 'retracted'], description: 'Page status; normally maintained by the supersedes/retract flows.' },
        supersedes: { type: 'string', description: 'Wiki-relative path of the page this one replaces; the old page is automatically marked superseded (history is preserved).' },
        retract: { type: 'boolean', description: 'Retract the existing page (status -> retracted) without editing its body.' },
        retractReason: { type: 'string', description: 'Reason recorded when retract is true.' },
        sourceFile: { type: 'string', description: 'Raw source path (e.g. "raw/foo.md") to mark ingested by this page.' },
        log: { type: 'string', description: 'Append this log entry, e.g. "ingest | Title".' },
        index: { type: 'boolean', description: 'Set false to skip the automatic index rebuild (bulk edits); run archivist_index once afterwards.' },
        workspace: WS_PROP,
      },
      additionalProperties: false,
    },
    run: (a) => writePage(resolveDir(a.workspace), a),
  },
  {
    name: 'archivist_index',
    description: 'Deterministically rebuild wiki/index.md from all pages (repairs drift). Run after bulk edits or when lint reports index-missing.',
    schema: { type: 'object', properties: { workspace: WS_PROP }, additionalProperties: false },
    run: (a) => {
      const dir = resolveDir(a.workspace)
      requireWiki(dir)
      const n = rebuildIndex(dir)
      return `index rebuilt: ${n} page(s) listed`
    },
  },
  {
    name: 'archivist_lint',
    description: 'Structural health check: broken wikilinks, orphan pages, missing frontmatter, duplicate titles, index coverage, frequently linked-but-missing pages, invalid trust/status values, and supersede-chain integrity. Use fix:true to also rebuild index.md.',
    schema: {
      type: 'object',
      properties: {
        fix: { type: 'boolean', description: 'Also rebuild index.md (safe, deterministic).' },
        workspace: WS_PROP,
      },
      additionalProperties: false,
    },
    run: (a) => lintWiki(resolveDir(a.workspace), { fix: !!a.fix }),
  },
  {
    name: 'archivist_log',
    description: 'Append a log entry (format: "## [YYYY-MM-DD] action | title") or read the last entries.',
    schema: {
      type: 'object',
      properties: {
        line: { type: 'string', description: 'Entry to append (e.g. "ingest | Title").' },
        read: { type: 'number', description: 'Read the last N entries instead of appending.' },
        workspace: WS_PROP,
      },
      additionalProperties: false,
    },
    run: (a) => {
      const dir = resolveDir(a.workspace)
      requireWiki(dir)
      return a.read !== undefined ? readLog(dir, Number(a.read)) : appendLog(dir, String(a.line || 'update'))
    },
  },
  {
    name: 'archivist_backup',
    description: 'No-git snapshot backup: copies the workspace (excluding .git/.backups) to a timestamped folder and rotates old snapshots. Point target at another drive or a cloud-synced folder to survive OS reinstalls. Git is optional and not required.',
    schema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Backup directory (default: <workspace>/.backups). Prefer another drive or a cloud-synced folder.' },
        keep: { type: 'number', description: 'Snapshots to keep (default 10, minimum 1; 0 is clamped to 1 because the snapshot just written must be retained).' },
        workspace: WS_PROP,
      },
      additionalProperties: false,
    },
    run: (a) => backupWorkspace(resolveDir(a.workspace), a.target, a.keep !== undefined ? Number(a.keep) : DEFAULT_KEEP),
  },
  {
    name: 'archivist_commit',
    description: 'Optional: git add + commit the workspace (requires git installed and the workspace to be a git repo). Use archivist_backup when git is unavailable.',
    schema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Commit message.' },
        workspace: WS_PROP,
      },
      additionalProperties: false,
    },
    run: (a) => commitWorkspace(resolveDir(a.workspace), a.message),
  },
]

/**
 * Run one tool after rejecting undeclared arguments.
 *
 * dsh compiles this table's `properties` into an implicit OPEN object root, so the
 * parameters root cannot express `additionalProperties: false`; and a direct `run()`
 * call bypasses the raw schema the other hosts receive. Without this check a
 * misspelled key is dropped silently while the operation still reports success.
 * @param {{name: string, schema: {properties?: Record<string, unknown>}, run: (a: Record<string, unknown>) => string}} tool - Entry from {@link TOOLS}.
 * @param {Record<string, unknown>} args - Arguments supplied by the host or the CLI.
 * @returns {string} The tool result.
 */
export function runTool(tool, args) {
  const given = Object.keys(args ?? {})
  const declared = Object.keys(tool.schema?.properties ?? {})
  const unknown = given.filter((k) => !declared.includes(k))
  if (unknown.length) {
    throw new Error(`${tool.name}: unknown parameter(s) ${unknown.map((k) => `"${k}"`).join(', ')} — declared: ${declared.join(', ')}`)
  }
  return tool.run(args ?? {})
}

// ---------------------------------------------------------------- CLI (host-independent self-test)

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isMain) {
  const [, , name, ...rest] = process.argv
  if (!name || name === '--help') {
    console.log('usage: node archivist.mjs <tool> \'<json-args>\'')
    console.log('   or: node archivist.mjs <tool> --key=value --flag ...   (Windows-friendly, no JSON quoting)')
    console.log('tools: ' + TOOLS.map((t) => t.name).join(', '))
    process.exit(0)
  }
  const tool = TOOLS.find((t) => t.name === name)
  if (!tool) { console.error('unknown tool: ' + name); process.exit(1) }
  let args = {}
  if (rest.length === 1 && rest[0].trim().startsWith('{')) {
    try { args = JSON.parse(rest[0]) } catch (e) { console.error('bad json args: ' + e.message); process.exit(1) }
  } else {
    for (const token of rest) {
      const m = /^--([^=]+)(?:=(.*))?$/.exec(token)
      if (!m) { console.error('bad flag (expected --key=value): ' + token); process.exit(1) }
      const key = m[1].replace(/-/g, '_')
      let val = m[2]
      if (val === undefined) val = true
      else if (val === 'true' || val === 'false') val = val === 'true'
      else if (/^-?\d+(\.\d+)?$/.test(val)) val = Number(val)
      args[key] = val
    }
  }
  try {
    const out = runTool(tool, args)
    console.log(out)
  } catch (e) {
    console.error('error: ' + e.message)
    process.exit(1)
  }
}
