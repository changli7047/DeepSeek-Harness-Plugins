/**
 * mod-retrieval.mjs — Phase 1 hybrid retrieval for archivist.
 *
 * Contract: docs/p1-contract.md §4 (frozen). This module owns ONLY retrieval:
 * query normalization, three channels (lexical BM25 via the SQLite index, alias
 * expansion from docs.aliases, exact/symbol scoring over candidate chunk texts),
 * RRF fusion, de-duplication, correction-state handling, deterministic re-ranking,
 * parent expansion, and a visible in-memory fallback when the index is unusable.
 *
 * Invariants:
 *  - deterministic: no Math.random, no tie-breaking on wall-clock time. The one
 *    time input (recency) is only applied when the caller supplies `asOf`.
 *  - no markdown writes, no network, node:* builtins only.
 *  - every fallback path writes `diagnostics.degraded` — silent degradation is a bug.
 *
 * Dependencies (frozen signatures, implemented in the sibling modules that the
 * build inlines before this one):
 *   ./mod-chunks.mjs   tokenize, estimateTokens, formatAnchor
 *   ./mod-indexdb.mjs  openIndex, syncIndex, searchLexical, getChunk, getDocChunks, getDocMeta
 */
import path from 'node:path'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { tokenize, estimateTokens, formatAnchor } from './mod-chunks.mjs'
import { openIndex, syncIndex, searchLexical, getChunk, getDocChunks, getDocMeta, indexRebuildNote } from './mod-indexdb.mjs'
import { ensureVectorSchema, searchDense, vectorStats, rerankDocs, mlStatus } from './mod-vector.mjs'

// ---------------------------------------------------------------- tuning constants

export const rt_RRF_K = 60
export const rt_SUPERSEDED_FACTOR = 0.35
const rt_PARENT_TOKEN_CAP = 3000 // contract §4.8
const rt_FUSED_CANDIDATE_CAP = 80 // candidates that get fetched / de-duped / re-ranked
const rt_EXACT_CANDIDATE_CAP = 50 // per contract: exact channel only touches top candidates
const rt_FTS_TOKEN_CAP = 96
const rt_LEXICAL_LIMIT = 100
const rt_INDEX_RETRY_MS = 5000
const rt_LEGACY_RAW_SIZE_CAP = 2 * 1024 * 1024
const rt_LEGACY_RAW_EXTS = /\.(md|txt|json|csv|ya?ml)$/i
const rt_LEGACY_EXCLUDE_RE = /(^|\/)(\.backups|\.git|node_modules|\.index)(\/|$)/

// ---------------------------------------------------------------- re-rank weights

/**
 * Feature weights of the deterministic re-ranker (contract §4.7). The object is
 * exported live on purpose: `bench/ablate.mjs` overrides fields through
 * setRerankWeights() (or by assignment) and the next search uses them.
 */
export const rt_RERANK_DEFAULTS = Object.freeze({
  title: 0, // title token coverage (0 = measured negative on the gold set)
  titleExact: 0.8, // document title equals the normalised query (title lookup)
  titleStarts: 0.3, // query / title is a prefix of the other
  titleSegCov: 0.5, // best query segment vs title (multi-part / multi-hop queries)
  heading: 0, // heading_path coverage (0 = measured negative)
  coverage: 0, // chunk body token coverage (0 = measured negative)
  phrase: 0.5, // long query segment occurs verbatim in the chunk text
  phraseDoc: 1.2, // phrase-shaped query occurs verbatim anywhere in the document
  proximity: 0, // token proximity (0 = measured negative)
  trust: 0, // trust tier (0 = measured negative)
  recency: 0.2, // event_time / mtime distance to asOf (only when asOf is given)
  length: 0, // length penalty (0 = measured negative)
})
export const RERANK_WEIGHTS = { ...rt_RERANK_DEFAULTS }

// Phase 3 cross-encoder re-rank knobs (contract p3 §1). `mode` is selectable so the gold
// ablation can pick between score-boost and pure-rerank ordering; candidates=30 matches the
// documented latency budget (30 pairs ≈ 0.3–0.5s on this machine).
export const RERANK_CANDIDATES = 10
export const RERANK_CONFIG = {
  candidates: RERANK_CANDIDATES,
  mode: 'boost', // 'boost' → rrf*(1+w*score) | 'pure' → rerank score only
  boostW: 1.0,
  maxTokens: 128, // sidecar truncation target (negotiated; preferred once supported)
  maxChars: 400, // char fallback until the sidecar honours maxTokens (~128 CJK tokens)
  marginThreshold: 0.05, // re-rank only when top1/top2 are this close (relative score gap)
  timeoutMs: 3000,
  cacheTtlMs: 300000,
  cacheMax: 4096,
}
const rt_RERANK_CACHE = new Map()
function rt_rerankCacheGet(key) {
  const hit = rt_RERANK_CACHE.get(key)
  if (!hit) return undefined
  if (Date.now() - hit.ts > RERANK_CONFIG.cacheTtlMs) {
    rt_RERANK_CACHE.delete(key)
    return undefined
  }
  return hit.score
}
function rt_rerankCacheSet(key, score) {
  rt_RERANK_CACHE.set(key, { ts: Date.now(), score })
  while (rt_RERANK_CACHE.size > RERANK_CONFIG.cacheMax) {
    const oldest = rt_RERANK_CACHE.keys().next()
    if (oldest.done) break
    rt_RERANK_CACHE.delete(oldest.value)
  }
}

/** Cross-encoder default: on only when ML + ARCHIVIST_ML_RERANK=1 are explicitly configured. */
function rt_rerankDefault() {
  try {
    if (String(process.env.ARCHIVIST_ML_RERANK || '').trim() !== '1') return false
    return rt_denseDefault()
  } catch {
    return false
  }
}

/** Dense channel default: on only when ML is explicitly configured (contract p2 §4: off by default). */
function rt_denseDefault() {
  try {
    const st = mlStatus({})
    if (!st || st.enabled !== true) return false
    const explicit = String(process.env.ARCHIVIST_ML_PYTHON || '').trim() || String(process.env.ARCHIVIST_ML_MODELS || '').trim()
    return !!explicit
  } catch {
    return false
  }
}


/** Replace a subset of the live re-rank weights; no argument resets to defaults. */
export function setRerankWeights(partial) {
  if (partial === undefined || partial === null) {
    for (const k of Object.keys(rt_RERANK_DEFAULTS)) RERANK_WEIGHTS[k] = rt_RERANK_DEFAULTS[k]
    return { ...RERANK_WEIGHTS }
  }
  for (const [k, v] of Object.entries(partial)) {
    if (!Object.prototype.hasOwnProperty.call(rt_RERANK_DEFAULTS, k)) continue
    const n = Number(v)
    if (Number.isFinite(n)) RERANK_WEIGHTS[k] = n
  }
  return { ...RERANK_WEIGHTS }
}

// ---------------------------------------------------------------- small helpers

const rt_nowMs = () => performance.now()

/** Full-width ASCII + ideographic space → half-width; then lowercase + squeeze blanks. */
export function normalizeQuery(q) {
  const s = String(q ?? '')
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, ' ')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .toLowerCase()
    .replace(/[\s\u00a0]+/g, ' ')
    .trim()
  return s
}

const rt_camel = (s) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase())
/** Read a rt_field from a DB row that may be snake_case (schema) or camelCase. */
function rt_field(row, key, fallback) {
  if (!row) return fallback
  if (row[key] !== undefined && row[key] !== null) return row[key]
  const c = rt_camel(key)
  if (row[c] !== undefined && row[c] !== null) return row[c]
  return fallback
}

function rt_chunkRowOf(row) {
  if (!row) return null
  if (row.chunk && typeof row.chunk === 'object') return row.chunk
  return row
}

const rt_shortHash = (text) => createHash('sha1').update(text).digest('hex').slice(0, 16)
const rt_sha256Hex = (buf) => createHash('sha256').update(buf).digest('hex')

function rt_errorText(e) {
  const msg = e && e.message ? e.message : String(e)
  return msg.length > 200 ? msg.slice(0, 200) + '…' : msg
}

function rt_uniqTokens(text) {
  const out = []
  const seen = new Set()
  for (const t of tokenize(text)) {
    const tok = typeof t === 'string' ? t : String(t ?? '')
    if (!tok || seen.has(tok)) continue
    if (out.length >= rt_FTS_TOKEN_CAP) break
    seen.add(tok)
    out.push(tok)
  }
  return out
}

function rt_countOcc(hay, needle, cap = 20) {
  if (!needle) return 0
  let n = 0
  let i = 0
  while (n < cap) {
    const j = hay.indexOf(needle, i)
    if (j < 0) break
    n++
    i = j + needle.length
  }
  return n
}

function rt_snippetOf(text, tokens) {
  const lower = text.toLowerCase()
  let pos = -1
  for (const t of tokens) {
    const j = lower.indexOf(t)
    if (j >= 0 && (pos < 0 || j < pos)) pos = j
  }
  if (pos < 0) pos = 0
  const start = Math.max(0, pos - 60)
  return text.slice(start, start + 180).replace(/\s+/g, ' ').trim()
}

// ---------------------------------------------------------------- index lifecycle

const rt_INDEX_CACHE = new Map() // resolved dir → { db, error, failedAt, sync, syncedAt, lastSyncError }

function rt_indexState(dir) {
  const key = path.resolve(String(dir))
  const cached = rt_INDEX_CACHE.get(key)
  if (cached && !cached.error) return cached
  if (cached && cached.error && Date.now() - cached.failedAt < rt_INDEX_RETRY_MS) return cached
  const rec = {
    db: null, error: null, failedAt: 0, sync: null, syncedAt: 0, lastSyncError: null,
    stamp: null, lastSyncAt: 0, lastFullSyncAt: 0, syncSkipped: 0,
    lastSyncMode: null, lastSyncCostMs: 0, throttleActive: false,
  }
  try {
    rec.db = openIndex(key)
    if (!rec.db) throw new Error('openIndex returned no handle')
  } catch (e) {
    rec.db = null
    rec.error = `索引不可用（${rt_errorText(e)}）`
    rec.failedAt = Date.now()
  }
  rt_INDEX_CACHE.set(key, rec)
  return rec
}

/**
 * Sync the index before every search: contract §8.6 wants a changed file to be
 * visible on the very next search. syncIndex is incremental (mtime+size gate), so
 * the steady-state cost is a stat pass. Returns null on success, a reason otherwise.
 */
export const rt_SYNC_MIN_INTERVAL_MS = 1500
export const rt_SYNC_FULL_INTERVAL_MS = 60000
// Workspaces below this scanned-file count keep the old "sync on every search" behavior: their
// scan costs a few ms, and the freshness assertions (§8.6) overwrite a file and search again
// inside one query sequence, which is worth more there than the saved milliseconds.
export const rt_SYNC_THROTTLE_MIN_FILES = 400
// Below this many scanned files a *file-level* stamp (path+mtime+size) is cheaper than the full
// sync scan (~1-2ms vs 18-50ms on a 107-file library) and it still catches in-place content
// edits, so the small-library path can skip the sync whenever nothing changed — no TTL needed.
export const rt_SYNC_DEEP_STAMP_MAX_FILES = 400

function rt_syncThrottleEligible(rec, opts) {
  if (opts.throttle === false || opts.forceSync === true) return false
  const minFiles = Number(opts.syncThrottleMinFiles ?? rt_SYNC_THROTTLE_MIN_FILES)
  const scanned = rec.sync && Number(rec.sync.scanned) ? Number(rec.sync.scanned) : 0
  return scanned >= minFiles
}

/** Cheap structural stamp: directory mtimes + child counts under wiki/ and raw/ (no file stats). */
const rt_VECTOR_SCHEMA_DONE = new WeakSet()

/** File-level stamp (path+mtime+size) — used for libraries small enough that statting them is cheap. */
function rt_workspaceStampDeep(dir) {
  const parts = []
  const visit = (base, rel) => {
    let ents
    try {
      ents = readdirSync(base, { withFileTypes: true })
    } catch {
      parts.push(rel + ':x')
      return
    }
    let mt = 0
    try {
      mt = statSync(base).mtimeMs
    } catch {
      mt = 0
    }
    parts.push(rel + ':' + mt + ':' + ents.length)
    for (const e of ents) {
      if (e.isDirectory()) {
        visit(path.join(base, e.name), rel + '/' + e.name)
      } else if (e.isFile()) {
        let st = null
        try {
          st = statSync(path.join(base, e.name))
        } catch {
          st = null
        }
        parts.push(rel + '/' + e.name + ':' + (st ? st.mtimeMs + ':' + st.size : 'x'))
      }
    }
  }
  visit(path.join(dir, 'wiki'), 'wiki')
  visit(path.join(dir, 'raw'), 'raw')
  return parts.join('|')
}

function rt_workspaceStamp(dir) {
  const parts = []
  const visit = (base, rel) => {
    let ents
    try {
      ents = readdirSync(base, { withFileTypes: true })
    } catch {
      parts.push(rel + ':x')
      return
    }
    let mt = 0
    try {
      mt = statSync(base).mtimeMs
    } catch {
      mt = 0
    }
    parts.push(rel + ':' + mt + ':' + ents.length)
    for (const e of ents) if (e.isDirectory()) visit(path.join(base, e.name), rel + '/' + e.name)
  }
  visit(path.join(dir, 'wiki'), 'wiki')
  visit(path.join(dir, 'raw'), 'raw')
  return parts.join('|')
}

/**
 * Sync the index before a search. Large workspaces (>= rt_SYNC_THROTTLE_MIN_FILES files) are
 * throttled: inside rt_SYNC_MIN_INTERVAL_MS the query reuses the open connection and cached
 * stats without touching the directory tree; a structural change (new/removed file, seen by
 * the cheap directory stamp) still forces a full sync on the very next query; content edits
 * of existing files are picked up by the periodic full sync (rt_SYNC_FULL_INTERVAL_MS) or
 * immediately by a forced sync (write tools call syncIndex/syncNow directly).
 * Returns null when the query may proceed, a reason string when it must degrade.
 */
function rt_syncIndexFor(rec, dir, opts = {}) {
  if (!rec.db) return rec.error
  const root = path.resolve(String(dir))
  const now = Date.now()
  const t0 = rt_nowMs()
  const interval = Math.max(0, Number(opts.syncMinIntervalMs ?? rt_SYNC_MIN_INTERVAL_MS))
  const fullInterval = Math.max(interval, Number(opts.syncFullIntervalMs ?? rt_SYNC_FULL_INTERVAL_MS))
  const scanned = rec.sync && Number(rec.sync.scanned) ? Number(rec.sync.scanned) : 0
  const force = opts.forceSync === true
  const deep = !force && scanned < rt_SYNC_DEEP_STAMP_MAX_FILES
  const throttled = deep || rt_syncThrottleEligible(rec, opts)
  const finish = (mode) => {
    rec.lastSyncMode = mode
    rec.lastSyncCostMs = rt_round2(rt_nowMs() - t0)
  }
  let stamp = null
  if (deep) {
    try {
      stamp = rt_workspaceStampDeep(root)
    } catch {
      stamp = null
    }
  } else if (throttled) {
    try {
      stamp = rt_workspaceStamp(root)
    } catch {
      stamp = null
    }
  }
  const withinInterval = rec.lastSyncAt > 0 && now - rec.lastSyncAt < interval
  const stampChanged = stamp !== null && rec.stamp !== null && stamp !== rec.stamp
  const fullDue = !(rec.lastFullSyncAt > 0) || now - rec.lastFullSyncAt >= fullInterval
  rec.throttleActive = throttled
  if (deep && stamp !== null && !stampChanged && rec.lastFullSyncAt > 0) {
    rec.lastSyncAt = now
    rec.syncSkipped++
    finish('stampDeep')
    return null
  }
  if (throttled && !stampChanged) {
    if (stamp !== null && !fullDue) {
      if (withinInterval) {
        rec.syncSkipped++
        finish('throttled')
        return null
      }
      rec.lastSyncAt = now
      rec.syncSkipped++
      finish('stamp')
      return null
    }
    if (withinInterval && fullDue) {
      // a due periodic full sync still runs even inside the interval (this is what bounds the
      // staleness of in-place content edits)
    }
  }
  try {
    const res = syncIndex(rec.db, root)
    const at = Date.now()
    rec.syncedAt = at
    rec.lastSyncAt = at
    rec.lastFullSyncAt = at
    rec.sync = res && typeof res === 'object' ? res : null
    rec.lastSyncError = null
    try {
      // store the same stamp flavour the next query will compute
      const scannedAfter = rec.sync && Number(rec.sync.scanned) ? Number(rec.sync.scanned) : 0
      const deepAfter = !force && scannedAfter < rt_SYNC_DEEP_STAMP_MAX_FILES
      rec.stamp = deepAfter ? rt_workspaceStampDeep(root) : rt_workspaceStamp(root)
      rec.stampDeep = deepAfter
    } catch {
      rec.stamp = null
      rec.stampDeep = false
    }
    rec.throttleActive = throttled
    finish('full')
    return null
  } catch (e) {
    rec.lastSyncError = rt_errorText(e)
    finish('failed')
    return `索引同步失败（${rec.lastSyncError}）`
  }
}

/** Force a full sync for a workspace, bypassing the throttle (write tools, tests). */
export function syncNow(dir, opts = {}) {
  const key = path.resolve(String(dir))
  const rec = rt_indexState(key)
  if (!rec.db) throw new Error(rec.error || 'index unavailable')
  const failure = rt_syncIndexFor(rec, key, { ...opts, forceSync: true, throttle: false })
  if (failure) throw new Error(failure)
  return rec.sync
}

function rt_docMeta(rec, docId, cache) {
  if (cache.has(docId)) return cache.get(docId)
  let meta = null
  try {
    meta = getDocMeta(rec.db, docId) || null
  } catch {
    meta = null
  }
  cache.set(docId, meta)
  return meta
}

function rt_chunkFetch(rec, chunkId, cache) {
  if (cache.has(chunkId)) return cache.get(chunkId)
  let row = null
  try {
    row = getChunk(rec.db, chunkId) || null
  } catch {
    row = null
  }
  const chunk = rt_chunkRowOf(row)
  cache.set(chunkId, chunk)
  return chunk
}

function rt_docChunks(rec, docId, cache) {
  if (cache.has(docId)) return cache.get(docId)
  let chunks = []
  try {
    chunks = getDocChunks(rec.db, docId) || []
  } catch {
    chunks = []
  }
  const byOrd = new Map()
  for (const raw of chunks) {
    const ch = rt_chunkRowOf(raw)
    if (!ch) continue
    byOrd.set(Number(rt_field(ch, 'ord', 0)), ch)
  }
  cache.set(docId, byOrd)
  return byOrd
}

// ---------------------------------------------------------------- query analysis

/**
 * Probes for the exact channel (contract §4.4). Only symbol-bearing ASCII
 * segments, long digit runs and uppercase abbreviations qualify; CJK is handled
 * by the lexical channel.
 */
function rt_exactProbes(rawQuery) {
  const raw = String(rawQuery ?? '')
  const probes = new Set()
  // Symbol-bearing ASCII segments: "o(logn)", "file_path", "b+", "zxqv-not-included-7788".
  for (const m of raw.matchAll(/[!-~]{2,}/g)) {
    const seg = m[0]
    if (/^[a-z0-9_-]+$/.test(seg) && !/_/.test(seg)) continue // plain word / plain id-lookalike
    if (!/[A-Za-z]/.test(seg) && !/[^0-9]/.test(seg)) continue // pure punctuation
    const clean = seg.replace(/[,;:!?"'()\[\]{}<>]+$/g, '').replace(/^[,;:!?"'()\[\]{}<>]+/g, '')
    if (clean.length >= 2 && /[^a-z0-9]/.test(clean.toLowerCase())) probes.add(clean.toLowerCase())
  }
  // Long digit runs (order numbers, ids).
  for (const m of raw.matchAll(/\d{6,}/g)) probes.add(m[0])
  // Uppercase abbreviations / mixed-case identifiers: DSH, TILT, CC0, WebGL.
  for (const m of raw.matchAll(/\b[A-Z][A-Za-z0-9]*[A-Z0-9][A-Za-z0-9]*\b/g)) probes.add(m[0].toLowerCase())
  const list = [...probes].filter((p) => p.length >= 2)
  return list.slice(0, 12)
}

function rt_exactEnabled(normalized, rawQuery) {
  return (
    /[^a-z0-9\s\u4e00-\u9fff]/.test(normalized) ||
    /\d{6,}/.test(normalized) ||
    /\b[A-Z][A-Z0-9]{1,}\b/.test(String(rawQuery ?? ''))
  )
}

/** Boundary-aware containment used by the alias channel ("dsh" must not match "dshx"). */
function rt_containsTerm(hay, term) {
  if (!term) return false
  const i = hay.indexOf(term)
  if (i < 0) return false
  if (!/[a-z0-9]/.test(term)) return true // CJK / punctuation term: plain substring match
  const isWord = (ch) => !!ch && /[a-z0-9]/.test(ch)
  if (isWord(i > 0 ? hay[i - 1] : '') || isWord(hay[i + term.length] || '')) return false
  return true
}

// ---------------------------------------------------------------- channels

function rt_channelLexical(rec, tokens, scope, filters) {
  const rows = searchLexical(rec.db, tokens, { limit: rt_LEXICAL_LIMIT, scope, filters })
  const ranks = new Map()
  const out = []
  let rank = 0
  for (const row of Array.isArray(rows) ? rows : []) {
    const chunkId = Number(rt_field(row, 'chunk_id', rt_field(row, 'chunkId', NaN)))
    if (!Number.isFinite(chunkId) || ranks.has(chunkId)) continue
    ranks.set(chunkId, rank++)
    out.push({
      chunkId,
      docId: Number(rt_field(row, 'doc_id', rt_field(row, 'docId', NaN))),
      path: rt_field(row, 'path', ''),
      scope: rt_field(row, 'scope', scope),
      bm25: rt_field(row, 'bm25', 0),
      row,
    })
  }
  return { rows: out, ranks }
}

/**
 * Alias channel (contract §4.3): alias → canonical and canonical → alias. The
 * aliases live in docs.aliases (schema v1, frozen), which the §2.3 API does not
 * expose as a listing, so the frozen schema is read directly. Any failure leaves
 * the channel empty instead of failing the search.
 */
function rt_loadAliasRows(rec) {
  if (!rec || !rec.db) return []
  if (rec.aliasRows && rec.aliasRowsAt === rec.syncedAt) return rec.aliasRows
  let rows = []
  try {
    const db = typeof rec.db.prepare === 'function' ? rec.db : rec.db.db
    if (db && typeof db.prepare === 'function') {
      rows = db.prepare('SELECT doc_id, path, title, aliases, tags FROM docs').all() || []
    }
  } catch {
    rows = []
  }
  rec.aliasRows = rows
  rec.aliasRowsAt = rec.syncedAt
  return rows
}

/**
 * Alias channel (contract §4.3) plus page-identity expansion. Two sources:
 *  1. docs.aliases both ways: a query naming an alias is re-searched under the canonical
 *     title, and a query naming the canonical page probes its aliases;
 *  2. titles/tags: a query that *is* a page title (or nearly is) injects that document's
 *     best leaf as a candidate. Required for pages whose title never occurs in the body
 *     (frontmatter-only title) — pure FTS cannot see those.
 * The docs table is read directly because the §2.3 API exposes no document listing.
 */
function rt_channelAlias(rec, normalized, queryTokens, scope, filters, chunkCache, aliasEnabled, metaEnabled) {
  const rows = rt_loadAliasRows(rec)
  const ranks = new Map()
  const out = []
  if (!rows.length) return { rows: out, ranks, queries: 0, docs: 0 }
  const metaDocs = []
  let aliasHits = 0
  for (const row of rows) {
    const docId = Number(rt_field(row, 'doc_id', rt_field(row, 'docId', NaN)))
    const docPath = String(rt_field(row, 'path', '') || '')
    const title = String(rt_field(row, 'title', '') || path.posix.basename(docPath, '.md'))
    const aliases = String(rt_field(row, 'aliases', '') || '').split(/\s+/).filter(Boolean)
    const titleNorm = normalizeQuery(title)
    const titleTokens = new Set(tokenize(title))
    const tagTokens = new Set(tokenize(String(rt_field(row, 'tags', '') || '')))
    const tagCov = rt_coverageOf(queryTokens, tagTokens)
    // Multi-part queries ("<title A> <title B>") must score each title separately: coverage
    // over all tokens would under-score both pages and the page-identity channel would miss them.
    const segs = normalized.split(' ').filter(Boolean)
    let titleCov = 0
    let segExact = false
    let segStarts = false
    for (const seg of segs) {
      const segTokens = rt_uniqTokens(seg)
      if (!segTokens.length) continue
      const cov = rt_coverageOf(segTokens, titleTokens)
      if (cov > titleCov) titleCov = cov
      if (titleNorm && titleNorm === seg) segExact = true
      else if (titleNorm && (titleNorm.startsWith(seg) || seg.startsWith(titleNorm) || (titleNorm === normalized))) segStarts = true
    }
    if (titleNorm && titleNorm === normalized) segExact = true
    let aliasHit = false
    for (const alias of aliases) {
      const a = normalizeQuery(alias)
      if (!a) continue
      // alias → canonical: the query names the alias; the reverse direction (alias contains
      // the query) keeps short canonical lookups working.
      if (rt_containsTerm(normalized, a) || rt_containsTerm(a, normalized)) aliasHit = true
    }
    // canonical → alias: the query names the page itself, so the page is a candidate.
    if (!aliasHit && titleNorm && rt_containsTerm(normalized, titleNorm)) aliasHit = true
    if (aliasHit && aliasEnabled) aliasHits++
    if (!aliasEnabled) aliasHit = false
    const exact = segExact
    const starts = !exact && segStarts
    const titleScore = (exact ? 10 : 0) + (starts ? 4 : 0) + 6 * titleCov + 3 * tagCov
    const metaScore = titleScore + (aliasHit ? 6 : 0)
    const keep = (metaEnabled !== false && titleScore >= 4) || (aliasHit && aliasEnabled)
    if (keep && Number.isFinite(docId)) {
      metaDocs.push({ docId, path: docPath, scope: String(rt_field(row, 'scope', scope) || scope), metaScore, exact, titleLen: title.length })
    }
  }
  let rank = 0
  // Page-identity candidates: inject the leaf that best covers the query for each matching doc
  // (at most 12 docs, deterministic order by metaScore then docId).
  metaDocs.sort((a, b) => b.metaScore - a.metaScore || a.titleLen - b.titleLen || a.docId - b.docId)
  let injected = 0
  for (const doc of metaDocs.slice(0, 12)) {
    let docChunksList = []
    try {
      docChunksList = getDocChunks(rec.db, doc.docId) || []
    } catch {
      docChunksList = []
    }
    let best = null
    let bestCov = -1
    for (const rawChunk of docChunksList) {
      const ch = rt_chunkRowOf(rawChunk)
      if (!ch) continue
      if (String(rt_field(ch, 'kind', 'leaf')) !== 'leaf') continue
      const text = String(rt_field(ch, 'text', '') || '')
      if (!text) continue
      const cov = rt_coverageOf(queryTokens, new Set(tokenize(text)))
      if (cov > bestCov) {
        bestCov = cov
        best = ch
      }
    }
    if (!best) continue
    const chunkId = Number(rt_field(best, 'chunk_id', rt_field(best, 'chunkId', NaN)))
    if (!Number.isFinite(chunkId)) continue
    chunkCache.set(chunkId, best)
    if (!ranks.has(chunkId)) {
      ranks.set(chunkId, rank++)
      out.push({ chunkId, docId: doc.docId, path: doc.path, scope: doc.scope, bm25: -doc.metaScore })
      injected++
    }
  }
  return { rows: out, ranks, queries: aliasHits, docs: injected }
}

/**
 * Exact channel (contract §4.4): score the candidate chunk texts with the existing
 * rt_countOcc semantics. `bm25` re-uses the rank order of the lexical channel as the
 * candidate window; nothing outside that window is scanned (no full-table scan).
 */
function rt_channelExact(probes, candidates, chunkCache) {
  const ranks = new Map()
  const out = []
  if (!probes.length || !candidates.length) return { rows: out, ranks }
  const scored = []
  for (const cand of candidates.slice(0, rt_EXACT_CANDIDATE_CAP)) {
    const chunk = chunkCache.get(cand.chunkId)
    if (!chunk) continue
    const text = String(rt_field(chunk, 'text', '') || '').toLowerCase()
    if (!text) continue
    let score = 0
    let matched = 0
    for (const probe of probes) {
      const c = rt_countOcc(text, probe, 10)
      if (!c) continue
      matched++
      score += c * (1 + Math.min(3, probe.length / 8))
    }
    if (score <= 0) continue
    if (matched === probes.length && probes.length > 1) score += 3 // all probes present
    scored.push({ chunkId: cand.chunkId, docId: cand.docId, path: cand.path, scope: cand.scope, score })
  }
  scored.sort((a, b) => b.score - a.score || a.chunkId - b.chunkId)
  let rank = 0
  for (const s of scored) {
    if (!ranks.has(s.chunkId)) {
      ranks.set(s.chunkId, rank)
      out.push({ ...s, bm25: -s.score })
    }
    rank++
  }
  return { rows: out, ranks }
}

// ---------------------------------------------------------------- re-rank features

function rt_tokenWeight(token) {
  if (/^[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]+$/.test(token)) {
    const n = token.length
    return n >= 10 ? 14 : n >= 6 ? 9 : n >= 3 ? 5 : 1
  }
  if (/[^a-z0-9]/.test(token)) return 5
  return 1
}

function rt_coverageOf(queryTokens, tokenSet) {
  if (!queryTokens.length) return 0
  let total = 0
  let hit = 0
  for (const t of queryTokens) {
    const w = Math.max(1, Math.min(3, rt_tokenWeight(t)))
    total += w
    if (tokenSet.has(t)) hit += w
  }
  return total ? hit / total : 0
}

const rt_TRUST_SCORE = { high: 1, medium: 0.7, low: 0.3 }

function rt_tagList(raw) {
  const arr = Array.isArray(raw) ? raw : String(raw || '').split(/\s+/)
  return arr.map((t) => String(t).toLowerCase()).filter(Boolean)
}

function rt_rerankFeatures(ctx) {
  const {
    queryTokens, normalizedQuery, chunkText, chunkTokens, title, titleTokens, headingTokens,
    tagsLower, trust, ageDays, tokenEst, hasDocPhrase,
  } = ctx
  const lower = chunkText.toLowerCase()
  const titleCov = rt_coverageOf(queryTokens, titleTokens)
  const headingCov = rt_coverageOf(queryTokens, headingTokens)
  const coverage = rt_coverageOf(queryTokens, chunkTokens)
  const titleNorm = normalizeQuery(title || '')
  const titleExact = titleNorm && titleNorm === normalizedQuery ? 1 : 0
  const titleStarts = !titleExact && titleNorm && (titleNorm.startsWith(normalizedQuery) || normalizedQuery.startsWith(titleNorm)) ? 1 : 0
  let titleSegCov = 0
  for (const seg of normalizedQuery.split(' ')) {
    if (!seg) continue
    const segTokens = rt_uniqTokens(seg)
    if (!segTokens.length) continue
    const cov = rt_coverageOf(segTokens, titleTokens)
    if (cov > titleSegCov) titleSegCov = cov
  }

  // Verbatim phrase evidence: a long query segment occurring inside the chunk. The legacy
  // scorer got this implicitly from substring countOcc with a 14x weight on long CJK runs;
  // bigram-only BM25 loses it because a document-side run boundary rarely equals the query
  // run boundary (query "补入三国志建造地图考" vs body "...补入三国志建造地图考据帖").
  let phrase = 0
  const segs = []
  for (const seg of normalizedQuery.split(' ')) if (seg && seg.length >= 4 && !segs.includes(seg)) segs.push(seg)
  if (segs.length) {
    let total = 0
    let found = 0
    for (const seg of segs) {
      const w = Math.min(20, seg.length)
      total += w
      if (lower.includes(seg)) found += w
    }
    phrase = total ? found / total : 0
  }

  let min = Infinity
  let max = -Infinity
  let matched = 0
  for (const t of queryTokens) {
    const j = lower.indexOf(t)
    if (j < 0) continue
    matched++
    if (j < min) min = j
    if (j + t.length > max) max = j + t.length
  }
  const proximity = matched >= 2 ? Math.max(0, 1 - (max - min) / 1200) : 0
  const trustScore = rt_TRUST_SCORE[String(trust || '').toLowerCase()] ?? 0.5
  const recency = ageDays === null || ageDays === undefined ? 0 : 1 / (1 + Math.max(0, ageDays) / 365)
  const lengthPenalty = tokenEst < 60 ? 0.5 : tokenEst > 800 ? Math.min(1, (tokenEst - 800) / 1600) : 0
  let tagHits = 0
  for (const tag of tagsLower || []) if (tag && normalizedQuery.includes(tag)) tagHits++
  return { titleCov, titleSegCov, headingCov, coverage, proximity, titleExact, titleStarts, phrase, phraseDoc: hasDocPhrase ? 1 : 0, trustScore, recency, lengthPenalty, tagHits, tokenEst }
}

function rt_rerankMultiplier(features) {
  const w = RERANK_WEIGHTS
  const m =
    1 +
    w.title * features.titleCov +
    w.titleExact * features.titleExact +
    w.titleStarts * features.titleStarts +
    w.titleSegCov * features.titleSegCov +
    w.heading * features.headingCov +
    w.coverage * features.coverage +
    w.phrase * features.phrase +
    w.phraseDoc * features.phraseDoc +
    w.proximity * features.proximity +
    w.trust * (features.trustScore - 0.5) +
    w.recency * features.recency +
    w.length * features.lengthPenalty
  return Math.min(10, Math.max(0.05, m))
}

/** Scope + filters for candidates that did not come from the (already filtered) lexical query. */
function rt_metaPassesFilters(meta, scope, filters) {
  if (!meta) return false
  const docScope = String(rt_field(meta, 'scope', '') || '')
  if (scope !== 'all' && docScope && docScope !== scope) return false
  const status = String(rt_field(meta, 'status', '') || '')
  if (filters.excludeRetracted !== false && status === 'retracted') return false
  if (filters.status && status !== filters.status) return false
  const trust = String(rt_field(meta, 'trust', '') || '')
  if (filters.trust && trust !== filters.trust) return false
  const pageType = String(rt_field(meta, 'page_type', '') || '')
  if (filters.pageType && pageType !== filters.pageType) return false
  const eventTime = rt_field(meta, 'event_time', null)
  if (filters.timeFrom && (!eventTime || String(eventTime) < String(filters.timeFrom))) return false
  if (filters.timeTo && (!eventTime || String(eventTime) > String(filters.timeTo))) return false
  return true
}


/**
 * Phase 3 cross-encoder re-rank. Sends at most RERANK_CONFIG.candidates leaf chunk texts in one
 * batch, applies cached scores within the TTL, then re-scores the candidates. Any failure
 * (sidecar missing, ARCHIVIST_ML=0, ARCHIVIST_ML_RERANK!=1, timeout) returns the input order
 * untouched and appends a precise degradation line.
 */
async function rt_crossEncoderRerank(final, rawQuery, normalizedQuery, degraded, channelInfo = {}) {
  const t0 = rt_nowMs()
  const { lexTopDoc, denseTopDoc } = channelInfo
  const info = {
    enabled: true,
    requested: true,
    skipped: null,
    trigger: null,
    margin: null,
    channelsDisagree: null,
    mode: RERANK_CONFIG.mode,
    boostW: RERANK_CONFIG.boostW,
    candidates: 0,
    reranked: 0,
    truncated: 0,
    cachedHits: 0,
    model: null,
    ms: 0,
    degraded: null,
  }
  const s1 = final.length ? final[0].finalScore : 0
  const s2 = final.length > 1 ? final[1].finalScore : 0
  const margin = s1 > 0 ? (s1 - s2) / s1 : 1
  const channelsDisagree = !!(lexTopDoc && denseTopDoc && Number(lexTopDoc) !== Number(denseTopDoc))
  const needRerank = margin < RERANK_CONFIG.marginThreshold || channelsDisagree
  info.margin = Math.round(margin * 1000) / 1000
  info.channelsDisagree = channelsDisagree
  if (!needRerank) {
    // Both triggers were evaluated and neither fired: the base ordering is confident
    // (margin >= threshold and the lexical/dense heads agree).
    info.skipped = 'margin'
    info.ms = rt_round2(rt_nowMs() - t0)
    return info
  }
  info.trigger = channelsDisagree ? 'top1-mismatch' : 'margin'
  const pool = final.slice(0, RERANK_CONFIG.candidates)
  const leafItems = []
  for (const item of pool) {
    const kind = String(rt_field(item.chunk, 'kind', 'leaf') || 'leaf')
    if (kind !== 'leaf') continue
    let text = item.chunkText
    if (text.length > RERANK_CONFIG.maxChars) {
      text = text.slice(0, RERANK_CONFIG.maxChars) + ' …'
      info.truncated++
    }
    leafItems.push({ item, text, score: undefined })
  }
  info.candidates = leafItems.length
  if (!leafItems.length) {
    info.ms = rt_round2(rt_nowMs() - t0)
    return info
  }
  const keyBase = rt_shortHash(normalizedQuery)
  const pending = []
  for (const entry of leafItems) {
    const cached = rt_rerankCacheGet(keyBase + '\u0000' + entry.item.cand.chunkId)
    if (cached !== undefined) {
      entry.score = cached
      info.cachedHits++
    } else {
      pending.push(entry)
    }
  }
  if (pending.length) {
    try {
      const res = await rerankDocs(rawQuery, pending.map((entry) => entry.text), { timeoutMs: RERANK_CONFIG.timeoutMs, maxTokens: RERANK_CONFIG.maxTokens })
      if (res && res.degraded) {
        info.degraded = res.degraded
        degraded.push('重排不可用（' + res.degraded + '）')
      } else {
        info.model = res && res.model ? res.model : null
        const scores = res && Array.isArray(res.scores) ? res.scores : []
        for (const row of scores) {
          const idx = Number(row && row.index)
          const entry = pending[idx]
          if (!entry) continue
          const score = Number(row && row.score)
          if (!Number.isFinite(score)) continue
          entry.score = score
          rt_rerankCacheSet(keyBase + '\u0000' + entry.item.cand.chunkId, score)
        }
      }
    } catch (e) {
      info.degraded = rt_errorText(e)
      degraded.push('重排失败（' + info.degraded + '）')
    }
  }
  for (const entry of leafItems) {
    if (entry.score === undefined) continue
    entry.item.rerankScore = entry.score
    if (RERANK_CONFIG.mode === 'pure') entry.item.finalScore = entry.score
    else entry.item.finalScore = entry.item.finalScore * (1 + RERANK_CONFIG.boostW * entry.score)
    info.reranked++
  }
  info.ms = rt_round2(rt_nowMs() - t0)
  return info
}
// ---------------------------------------------------------------- fusion / dedupe

function rt_jaccard(a, b) {
  if (!a.size || !b.size) return 0
  let inter = 0
  const [small, big] = a.size <= b.size ? [a, b] : [b, a]
  for (const x of small) if (big.has(x)) inter++
  return inter / (a.size + b.size - inter)
}

// ---------------------------------------------------------------- legacy fallback

function rt_walk(dir, out = []) {
  if (!existsSync(dir)) return out
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const abs = path.join(dir, e.name)
    const rel = abs.slice(dir.length + 1).replace(/\\/g, '/')
    if (rt_LEGACY_EXCLUDE_RE.test(rel)) continue
    if (e.isDirectory()) rt_walk(abs, out)
    else if (e.isFile()) out.push(abs)
  }
  return out
}

/** Minimal frontmatter reader for the fallback path (the index path never needs it). */
function rt_legacyFm(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!m) return { fm: {}, body: text }
  const fm = {}
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^\s*([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line)
    if (!kv) continue
    let v = kv[2].trim()
    if (v.startsWith('[') && v.endsWith(']')) {
      fm[kv[1]] = v.slice(1, -1).split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
    } else if (v !== '') {
      fm[kv[1]] = v.replace(/^["']|["']$/g, '')
    }
  }
  return { fm, body: text.slice(m[0].length) }
}

function rt_legacyScoreDocs(docs, tokens) {
  const N = docs.length || 1
  const df = new Map()
  const counts = []
  for (const doc of docs) {
    const m = new Map()
    for (const t of tokens) {
      const c = rt_countOcc(doc.lower, t, 20)
      if (c > 0) {
        m.set(t, c)
        df.set(t, (df.get(t) || 0) + 1)
      }
    }
    counts.push(m)
  }
  const idf = (t) => Math.log(1 + N / (1 + (df.get(t) || 0)))
  const results = []
  docs.forEach((doc, i) => {
    const m = counts[i]
    let score = 0
    let matched = 0
    for (const t of tokens) {
      const w = rt_tokenWeight(t)
      const c = m.get(t) || 0
      if (c > 0) matched++
      if (doc.titleLower.includes(t)) score += 6 * w
      if (c > 0) score += Math.min(20, c) * w * idf(t)
      if (doc.tagsLower.some((tag) => tag.includes(t))) score += 3 * w
    }
    if (score > 0) {
      if (tokens.length > 1 && matched === tokens.length) score += 8
      results.push({ doc, score })
    }
  })
  return results
}

function rt_legacySearch(dir, rawQuery, normalized, opts, reason) {
  const t0 = rt_nowMs()
  const tokens = rt_uniqTokens(normalized)
  const scope = opts.scope === 'raw' || opts.scope === 'all' ? opts.scope : 'wiki'
  const skips = { size: [], extension: [], unreadable: [] }
  const rawScope = scope === 'raw' || scope === 'all'
  const refDate = opts.asOf ? Date.parse(String(opts.asOf)) : null
  const filters = opts.filters || {}
  const docs = []

  const wikiDir = path.join(dir, 'wiki')
  for (const abs of rt_walk(wikiDir)) {
    const rel = abs.slice(wikiDir.length + 1).replace(/\\/g, '/')
    if (!rel.endsWith('.md') || rel === 'index.md' || rel === 'log.md' || rel.startsWith('.')) continue
    let text
    try {
      text = readFileSync(abs, 'utf8')
    } catch {
      continue
    }
    const { fm, body } = rt_legacyFm(text)
    const status = fm.status || 'active'
    if (status === 'retracted') continue
    if (filters.status && status !== filters.status) continue
    if (filters.pageType && String(fm.type || '') !== String(filters.pageType)) continue
    if (filters.trust && String(fm.trust || '') !== String(filters.trust)) continue
    if (refDate !== null && fm.event_time) {
      const t = Date.parse(String(fm.event_time))
      if (Number.isFinite(t) && t > refDate) continue
    }
    const title = String(fm.title || /^#\s+(.+)$/m.exec(body)?.[1] || path.posix.basename(rel, '.md')).trim()
    docs.push({
      path: 'wiki/' + rel,
      scope: 'wiki',
      title,
      titleLower: title.toLowerCase(),
      summary: String(fm.summary || ''),
      tags: Array.isArray(fm.tags) ? fm.tags : [],
      tagsLower: (Array.isArray(fm.tags) ? fm.tags : []).map((t) => String(t).toLowerCase()),
      trust: fm.trust,
      status,
      supersededBy: fm.superseded_by,
      pageType: fm.type,
      eventTime: fm.event_time || null,
      sha: rt_sha256Hex(text),
      text: body,
      lower: text.toLowerCase(), // whole file: title hits count too, like the old scorer
    })
  }
  if (scope === 'raw' || scope === 'all') {
    const rawDir = path.join(dir, 'raw')
    for (const abs of rt_walk(rawDir)) {
      const rel = abs.slice(rawDir.length + 1).replace(/\\/g, '/')
      let size = 0
      try {
        size = readFileSync(abs).length
      } catch {
        skips.unreadable.push('raw/' + rel)
        continue
      }
      if (size === 0) continue // scanned-but-empty: not a coverage gap (core readRawDocs parity)
      if (!rt_LEGACY_RAW_EXTS.test(rel)) { skips.extension.push('raw/' + rel); continue }
      if (size > rt_LEGACY_RAW_SIZE_CAP) { skips.size.push('raw/' + rel); continue }
      let text
      try {
        text = readFileSync(abs, 'utf8')
      } catch {
        skips.unreadable.push('raw/' + rel)
        continue
      }
      docs.push({
        path: 'raw/' + rel,
        scope: 'raw',
        title: path.posix.basename(rel, '.md'),
        titleLower: path.posix.basename(rel).toLowerCase(),
        summary: '',
        tags: [],
        tagsLower: [],
        trust: null,
        status: null,
        sha: rt_sha256Hex(text),
        text,
        lower: text.toLowerCase(),
      })
    }
  }

  const scored = rt_legacyScoreDocs(docs, tokens)
  for (const r of scored) if (r.doc.status === 'superseded') r.score *= rt_SUPERSEDED_FACTOR
  scored.sort((a, b) => b.score - a.score || a.doc.path.localeCompare(b.doc.path))
  const lim = Math.max(1, Math.min(100, Number(opts.limit ?? 20) || 20))
  const hits = []
  for (const { doc, score } of scored.slice(0, lim)) {
    hits.push({
      path: doc.path,
      scope: doc.scope,
      title: doc.title,
      trust: doc.trust ?? null,
      status: doc.status ?? null,
      supersededBy: doc.supersededBy ?? null,
      pageType: doc.pageType ?? null,
      tags: doc.tags || [],
      summary: doc.summary || '',
      eventTime: doc.eventTime ?? null,
      chunkId: null,
      ord: 0,
      span: { start: 0, end: doc.text.length },
      headingPath: '',
      text: doc.text,
      snippet: rt_snippetOf(doc.text, tokens),
      anchor: formatAnchor(doc.path, doc.sha, 0, 0, doc.text.length),
      parent: null,
      score,
      ranks: { lexical: hits.length + 1, alias: null, exact: null },
      legacy: true,
    })
  }
  const maxScore = hits.length ? hits[0].score : 0
  for (const h of hits) h.score = maxScore > 0 ? Math.round((h.score / maxScore) * 1e6) / 1e6 : 0
  return {
    hits,
    diagnostics: {
      channels: { lexical: hits.length, alias: 0, exact: 0 },
      timings: { total: rt_round2(rt_nowMs() - t0) },
      total: hits.length,
      legacy: true,
      degraded: reason || undefined,
      ...(rawScope
        ? {
            skipped: { size: skips.size.length, extension: skips.extension.length, unreadable: skips.unreadable.length },
            skippedFiles: [...skips.size, ...skips.extension, ...skips.unreadable].slice(0, 5),
          }
        : {}),
    },
  }
}

const rt_round2 = (n) => Math.round(n * 100) / 100

// ---------------------------------------------------------------- hybridSearch

/**
 * Hybrid search over the workspace at `dir`.
 *
 * @param {string} dir workspace root
 * @param {string} query raw query text
 * @param {object} [opts]
 *   limit, scope ('wiki'|'raw'|'all'), expand ('parent'|'none'), rerank (bool),
 *   filters ({trust,status,timeFrom,timeTo,pageType,excludeRetracted}), asOf ('YYYY-MM-DD'),
 *   legacy (force the in-memory path), channels ({lexical,alias,exact} booleans for ablation)
 * @returns {{hits: Array<object>, diagnostics: object}}
 */
export async function hybridSearch(dir, query, opts = {}) {
  const tStart = rt_nowMs()
  const rawQuery = String(query ?? '')
  const normalized = normalizeQuery(rawQuery)
  const options = {
    limit: 20,
    scope: 'wiki',
    expand: 'parent',
    ...opts,
  }
  const io = {
    limit: Math.max(1, Math.min(100, Number(options.limit ?? 20) || 20)),
    scope: options.scope === 'raw' || options.scope === 'all' ? options.scope : 'wiki',
    expand: options.expand === 'none' ? 'none' : 'parent',
    rerank: options.rerank === undefined ? rt_rerankDefault() : options.rerank === true,
    featureRerank: options.featureRerank === undefined ? options.rerank === undefined : options.featureRerank !== false,
    forceSync: options.forceSync === true,
    denseWeight: options.denseWeight === undefined ? 0.5 : Math.max(0, Number(options.denseWeight) || 0),
    denseTopK: Number(options.denseTopK) > 0 ? Number(options.denseTopK) : 100,
    fusedCandidateCap: Number(options.fusedCandidateCap) > 0 ? Number(options.fusedCandidateCap) : rt_FUSED_CANDIDATE_CAP,
    syncMinIntervalMs: options.syncMinIntervalMs,
    syncFullIntervalMs: options.syncFullIntervalMs,
    asOf: options.asOf ? String(options.asOf) : null,
    // Production defaults follow the ablation: the page-identity channel is on, the alias
    // list and the exact/symbol channel are off until they show a positive marginal gain.
    channels: { lexical: true, meta: true, alias: false, exact: false, dense: rt_denseDefault(), ...(options.channels || {}) },
  }
  const timings = {}
  let rebuildNote = null
  let skippedInfo = null
  const degraded = []

  if (!normalized) {
    return {
      hits: [],
      diagnostics: { channels: { lexical: 0, alias: 0, exact: 0 }, timings: { total: rt_round2(rt_nowMs() - tStart) }, total: 0 },
    }
  }

  const filters = { excludeRetracted: true, ...(options.filters || {}) }
  if (io.asOf && filters.timeTo === undefined) filters.timeTo = io.asOf

  if (options.legacy === true) {
    const res = rt_legacySearch(path.resolve(String(dir)), rawQuery, normalized, { ...io, filters }, null)
    res.diagnostics.mode = 'legacy'
    return res
  }

  // ---- open + sync index (visible fallback if this fails)
  const rec = rt_indexState(dir)
  const syncErr = rt_syncIndexFor(rec, dir, {
    forceSync: io.forceSync,
    syncMinIntervalMs: io.syncMinIntervalMs,
    syncFullIntervalMs: io.syncFullIntervalMs,
  })
  if (syncErr) {
    degraded.push(syncErr)
    const res = rt_legacySearch(path.resolve(String(dir)), rawQuery, normalized, { ...io, filters }, degraded.join('；'))
    res.diagnostics.sync = rec.sync || null
    return res
  }
  timings.sync = rec.lastSyncCostMs || 0
  timings.syncMode = rec.lastSyncMode || 'full'
  if (io.scope === 'raw' || io.scope === 'all') {
    const syncState = rec.sync || null
    if (syncState && syncState.skipped) {
      skippedInfo = {
        skipped: syncState.skipped,
        skippedFiles: Array.isArray(syncState.skippedFiles) ? syncState.skippedFiles : [],
      }
    }
  }
  try {
    const note = typeof indexRebuildNote === 'function' ? indexRebuildNote(rec.db) : null
    if (note) {
      rebuildNote = String(note)
      degraded.push(rebuildNote.replace(/^⚠\s*/, ''))
    }
  } catch {}

  // Phase 2: v2 vector tables. Local DDL only — ensureVectorSchema never starts the sidecar,
  // so ARCHIVIST_ML=0 stays spawn-free even when this runs.
  let vectorSchema = null
  if (io.channels.dense && !rt_VECTOR_SCHEMA_DONE.has(rec.db)) {
    try {
      vectorSchema = ensureVectorSchema(rec.db)
      rt_VECTOR_SCHEMA_DONE.add(rec.db)
      if (vectorSchema && vectorSchema.wiped) degraded.push('向量索引重建（schema v2 首次建立或索引被重建）')
    } catch (e) {
      degraded.push(`向量表不可用（${rt_errorText(e)}）`)
    }
  }

  const queryTokens = rt_uniqTokens(normalized)
  if (!queryTokens.length) {
    return {
      hits: [],
      diagnostics: {
        channels: { lexical: 0, alias: 0, exact: 0 },
        timings: { total: rt_round2(rt_nowMs() - tStart) },
        total: 0,
        ...(skippedInfo || {}),
        ...(degraded.length ? { degraded: degraded.join('；') } : {}),
      },
    }
  }

  timings.fuse = 0
  timings.rerank = 0
  const tFuse = rt_nowMs()
  const metaCache = new Map() // docId → meta
  const chunkCache = new Map() // chunkId → chunk row
  const hitsByChunk = new Map() // chunkId → { chunkId, docId, path, scope, rrf, ranks }

  const mergeChannel = (label, channel, weight = 1) => {
    for (const [chunkId, rank] of channel.ranks) {
      let entry = hitsByChunk.get(chunkId)
      if (!entry) {
        const row = channel.rows.find((r) => r.chunkId === chunkId) || {}
        entry = { chunkId, docId: row.docId, path: row.path, scope: row.scope, rrf: 0, ranks: {}, needsFilter: row.needsFilter === true }
        hitsByChunk.set(chunkId, entry)
      }
      entry.rrf += weight / (rt_RRF_K + rank + 1)
      entry.ranks[label] = rank + 1
    }
  }

  let lexicalTopDoc = null
  let denseTopDoc = null

  // ---- channel A: lexical BM25
  let lexical
  if (io.channels.lexical) {
    try {
      const t = rt_nowMs()
      lexical = rt_channelLexical(rec, queryTokens, io.scope, filters)
      timings.lexical = rt_round2(rt_nowMs() - t)
      mergeChannel('lexical', lexical)
      if (lexical.rows.length) lexicalTopDoc = lexical.rows[0].docId
    } catch (e) {
      degraded.push(`词法通道失败（${rt_errorText(e)}）`)
      const res = rt_legacySearch(path.resolve(String(dir)), rawQuery, normalized, { ...io, filters }, degraded.join('；'))
      res.diagnostics.sync = rec.sync || null
      return res
    }
  } else {
    lexical = { rows: [], ranks: new Map() }
    timings.lexical = 0
  }

  // Pre-fetch the candidate chunk texts (needed by exact channel and by hits).
  const fetchChunks = (ids) => {
    for (const id of ids) {
      if (chunkCache.get(id) === undefined || chunkCache.get(id) === null) rt_chunkFetch(rec, id, chunkCache)
    }
  }
  fetchChunks(lexical.rows.slice(0, rt_EXACT_CANDIDATE_CAP).map((r) => r.chunkId))

  // ---- channel D: dense (Phase 2, contract p2 §3). Default off until the gold ablation says
  // otherwise; searchDense degrades by itself for ARCHIVIST_ML=0 / missing sidecar / empty index
  // and never spawns anything in those cases.
  let denseInfo = null
  let denseCount = 0
  if (io.channels.dense) {
    try {
      const t = rt_nowMs()
      const dense = await searchDense(rec.db, normalized, { topK: io.denseTopK, dir: path.resolve(String(dir)) })
      denseInfo = dense && dense.diagnostics ? dense.diagnostics : null
      if (denseInfo && denseInfo.degraded) degraded.push(`向量通道不可用（${denseInfo.degraded}）`)
      const ranks = new Map()
      const rows = []
      for (const hit of (dense && dense.hits) || []) {
        const chunkId = Number(hit.chunkId)
        if (!Number.isFinite(chunkId) || ranks.has(chunkId)) continue
        ranks.set(chunkId, ranks.size)
        rows.push({ chunkId, docId: Number(hit.docId), path: '', scope: io.scope, bm25: -hit.score, needsFilter: true })
      }
      denseCount = rows.length
      if (rows.length) denseTopDoc = rows[0].docId
      if (rows.length) {
        mergeChannel('dense', { rows, ranks }, io.denseWeight)
        fetchChunks(rows.slice(0, rt_FUSED_CANDIDATE_CAP).map((r) => r.chunkId))
      }
      timings.dense = rt_round2(rt_nowMs() - t)
    } catch (e) {
      degraded.push(`向量通道失败（${rt_errorText(e)}）`)
      timings.dense = 0
    }
  } else {
    timings.dense = 0
  }

  // ---- channel B: alias expansion + page-identity (title/tag) candidates
  let aliasCount = 0
  let metaCount = 0
  if (io.channels.alias || io.channels.meta) {
    try {
      const t = rt_nowMs()
      const alias = rt_channelAlias(rec, normalized, queryTokens, io.scope, filters, chunkCache, io.channels.alias === true, io.channels.meta !== false)
      aliasCount = alias.queries
      metaCount = alias.docs
      mergeChannel('alias', alias)
      if (alias.rows.length) fetchChunks(alias.rows.map((r) => r.chunkId))
      timings.alias = rt_round2(rt_nowMs() - t)
    } catch {
      timings.alias = 0
    }
  } else {
    timings.alias = 0
  }

  // ---- channel C: exact / symbol scoring over the lexical candidate window
  let exactRows = 0
  if (io.channels.exact && rt_exactEnabled(normalized, rawQuery)) {
    try {
      const t = rt_nowMs()
      const probes = rt_exactProbes(rawQuery)
      const exact = rt_channelExact(probes, lexical.rows, chunkCache)
      exactRows = exact.rows.length
      mergeChannel('exact', exact)
      timings.exact = rt_round2(rt_nowMs() - t)
      fetchChunks(exact.rows.slice(0, rt_FUSED_CANDIDATE_CAP).map((r) => r.chunkId))
    } catch {
      timings.exact = 0
    }
  } else {
    timings.exact = 0
  }

  timings.fuse = rt_round2(rt_nowMs() - tFuse)
  // ---- RRF fusion + candidate selection
  const fused = [...hitsByChunk.values()].sort((a, b) => b.rrf - a.rrf || a.chunkId - b.chunkId)
  const candidates = fused.slice(0, io.fusedCandidateCap)
  const docChunkCache = new Map() // docId → Map(ord → chunk), shared by phrase check + parent expansion
  // A phrase-shaped query (one long CJK/latin run, no spaces) is usually a verbatim snippet.
  // The chunk holding it may be split or ranked low, so test the whole document: the legacy
  // substring scorer effectively did this over the full page body.
  const phraseQuery = (() => {
    const q = normalized
    if (!q || q.includes(' ')) return null
    if (q.length < 8) return null
    if (!/[\u4e00-\u9fff]/.test(q) && q.length < 14) return null
    return q
  })()
  const docPhrase = new Set()
  if (phraseQuery) {
    const checkedDocs = new Set()
    for (const cand of candidates.slice(0, 24)) {
      if (!cand.docId || checkedDocs.has(cand.docId)) continue
      checkedDocs.add(cand.docId)
      const byOrd = rt_docChunks(rec, cand.docId, docChunkCache)
      for (const ch of byOrd.values()) {
        if (String(rt_field(ch, 'text', '') || '').toLowerCase().includes(phraseQuery)) {
          docPhrase.add(cand.docId)
          break
        }
      }
    }
  }
  fetchChunks(candidates.map((c) => c.chunkId))

  const refMs = io.asOf ? Date.parse(io.asOf) : null
  const kept = []
  for (const cand of candidates) {
    const chunk = chunkCache.get(cand.chunkId)
    if (!chunk) continue
    const meta = cand.docId ? rt_docMeta(rec, cand.docId, metaCache) : null
    if (cand.needsFilter && !rt_metaPassesFilters(meta, io.scope, filters)) continue
    const status = String(rt_field(meta, 'status', '') || '').toLowerCase()
    if (status === 'retracted') continue // contract §4.6: never show retracted content
    const pathValue = String(rt_field(meta, 'path', cand.path) || cand.path)
    const scopeValue = String(rt_field(meta, 'scope', cand.scope) || cand.scope)
    const chunkText = String(rt_field(chunk, 'text', '') || '')
    if (!chunkText) continue
    const ord = Number(rt_field(chunk, 'ord', 0))
    const tokenEst = Number(rt_field(chunk, 'token_est', rt_field(chunk, 'tokenEst', 0))) || estimateTokens(chunkText)
    kept.push({ cand, chunk, meta, status, pathValue, scopeValue, chunkText, ord, tokenEst })
  }

  // ---- near-duplicate removal (same normalised text hash, or same doc + adjacent
  //      ord + Jaccard ≥ 0.85), in RRF order so the best-ranked witness survives.
  const keptDedup = []
  const seenHash = new Set()
  for (const item of kept) {
    const normText = item.chunkText.replace(/\s+/g, ' ').trim().toLowerCase()
    const hash = rt_shortHash(normText)
    if (seenHash.has(hash)) continue
    let dup = false
    for (const prev of keptDedup) {
      if (prev.cand.docId !== item.cand.docId) continue
      if (Math.abs(prev.ord - item.ord) > 3) continue
      const a = prev.tokenSet
      const b = new Set(tokenize(item.chunkText))
      if (rt_jaccard(a, b) >= 0.85) {
        dup = true
        break
      }
    }
    if (dup) continue
    item.tokenSet = new Set(tokenize(item.chunkText))
    seenHash.add(hash)
    keptDedup.push(item)
  }

  // ---- status handling + deterministic re-rank
  const tRerankStage = rt_nowMs()
  const final = []
  for (const item of keptDedup) {
    let score = item.cand.rrf
    let features = null
    if (io.featureRerank) {
      const titleText = String(rt_field(item.meta, 'title', '') || path.posix.basename(item.pathValue, '.md'))
      const headingPath = String(rt_field(item.chunk, 'heading_path', rt_field(item.chunk, 'headingPath', '')) || '')
      let ageDays = null
      if (refMs !== null) {
        const eventTime = rt_field(item.meta, 'event_time', rt_field(item.meta, 'eventTime', null))
        let then = eventTime ? Date.parse(String(eventTime)) : NaN
        if (!Number.isFinite(then)) {
          const mtime = Number(rt_field(item.meta, 'mtime_ms', rt_field(item.meta, 'mtimeMs', 0)) || 0)
          if (mtime > 0) then = mtime
        }
        if (Number.isFinite(then)) ageDays = Math.max(0, (refMs - then) / 86400000)
      }
      features = rt_rerankFeatures({
        queryTokens,
        normalizedQuery: normalized,
        chunkText: item.chunkText,
        chunkTokens: item.tokenSet,
        title: titleText,
        titleTokens: new Set(tokenize(titleText)),
        headingTokens: new Set(tokenize(headingPath)),
        tagsLower: rt_tagList(rt_field(item.meta, 'tags', '')),
        hasDocPhrase: docPhrase.has(item.cand.docId),
        trust: rt_field(item.meta, 'trust', null),
        ageDays,
        tokenEst: item.tokenEst,
      })
      const mult = rt_rerankMultiplier(features)
      score *= mult
    }
    if (item.status === 'superseded') score *= rt_SUPERSEDED_FACTOR
    // normalize display score to 0..1 later against the max
    final.push({ ...item, finalScore: score, features })
  }
  final.sort((a, b) => b.finalScore - a.finalScore || a.cand.chunkId - b.cand.chunkId)

  timings.rerank = rt_round2(rt_nowMs() - tRerankStage)
  // ---- Phase 3: cross-encoder re-rank over the top RERANK_CANDIDATES (contract p3 §1).
  // Only leaf chunks are sent; long chunks are truncated (and counted). Failures/timeouts keep
  // the RRF order and are reported through diagnostics.degraded — a search never fails here.
  let rerankInfo = null
  if (io.rerank && final.length) {
    rerankInfo = await rt_crossEncoderRerank(final, rawQuery, normalized, degraded, { lexTopDoc: lexicalTopDoc, denseTopDoc })
    final.sort((a, b) => b.finalScore - a.finalScore || a.cand.chunkId - b.cand.chunkId)
  }
  // ---- delivery order. Two requirements pull in opposite directions:
  //   a) a multi-hop question must see every relevant page early → first chunk per document;
  //   b) the answer span often sits in a *sibling* chunk of the right page, and the gold set
  //      showed 15/62 cases where the page was found but the delivered chunk was wrong.
  // So: one chunk per page for the first (limit - extra) pages, then the next chunks of the
  // same pages fill the remaining slots (first-hit ranks, and therefore MRR, stay unchanged).
  const groups = []
  const groupByDoc = new Map()
  for (const item of final) {
    let g = groupByDoc.get(item.cand.docId)
    if (!g) {
      g = { docId: item.cand.docId, items: [] }
      groupByDoc.set(item.cand.docId, g)
      groups.push(g)
    }
    g.items.push(item)
  }
  const extraSlots = Math.min(4, Math.max(1, Math.floor(io.limit / 4)))
  const headSlots = Math.max(1, io.limit - extraSlots)
  const ordered = []
  for (const g of groups) {
    if (ordered.length >= headSlots) break
    ordered.push(g.items[0])
  }
  for (let k = 1; k < 3; k++) {
    for (const g of groups) {
      if (ordered.length >= io.limit) break
      if (g.items.length <= k) continue
      ordered.push(g.items[k])
    }
  }

  const maxFinal = ordered.length ? ordered[0].finalScore : 0
  const hits = []
  for (const item of ordered) {
    const chunk = item.chunk
    const meta = item.meta
    const parentOrd = rt_field(chunk, 'parent_ord', rt_field(chunk, 'parentOrd', null))
    let parent = null
    if (io.expand === 'parent' && parentOrd !== null && parentOrd !== undefined && item.cand.docId) {
      const byOrd = rt_docChunks(rec, item.cand.docId, docChunkCache)
      const pchunk = byOrd.get(Number(parentOrd))
      if (pchunk && Number(parentOrd) !== item.ord) {
        let ptext = String(rt_field(pchunk, 'text', '') || '')
        const ptokens = Number(rt_field(pchunk, 'token_est', rt_field(pchunk, 'tokenEst', 0))) || estimateTokens(ptext)
        if (ptokens > rt_PARENT_TOKEN_CAP) {
          const ratio = rt_PARENT_TOKEN_CAP / ptokens
          ptext = ptext.slice(0, Math.max(200, Math.floor(ptext.length * ratio))) + ' …'
        }
        const pstart = Number(rt_field(pchunk, 'char_start', rt_field(pchunk, 'charStart', 0)) || 0)
        const pend = Number(rt_field(pchunk, 'char_end', rt_field(pchunk, 'charEnd', pstart + ptext.length)) || pstart + ptext.length)
        parent = {
          ord: Number(parentOrd),
          span: { start: pstart, end: pend },
          headingPath: String(rt_field(pchunk, 'heading_path', rt_field(pchunk, 'headingPath', '')) || ''),
          text: ptext,
        }
      }
    }
    const tags = rt_tagList(rt_field(meta, 'tags', ''))
    const start = Number(rt_field(chunk, 'char_start', rt_field(chunk, 'charStart', 0)) || 0)
    const end = Number(rt_field(chunk, 'char_end', rt_field(chunk, 'charEnd', start + item.chunkText.length)) || start + item.chunkText.length)
    const sha = String(rt_field(meta, 'sha256', '') || '')
    hits.push({
      path: item.pathValue,
      scope: item.scopeValue,
      title: String(rt_field(meta, 'title', '') || path.posix.basename(item.pathValue, '.md')),
      trust: rt_field(meta, 'trust', null),
      status: item.status || null,
      supersededBy: rt_field(meta, 'superseded_by', rt_field(meta, 'supersededBy', null)),
      pageType: rt_field(meta, 'page_type', rt_field(meta, 'pageType', null)),
      tags,
      summary: String(rt_field(meta, 'summary', '') || ''),
      eventTime: rt_field(meta, 'event_time', rt_field(meta, 'eventTime', null)),
      chunkId: item.cand.chunkId,
      ord: item.ord,
      span: { start, end },
      headingPath: String(rt_field(chunk, 'heading_path', rt_field(chunk, 'headingPath', '')) || ''),
      text: item.chunkText,
      snippet: rt_snippetOf(item.chunkText, queryTokens),
      anchor: formatAnchor(item.pathValue, sha, item.ord, start, end),
      parent,
      score: maxFinal > 0 ? Math.round((item.finalScore / maxFinal) * 1e6) / 1e6 : 0,
      ranks: { lexical: item.cand.ranks.lexical ?? null, alias: item.cand.ranks.alias ?? null, exact: item.cand.ranks.exact ?? null, dense: item.cand.ranks.dense ?? null },
    })
  }

  timings.total = rt_round2(rt_nowMs() - tStart)
  const diagnostics = {
    channels: { lexical: lexical.rows.length, alias: aliasCount, exact: exactRows, meta: metaCount, dense: denseCount },
    channelsNote: {
      meta: 'page-identity (title/tag) candidate injection',
      alias: io.channels.alias ? 'on' : 'off (gold ablation: no positive marginal gain)',
      exact: io.channels.exact ? 'on' : 'off (gold ablation: no positive marginal gain)',
    },
    timings,
    total: hits.length,
    candidates: candidates.length,
    queryTokens: queryTokens.length,
  }
  if (skippedInfo) {
    diagnostics.skipped = skippedInfo.skipped
    diagnostics.skippedFiles = skippedInfo.skippedFiles
  }
  diagnostics.rerank = rerankInfo || {
    enabled: false,
    requested: io.rerank === true,
    skipped: null,
    trigger: null,
    margin: null,
    channelsDisagree: null,
    candidates: 0,
    reranked: 0,
    truncated: 0,
    cachedHits: 0,
    model: null,
    ms: 0,
    degraded: null,
  }
  if (rerankInfo) diagnostics.timings.rerankCross = rerankInfo.ms
  diagnostics.models = denseInfo
    ? {
        dense: {
          model: denseInfo.model,
          embedMs: denseInfo.embedMs,
          searchMs: denseInfo.searchMs,
          total: denseInfo.total,
          coverage: denseInfo.coverage,
          cached: denseInfo.cached,
          degraded: denseInfo.degraded || null,
        },
        rerank: rerankInfo
          ? { model: rerankInfo.model, mode: rerankInfo.mode, candidates: rerankInfo.candidates, reranked: rerankInfo.reranked, ms: rerankInfo.ms, degraded: rerankInfo.degraded || null }
          : { enabled: false },
      }
    : { dense: { enabled: false }, rerank: { enabled: !!rerankInfo } }
  diagnostics.syncPolicy = {
    mode: rec.lastSyncMode || 'full',
    intervalMs: rt_SYNC_MIN_INTERVAL_MS,
    fullIntervalMs: rt_SYNC_FULL_INTERVAL_MS,
    throttleActive: rec.throttleActive === true,
    skippedSyncs: rec.syncSkipped,
  }
  if (rebuildNote) diagnostics.rebuild = rebuildNote
  if (rec.sync && (rec.sync.added || rec.sync.changed || rec.sync.removed)) {
    diagnostics.sync = { added: rec.sync.added, changed: rec.sync.changed, removed: rec.sync.removed }
  }
  if (degraded.length) diagnostics.degraded = degraded.join('；')
  return { hits, diagnostics }
}

