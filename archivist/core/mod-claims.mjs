// mod-claims.mjs — Phase 4 派生知识层：claims 存储/校验/查询/冲突检测（p4-contract §1–§3）。owner: impl-tools
//
// 存储：<workspace>/wiki/claims/<slug>.jsonl（append-only）。每行一条**完整 claim 记录**；同一
// claim_id 的后续行覆盖前一行，读取时按 claim_id fold 出最新状态。claims 是可重抽的派生数据
// （不是索引）：放 wiki/ 下以便随备份一起走，删掉可 reindex/重抽，但真相仍在 wiki/raw 页面。
//
// 公开 API（工具接线由 Lead 做；本文件是唯一权威签名）：
//   ensureClaimsSchema(db, dir?)                      建表/索引/meta.claims_version；版本不符且给 dir → 自动 reindex
//                                                     → { created, rebuilt, version, claims }
//   claimsAdd(dir, db, {claims, file?})               逐条校验后 append；
//       claims: [{subject, predicate, object, object_type?, validFrom?, validTo?, anchor, quote,
//                 confidence?, extractor_ver?, page?}]
//                                                     → { added, skipped, rejected:[{index,reason}],
//                                                         conflicts:[{claim_id, subject, predicate,
//                                                                     oldObject, newObject, newClaimId, validFrom}],
//                                                         warnings:[{index,message}], written:{file,lines} }
//   claimsSupersede(dir, db, {claimId, newObject?, validFrom?, reason?, anchor?, quote?})
//                                                     → { ok, oldClaim, newClaim, reason? }
//   claimsRetract(dir, db, {claimId, reason?})         → { ok, claim, already? }
//   claimsList(dir, db, {subject?, predicate?, page?, asOf?, status?='active', limit?=50})
//                                                     → { claims:[claim & {orphaned, pageMissing}], total, truncated }
//   claimsConflicts(dir, db, {subject?, limit?})       → { conflicts:[{subject, predicate, objects, claims}], total, claimsChecked }
//   claimsReindex(db, dir)                            从 wiki/claims/*.jsonl 全量重建表 → {files, lines, badLines, claims, inserted}
//   claimsForPack(dir, db, {pagePaths?, query?, limit?=10, asOf?})
//                                                     证据包集成：命中的 active claims（≤limit）与 conflicts
//   claimsCountsByPage(db, pagePaths)                 → { [page_path]: activeCount }（search 行尾〔claims: N active〕用）
//   claimsStats(db)                                   → { total, active, superseded, retracted, pages }
//
// 写域/依赖：本文件只 import node:* 与 './mod-chunks.mjs'（parseAnchor/tokenize）。不 import core/indexdb。
// 命名空间：内部辅助符号全部 cl_ 前缀（build 内联后与其它模块共用顶层作用域）。
// 限制：插件不做抽取、不做 NLI；claim 只是"带原文锚点的结构化断言"，冲突检测是机械的
// (subject_norm, predicate_norm) + 不同 object，不判断语义是否真的矛盾。
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { parseAnchor, tokenize } from './mod-chunks.mjs'

const cl_CLAIMS_VERSION = 1
const cl_CLAIMS_DIR = 'wiki/claims'

const cl_CLAIMS_DDL = `
CREATE TABLE IF NOT EXISTS claims (
  claim_id TEXT PRIMARY KEY,
  subject TEXT NOT NULL, subject_norm TEXT NOT NULL,
  predicate TEXT NOT NULL, predicate_norm TEXT NOT NULL,
  object TEXT NOT NULL, object_type TEXT,
  valid_from TEXT, valid_to TEXT,
  anchor TEXT NOT NULL, quote TEXT NOT NULL,
  confidence REAL, extractor_ver TEXT,
  status TEXT NOT NULL, superseded_by TEXT, reason TEXT, created_at TEXT,
  page_path TEXT, chunk_id INTEGER
);
CREATE INDEX IF NOT EXISTS claims_sp ON claims(subject_norm, predicate_norm, status);
CREATE INDEX IF NOT EXISTS claims_page ON claims(page_path);
-- list 默认 (status=active, ORDER BY subject_norm,predicate_norm,valid_from,claim_id) 的覆盖索引：
-- 5000 条时无它需全表排序（p95 30ms+），有它可以走索引有序扫描 + LIMIT 提前终止。
CREATE INDEX IF NOT EXISTS claims_list ON claims(status, subject_norm, predicate_norm, valid_from, claim_id);
-- conflicts 的 GROUP BY subject_norm,predicate_norm + count(DISTINCT object) 覆盖索引：
-- 无它时 5000 条要回表 5000 次（p50 ~30ms），有它只扫索引。
CREATE INDEX IF NOT EXISTS claims_conflict ON claims(status, subject_norm, predicate_norm, object);
`
const cl_META_DDL = 'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)'

const cl_INSERT_SQL = `INSERT OR REPLACE INTO claims(
  claim_id, subject, subject_norm, predicate, predicate_norm, object, object_type,
  valid_from, valid_to, anchor, quote, confidence, extractor_ver, status, superseded_by,
  reason, created_at, page_path, chunk_id
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`

const cl_MAX_LIMIT = 500

// ---------------------------------------------------------------- 基础工具

const cl_str = (v) => (v === undefined || v === null ? '' : String(v).trim())
const cl_norm = (v) => String(v ?? '')
  .normalize('NFC')
  .replace(/[\uff01-\uff5e]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
  .replace(/\u3000/g, ' ')
  .replace(/[\u00ad\u200b-\u200d\u2060\ufeff]/g, '')
  .toLowerCase()
  .replace(/\s+/g, ' ')
  .trim()
const cl_normPath = (v) => String(v ?? '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').trim()
const cl_isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v ?? '').trim())
const cl_today = () => new Date().toISOString().slice(0, 10)

/** FK 安全的表内计数（表不存在 → 0）。 */
function cl_count(db, table) {
  try { return Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n) || 0 } catch { return 0 }
}

function cl_limit(v, dflt, hi = cl_MAX_LIMIT) {
  const n = Math.trunc(Number(v))
  if (!Number.isFinite(n) || n <= 0) return dflt
  return Math.min(hi, n)
}

/** 工作区相对路径的安全解析：拒绝绝对路径、`..`、越界。 */
function cl_resolve(dir, relRaw) {
  const rel = cl_normPath(relRaw)
  if (!rel) return null
  if (rel.split('/').includes('..')) return null
  const base = path.resolve(String(dir))
  const abs = path.resolve(base, rel)
  if (abs !== base && !abs.startsWith(base + path.sep)) return null
  return { rel, abs }
}

function cl_splitFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(String(text ?? ''))
  if (!m) return { body: String(text ?? ''), fm: '' }
  return { body: String(text).slice(m[0].length), fm: m[1] }
}

function cl_fmField(fm, key) {
  const m = new RegExp('^' + key + ':\\s*(.*)$', 'm').exec(fm || '')
  return m ? m[1].replace(/\s+#.*$/, '').trim().replace(/^["']|["']$/g, '').trim() : ''
}

function cl_sha8(buf) {
  return createHash('sha256').update(buf).digest('hex').slice(0, 8)
}

function cl_claimId(subjectNorm, predicateNorm, object, anchor) {
  const h = createHash('sha256')
    .update(`${subjectNorm}\u0000${predicateNorm}\u0000${object}\u0000${anchor}`)
    .digest('hex')
  return 'c_' + h.slice(0, 8)
}

const cl_OBJECT_TYPES = new Set(['string', 'number', 'date', 'bool'])
function cl_confidence(v) {
  if (v === undefined || v === null || v === '') return null
  const n = Number(v)
  if (!Number.isFinite(n)) return null
  return Math.min(1, Math.max(0, n))
}
function cl_objectType(given, object) {
  const g = cl_str(given)
  if (cl_OBJECT_TYPES.has(g)) return g
  const s = cl_str(object)
  if (/^-?\d+(?:\.\d+)?$/.test(s)) return 'number'
  if (cl_isDate(s)) return 'date'
  if (/^(true|false)$/i.test(s)) return 'bool'
  return 'string'
}

/** claim 的对外形状（JSONL 合同字段；page_path 为附加派生字段）。 */
function cl_public(rec) {
  return {
    claim_id: rec.claim_id,
    subject: rec.subject,
    predicate: rec.predicate,
    object: rec.object,
    object_type: rec.object_type || 'string',
    valid_from: rec.valid_from ?? null,
    valid_to: rec.valid_to ?? null,
    anchor: rec.anchor,
    quote: rec.quote,
    confidence: rec.confidence === undefined || rec.confidence === null ? null : Number(rec.confidence),
    extractor_ver: rec.extractor_ver || '',
    status: rec.status || 'active',
    superseded_by: rec.superseded_by ?? null,
    reason: rec.reason || '',
    created_at: rec.created_at || '',
    page_path: rec.page_path || '',
  }
}

/** 落盘时只写合同字段 + page_path，剥掉 fold 用的内部键。 */
function cl_persistLine(rec) {
  return JSON.stringify(cl_public(rec))
}

// ---------------------------------------------------------------- 锚点 / 页面校验

/**
 * 写入前校验：anchor 可解析、(sha8 若给出) 与当前文件一致、quote 归一化后是 cited span
 * （无 span 则整页 body）的子串。返回 { ok, pagePath, warn } 或 { ok:false, reason }。
 */
function cl_verifyAnchor(dir, anchor, quote) {
  const raw = cl_str(anchor)
  if (!raw) return { ok: false, reason: 'anchor 为空：没有原文锚定的 claim 不允许入库' }
  const a = parseAnchor(raw)
  const loc = cl_resolve(dir, a.path)
  if (!loc) return { ok: false, reason: `anchor path 非法或越出工作区：${a.path || '(空)'}` }
  let buf
  try { buf = readFileSync(loc.abs) } catch { return { ok: false, reason: `anchor 指向的文件不存在：${loc.rel}` } }
  const sha8 = cl_sha8(buf)
  if (a.sha8 && a.sha8 !== sha8) return { ok: false, reason: `anchor version mismatch: ${a.sha8} != current ${sha8}` }
  const { body } = cl_splitFrontmatter(buf.toString('utf8'))
  let cited = body
  let where = 'page body'
  const hasSpan = Number.isFinite(a.start) && Number.isFinite(a.end)
  if (hasSpan) {
    if (a.start < 0 || a.end > body.length || a.end <= a.start) {
      return { ok: false, reason: `anchor span [${a.start}:${a.end}] 越界（正文 ${body.length} 字符）` }
    }
    cited = body.slice(a.start, a.end)
    where = `span [${a.start}:${a.end}]`
  }
  const q = cl_norm(quote)
  if (!q) return { ok: false, reason: 'quote 为空：没有原文锚定的 claim 不允许入库' }
  if (!cl_norm(cited).includes(q)) return { ok: false, reason: `quote not found in ${where}` }
  return {
    ok: true,
    pagePath: loc.rel,
    warn: hasSpan ? '' : `anchor 只有 ord 没有 [start:end]，quote 按整页正文核验`,
  }
}

/** 页面状态（retract 联动用）；每次调用内用 Map 缓存，不跨调用缓存以感知最新状态。 */
function cl_pageStatus(dir, pagePath) {
  const loc = cl_resolve(dir, pagePath)
  if (!loc) return { exists: false, status: '' }
  let text
  try { text = readFileSync(loc.abs, 'utf8') } catch { return { exists: false, status: '' } }
  const { fm } = cl_splitFrontmatter(text)
  return { exists: true, status: cl_fmField(fm, 'status').toLowerCase() }
}

function cl_orphanInfo(dir, pagePath, cache) {
  if (!pagePath) return { orphaned: false, pageMissing: false }
  let st = cache.get(pagePath)
  if (st === undefined) { st = cl_pageStatus(dir, pagePath); cache.set(pagePath, st) }
  return { orphaned: st.exists && st.status === 'retracted', pageMissing: !st.exists }
}

// ---------------------------------------------------------------- JSONL 存储

function cl_claimFile(dir, file) {
  const raw = cl_str(file) || 'claims'
  const base = raw.replace(/\\/g, '/')
  if (base.includes('..') || base.startsWith('/') || /^[A-Za-z]:/.test(base)) {
    throw new Error(`claims 文件名非法（不允许路径）：${raw}`)
  }
  const name = path.posix.basename(base).replace(/\.jsonl$/i, '')
  const clean = name.replace(/[\\/:*?"<>|#]+/g, '-').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
  if (!clean) throw new Error(`claims 文件名非法：${raw}`)
  const rel = path.posix.join(cl_CLAIMS_DIR, clean + '.jsonl')
  return { rel, abs: path.join(String(dir), cl_CLAIMS_DIR, clean + '.jsonl') }
}

function cl_appendLines(dir, rel, lines) {
  if (!lines.length) return 0
  const loc = cl_resolve(dir, rel)
  if (!loc) throw new Error(`claims 文件路径越界：${rel}`)
  mkdirSync(path.dirname(loc.abs), { recursive: true })
  appendFileSync(loc.abs, lines.join('\n') + '\n', 'utf8')
  return lines.length
}

/** 读全部 jsonl 并按 claim_id fold：同一 id 后者覆盖前者（允许部分字段 patch）。 */
function cl_readEvents(dir) {
  const out = { files: 0, lines: 0, badLines: 0, events: new Map() }
  const relDir = cl_CLAIMS_DIR
  let entries
  try { entries = readdirSync(path.join(String(dir), relDir), { withFileTypes: true }) } catch { return out }
  const names = entries.filter((e) => e.isFile() && e.name.endsWith('.jsonl')).map((e) => e.name).sort()
  for (const name of names) {
    const rel = path.posix.join(relDir, name)
    let text
    try { text = readFileSync(path.join(String(dir), relDir, name), 'utf8') } catch { continue }
    out.files++
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim()
      if (!t) continue
      out.lines++
      let rec
      try { rec = JSON.parse(t) } catch { out.badLines++; continue }
      if (!rec || typeof rec.claim_id !== 'string' || !rec.claim_id) { out.badLines++; continue }
      const prev = out.events.get(rec.claim_id)
      out.events.set(rec.claim_id, { ...(prev || {}), ...rec, _file: rel })
    }
  }
  return out
}

/** 找到含某 claim_id 的文件（最近一次事件所在文件）；找不到返回 null。 */
function cl_findClaimFile(dir, claimId) {
  const ev = cl_readEvents(dir)
  const rec = ev.events.get(claimId)
  return rec ? { events: ev, record: rec, file: rec._file } : { events: ev, record: null, file: null }
}

// ---------------------------------------------------------------- 实体页（subject 规范化检查）

function cl_entityNorm(s) {
  return cl_norm(s).replace(/[\s\-_]/g, '')
}

/** entities/*.md 的标题/文件名 → 规范名映射（每次 add 调用建一次，量小）。 */
function cl_entityPages(dir) {
  const out = new Map()
  const absDir = path.join(String(dir), 'wiki', 'entities')
  let entries
  try { entries = readdirSync(absDir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.md')) continue
    const rel = path.posix.join('wiki', 'entities', e.name)
    let text = ''
    try { text = readFileSync(path.join(absDir, e.name), 'utf8') } catch { /* 不可读就跳过 */ }
    const { fm } = cl_splitFrontmatter(text)
    const title = cl_fmField(fm, 'title') || path.basename(e.name, '.md')
    out.set(cl_entityNorm(title), rel)
    out.set(cl_entityNorm(path.basename(e.name, '.md')), rel)
  }
  return out
}

function cl_entityMatch(map, subject) {
  return map.has(cl_entityNorm(subject))
}

// ---------------------------------------------------------------- SQLite 行读写

function cl_rowToClaim(row) {
  return {
    claim_id: row.claim_id,
    subject: row.subject,
    predicate: row.predicate,
    object: row.object,
    object_type: row.object_type || 'string',
    valid_from: row.valid_from ?? null,
    valid_to: row.valid_to ?? null,
    anchor: row.anchor,
    quote: row.quote,
    confidence: row.confidence === null || row.confidence === undefined ? null : Number(row.confidence),
    extractor_ver: row.extractor_ver || '',
    status: row.status,
    superseded_by: row.superseded_by ?? null,
    reason: row.reason || '',
    created_at: row.created_at || '',
    page_path: row.page_path || '',
    chunk_id: row.chunk_id === null || row.chunk_id === undefined ? null : Number(row.chunk_id),
  }
}

function cl_chunkIdFor(db, pagePath, ord) {
  if (!pagePath || ord === undefined || ord === null) return null
  try {
    const row = db.prepare(
      'SELECT c.chunk_id AS id FROM chunks c JOIN docs d ON d.doc_id = c.doc_id WHERE d.path = ? AND c.ord = ? LIMIT 1',
    ).get(cl_normPath(pagePath), Number(ord))
    return row ? Number(row.id) : null
  } catch { return null }
}

function cl_metaGet(db, key) {
  try { const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key); return row ? String(row.value) : null } catch { return null }
}
function cl_metaSet(db, key, value) {
  db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run(key, String(value))
}

function cl_tx(db, fn) {
  let opened = false
  try { db.exec('BEGIN IMMEDIATE'); opened = true } catch { opened = false }
  try {
    const out = fn()
    if (opened) db.exec('COMMIT')
    return out
  } catch (err) {
    if (opened) { try { db.exec('ROLLBACK') } catch { /* 已回滚/不可回滚 */ } }
    throw err
  }
}

function cl_upsertRecords(db, records) {
  if (!records.length) return 0
  let n = 0
  cl_tx(db, () => {
    const st = db.prepare(cl_INSERT_SQL)
    for (const rec of records) {
      const claim = cl_public(rec)
      const a = parseAnchor(claim.anchor)
      const pagePath = claim.page_path || (a.path || '')
      const chunkId = rec.chunk_id !== undefined && rec.chunk_id !== null ? rec.chunk_id : cl_chunkIdFor(db, pagePath, a.ord)
      st.run(
        claim.claim_id, claim.subject, cl_norm(claim.subject), claim.predicate, cl_norm(claim.predicate),
        claim.object, claim.object_type, claim.valid_from, claim.valid_to, claim.anchor, claim.quote,
        claim.confidence, claim.extractor_ver, claim.status, claim.superseded_by, claim.reason,
        claim.created_at, cl_normPath(pagePath), chunkId,
      )
      n++
    }
  })
  return n
}

function cl_upsertOne(db, rec) { cl_upsertRecords(db, [rec]) }

/** 尽力把 jsonl 事件同步进 claims 表；失败只 warning，不影响 jsonl 真相。 */
function cl_trySync(db, records, warnings) {
  if (!db || !records.length) return
  try { cl_upsertRecords(db, records) } catch (err) {
    warnings.push({ index: -1, message: `claims 表同步失败（jsonl 已写入，可 reindex 修复）：${err && err.message ? err.message : err}` })
  }
}

// ---------------------------------------------------------------- 公开 API：schema / 重建

/**
 * 建 claims 表/索引；用 meta.claims_version 标记（不动 indexdb 的 schema_version）。
 * 版本不符且提供了 dir → 从 wiki/claims/*.jsonl 全量重建（自愈）。
 */
export function ensureClaimsSchema(db, dir) {
  if (!db) throw new Error('ensureClaimsSchema 需要 SQLite db 句柄')
  let created = false
  try { created = !db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='claims'").get() } catch { created = true }
  db.exec(cl_META_DDL)
  db.exec(cl_CLAIMS_DDL)
  const version = cl_metaGet(db, 'claims_version')
  let rebuilt = false
  let claims = cl_count(db, 'claims')
  if (version !== String(cl_CLAIMS_VERSION)) {
    if (dir) {
      const res = claimsReindex(db, dir)
      rebuilt = true
      claims = res.claims
    }
  }
  return { created, rebuilt, version: String(cl_CLAIMS_VERSION), claims }
}

/** 从 jsonl 全量重建 claims 表；幂等（重复跑行数不变）。 */
export function claimsReindex(db, dir) {
  if (!db) throw new Error('claimsReindex 需要 SQLite db 句柄')
  db.exec(cl_META_DDL)
  db.exec(cl_CLAIMS_DDL)
  const ev = cl_readEvents(dir)
  const records = [...ev.events.values()]
  cl_tx(db, () => {
    db.exec('DELETE FROM claims')
    const st = db.prepare(cl_INSERT_SQL)
    for (const rec of records) {
      const claim = cl_public(rec)
      const a = parseAnchor(claim.anchor)
      const pagePath = claim.page_path || (a.path || '')
      st.run(
        claim.claim_id, claim.subject, cl_norm(claim.subject), claim.predicate, cl_norm(claim.predicate),
        claim.object, claim.object_type, claim.valid_from, claim.valid_to, claim.anchor, claim.quote,
        claim.confidence, claim.extractor_ver, claim.status, claim.superseded_by, claim.reason,
        claim.created_at, cl_normPath(pagePath), cl_chunkIdFor(db, pagePath, a.ord),
      )
    }
  })
  cl_metaSet(db, 'claims_version', cl_CLAIMS_VERSION)
  return { files: ev.files, lines: ev.lines, badLines: ev.badLines, claims: records.length, inserted: records.length }
}

// ---------------------------------------------------------------- 公开 API：add / supersede / retract

/**
 * 批量 add。逐条校验（anchor/quote 必须能回到原文 span；subject 对不上 entities 只 warning），
 * 通过校验的 append 进 wiki/claims/<file>.jsonl（同 claim_id 幂等跳过），并同步 claims 表。
 * 同 (subject_norm, predicate_norm) 已有 active 且 object 不同 → 不拒绝，作为 conflicts 返回。
 */
export function claimsAdd(dir, db, args = {}) {
  const list = Array.isArray(args.claims) ? args.claims : null
  if (!list || !list.length) throw new Error('claimsAdd 需要 claims 数组（至少 1 条）')
  const fileInfo = cl_claimFile(dir, args.file)
  const ev = cl_readEvents(dir)
  const entities = cl_entityPages(dir)
  const added = []
  const skipped = []
  const rejected = []
  const warnings = []
  const conflicts = []
  const addedById = new Map()
  const activeGroups = new Map()
  for (const rec of ev.events.values()) {
    if ((rec.status || 'active') !== 'active') continue
    const key = cl_norm(rec.subject) + '\u0000' + cl_norm(rec.predicate)
    let g = activeGroups.get(key)
    if (!g) { g = []; activeGroups.set(key, g) }
    g.push(rec)
  }
  const nowIso = new Date().toISOString()
  const lines = []
  for (let i = 0; i < list.length; i++) {
    const c = list[i] || {}
    const subject = cl_str(c.subject)
    const predicate = cl_str(c.predicate)
    const object = cl_str(c.object)
    const anchor = cl_str(c.anchor)
    const quote = cl_str(c.quote)
    if (!subject) { rejected.push({ index: i, reason: 'subject 为空' }); continue }
    if (!predicate) { rejected.push({ index: i, reason: 'predicate 为空' }); continue }
    if (!object) { rejected.push({ index: i, reason: 'object 为空' }); continue }
    const validFromRaw = c.validFrom !== undefined ? c.validFrom : c.valid_from
    const validToRaw = c.validTo !== undefined ? c.validTo : c.valid_to
    const validFrom = validFromRaw === undefined || validFromRaw === null || cl_str(validFromRaw) === '' ? null : cl_str(validFromRaw)
    const validTo = validToRaw === undefined || validToRaw === null || cl_str(validToRaw) === '' ? null : cl_str(validToRaw)
    if (validFrom !== null && !cl_isDate(validFrom)) { rejected.push({ index: i, reason: `valid_from 非法（需 YYYY-MM-DD）：${validFrom}` }); continue }
    if (validTo !== null && !cl_isDate(validTo)) { rejected.push({ index: i, reason: `valid_to 非法（需 YYYY-MM-DD）：${validTo}` }); continue }
    const subjectNorm = cl_norm(subject)
    const predNorm = cl_norm(predicate)
    if (!subjectNorm || !predNorm) { rejected.push({ index: i, reason: 'subject/predicate 归一化后为空' }); continue }
    const ver = cl_verifyAnchor(dir, anchor, quote)
    if (!ver.ok) { rejected.push({ index: i, reason: ver.reason }); continue }
    if (ver.warn) warnings.push({ index: i, message: ver.warn })
    const claimId = cl_claimId(subjectNorm, predNorm, object, anchor)
    const prev = ev.events.get(claimId) || addedById.get(claimId)
    if (prev) {
      const st = prev.status || 'active'
      skipped.push({
        index: i,
        claim_id: claimId,
        reason: st === 'active' ? '已存在且 active（幂等跳过）' : `已存在且状态为 ${st}（不复活；新值请用 add/supersede 生成新 claim）`,
      })
      continue
    }
    if (!cl_entityMatch(entities, subject)) {
      warnings.push({ index: i, message: `subject「${subject}」在 wiki/entities 未找到规范实体页（按原样入库）` })
    }
    const rec = {
      claim_id: claimId,
      subject,
      predicate,
      object,
      object_type: cl_objectType(c.objectType ?? c.object_type, object),
      valid_from: validFrom,
      valid_to: validTo,
      anchor,
      quote,
      confidence: cl_confidence(c.confidence),
      extractor_ver: cl_str(c.extractor_ver ?? c.extractorVer) || 'agent',
      status: 'active',
      superseded_by: null,
      reason: '',
      created_at: nowIso,
      page_path: ver.pagePath,
    }
    const groupKey = subjectNorm + '\u0000' + predNorm
    let group = activeGroups.get(groupKey)
    if (!group) { group = []; activeGroups.set(groupKey, group) }
    for (const other of group) {
      if (cl_norm(other.object) === cl_norm(object)) continue
      conflicts.push({
        claim_id: other.claim_id,
        oldClaimId: other.claim_id,
        subject,
        predicate,
        oldObject: other.object,
        newObject: object,
        newClaimId: claimId,
        validFrom: other.valid_from ?? null,
      })
    }
    group.push(rec)
    addedById.set(claimId, rec)
    added.push(rec)
    lines.push(cl_persistLine(rec))
  }
  const written = { file: fileInfo.rel, lines: lines.length }
  if (lines.length) cl_appendLines(dir, fileInfo.rel, lines)
  cl_trySync(db, added, warnings)
  return {
    added: added.map(cl_public),
    skipped,
    rejected,
    conflicts,
    warnings,
    written,
  }
}

const cl_TARGET_STATUS = new Set(['active', 'superseded', 'retracted'])

/**
 * 关闭旧 claim（append 一条 status=superseded + valid_to 事件）；给了 newObject 时同时创建新 active claim
 * （同一 subject/predicate，锚点默认沿用旧 claim，可用 anchor/quote 覆盖并重新校验）。
 */
export function claimsSupersede(dir, db, args = {}) {
  const claimId = cl_str(args.claimId ?? args.claim_id)
  if (!claimId) return { ok: false, reason: '缺少 claimId' }
  const found = cl_findClaimFile(dir, claimId)
  const old = found.record
  if (!old) return { ok: false, reason: `claim 不存在：${claimId}` }
  const oldStatus = old.status || 'active'
  if (oldStatus !== 'active') return { ok: false, reason: `claim 当前状态为 ${oldStatus}，只能 supersede active claim` }
  const validFrom = args.validFrom !== undefined ? cl_str(args.validFrom)
    : (args.valid_from !== undefined ? cl_str(args.valid_from) : cl_today())
  if (!cl_isDate(validFrom)) return { ok: false, reason: `validFrom 非法（需 YYYY-MM-DD）：${validFrom}` }
  const reason = cl_str(args.reason)
  const newObjectRaw = args.newObject !== undefined ? args.newObject : args.new_object
  let newClaim = null
  if (newObjectRaw !== undefined && newObjectRaw !== null && cl_str(newObjectRaw) !== '') {
    const object = cl_str(newObjectRaw)
    if (cl_norm(object) === cl_norm(old.object)) return { ok: false, reason: 'newObject 与旧值相同：无需 supersede（等价于保留旧 claim）' }
    const anchor = cl_str(args.anchor) || cl_str(old.anchor)
    const quote = cl_str(args.quote) || cl_str(old.quote)
    const ver = cl_verifyAnchor(dir, anchor, quote)
    if (!ver.ok) return { ok: false, reason: `新 claim 的锚点/引文校验失败：${ver.reason}` }
    const newClaimId = cl_claimId(cl_norm(old.subject), cl_norm(old.predicate), object, anchor)
    const existingNew = found.events.events.get(newClaimId)
    if (existingNew && (existingNew.status || 'active') !== 'active') {
      return { ok: false, reason: `目标新 claim 已存在且状态为 ${existingNew.status}` }
    }
    if (existingNew) {
      newClaim = existingNew
    } else {
      newClaim = {
        claim_id: newClaimId,
        subject: old.subject,
        predicate: old.predicate,
        object,
        object_type: cl_objectType(old.object_type, object),
        valid_from: validFrom,
        valid_to: null,
        anchor,
        quote,
        confidence: old.confidence === undefined ? null : old.confidence,
        extractor_ver: old.extractor_ver || 'agent',
        status: 'active',
        superseded_by: null,
        reason: '',
        created_at: new Date().toISOString(),
        page_path: ver.pagePath,
      }
    }
  }
  const closed = {
    ...old,
    status: 'superseded',
    valid_to: validFrom,
    superseded_by: newClaim ? newClaim.claim_id : null,
    reason: reason || old.reason || '',
  }
  const targetFile = found.file || cl_claimFile(dir, 'claims').rel
  const lines = [cl_persistLine(closed)]
  if (newClaim && !found.events.events.has(newClaim.claim_id)) lines.push(cl_persistLine(newClaim))
  cl_appendLines(dir, targetFile, lines)
  const warnings = []
  cl_trySync(db, [closed, ...(newClaim ? [newClaim] : [])], warnings)
  return { ok: true, oldClaim: cl_public(closed), newClaim: newClaim ? cl_public(newClaim) : null, warnings }
}

/** 撤回某 claim（append status=retracted）；重复 retract 幂等返回 already:true。 */
export function claimsRetract(dir, db, args = {}) {
  const claimId = cl_str(args.claimId ?? args.claim_id)
  if (!claimId) return { ok: false, reason: '缺少 claimId' }
  const found = cl_findClaimFile(dir, claimId)
  const old = found.record
  if (!old) return { ok: false, reason: `claim 不存在：${claimId}` }
  if ((old.status || 'active') === 'retracted') {
    return { ok: true, already: true, claim: cl_public(old) }
  }
  const rec = {
    ...old,
    status: 'retracted',
    reason: cl_str(args.reason) || old.reason || '',
  }
  const targetFile = found.file || cl_claimFile(dir, 'claims').rel
  cl_appendLines(dir, targetFile, [cl_persistLine(rec)])
  const warnings = []
  cl_trySync(db, [rec], warnings)
  return { ok: true, already: false, claim: cl_public(rec), warnings }
}

// ---------------------------------------------------------------- 公开 API：查询

/**
 * 列表（默认 status=active）。asOf：只返回该日期区间内有效的 claim
 * （valid_from <= asOf 且 (valid_to 为空或 >= asOf)）。
 * orphaned: 锚点页面 status=retracted（页面撤回联动；行不删除，输出标注）。
 */
export function claimsList(dir, db, opts = {}) {
  const status = opts.status === undefined || opts.status === null ? 'active' : String(opts.status)
  const limit = cl_limit(opts.limit, 50)
  const where = []
  const params = []
  if (status && status !== 'all') { where.push('status = ?'); params.push(status) }
  if (cl_str(opts.subject)) { where.push('subject_norm = ?'); params.push(cl_norm(opts.subject)) }
  if (cl_str(opts.predicate)) { where.push('predicate_norm = ?'); params.push(cl_norm(opts.predicate)) }
  if (cl_str(opts.page)) { where.push('page_path = ?'); params.push(cl_normPath(opts.page)) }
  if (cl_str(opts.asOf)) {
    if (!cl_isDate(opts.asOf)) throw new Error(`asOf 非法（需 YYYY-MM-DD）：${opts.asOf}`)
    where.push('(valid_from IS NULL OR valid_from <= ?) AND (valid_to IS NULL OR valid_to >= ?)')
    params.push(cl_str(opts.asOf), cl_str(opts.asOf))
  }
  const whereSql = where.length ? ' WHERE ' + where.join(' AND ') : ''
  const total = Number(db.prepare('SELECT count(*) AS n FROM claims' + whereSql).get(...params).n) || 0
  const rows = db.prepare(
    'SELECT * FROM claims' + whereSql + ' ORDER BY subject_norm, predicate_norm, valid_from, claim_id LIMIT ?',
  ).all(...params, limit + 1)
  const truncated = rows.length > limit
  const cache = new Map()
  const claims = rows.slice(0, limit).map((r) => ({ ...cl_rowToClaim(r), ...cl_orphanInfo(dir, r.page_path, cache) }))
  return { claims, total, truncated }
}

/** 所有同 (subject_norm, predicate_norm) 的 active 冲突（object 不同），全列。 */
export function claimsConflicts(dir, db, opts = {}) {
  const wantSubject = cl_str(opts.subject) ? cl_norm(opts.subject) : null
  let claimsChecked = 0
  try { claimsChecked = Number(db.prepare("SELECT count(*) AS n FROM claims WHERE status='active'").get().n) || 0 } catch { claimsChecked = 0 }
  // 先用 SQL 聚合把"疑似冲突组"筛出来（避免把 5000 行全读进 JS —— node:sqlite 的行封送在小查询上是
  // 主要成本，5000 行约 90ms）；再对命中的组读明细，并用归一化 object 二次确认（全角/大小写不同不算冲突）。
  let groups
  try {
    groups = db.prepare(
      "SELECT subject_norm, predicate_norm, count(DISTINCT object) AS distinct_objects FROM claims WHERE status = 'active' GROUP BY subject_norm, predicate_norm HAVING distinct_objects > 1 ORDER BY subject_norm, predicate_norm",
    ).all()
  } catch {
    return { conflicts: [], total: 0, claimsChecked }
  }
  const max = opts.limit ? cl_limit(opts.limit, 20) : 0
  const cache = new Map()
  const conflicts = []
  let stmt
  try { stmt = db.prepare("SELECT * FROM claims WHERE status = 'active' AND subject_norm = ? AND predicate_norm = ? ORDER BY claim_id") } catch { return { conflicts: [], total: 0, claimsChecked } }
  for (const g of groups) {
    const subjectNorm = String(g.subject_norm)
    const predNorm = String(g.predicate_norm)
    if (wantSubject && wantSubject !== subjectNorm) continue
    const rows = stmt.all(subjectNorm, predNorm)
    const objects = new Set()
    for (const r of rows) objects.add(cl_norm(r.object))
    if (objects.size < 2) continue
    conflicts.push({
      subject: rows[0].subject,
      subject_norm: subjectNorm,
      predicate: rows[0].predicate,
      predicate_norm: predNorm,
      objects: [...objects],
      claims: rows.map((r) => ({ ...cl_rowToClaim(r), ...cl_orphanInfo(dir, r.page_path, cache) })),
    })
    if (max && conflicts.length >= max) break
  }
  return { conflicts, total: conflicts.length, claimsChecked }
}

export function claimsStats(db) {
  const byStatus = {}
  try {
    for (const r of db.prepare('SELECT status, count(*) AS n FROM claims GROUP BY status').all()) byStatus[String(r.status)] = Number(r.n)
  } catch { /* 表不存在 → 空统计 */ }
  const pages = (() => {
    try { return Number(db.prepare("SELECT count(DISTINCT page_path) AS n FROM claims WHERE status='active'").get().n) || 0 } catch { return 0 }
  })()
  const total = Object.values(byStatus).reduce((a, b) => a + b, 0)
  return { total, active: byStatus.active || 0, superseded: byStatus.superseded || 0, retracted: byStatus.retracted || 0, pages }
}

/**
 * 证据包集成：按召回页集合（或查询词）取 active claims（≤limit），附带 conflicts。
 * asOf 语义同 claimsList。
 */
export function claimsForPack(dir, db, opts = {}) {
  const limit = cl_limit(opts.limit, 10, 50)
  let rows = []
  const pages = Array.isArray(opts.pagePaths) ? opts.pagePaths.map(cl_normPath).filter(Boolean) : []
  if (pages.length) {
    const labels = pages.map(() => '?').join(',')
    rows = db.prepare(
      `SELECT * FROM claims WHERE status = 'active' AND page_path IN (${labels}) ORDER BY subject_norm, predicate_norm, claim_id LIMIT ?`,
    ).all(...pages, limit)
  } else if (cl_str(opts.query)) {
    const toks = [...new Set(tokenize(cl_norm(opts.query)).map((t) => String(t).toLowerCase()))]
      .filter((t) => t.length >= 2 && !/^[\u3000-\u303f\uff00-\uffef]+$/.test(t))
      .slice(0, 8)
    if (toks.length) {
      const conds = toks.map(() => '(subject_norm LIKE ? ESCAPE \'\\\' OR predicate_norm LIKE ? ESCAPE \'\\\')').join(' OR ')
      const params = []
      for (const t of toks) {
        const pat = '%' + t.replace(/[\\%_]/g, (ch) => '\\' + ch) + '%'
        params.push(pat, pat)
      }
      rows = db.prepare(
        `SELECT * FROM claims WHERE status = 'active' AND (${conds}) ORDER BY subject_norm, predicate_norm, claim_id LIMIT ?`,
      ).all(...params, limit)
    }
  }
  if (cl_str(opts.asOf)) {
    if (!cl_isDate(opts.asOf)) throw new Error(`asOf 非法（需 YYYY-MM-DD）：${opts.asOf}`)
    const day = cl_str(opts.asOf)
    rows = rows.filter((r) => (!r.valid_from || r.valid_from <= day) && (!r.valid_to || r.valid_to >= day))
  }
  const cache = new Map()
  const claims = rows.map((r) => ({ ...cl_rowToClaim(r), ...cl_orphanInfo(dir, r.page_path, cache) }))
  let conflicts = []
  try { conflicts = claimsConflicts(dir, db, { limit: 5 }).conflicts } catch { conflicts = [] }
  return { claims, conflicts, asOf: cl_str(opts.asOf) || null }
}

/** search 行尾标注用：page_path → active claim 数（无 claim 的页不出现在结果里）。 */
export function claimsCountsByPage(db, pagePaths) {
  const out = {}
  const pages = Array.isArray(pagePaths) ? pagePaths.map(cl_normPath).filter(Boolean) : []
  if (!pages.length) return out
  const labels = pages.map(() => '?').join(',')
  try {
    for (const r of db.prepare(
      `SELECT page_path, count(*) AS n FROM claims WHERE status = 'active' AND page_path IN (${labels}) GROUP BY page_path`,
    ).all(...pages)) out[String(r.page_path)] = Number(r.n)
  } catch { /* 表不存在 → 空 */ }
  return out
}
