/**
 * archivist Phase 1 — SQLite index: schema v1, build, incremental sync, lexical (BM25) query.
 * Owner: impl-chunks. Authority: docs/p1-contract.md §2 (schema/DDL/增量/API frozen).
 *
 * - `node:sqlite` is loaded lazily (the Electron host must not see the experimental warning
 *   at plugin load); any load/open failure throws and the caller degrades visibly.
 * - All module-internal symbols carry the `ix_` prefix: build.mjs inlines every module into a
 *   single top-level scope, so helpers must never collide with core / other modules.
 * - The one cross-module edge is the import of the chunker/tokenizer below; build.mjs drops
 *   relative `./mod-*.mjs` imports and inlines mod-chunks before mod-indexdb, so the flattened
 *   bundle and a direct `node mod-indexdb.mjs` both resolve the same functions. Duplicating
 *   the tokenizer instead would let index-time and query-time tokenization drift apart.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import { chunkDocument, tokenize, estimateTokens, formatAnchor, ch_CHUNKER_VERSION } from './mod-chunks.mjs'

// ---------------------------------------------------------------- lazy node:sqlite

let ix_sqlite = null
function ix_getSql() {
  if (ix_sqlite) return ix_sqlite
  ix_sqlite = createRequire(import.meta.url)('node:sqlite')
  return ix_sqlite
}

// ---------------------------------------------------------------- constants

const ix_SCHEMA_VERSION = '1'
const ix_INDEX_DIR = '.index'
const ix_DB_FILE = 'archivist.db'
const ix_EXCLUDE_RE = /(^|\/)(\.backups|\.git|node_modules|\.index)(\/|$)/
const ix_RAW_EXTS = /\.(md|txt|json|csv|ya?ml)$/i
const ix_RAW_SIZE_CAP = 2 * 1024 * 1024
const ix_INTEGRITY_FULL_CAP = 64 * 1024 * 1024
const ix_PAGE_TYPES = new Set(['source', 'entity', 'concept', 'synthesis'])
const ix_TYPE_BY_DIR = { sources: 'source', entities: 'entity', concepts: 'concept', syntheses: 'synthesis' }
const ix_FTS_SAFE_RE = /[a-z0-9\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/
const ix_FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/
// db -> { dir, dbPath, rebuildReason } (WeakMap keeps DatabaseSync instances unmodified where
// possible; the property is also assigned as a convenience).
const ix_DB_META = new WeakMap()
// Index-logic version: stored in meta; a mismatch forces a full rebuild on open, so a changed
// chunker/indexer never keeps serving chunks produced by older code.
const ix_INDEXER_VERSION = 1
// syncIndex({fast:true}) re-uses the last directory walk for this long. Write tools call the
// default full sync, so §8.6 freshness remains guaranteed through the write path.
const ix_FAST_SYNC_TTL_MS = 1000
const ix_SCAN_CACHE_MAX = 16
const ix_SCAN_CACHE = new Map()
const ix_now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())
// Tiered lexical search only pays off on big indexes; below this many chunks the plain
// full-OR query is already sub-millisecond and is kept verbatim (identical ranking).
const ix_TIER_MIN_CHUNKS = 4000
const ix_STMT_CACHE = new WeakMap()
const ix_SCALE_CACHE = new WeakMap()
/** Prepared-statement cache (the lexical SQL shape repeats on every search). */
function ix_cachedStmt(db, sql) {
  let map = ix_STMT_CACHE.get(db)
  if (!map) { map = new Map(); ix_STMT_CACHE.set(db, map) }
  let stmt = map.get(sql)
  if (!stmt) {
    if (map.size >= 24) map.clear()
    stmt = db.prepare(sql)
    map.set(sql, stmt)
  }
  return stmt
}
/** Cheap scale proxy: highest chunk id (~chunks inserted since the last full rebuild). */
function ix_leafScale(db) {
  let v = ix_SCALE_CACHE.get(db)
  if (v === undefined) {
    try { v = Number(db.prepare('SELECT max(chunk_id) AS m FROM chunks').get().m) || 0 } catch { v = 0 }
    ix_SCALE_CACHE.set(db, v)
  }
  return v
}

const ix_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS docs (
  doc_id      INTEGER PRIMARY KEY,
  scope       TEXT NOT NULL CHECK (scope IN ('wiki','raw')),
  path        TEXT NOT NULL UNIQUE,
  title       TEXT NOT NULL DEFAULT '',
  sha256      TEXT NOT NULL,
  mtime_ms    INTEGER NOT NULL,
  size        INTEGER NOT NULL,
  trust       TEXT,
  status      TEXT,
  superseded_by TEXT,
  page_type   TEXT,
  tags        TEXT NOT NULL DEFAULT '',
  aliases     TEXT NOT NULL DEFAULT '',
  summary     TEXT NOT NULL DEFAULT '',
  raw_refs    TEXT NOT NULL DEFAULT '',
  event_time  TEXT
);
CREATE TABLE IF NOT EXISTS chunks (
  chunk_id    INTEGER PRIMARY KEY,
  doc_id      INTEGER NOT NULL REFERENCES docs(doc_id) ON DELETE CASCADE,
  ord         INTEGER NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('section','leaf')),
  parent_ord  INTEGER,
  heading_path TEXT NOT NULL DEFAULT '',
  char_start  INTEGER NOT NULL,
  char_end    INTEGER NOT NULL,
  token_est   INTEGER NOT NULL,
  text        TEXT NOT NULL,
  UNIQUE (doc_id, ord)
);
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  tokens, heading_tokens,
  content='', contentless_delete=1,
  tokenize='unicode61 remove_diacritics 2'
);
`

// ---------------------------------------------------------------- small helpers

const ix_fwd = (p) => String(p).replace(/\\/g, '/')
function ix_errMsg(err) {
  return String(err && err.message ? err.message : err)
}
function ix_splitSpace(s) {
  return s ? String(s).split(/\s+/).filter(Boolean) : []
}
function ix_removeDbFiles(dbPath) {
  for (const p of [dbPath, dbPath + '-wal', dbPath + '-shm']) {
    try { rmSync(p, { force: true }) } catch { /* locked file: the caller reports degrade */ }
  }
}
function ix_applyPragmas(db) {
  db.exec('PRAGMA journal_mode=WAL')
  db.exec('PRAGMA synchronous=NORMAL')
  db.exec('PRAGMA busy_timeout=3000')
  db.exec('PRAGMA foreign_keys=ON')
}
function ix_getMeta(db, key) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key)
  return row ? row.value : null
}
function ix_setMeta(db, key, value) {
  db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run(key, String(value))
}
function ix_createSchema(db) {
  db.exec(ix_SCHEMA_SQL)
  ix_setMeta(db, 'schema_version', ix_SCHEMA_VERSION)
}
function ix_metaSafe(db, key) {
  try { return ix_getMeta(db, key) } catch { return null }
}
function ix_countDocs(db) {
  try { return Number(db.prepare('SELECT count(*) AS n FROM docs').get().n) || 0 } catch { return 0 }
}
/** Record the index-logic versions this build produces (chunker comes from mod-chunks). */
function ix_stampVersions(db) {
  ix_setMeta(db, 'chunker_version', String(ch_CHUNKER_VERSION))
  ix_setMeta(db, 'indexer_version', String(ix_INDEXER_VERSION))
}
/** Empty both regular tables + the contentless FTS index, atomically. */
function ix_clearTables(db) {
  db.exec('BEGIN IMMEDIATE')
  try {
    try {
      db.exec("INSERT INTO chunks_fts(chunks_fts) VALUES('delete-all')")
    } catch {
      const st = ix_prepare(db)
      for (const r of db.prepare('SELECT chunk_id FROM chunks').all()) st.deleteFts.run(r.chunk_id)
    }
    db.exec('DELETE FROM chunks')
    db.exec('DELETE FROM docs')
    db.exec('COMMIT')
  } catch (err) {
    try { db.exec('ROLLBACK') } catch { /* nothing to roll back */ }
    throw err
  }
}
/**
 * Workspace scan with an optional TTL cache for the search path.
 * `fast` trades freshness latency for latency: a query-path sync reuses the previous directory
 * walk for ttlMs instead of re-reading every file's stat. Write tools call the default full
 * sync, which always rescans and refreshes the cache, so a write is visible on the next search.
 */
function ix_scanWorkspaceCached(dir, fast, ttlMs) {
  if (fast) {
    const hit = ix_SCAN_CACHE.get(dir)
    if (hit && Date.now() - hit.at < ttlMs) return { ...hit, fromCache: true }
  }
  const scanned = ix_scanWorkspace(dir)
  if (ix_SCAN_CACHE.size >= ix_SCAN_CACHE_MAX) ix_SCAN_CACHE.clear()
  ix_SCAN_CACHE.set(dir, { at: Date.now(), ...scanned })
  return { ...scanned, fromCache: false }
}
function ix_integrityOk(db, dbPath) {
  let pragma = 'integrity_check'
  try { if (statSync(dbPath).size > ix_INTEGRITY_FULL_CAP) pragma = 'quick_check' } catch { /* default */ }
  try {
    const row = db.prepare(`PRAGMA ${pragma}`).get()
    const value = row ? String(Object.values(row)[0]) : 'ok'
    return value.toLowerCase() === 'ok'
  } catch {
    return false
  }
}
/** Drop + recreate every table; if the file is too broken even for DROP, delete and reopen. */
function ix_recreate(db, dbPath) {
  try {
    db.exec('PRAGMA foreign_keys=OFF')
    for (const t of ['chunks_fts', 'chunks', 'docs', 'meta']) {
      try { db.exec(`DROP TABLE IF EXISTS ${t}`) } catch { /* try the next table / fall back below */ }
    }
    ix_createSchema(db)
    db.exec('PRAGMA foreign_keys=ON')
    return db
  } catch {
    try { db.close() } catch { /* already closed */ }
    ix_removeDbFiles(dbPath)
    const { DatabaseSync } = ix_getSql()
    const fresh = new DatabaseSync(dbPath)
    ix_applyPragmas(fresh)
    ix_createSchema(fresh)
    return fresh
  }
}

// ---------------------------------------------------------------- open

/**
 * Open (or create/repair) `<workspace>/.index/archivist.db`.
 * Schema version mismatch / unreadable / integrity failure → rebuild the empty schema and
 * record the reason (see indexRebuildNote); the caller's next syncIndex repopulates it.
 * Throws when the index cannot be opened at all — the caller must degrade visibly.
 */
export function openIndex(dir) {
  if (!dir || !String(dir).trim()) throw new Error('openIndex requires an explicit workspace directory')
  const root = path.resolve(String(dir))
  const ixDir = path.join(root, ix_INDEX_DIR)
  mkdirSync(ixDir, { recursive: true })
  const dbPath = path.join(ixDir, ix_DB_FILE)
  const existed = existsSync(dbPath) && statSync(dbPath).size > 0
  const { DatabaseSync } = ix_getSql()
  let reason = null
  let db
  try {
    db = new DatabaseSync(dbPath)
  } catch (err) {
    ix_removeDbFiles(dbPath)
    db = new DatabaseSync(dbPath)
    reason = `⚠ 索引重建：数据库打不开（${ix_errMsg(err)}）`
  }
  ix_applyPragmas(db)
  if (!existed) {
    ix_createSchema(db)
  } else {
    let version = null
    let readErr = null
    try { version = ix_getMeta(db, 'schema_version') } catch (err) { readErr = err }
    if (readErr || version !== ix_SCHEMA_VERSION) {
      reason = reason || (readErr
        ? `⚠ 索引重建：索引不可读（${ix_errMsg(readErr)}）`
        : `⚠ 索引重建：索引 schema 版本 ${version === null ? '(缺失)' : version} ≠ ${ix_SCHEMA_VERSION}`)
      db = ix_recreate(db, dbPath)
    } else if (!ix_integrityOk(db, dbPath)) {
      reason = reason || '⚠ 索引重建：索引完整性检查失败'
      db = ix_recreate(db, dbPath)
    }
  }
  // Index-logic version gate: a newer chunker/indexer invalidates every stored chunk. Rebuild
  // here, once, instead of silently serving chunks produced by older code; the rebuild includes
  // the full sync so an upgrade never comes back with an empty index.
  const curCh = String(ch_CHUNKER_VERSION)
  const curIx = String(ix_INDEXER_VERSION)
  const storedCh = ix_metaSafe(db, 'chunker_version')
  const storedIx = ix_metaSafe(db, 'indexer_version')
  if (storedCh !== curCh || storedIx !== curIx) {
    if (existed && ix_countDocs(db) > 0) {
      reason = reason || `⚠ 索引重建：分块器/索引器版本变化（chunker ${storedCh ?? 'v0'}→${curCh}，indexer ${storedIx ?? 'v0'}→${curIx}）`
      ix_clearTables(db)
      syncIndex(db, root)
    }
    ix_stampVersions(db)
  }
  ix_setMeta(db, 'schema_version', ix_SCHEMA_VERSION)
  ix_DB_META.set(db, { dir: root, dbPath, rebuildReason: reason })
  try { db.rebuildReason = reason } catch { /* sealed instance: WeakMap above is authoritative */ }
  if (reason) {
    try { ix_setMeta(db, 'rebuild_reason', reason) } catch { /* best effort */ }
  }
  return db
}

/** Why openIndex had to rebuild (null when the index was fine / newly created). */
export function indexRebuildNote(db) {
  const meta = ix_DB_META.get(db)
  return meta ? meta.rebuildReason : null
}

// ---------------------------------------------------------------- workspace scan

function ix_walk(absDir) {
  const out = []
  if (!existsSync(absDir)) return out
  const stack = [absDir]
  while (stack.length) {
    const cur = stack.pop()
    let entries
    try { entries = readdirSync(cur, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      const abs = path.join(cur, e.name)
      const rel = ix_fwd(path.relative(absDir, abs))
      if (ix_EXCLUDE_RE.test(rel)) continue
      if (e.isDirectory()) stack.push(abs)
      else out.push(abs)
    }
  }
  return out.sort()
}

/**
 * Files the index owns, mirroring core's page/raw selection:
 *   wiki/**.md except index.md, log.md and dot-entries (listPages);
 *   raw/** with the same extension whitelist / 2MB cap / 0-byte pass-through (readRawDocs).
 * `skipped`/`skippedFiles` keep the legacy raw coverage declaration honest: they count and
 * name raw files the index had to leave out (same three reasons as readRawDocs).
 */
function ix_scanWorkspace(dir) {
  const files = []
  const skipped = { extension: 0, size: 0, unreadable: 0 }
  const skippedFiles = []
  const noteSkip = (reason, rel) => {
    skipped[reason]++
    if (skippedFiles.length < 5) skippedFiles.push(rel)
  }
  for (const abs of ix_walk(path.join(dir, 'wiki'))) {
    const rel = ix_fwd(path.relative(dir, abs))
    const inWiki = rel.slice('wiki/'.length)
    if (!inWiki.endsWith('.md')) continue
    if (inWiki === 'index.md' || inWiki === 'log.md') continue
    if (inWiki.startsWith('.')) continue
    let st
    try { st = statSync(abs) } catch { continue }
    files.push({ scope: 'wiki', path: rel, abs, mtimeMs: Math.round(st.mtimeMs), size: st.size })
  }
  for (const abs of ix_walk(path.join(dir, 'raw'))) {
    const rel = ix_fwd(path.relative(dir, abs))
    let st
    try { st = statSync(abs) } catch { noteSkip('unreadable', rel); continue }
    if (st.size === 0) {
      // Mirrors readRawDocs: 0-byte placeholders are scanned docs, not filtered-out files.
      files.push({ scope: 'raw', path: rel, abs, mtimeMs: Math.round(st.mtimeMs), size: 0 })
      continue
    }
    if (!ix_RAW_EXTS.test(rel)) { noteSkip('extension', rel); continue }
    if (st.size > ix_RAW_SIZE_CAP) { noteSkip('size', rel); continue }
    files.push({ scope: 'raw', path: rel, abs, mtimeMs: Math.round(st.mtimeMs), size: st.size })
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return { files, skipped, skippedFiles }
}

// ---------------------------------------------------------------- metadata (frontmatter)

function ix_oneLine(v) {
  return String(v ?? '').replace(/\s+/g, ' ').trim()
}
function ix_unquote(v) {
  const s = String(v ?? '').trim()
  if (s.length >= 2 && ((s[0] === '"' && s[s.length - 1] === '"') || (s[0] === "'" && s[s.length - 1] === "'"))) {
    return s.slice(1, -1)
  }
  return s
}
function ix_asList(v) {
  if (v === null || v === undefined || v === '') return []
  const items = Array.isArray(v) ? v : [v]
  return items.map((x) => ix_oneLine(ix_unquote(x))).filter((x) => x !== '')
}
/**
 * Minimal frontmatter parser for the index only: scalars, inline `[a, b]` lists and `- item`
 * blocks are enough for every indexed field. Nested maps / anchors are ignored here on
 * purpose — core's parsePage stays the authority for reading and rewriting pages.
 */
function ix_parseFrontmatter(block) {
  const fm = {}
  const lines = String(block).split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(lines[i])
    if (!m) continue
    const key = m[1]
    const inline = ix_unquote(String(m[2]).replace(/\s+#.*$/, '').trim())
    if (inline === '' || /^[|>][+-]?\d*[+-]?$/.test(inline)) {
      const items = []
      const parts = []
      let j = i + 1
      for (; j < lines.length; j++) {
        const l = lines[j]
        if (/^\s*-\s+/.test(l)) items.push(ix_unquote(l.replace(/^\s*-\s+/, '').trim()))
        else if (/^\s+\S/.test(l)) parts.push(l.trim())
        else if (l.trim() !== '') break
      }
      if (items.length) fm[key] = items
      else if (parts.length) fm[key] = inline.startsWith('>') ? parts.join(' ') : (parts.length === 1 ? parts[0] : parts)
      else fm[key] = ''
      i = j - 1
      continue
    }
    if (inline.startsWith('[') && inline.endsWith(']')) {
      fm[key] = inline.slice(1, -1).split(',').map((s) => ix_unquote(s.trim())).filter((s) => s !== '')
    } else {
      fm[key] = inline
    }
  }
  return fm
}
function ix_firstHeading(body) {
  const m = /^#\s+(.+)$/m.exec(body)
  return m ? ix_oneLine(m[1]) : ''
}
function ix_normalizeDate(v) {
  if (!v) return null
  const s = ix_oneLine(Array.isArray(v) ? v[0] : v)
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s)
  return m ? m[1] : null
}
function ix_normKeyList(v, sep) {
  return ix_asList(v).map((x) => x.toLowerCase().replace(/\s+/g, sep)).join(' ')
}
function ix_pageMeta(docPath, text) {
  const m = ix_FM_RE.exec(text)
  const fm = m ? ix_parseFrontmatter(m[1]) : {}
  const body = m ? text.slice(m[0].length) : text
  const relInWiki = docPath.slice('wiki/'.length)
  const typeRaw = fm.type ? ix_oneLine(fm.type) : ''
  const topDir = relInWiki.includes('/') ? relInWiki.slice(0, relInWiki.indexOf('/')) : ''
  return {
    body,
    meta: {
      title: ix_oneLine(fm.title || ix_firstHeading(body) || path.basename(relInWiki, '.md')),
      trust: fm.trust ? ix_oneLine(fm.trust) : null,
      status: fm.status ? ix_oneLine(fm.status) : 'active',
      supersededBy: fm.superseded_by ? ix_oneLine(fm.superseded_by) : null,
      pageType: ix_PAGE_TYPES.has(typeRaw) ? typeRaw : (ix_TYPE_BY_DIR[topDir] || null),
      tags: ix_normKeyList(fm.tags, '-'),
      aliases: ix_normKeyList(fm.aliases, '-'),
      rawRefs: ix_asList(fm.sources).join(' '),
      summary: ix_oneLine(Array.isArray(fm.summary) ? fm.summary.join(' ') : fm.summary),
      eventTime: ix_normalizeDate(fm.event_time || fm.date),
    },
  }
}
function ix_rawMeta(docPath, text) {
  const base = path.posix.basename(docPath)
  const ext = path.posix.extname(base)
  return {
    body: text,
    meta: {
      title: base.slice(0, base.length - ext.length) || base,
      trust: null,
      status: null,
      supersededBy: null,
      pageType: null,
      tags: '',
      aliases: '',
      rawRefs: '',
      summary: '',
      eventTime: null,
    },
  }
}
function ix_buildDoc(file, buf) {
  const text = buf.toString('utf8')
  return file.scope === 'wiki' ? ix_pageMeta(file.path, text) : ix_rawMeta(file.path, text)
}

// ---------------------------------------------------------------- write path

function ix_prepare(db) {
  return {
    now: Date.now(),
    insertDoc: db.prepare(`INSERT INTO docs(scope, path, title, sha256, mtime_ms, size, trust, status, superseded_by, page_type, tags, aliases, summary, raw_refs, event_time)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    touchDoc: db.prepare('UPDATE docs SET mtime_ms = ?, size = ? WHERE doc_id = ?'),
    insertChunk: db.prepare(`INSERT INTO chunks(doc_id, ord, kind, parent_ord, heading_path, char_start, char_end, token_est, text)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    insertFts: db.prepare('INSERT INTO chunks_fts(rowid, tokens, heading_tokens) VALUES (?, ?, ?)'),
    chunkIds: db.prepare('SELECT chunk_id FROM chunks WHERE doc_id = ?'),
    deleteFts: db.prepare('DELETE FROM chunks_fts WHERE rowid = ?'),
    deleteDoc: db.prepare('DELETE FROM docs WHERE doc_id = ?'),
  }
}
function ix_deleteDocRows(st, docId) {
  for (const r of st.chunkIds.all(docId)) st.deleteFts.run(r.chunk_id)
  st.deleteDoc.run(docId)
}
function ix_insertDocRow(st, file, sha, doc) {
  const m = doc.meta
  const r = st.insertDoc.run(file.scope, file.path, m.title, sha, file.mtimeMs, file.size,
    m.trust, m.status, m.supersededBy, m.pageType, m.tags, m.aliases, m.summary, m.rawRefs, m.eventTime)
  return Number(r.lastInsertRowid)
}
function ix_insertChunks(st, docId, chunks) {
  for (const c of chunks) {
    const r = st.insertChunk.run(docId, c.ord, c.kind, c.parentOrd, c.headingPath, c.charStart, c.charEnd, c.tokenEst, c.text)
    if (c.kind === 'leaf') {
      st.insertFts.run(Number(r.lastInsertRowid), tokenize(c.text).join(' '), tokenize(c.headingPath).join(' '))
    }
  }
}
function ix_writeBuiltMeta(db, root) {
  ix_setMeta(db, 'schema_version', ix_SCHEMA_VERSION)
  ix_setMeta(db, 'built_at', new Date().toISOString())
  ix_setMeta(db, 'workspace', ix_fwd(root))
  ix_stampVersions(db)
}

// ---------------------------------------------------------------- sync

/**
 * Incremental sync (idempotent). Contract §2.2.
 * Per file: (mtime_ms, size) unchanged → skip; changed → read + sha256 (content-unchanged
 * files only refresh their stat row); new → parse+insert; missing on disk → delete rows.
 * opts.verifyHashes=true hashes every file (strict reading of §2.2; slower on big corpora).
 * @returns {{added:number, changed:number, removed:number, scanned:number, ms:number,
 *            skipped:{size:number, extension:number, unreadable:number}, skippedFiles:string[]}}
 */
export function syncIndex(db, dir, opts = {}) {
  const t0 = Date.now()
  const root = path.resolve(String(dir))
  const verifyHashes = !!(opts && opts.verifyHashes === true)
  const fast = !!(opts && opts.fast === true)
  const ttlMs = Number.isFinite(Number(opts && opts.ttlMs)) ? Math.max(0, Number(opts.ttlMs)) : ix_FAST_SYNC_TTL_MS
  const { files, skipped, skippedFiles } = ix_scanWorkspaceCached(root, fast, ttlMs)
  const existing = new Map()
  for (const row of db.prepare('SELECT doc_id, path, sha256, mtime_ms, size FROM docs').all()) {
    existing.set(String(row.path), row)
  }
  const stats = { added: 0, changed: 0, removed: 0, scanned: files.length, ms: 0, skipped, skippedFiles }
  const work = []
  const seen = new Set()
  const removed = []
  for (const f of files) {
    seen.add(f.path)
    const row = existing.get(f.path)
    if (!row) { work.push({ f, row: null }); continue }
    if (!verifyHashes && Number(row.mtime_ms) === f.mtimeMs && Number(row.size) === f.size) continue
    work.push({ f, row })
  }
  for (const [p, row] of existing) if (!seen.has(p)) removed.push({ path: p, doc_id: row.doc_id })
  if (!work.length && !removed.length) {
    if (ix_getMeta(db, 'built_at') === null) ix_writeBuiltMeta(db, root)
    stats.ms = Date.now() - t0
    return stats
  }
  const st = ix_prepare(db)
  const ix_txn = (fn) => {
    db.exec('BEGIN IMMEDIATE')
    try {
      const out = fn()
      db.exec('COMMIT')
      return out
    } catch (err) {
      try { db.exec('ROLLBACK') } catch { /* nothing to roll back */ }
      throw err
    }
  }
  for (const { f, row } of work) {
    let buf
    try { buf = readFileSync(f.abs) } catch { continue } // unreadable now: leave the doc row untouched
    const sha = createHash('sha256').update(buf).digest('hex')
    if (row && sha === String(row.sha256)) {
      if (Number(row.mtime_ms) !== f.mtimeMs || Number(row.size) !== f.size) {
        ix_txn(() => st.touchDoc.run(f.mtimeMs, f.size, row.doc_id))
      }
      continue
    }
    let doc
    let chunks
    try {
      doc = ix_buildDoc(f, buf)
      chunks = chunkDocument(doc.body) // CPU outside the write transaction
    } catch {
      continue // a single malformed/unparseable file must not abort the whole sync
    }
    ix_txn(() => {
      if (row) ix_deleteDocRows(st, row.doc_id)
      const docId = ix_insertDocRow(st, f, sha, doc)
      ix_insertChunks(st, docId, chunks)
    })
    if (row) stats.changed++
    else stats.added++
  }
  if (removed.length) {
    ix_txn(() => { for (const r of removed) ix_deleteDocRows(st, r.doc_id) })
    stats.removed = removed.length
  }
  ix_writeBuiltMeta(db, root)
  stats.ms = Date.now() - t0
  return stats
}

/** Full rebuild: clear both tables (contentless FTS via delete-all) then sync everything. */
export function rebuildSearchIndex(db, dir) {
  const t0 = Date.now()
  const root = path.resolve(String(dir))
  ix_clearTables(db)
  const stats = syncIndex(db, root)
  stats.ms = Date.now() - t0
  ix_writeBuiltMeta(db, root)
  return { ...stats, full: true }
}

// ---------------------------------------------------------------- lexical query

function ix_snippet(text, tokenSet) {
  const src = String(text ?? '')
  const lower = src.toLowerCase()
  let pos = -1
  for (const t of tokenSet) {
    if (!t) continue
    const j = lower.indexOf(t)
    if (j >= 0 && (pos < 0 || j < pos)) pos = j
  }
  if (pos < 0) pos = 0
  const from = Math.max(0, pos - 60)
  return src.slice(from, from + 240).replace(/\s+/g, ' ').trim()
}
function ix_mapLexRow(row, tokenSet) {
  return {
    chunkId: Number(row.chunk_id),
    docId: Number(row.doc_id),
    path: row.path,
    scope: row.scope,
    ord: Number(row.ord),
    headingPath: row.heading_path,
    charStart: Number(row.char_start),
    charEnd: Number(row.char_end),
    snippetText: ix_snippet(row.text, tokenSet),
    bm25: Number(row.bm25Score),
    // ---- additive (contract allows extra fields): everything a Hit needs without re-query
    title: row.title,
    trust: row.trust ?? null,
    status: row.status ?? null,
    supersededBy: row.superseded_by ?? null,
    pageType: row.page_type ?? null,
    tags: ix_splitSpace(row.tags),
    summary: row.summary || '',
    eventTime: row.event_time ?? null,
    tokenEst: Number(row.token_est),
    text: row.text,
  }
}

/**
 * BM25 channel over leaf chunks (contract §2.1/§2.3). The returned row shape is unchanged.
 *
 * Perf strategy — tiered anchor queries. A 15-token CJK query is a huge OR match set on a 10M
 * index and FTS5 has to bm25-score every match (~350 ms measured). Instead of ranking that
 * whole set, each tier runs a *bounded* MATCH expression: the k most specific query tokens
 * (longest first; only multi-char tokens are used — a 2-char CJK bigram is usually common)
 * OR-ed as anchors, AND-ed with the full query so bm25() still sums over all query phrases.
 * Tiers add anchors (nested match sets), so any document's bm25 score equals the old
 * single-query score; only the candidate pool is narrower. The first tier yielding `limit`
 * rows wins; if no tier does, the widest bounded tier is returned (precision-first) instead of
 * padding from the full OR set. Small indexes (`ix_TIER_MIN_CHUNKS`) always use the old
 * full-OR query verbatim, so real-corpus ranking is byte-identical.
 * `opts.explain` (an object) receives non-breaking stage statistics.
 */
export function searchLexical(db, tokens, opts = {}) {
  const o = opts || {}
  const explain = o.explain && typeof o.explain === 'object' ? o.explain : null
  const tStart = ix_now()
  const input = Array.isArray(tokens) ? tokens : []
  const limit = Math.max(1, Math.min(5000, Number.isFinite(Number(o.limit)) ? Math.trunc(Number(o.limit)) : 100))
  const scope = o.scope === 'raw' || o.scope === 'all' ? o.scope : 'wiki'
  const filters = o.filters || {}
  const seen = new Set()
  const ordered = []
  for (const raw of input) {
    const s = String(raw ?? '').trim().toLowerCase()
    if (!s || seen.has(s) || !ix_FTS_SAFE_RE.test(s)) continue
    seen.add(s)
    ordered.push(s)
  }
  if (!ordered.length) return []
  const esc = (t) => '"' + t.replace(/"/g, '""') + '"'
  const where = ['chunks_fts MATCH ?']
  const args = []
  if (scope !== 'all') { where.push('d.scope = ?'); args.push(scope) }
  if (filters.excludeRetracted !== false) where.push("COALESCE(d.status, '') <> 'retracted'")
  const inClause = (col, val) => {
    const arr = (Array.isArray(val) ? val : [val]).map((v) => String(v)).filter((v) => v !== '')
    if (!arr.length) return
    where.push(`${col} IN (${arr.map(() => '?').join(',')})`)
    args.push(...arr)
  }
  if (filters.trust) inClause('d.trust', filters.trust)
  if (filters.status) inClause('d.status', filters.status)
  if (filters.pageType) inClause('d.page_type', filters.pageType)
  if (filters.timeFrom) { where.push('d.event_time IS NOT NULL AND d.event_time >= ?'); args.push(String(filters.timeFrom)) }
  if (filters.timeTo) { where.push('d.event_time IS NOT NULL AND d.event_time <= ?'); args.push(String(filters.timeTo)) }
  const sql = `SELECT c.chunk_id, c.doc_id, c.ord, c.heading_path, c.char_start, c.char_end, c.token_est, c.text,
      d.path, d.scope, d.title, d.trust, d.status, d.superseded_by, d.page_type, d.tags, d.summary, d.event_time,
      bm25(chunks_fts, 1.0, 2.0) AS bm25Score
    FROM chunks_fts
    JOIN chunks c ON c.chunk_id = chunks_fts.rowid
    JOIN docs d ON d.doc_id = c.doc_id
    WHERE ${where.join(' AND ')}
    ORDER BY bm25(chunks_fts, 1.0, 2.0) ASC, c.chunk_id ASC
    LIMIT ?`
  const stmt = ix_cachedStmt(db, sql)
  const spec = ordered
    .map((t, idx) => ({ t, idx, len: [...t].length }))
    .sort((a, b) => b.len - a.len || a.idx - b.idx)
  const fullOr = ordered.map(esc).join(' OR ')
  const tiers = []
  let rows = []
  // Below the tier threshold the plain full-OR query is already cheap: keep it verbatim so
  // small workspaces (and the selftest fixture) get exactly the previous ranking.
  const tiered = ordered.length > 3 && spec.some((x) => x.len >= 3) && ix_leafScale(db) > ix_TIER_MIN_CHUNKS
  if (!tiered) {
    const t = ix_now()
    rows = stmt.all(fullOr, ...args, limit)
    if (explain) tiers.push({ k: ordered.length, expr: 'full-or', rows: rows.length, ms: Math.round((ix_now() - t) * 100) / 100 })
  } else {
    // Multi-character tokens are the anchors: a 2-char CJK bigram is usually common, and one
    // common anchor puts the whole match set (and the bm25 cost) right back where it was.
    // If the specific anchors cannot fill `limit`, the bounded set is returned as-is instead of
    // padding with weak OR matches — at scale that is precision-first and keeps the cost flat.
    const anchors = spec.filter((x) => x.len >= 3)
    for (let k = 1; k <= anchors.length; k++) {
      const expr = '(' + anchors.slice(0, k).map((x) => esc(x.t)).join(' OR ') + ') AND (' + fullOr + ')'
      const t = ix_now()
      rows = stmt.all(expr, ...args, limit)
      if (explain) tiers.push({ k, expr: 'anchor-and', rows: rows.length, ms: Math.round((ix_now() - t) * 100) / 100 })
      if (rows.length >= limit) break
    }
  }
  if (explain) {
    explain.limit = limit
    explain.ordered = ordered.length
    explain.mode = tiers.some((x) => x.expr === 'anchor-and') ? 'tiered' : 'legacy'
    explain.tiers = tiers
    explain.totalMs = Math.round((ix_now() - tStart) * 100) / 100
  }
  return rows.map((row) => ix_mapLexRow(row, ordered))
}

// ---------------------------------------------------------------- reads

function ix_mapChunkRow(row) {
  return {
    chunkId: Number(row.chunk_id),
    docId: Number(row.doc_id),
    ord: Number(row.ord),
    kind: row.kind,
    parentOrd: row.parent_ord === null ? null : Number(row.parent_ord),
    headingPath: row.heading_path,
    charStart: Number(row.char_start),
    charEnd: Number(row.char_end),
    tokenEst: Number(row.token_est),
    text: row.text,
    path: row.path,
    scope: row.scope,
    title: row.title,
    sha256: row.sha256,
    trust: row.trust ?? null,
    status: row.status ?? null,
    supersededBy: row.superseded_by ?? null,
    pageType: row.page_type ?? null,
    tags: ix_splitSpace(row.tags),
    aliases: ix_splitSpace(row.aliases),
    summary: row.summary || '',
    rawRefs: ix_splitSpace(row.raw_refs),
    eventTime: row.event_time ?? null,
    anchor: formatAnchor(row.path, row.sha256, row.ord, row.char_start, row.char_end),
  }
}

/** Chunk row + doc row (flat), plus the parent section chunk when kind='leaf'. */
export function getChunk(db, chunkId) {
  const id = Number(chunkId)
  if (!Number.isFinite(id)) return null
  const row = db.prepare(`SELECT c.chunk_id, c.doc_id, c.ord, c.kind, c.parent_ord, c.heading_path, c.char_start, c.char_end, c.token_est, c.text,
      d.path, d.scope, d.title, d.sha256, d.trust, d.status, d.superseded_by, d.page_type, d.tags, d.aliases, d.summary, d.raw_refs, d.event_time
    FROM chunks c JOIN docs d ON d.doc_id = c.doc_id WHERE c.chunk_id = ?`).get(id)
  if (!row) return null
  const out = ix_mapChunkRow(row)
  out.parent = null
  if (out.parentOrd !== null) {
    const p = db.prepare('SELECT chunk_id, ord, kind, heading_path, char_start, char_end, token_est, text FROM chunks WHERE doc_id = ? AND ord = ?')
      .get(out.docId, out.parentOrd)
    if (p) {
      out.parent = {
        chunkId: Number(p.chunk_id), ord: Number(p.ord), kind: p.kind, headingPath: p.heading_path,
        charStart: Number(p.char_start), charEnd: Number(p.char_end), tokenEst: Number(p.token_est), text: p.text,
      }
    }
  }
  return out
}

/** All chunks of one doc, ordered by ord (section before its leaves). */
export function getDocChunks(db, docId) {
  const id = Number(docId)
  if (!Number.isFinite(id)) return []
  return db.prepare(`SELECT c.chunk_id, c.doc_id, c.ord, c.kind, c.parent_ord, c.heading_path, c.char_start, c.char_end, c.token_est, c.text, d.path, d.sha256
    FROM chunks c JOIN docs d ON d.doc_id = c.doc_id WHERE c.doc_id = ? ORDER BY c.ord`).all(id)
    .map((r) => ({
      chunkId: Number(r.chunk_id),
      docId: Number(r.doc_id),
      ord: Number(r.ord),
      kind: r.kind,
      parentOrd: r.parent_ord === null ? null : Number(r.parent_ord),
      headingPath: r.heading_path,
      charStart: Number(r.char_start),
      charEnd: Number(r.char_end),
      tokenEst: Number(r.token_est),
      text: r.text,
      path: r.path,
      anchor: formatAnchor(r.path, r.sha256, r.ord, r.char_start, r.char_end),
    }))
}

/** Doc row with tags/aliases/rawRefs expanded to string[]. */
export function getDocMeta(db, docId) {
  const id = Number(docId)
  if (!Number.isFinite(id)) return null
  const r = db.prepare(`SELECT doc_id, scope, path, title, sha256, mtime_ms, size, trust, status, superseded_by, page_type, tags, aliases, summary, raw_refs, event_time
    FROM docs WHERE doc_id = ?`).get(id)
  if (!r) return null
  return {
    docId: Number(r.doc_id),
    scope: r.scope,
    path: r.path,
    title: r.title,
    sha256: r.sha256,
    mtimeMs: Number(r.mtime_ms),
    size: Number(r.size),
    trust: r.trust ?? null,
    status: r.status ?? null,
    supersededBy: r.superseded_by ?? null,
    pageType: r.page_type ?? null,
    tags: ix_splitSpace(r.tags),
    aliases: ix_splitSpace(r.aliases),
    summary: r.summary || '',
    rawRefs: ix_splitSpace(r.raw_refs),
    eventTime: r.event_time ?? null,
  }
}

export function indexStats(db) {
  const meta = ix_DB_META.get(db) || {}
  const count = (sql) => {
    try { return Number(db.prepare(sql).get().v || 0) } catch { return 0 }
  }
  let dbBytes = 0
  if (meta.dbPath) {
    for (const p of [meta.dbPath, meta.dbPath + '-wal', meta.dbPath + '-shm']) {
      try { if (existsSync(p)) dbBytes += statSync(p).size } catch { /* ignore */ }
    }
  }
  let schemaVersion = null
  let builtAt = null
  try { schemaVersion = ix_getMeta(db, 'schema_version') } catch { /* unreadable */ }
  try { builtAt = ix_getMeta(db, 'built_at') } catch { /* unreadable */ }
  // Live raw-coverage counters (status must stay honest even if sync has not run since a file
  // appeared): a stat-only walk of the workspace, same selection rules as syncIndex.
  let skipped = { extension: 0, size: 0, unreadable: 0 }
  let skippedFiles = []
  if (meta.dir) {
    try { ({ skipped, skippedFiles } = ix_scanWorkspace(meta.dir)) } catch { /* keep zeros */ }
  }
  return {
    docs: count('SELECT count(*) AS v FROM docs'),
    chunks: count('SELECT count(*) AS v FROM chunks'),
    fts: count('SELECT count(*) AS v FROM chunks_fts'),
    dbBytes,
    schemaVersion,
    builtAt,
    rebuildReason: meta.rebuildReason || null,
    skipped,
    skippedFiles,
  }
}

/** Disk-vs-index drift for lint: files not indexed / rows without a file / stat mismatch. */
export function indexDrift(db, dir) {
  const root = path.resolve(String(dir))
  const { files } = ix_scanWorkspace(root)
  let rows
  try {
    rows = db.prepare('SELECT path, mtime_ms, size FROM docs').all()
  } catch {
    return { missing: files.map((f) => f.path), extra: [], stale: [] }
  }
  const byPath = new Map()
  for (const r of rows) byPath.set(String(r.path), r)
  const onDisk = new Set()
  const missing = []
  const stale = []
  for (const f of files) {
    onDisk.add(f.path)
    const row = byPath.get(f.path)
    if (!row) { missing.push(f.path); continue }
    if (Number(row.mtime_ms) !== f.mtimeMs || Number(row.size) !== f.size) stale.push(f.path)
  }
  const extra = []
  for (const p of byPath.keys()) if (!onDisk.has(p)) extra.push(p)
  missing.sort()
  extra.sort()
  stale.sort()
  return { missing, extra, stale }
}

// ---------------------------------------------------------------- runnable self-check
// `node core/mod-indexdb.mjs` — build/search/delete round-trip in a throwaway workspace.
if (process.argv[1] && /mod-indexdb\.mjs$/.test(process.argv[1])) {
  const ix_tmp = path.join(os.tmpdir(), `archivist-ix-selfcheck-${process.pid}-${Date.now()}`)
  const ix_report = { ok: true, errors: [] }
  try {
    mkdirSync(path.join(ix_tmp, 'wiki', 'concepts'), { recursive: true })
    mkdirSync(path.join(ix_tmp, 'raw'), { recursive: true })
    const ix_page = path.join(ix_tmp, 'wiki', 'concepts', 'land.md')
    writeFileSync(ix_page, '---\ntitle: Land System\ntrust: medium\ntags: [land, 土地]\nsources: [raw/note.txt]\ndate: 2026-10-19\n---\n# 全国土地制度\n\n土地制度是全国性的制度安排，城市土地规划需要兼顾效率与公平。\n')
    writeFileSync(path.join(ix_tmp, 'raw', 'note.txt'), 'lorem ipsum 土地制度 raw note\n')
    const ix_db = openIndex(ix_tmp)
    const ix_s1 = syncIndex(ix_db, ix_tmp)
    const ix_hits = searchLexical(ix_db, tokenize('土地制度'), { limit: 10, scope: 'all' })
    const ix_stats = indexStats(ix_db)
    const ix_chunk = ix_hits.length ? getChunk(ix_db, ix_hits[0].chunkId) : null
    const ix_spanOk = !!(ix_chunk && ix_chunk.parent && ix_chunk.parent.text.slice(ix_chunk.charStart - ix_chunk.parent.charStart, ix_chunk.charEnd - ix_chunk.parent.charStart) === ix_chunk.text)
    if (ix_s1.added !== 2) ix_report.errors.push(`added=${ix_s1.added} (want 2)`)
    if (!ix_hits.length) ix_report.errors.push('no lexical hits')
    if (ix_stats.docs !== 2 || ix_stats.chunks < 2) ix_report.errors.push(`stats=${JSON.stringify(ix_stats)}`)
    if (!ix_stats.fts) ix_report.errors.push('fts count is 0')
    if (!ix_spanOk) ix_report.errors.push('chunk span does not map into parent span')
    // index-logic versions are stamped on every build (open-time rebuild gate depends on them)
    const ix_verKeys = ix_db.prepare("SELECT key FROM meta WHERE key IN ('chunker_version','indexer_version')").all().map((r) => r.key).sort()
    if (ix_verKeys.join(',') !== 'chunker_version,indexer_version') ix_report.errors.push(`version meta missing: ${ix_verKeys.join(',')}`)
    // two-stage searchLexical must reproduce the old single-query ranking when the candidate
    // budget covers every OR match (tiny corpus): compare against a direct OR+bm25 query.
    const ix_toks = tokenize('土地制度 城市 规划 note')
    const ix_orQuery = [...new Set(ix_toks)].map((t) => '"' + t.replace(/"/g, '""') + '"').join(' OR ')
    const ix_oldIds = ix_db.prepare(`SELECT c.chunk_id AS id FROM chunks_fts JOIN chunks c ON c.chunk_id = chunks_fts.rowid WHERE chunks_fts MATCH ? ORDER BY bm25(chunks_fts, 1.0, 2.0) ASC, c.chunk_id ASC LIMIT 10`).all(ix_orQuery).map((r) => Number(r.id))
    const ix_newIds = searchLexical(ix_db, ix_toks, { limit: 10, scope: 'all' }).map((r) => r.chunkId)
    if (JSON.stringify(ix_oldIds) !== JSON.stringify(ix_newIds)) {
      ix_report.errors.push(`two-stage ranking differs from single-query: ${JSON.stringify(ix_oldIds)} vs ${JSON.stringify(ix_newIds)}`)
    }
    ix_report.twoStage = { old: ix_oldIds, now: ix_newIds }
    // fast sync (search-path mode) must be a no-op on an unchanged corpus
    const ix_fast = syncIndex(ix_db, ix_tmp, { fast: true })
    if (ix_fast.added || ix_fast.changed || ix_fast.removed) {
      ix_report.errors.push(`fast sync reported changes: ${JSON.stringify({ added: ix_fast.added, changed: ix_fast.changed, removed: ix_fast.removed })}`)
    }
    rmSync(ix_page, { force: true })
    const ix_s2 = syncIndex(ix_db, ix_tmp)
    const ix_stats2 = indexStats(ix_db)
    if (ix_s2.removed !== 1 || ix_stats2.docs !== 1) ix_report.errors.push(`after delete removed=${ix_s2.removed} docs=${ix_stats2.docs}`)
    ix_report.ok = ix_report.errors.length === 0
    ix_report.stats = { before: ix_stats, after: ix_stats2 }
    ix_report.hits = ix_hits.length
    try { ix_db.close() } catch { /* closed */ }
  } catch (err) {
    ix_report.ok = false
    ix_report.errors.push(ix_errMsg(err))
  } finally {
    try { rmSync(ix_tmp, { recursive: true, force: true }) } catch { /* cleanup best effort */ }
  }
  console.log(JSON.stringify(ix_report, null, 2))
  if (!ix_report.ok) process.exitCode = 1
}
