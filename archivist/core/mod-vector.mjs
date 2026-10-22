/**
 * Archivist Phase 2 — vector channel: ML sidecar client + embedding storage + brute-force cosine.
 *
 * Contract: docs/p2-contract.md §2–§4. This module is inlined by build/build.mjs, therefore
 * every internal symbol carries the `mv_` prefix; only the exported API is unprefixed.
 * Imports: node:* only (no core, no mod-chunks).
 *
 * Sidecar (ml/archivist_ml/sidecar.py) is spawned lazily at the first need, speaks one JSON
 * object per line over stdin/stdout, and is never spawned when ARCHIVIST_ML=0.
 *
 * Exported API (frozen):
 *   mlStatus(opts)                  sync  → {enabled, python, modelsDir, embedModel, rerank, home, sidecar, degraded}
 *   mlPing(opts)                    async → {ok, pid, rss_mb, models_loaded, version, ms} | {ok:false, degraded}
 *   ensureVectorSchema(db)          sync  → {schema:'2', wiped}      (creates embeddings/embedding_meta)
 *   vectorStats(db, opts)           sync  → {model, count, chunks, missing, dim, builtAt, enabled, degraded}
 *   embedPending(db, opts)          async → {embedded, skipped, failed, total, model, dim, batches, ms, degraded}
 *   searchDense(db, query, opts)    async → {hits:[{chunkId, docId, score, rank}],
 *                                            diagnostics:{channel:'dense', model, ms, embedMs, searchMs, cached,
 *                                                         total, coverage:{embedded,chunks,missing}, degraded}}
 *   rerankDocs(query, docs, opts)   async → {scores:[{index, score}], model, ms, degraded}
 *   clearEmbeddings(db, opts)       sync  → {removed}
 *   closeMl()                       async → void (graceful sidecar shutdown)
 *
 * opts: {dir, modelsDir, python, model, batch=64, limit, topK=100, timeoutMs, kind, onProgress, all}
 *   dir        workspace root; default modelsDir = <dir>/.index/models
 *   model      default env ARCHIVIST_ML_EMBED_MODEL or 'e5-small'
 *   kind       embed prefix kind for chunks: 'passage' (default) | 'none'
 *
 * Degradation is explicit: every unavailable path returns `degraded` with a human-readable reason
 * (never an empty array without explanation).
 *
 * Schema note: this module owns the two v2 tables plus `meta.vector_schema_version='2'`.
 * It deliberately does NOT write `meta.schema_version` (= index schema owner; see report).
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const mv_EMBED_TIMEOUT_MS = 5000
const mv_RERANK_TIMEOUT_MS = 15000
const mv_PING_TIMEOUT_MS = 5000
const mv_QUERY_CACHE_TTL_MS = 60000
const mv_QUERY_CACHE_MAX = 256
const mv_CLIENT_IDLE_MS = 300000
const mv_MARKER_KEY = 'vector_schema_version'
const mv_PY_CANDIDATES = ['python', 'python3']
const mv_MAX_TEXT_CHARS = 2000000

const mv_env = (name) => {
  const value = process.env[name]
  return value && String(value).trim() ? String(value).trim() : ''
}
const mv_msg = (err) => String(err && err.message ? err.message : err)
const mv_round = (value, digits = 6) => {
  const factor = 10 ** digits
  return Math.round(Number(value) * factor) / factor
}
function mv_err(code, message) {
  const err = new Error(message)
  err.code = code
  return err
}

// ------------------------------------------------------------------ configuration

/** The `ml/` directory: env override, else `../ml` relative to this module (works in core/ and in the two built plugins). */
function mv_home() {
  const overridden = mv_env('ARCHIVIST_ML_HOME')
  if (overridden) return path.resolve(overridden)
  try {
    return fileURLToPath(new URL('../ml/', import.meta.url))
  } catch {
    return path.join(process.cwd(), 'ml')
  }
}

function mv_config(opts = {}) {
  const enabled = mv_env('ARCHIVIST_ML') !== '0'
  const dir = opts.dir ? path.resolve(String(opts.dir)) : ''
  const envModels = mv_env('ARCHIVIST_ML_MODELS')
  const modelsDir = path.resolve(
    opts.modelsDir
      ? String(opts.modelsDir)
      : envModels || (dir ? path.join(dir, '.index', 'models') : path.join(process.cwd(), '.index', 'models')),
  )
  return {
    enabled,
    home: mv_home(),
    modelsDir,
    python: mv_env('ARCHIVIST_ML_PYTHON') || (opts.python ? String(opts.python) : ''),
    embedModel: String(opts.model || mv_env('ARCHIVIST_ML_EMBED_MODEL') || 'e5-small'),
    rerank: mv_env('ARCHIVIST_ML_RERANK') === '1',
    dir,
  }
}

// ------------------------------------------------------------------ sidecar client

const mv_stats = {
  spawns: 0,
  restarts: 0,
  requests: 0,
  errors: 0,
  lastError: null,
  lastPid: null,
  lastRssMb: null,
  lastExit: null,
  lastStderr: '',
}
let mv_client = null
const mv_qcache = new Map()

function mv_clientAlive() {
  const client = mv_client
  return !!(client && client.child && !client.dead && client.child.exitCode === null)
}

function mv_rejectPending(client, err) {
  for (const [, slot] of client.pending) {
    clearTimeout(slot.timer)
    try {
      slot.reject(err)
    } catch {
      /* already settled */
    }
  }
  client.pending.clear()
}

function mv_killClient(reason) {
  const client = mv_client
  if (!client) return
  mv_client = null
  client.dead = true
  client.closing = true
  if (client.idleTimer) clearTimeout(client.idleTimer)
  try {
    client.child.stdin.end()
  } catch {
    /* already gone */
  }
  const timer = setTimeout(() => {
    try {
      client.child.kill('SIGKILL')
    } catch {
      /* already gone */
    }
  }, 800)
  if (timer.unref) timer.unref()
  mv_rejectPending(client, mv_err('SIDECAR_GONE', reason || 'sidecar stopped'))
}

function mv_touchIdle() {
  const client = mv_client
  if (!client) return
  if (client.idleTimer) clearTimeout(client.idleTimer)
  client.idleTimer = setTimeout(() => {
    if (mv_client === client) {
      client.closing = true
      mv_killClient('idle timeout')
    }
  }, mv_CLIENT_IDLE_MS)
  if (client.idleTimer.unref) client.idleTimer.unref()
}

function mv_onStdout(client, chunk) {
  client.buf += String(chunk)
  if (client.buf.length > 8 * 1024 * 1024) {
    client.buf = ''
    mv_stats.errors += 1
    mv_stats.lastError = 'sidecar protocol overflow (stdout > 8MB without newline)'
    return
  }
  let index
  while ((index = client.buf.indexOf('\n')) >= 0) {
    const line = client.buf.slice(0, index).trim()
    client.buf = client.buf.slice(index + 1)
    if (!line) continue
    let payload
    try {
      payload = JSON.parse(line)
    } catch {
      mv_stats.errors += 1
      mv_stats.lastError = `sidecar 输出非 JSON：${line.slice(0, 120)}`
      continue
    }
    if (!payload || typeof payload !== 'object') continue
    const slot = client.pending.get(payload.id)
    if (!slot) {
      if (payload.id === null || payload.id === undefined) {
        mv_stats.errors += 1
        mv_stats.lastError = `sidecar 错误帧：${line.slice(0, 120)}`
      }
      continue
    }
    client.pending.delete(payload.id)
    clearTimeout(slot.timer)
    if (payload.ok === true) slot.resolve(payload.result)
    else {
      const info = payload.error || {}
      slot.reject(mv_err(info.code || 'SIDECAR_ERROR', info.message || 'sidecar error'))
    }
  }
}

function mv_wire(client) {
  client.child.stdout.on('data', (chunk) => mv_onStdout(client, chunk))
  client.child.stderr.on('data', (chunk) => {
    mv_stats.lastStderr = (mv_stats.lastStderr + String(chunk)).slice(-4000)
  })
  client.child.on('exit', (code, signal) => {
    client.dead = true
    mv_stats.lastExit = { code, signal }
    if (client.idleTimer) clearTimeout(client.idleTimer)
    mv_rejectPending(client, mv_err('SIDECAR_GONE', `sidecar 退出（code=${code} signal=${signal}）`))
    if (!client.closing) {
      mv_stats.errors += 1
      const tail = mv_stats.lastStderr.split('\n').filter(Boolean).slice(-2).join(' | ')
      mv_stats.lastError = `sidecar 意外退出（code=${code} signal=${signal}）${tail ? '：' + tail : ''}`
    }
  })
}

function mv_startProcess(exe, cfg) {
  return new Promise((resolve, reject) => {
    const sep = process.platform === 'win32' ? ';' : ':'
    const env = {
      ...process.env,
      ARCHIVIST_ML_MODELS: cfg.modelsDir,
      ARCHIVIST_ML_EMBED_MODEL: cfg.embedModel,
      ARCHIVIST_ML_RERANK: cfg.rerank ? '1' : '0',
      PYTHONIOENCODING: 'utf-8',
    }
    if (!mv_env('ARCHIVIST_ML_IDLE_UNLOAD_S')) env.ARCHIVIST_ML_IDLE_UNLOAD_S = '600'
    env.PYTHONPATH = cfg.home + (env.PYTHONPATH ? sep + env.PYTHONPATH : '')
    let child
    try {
      child = spawn(exe, ['-m', 'archivist_ml.sidecar'], {
        cwd: cfg.home,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (err) {
      reject(err)
      return
    }
    const client = { child, pending: new Map(), nextId: 1, buf: '', dead: false, closing: false, exe, idleTimer: null }
    mv_stats.lastStderr = ''
    let settled = false
    const startupTimer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
      reject(mv_err('SIDECAR_TIMEOUT', `sidecar 启动超时（${exe} -m archivist_ml.sidecar）`))
    }, 20000)
    if (startupTimer.unref) startupTimer.unref()
    child.once('spawn', () => {
      if (settled) return
      settled = true
      clearTimeout(startupTimer)
      mv_wire(client)
      resolve(client)
    })
    child.once('error', (err) => {
      if (settled) {
        mv_stats.errors += 1
        mv_stats.lastError = `sidecar 进程错误：${mv_msg(err)}`
        return
      }
      settled = true
      clearTimeout(startupTimer)
      reject(err)
    })
  })
}

async function mv_ensureClient(cfg) {
  if (!cfg.enabled) throw mv_err('DISABLED', '向量通道已禁用（ARCHIVIST_ML=0）')
  if (mv_clientAlive()) {
    mv_touchIdle()
    return mv_client
  }
  if (mv_client && mv_client.dead) {
    if (mv_stats.restarts >= 1) {
      throw mv_err(
        'SIDECAR_CRASHED',
        `向量侧车已崩溃且自动重启一次后仍不可用（${mv_stats.lastError || 'unknown'}）`,
      )
    }
    mv_stats.restarts += 1
  }
  const candidates = cfg.python ? [cfg.python] : mv_PY_CANDIDATES.slice()
  let lastErr = null
  for (const exe of candidates) {
    try {
      const client = await mv_startProcess(exe, cfg)
      mv_client = client
      mv_stats.spawns += 1
      mv_touchIdle()
      return client
    } catch (err) {
      lastErr = err
    }
  }
  mv_stats.errors += 1
  mv_stats.lastError = mv_msg(lastErr)
  throw mv_err(
    'SIDECAR_MISSING',
    `无法启动 ML 侧车（python: ${cfg.python || mv_PY_CANDIDATES.join('/')}）：${mv_msg(lastErr)}`,
  )
}

function mv_request(client, method, params, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (!client || client.dead || !client.child || client.child.exitCode !== null) {
      reject(mv_err('SIDECAR_GONE', 'sidecar 未运行'))
      return
    }
    const id = client.nextId
    client.nextId += 1
    const timer = setTimeout(() => {
      client.pending.delete(id)
      mv_stats.errors += 1
      mv_stats.lastError = `侧车请求超时：${method} > ${timeoutMs}ms`
      reject(mv_err('TIMEOUT', `侧车请求超时（${method} > ${timeoutMs}ms），已终止该请求`))
      // An ONNX call inside the sidecar is not preemptible: kill the process, the next
      // request restarts it once (degradation is reported by the caller).
      mv_killClient(`request timeout: ${method}`)
    }, timeoutMs)
    if (timer.unref) timer.unref()
    client.pending.set(id, { resolve, reject, timer })
    mv_stats.requests += 1
    try {
      client.child.stdin.write(JSON.stringify({ id, method, params: params || {} }) + '\n')
    } catch (err) {
      client.pending.delete(id)
      clearTimeout(timer)
      reject(mv_err('SIDECAR_GONE', mv_msg(err)))
    }
  })
}

// ------------------------------------------------------------------ schema v2

function mv_ensureMetaTable(db) {
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
}

function mv_getMeta(db, key) {
  try {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key)
    return row ? row.value : null
  } catch {
    return null
  }
}

function mv_setMeta(db, key, value) {
  db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run(key, String(value))
}

function mv_count(db, sql, ...params) {
  const row = db.prepare(sql).get(...params)
  return Number(row && row.n != null ? row.n : 0)
}

/**
 * Create the two v2 tables and return whether stored vectors had to be discarded.
 * A missing `vector_schema_version` marker means the index DB was recreated underneath us
 * (openIndex rebuild drops `meta`), so stale chunk_id → vector mappings are wiped.
 */
function mv_createVectorTables(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS embeddings (
    chunk_id INTEGER PRIMARY KEY REFERENCES chunks(chunk_id) ON DELETE CASCADE,
    model    TEXT NOT NULL,
    dim      INTEGER NOT NULL,
    vec      BLOB NOT NULL
  )`)
  db.exec(`CREATE TABLE IF NOT EXISTS embedding_meta (
    model    TEXT PRIMARY KEY,
    dim      INTEGER NOT NULL,
    built_at TEXT NOT NULL,
    count    INTEGER NOT NULL
  )`)
}

/**
 * Create the two v2 tables and return whether stored vectors had to be discarded.
 * A missing `vector_schema_version` marker means the index DB was recreated underneath us
 * (openIndex rebuild drops `meta`), so stale chunk_id → vector mappings are wiped.
 * A fresh DB may not have `chunks` yet (module used before indexdb created its schema):
 * a DELETE on embeddings would then fail ("no such table: main.chunks") because of the FK,
 * so the wipe drops + recreates both derived tables instead.
 */
function ensureVectorSchema(db) {
  if (!db || typeof db.prepare !== 'function' || typeof db.exec !== 'function') {
    throw mv_err('BAD_DB', 'ensureVectorSchema requires an open node:sqlite database')
  }
  // Fast path: on a live connection the DDL + marker read happens once, not per query.
  if (mv_SCHEMA_READY.has(db) && mv_getMeta(db, mv_MARKER_KEY) === '2') {
    return { schema: '2', wiped: false }
  }
  mv_ensureMetaTable(db)
  mv_createVectorTables(db)
  if (mv_getMeta(db, mv_MARKER_KEY) === '2') {
    mv_SCHEMA_READY.add(db)
    return { schema: '2', wiped: false }
  }
  db.exec('DROP TABLE IF EXISTS embeddings')
  db.exec('DROP TABLE IF EXISTS embedding_meta')
  mv_createVectorTables(db)
  mv_setMeta(db, mv_MARKER_KEY, '2')
  mv_SCHEMA_READY.add(db)
  mv_invalidateMatrix()
  return { schema: '2', wiped: true }
}

function mv_upsertEmbeddingMeta(db, model, dim, count) {
  if (!dim) return
  db.prepare('INSERT OR REPLACE INTO embedding_meta(model, dim, built_at, count) VALUES (?, ?, ?, ?)').run(
    model,
    Number(dim),
    new Date().toISOString(),
    Number(count),
  )
}

function mv_clearModelRows(db, model) {
  const removed = db.prepare('DELETE FROM embeddings WHERE model = ?').run(model)
  db.prepare('DELETE FROM embedding_meta WHERE model = ?').run(model)
  mv_matrixCache.delete(db)
  return Number(removed && removed.changes != null ? removed.changes : 0)
}

function vectorStats(db, opts = {}) {
  const cfg = mv_config(opts)
  const out = {
    model: cfg.embedModel,
    count: 0,
    chunks: 0,
    missing: 0,
    dim: null,
    builtAt: null,
    enabled: cfg.enabled,
    degraded: null,
  }
  if (!cfg.enabled) {
    out.degraded = '向量通道已禁用（ARCHIVIST_ML=0）'
    return out
  }
  try {
    ensureVectorSchema(db)
    out.chunks = mv_count(db, "SELECT COUNT(*) AS n FROM chunks WHERE kind = 'leaf'")
    out.count = mv_count(db, 'SELECT COUNT(*) AS n FROM embeddings WHERE model = ?', cfg.embedModel)
    out.missing = Math.max(0, out.chunks - out.count)
    const meta = db.prepare('SELECT dim, built_at FROM embedding_meta WHERE model = ?').get(cfg.embedModel)
    if (meta) {
      out.dim = Number(meta.dim)
      out.builtAt = meta.built_at
    }
  } catch (err) {
    out.degraded = `向量表不可用：${mv_msg(err)}`
  }
  return out
}

// ------------------------------------------------------------------ embedding write path

function mv_validateTexts(texts) {
  if (!Array.isArray(texts) || !texts.length) throw mv_err('BAD_PARAMS', 'texts must be a non-empty array')
  let chars = 0
  for (const text of texts) {
    if (typeof text !== 'string') throw mv_err('BAD_PARAMS', 'texts must contain only strings')
    chars += text.length
  }
  if (chars > mv_MAX_TEXT_CHARS) throw mv_err('TOO_LARGE', `texts too large: ${chars} chars`)
}

function mv_matrixCacheDelete(db) {
  mv_matrixCache.delete(db)
}

async function embedPending(db, opts = {}) {
  const started = Date.now()
  const cfg = mv_config(opts)
  const out = {
    embedded: 0,
    skipped: 0,
    failed: 0,
    total: 0,
    model: cfg.embedModel,
    dim: null,
    batches: 0,
    ms: 0,
    degraded: null,
  }
  const done = () => {
    out.ms = Date.now() - started
    if (out.failed > 0 && !out.degraded) out.degraded = `向量嵌入未完成：${out.failed} 块失败`
    return out
  }
  if (!cfg.enabled) {
    out.degraded = '向量通道已禁用（ARCHIVIST_ML=0）'
    return done()
  }
  try {
    ensureVectorSchema(db)
  } catch (err) {
    out.degraded = `向量表不可用：${mv_msg(err)}`
    return done()
  }
  let storedDim = null
  try {
    // Only leaf chunks are retrieval targets (the lexical channel indexes leaves too);
    // section chunks are parent context and are never returned as hits.  Embedding leaves
    // keeps the dense channel's chunk universe identical to the lexical one (and is ~2x
    // less work on this corpus: 968 leaves vs 1884 total chunks).
    out.total = mv_count(db, "SELECT COUNT(*) AS n FROM chunks WHERE kind = 'leaf'")
    const metas = db.prepare('SELECT model, dim FROM embedding_meta').all()
    const stored = metas.find((row) => row.model === cfg.embedModel)
    storedDim = stored ? Number(stored.dim) : null
    const foreignMeta = metas.some((row) => row.model !== cfg.embedModel)
    const foreignRows = mv_count(db, 'SELECT COUNT(*) AS n FROM embeddings WHERE model <> ?', cfg.embedModel)
    if (foreignMeta || foreignRows > 0) {
      db.exec('DELETE FROM embeddings')
      db.exec('DELETE FROM embedding_meta')
      storedDim = null
    }
  } catch (err) {
    out.degraded = `向量存储读取失败：${mv_msg(err)}`
    return done()
  }
  let missing
  try {
    missing = db
      .prepare(
        'SELECT c.chunk_id AS chunkId, c.text AS text, c.token_est AS tokenEst FROM chunks c ' +
          "WHERE c.kind = 'leaf' AND NOT EXISTS " +
          '(SELECT 1 FROM embeddings e WHERE e.chunk_id = c.chunk_id AND e.model = ?) ' +
          'ORDER BY c.chunk_id',
      )
      .all(cfg.embedModel)
  } catch (err) {
    out.degraded = `向量缺块查询失败：${mv_msg(err)}`
    return done()
  }
  if (opts.limit && Number(opts.limit) > 0) missing = missing.slice(0, Number(opts.limit))
  out.skipped = Math.max(0, out.total - missing.length)
  if (!missing.length) {
    if (out.total > 0) mv_upsertEmbeddingMeta(db, cfg.embedModel, storedDim, out.total)
    return done()
  }
  const batchSize = Math.max(1, Math.min(256, Number(opts.batch) || 64))
  // Batch by length: one 512-token section would otherwise pad a whole batch of 64 up to
  // sequence length 512 (measured ~37ms per 512-token sequence on this CPU) and blow the 5s
  // per-request budget.  Length-sorted batches with a padding-slot cap keep requests bounded.
  // 8192 padding slots kept a batch of ~35 real chunks alive at once; onnxruntime then
  // peaked at 2.4GB RSS on this host (measured), which is unacceptable next to a 4.5GB
  // free-RAM host.  2048 slots (e.g. 4x512 or 64x32) keeps the sidecar under ~700MB.
  const slotBudget = Number(opts.slotBudget) > 0 ? Number(opts.slotBudget) : 2048
  missing.sort((a, b) => Number(a.tokenEst || 1) - Number(b.tokenEst || 1))
  const plan = []
  let batchPlan = []
  let planMaxTokens = 0
  for (const row of missing) {
    const tokens = Math.max(1, Number(row.tokenEst) || 1)
    const nextMax = Math.max(planMaxTokens, tokens)
    if (batchPlan.length && (batchPlan.length >= batchSize || nextMax * (batchPlan.length + 1) > slotBudget)) {
      plan.push(batchPlan)
      batchPlan = []
      planMaxTokens = 0
    }
    batchPlan.push(row)
    planMaxTokens = Math.max(planMaxTokens, tokens)
  }
  if (batchPlan.length) plan.push(batchPlan)
  const timeoutMs = Number(opts.timeoutMs) || mv_EMBED_TIMEOUT_MS
  const kind = opts.kind || 'passage'
  let dim = storedDim
  let db2
  try {
    db2 = db
    for (const rows of plan) {
      const texts = rows.map((row) => (row.text == null ? '' : String(row.text)))
      try {
        mv_validateTexts(texts)
      } catch (err) {
        out.degraded = `跳过非法文本块：${mv_msg(err)}`
        out.failed = missing.length - out.embedded
        break
      }
      let result
      try {
        const client = await mv_ensureClient(cfg)
        result = await mv_request(client, 'embed', { texts, model: cfg.embedModel, kind }, timeoutMs)
      } catch (err) {
        out.degraded = `向量侧车调用失败：${mv_msg(err)}`
        out.failed = missing.length - out.embedded
        break
      }
      const vectors = result && Array.isArray(result.vectors) ? result.vectors : null
      const resultDim = Number(result && result.dim)
      if (!vectors || vectors.length !== rows.length || !resultDim) {
        out.degraded = '向量侧车返回格式异常（vectors/dim 不匹配）'
        out.failed = missing.length - out.embedded
        break
      }
      if (storedDim && storedDim !== resultDim) {
        out.degraded = `嵌入维度变化（stored ${storedDim} ≠ ${resultDim}）：模型被替换，请先 clearEmbeddings 再重建`
        out.failed = missing.length - out.embedded
        break
      }
      dim = resultDim
      try {
        db2.exec('BEGIN')
        const insert = db2.prepare('INSERT OR REPLACE INTO embeddings(chunk_id, model, dim, vec) VALUES (?, ?, ?, ?)')
        for (let row = 0; row < rows.length; row += 1) {
          const vector = vectors[row]
          if (!Array.isArray(vector) || vector.length !== dim) throw mv_err('BAD_VECTOR', `vector ${row} has wrong length`)
          const f32 = Float32Array.from(vector)
          insert.run(
            Number(rows[row].chunkId),
            cfg.embedModel,
            dim,
            Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength),
          )
        }
        db2.exec('COMMIT')
      } catch (err) {
        try {
          db2.exec('ROLLBACK')
        } catch {
          /* no transaction left */
        }
        out.degraded = `写入嵌入失败：${mv_msg(err)}`
        out.failed = missing.length - out.embedded
        break
      }
      out.embedded += rows.length
      out.batches += 1
      mv_matrixCacheDelete(db2)
      if (typeof opts.onProgress === 'function') {
        try {
          opts.onProgress({ embedded: out.embedded, total: missing.length, batch: out.batches, dim })
        } catch {
          /* progress callback must not break embedding */
        }
      }
    }
  } finally {
    out.dim = dim
    if (db2) {
      let count = 0
      try {
        count = mv_count(db2, 'SELECT COUNT(*) AS n FROM embeddings WHERE model = ?', cfg.embedModel)
        if (count > 0) mv_upsertEmbeddingMeta(db2, cfg.embedModel, dim, count)
        out.missingAfter = Math.max(0, out.total - count)
      } catch {
        /* reported through out.degraded by the caller path */
      }
    }
  }
  return done()
}

// ------------------------------------------------------------------ brute-force cosine

/**
 * Matrix cache, keyed by an embedding_meta fingerprint (model|count|built_at|dim), NOT by
 * the db handle.  archivist may open a fresh DatabaseSync per search; a WeakMap keyed by the
 * handle then reloads all 34K x 384 BLOBs on every query (the 1328ms p50 dense cost on the
 * 10M corpus).  A fingerprint hit costs one primary-key lookup plus the dot product.
 * 34K x 384 Float32 = 52MB; keep at most the two most recent corpora.
 * Invalidation: embeddings/embedding_meta writes bump built_at/count (embedPending), and
 * mv_invalidateMatrix() is also called on schema wipe/clear/batch write.
 */
const mv_MATRIX_INDEX_MAX = 2
const mv_matrixIndex = new Map()
const mv_SCHEMA_READY = new WeakSet()

/** Backwards-compatible invalidation hook for call sites written before the fingerprint cache. */
const mv_matrixCache = {
  delete: () => mv_invalidateMatrix(),
  get: () => undefined,
  set: () => {},
}

function mv_invalidateMatrix() {
  mv_matrixIndex.clear()
}

function mv_blobToFloat32(blob, dim) {
  const u8 = blob instanceof Uint8Array ? blob : new Uint8Array(blob)
  const need = dim * 4
  if (u8.length < need) throw mv_err('BAD_VECTOR', `embedding blob too short: ${u8.length} < ${need}`)
  const copy = new Uint8Array(need)
  copy.set(u8.subarray(0, need))
  return new Float32Array(copy.buffer)
}

function mv_embeddingFingerprint(db, model) {
  try {
    const meta = db.prepare('SELECT count, built_at, dim FROM embedding_meta WHERE model = ?').get(model)
    if (meta) {
      return {
        key: `${model}|${Number(meta.count)}|${String(meta.built_at)}|${Number(meta.dim)}`,
        count: Number(meta.count),
        dim: Number(meta.dim),
      }
    }
  } catch {
    /* no meta table yet: fall through to the slower row count */
  }
  const count = mv_count(db, 'SELECT COUNT(*) AS n FROM embeddings WHERE model = ?', model)
  return { key: `${model}|${count}|no-meta|0`, count, dim: 0 }
}

function mv_loadMatrix(db, model) {
  const fingerprint = mv_embeddingFingerprint(db, model)
  const cached = mv_matrixIndex.get(fingerprint.key)
  if (cached) {
    mv_matrixIndex.delete(fingerprint.key) // refresh LRU position
    mv_matrixIndex.set(fingerprint.key, cached)
    return cached
  }
  const statement = db.prepare(
    'SELECT e.chunk_id AS chunk_id, c.doc_id AS doc_id, e.dim AS dim, e.vec AS vec ' +
      'FROM embeddings e JOIN chunks c ON c.chunk_id = e.chunk_id WHERE e.model = ? ORDER BY e.chunk_id',
  )
  let dim = fingerprint.dim > 0 ? fingerprint.dim : 0
  let ids = null
  let docIds = null
  let vectors = null
  let at = 0
  const take = (row) => {
    const rowDim = Number(row.dim)
    if (!dim) dim = rowDim
    if (rowDim !== dim) throw mv_err('EMBED_DIM_MISMATCH', `嵌入维度不一致：${rowDim} ≠ ${dim}`)
    if (!ids) {
      const capacity = Math.max(1, fingerprint.count || 1)
      ids = new Int32Array(capacity)
      docIds = new Int32Array(capacity)
      vectors = new Float32Array(capacity * dim)
    } else if (at >= ids.length) {
      const grown = Math.max(at + 1, Math.ceil(ids.length * 1.5))
      const biggerIds = new Int32Array(grown)
      biggerIds.set(ids)
      ids = biggerIds
      const biggerDocs = new Int32Array(grown)
      biggerDocs.set(docIds)
      docIds = biggerDocs
      const biggerVec = new Float32Array(grown * dim)
      biggerVec.set(vectors)
      vectors = biggerVec
    }
    ids[at] = Number(row.chunk_id)
    docIds[at] = Number(row.doc_id)
    vectors.set(mv_blobToFloat32(row.vec, dim), at * dim)
    at += 1
  }
  // iterate() keeps peak memory at ~matrix size (streaming one BLOB row at a time).
  if (typeof statement.iterate === 'function') {
    for (const row of statement.iterate(model)) take(row)
  } else {
    for (const row of statement.all(model)) take(row)
  }
  const chunks = mv_count(db, "SELECT COUNT(*) AS n FROM chunks WHERE kind = 'leaf'")
  const matrix = {
    model,
    fingerprint: fingerprint.key,
    count: at,
    dim,
    ids: ids ? ids.subarray(0, at) : new Int32Array(0),
    docIds: docIds ? docIds.subarray(0, at) : new Int32Array(0),
    vec: vectors ? vectors.subarray(0, at * dim) : new Float32Array(0),
    chunks,
  }
  mv_matrixIndex.set(fingerprint.key, matrix)
  while (mv_matrixIndex.size > mv_MATRIX_INDEX_MAX) {
    const oldest = mv_matrixIndex.keys().next()
    if (oldest.done) break
    mv_matrixIndex.delete(oldest.value)
  }
  return matrix
}

function mv_cacheQueryVector(key, vector, dim) {
  const now = Date.now()
  mv_qcache.delete(key) // re-insert so Map order is LRU-ish
  mv_qcache.set(key, { vec: vector, dim, ts: now })
  while (mv_qcache.size > mv_QUERY_CACHE_MAX) {
    const oldest = mv_qcache.keys().next()
    if (oldest.done) break
    mv_qcache.delete(oldest.value)
  }
}

async function searchDense(db, query, opts = {}) {
  const started = Date.now()
  const cfg = mv_config(opts)
  const diagnostics = {
    channel: 'dense',
    model: cfg.embedModel,
    ms: 0,
    embedMs: 0,
    searchMs: 0,
    cached: false,
    total: 0,
    coverage: { embedded: 0, chunks: 0, missing: 0 },
    degraded: null,
  }
  const done = (hits = []) => {
    diagnostics.ms = Date.now() - started
    return { hits, diagnostics }
  }
  const degraded = (reason) => {
    diagnostics.degraded = reason
    return done([])
  }
  if (!cfg.enabled) return degraded('向量通道已禁用（ARCHIVIST_ML=0）')
  const text = query == null ? '' : String(query).trim()
  if (!text) return degraded('空查询，向量通道跳过')
  try {
    ensureVectorSchema(db)
  } catch (err) {
    return degraded(`向量表不可用：${mv_msg(err)}`)
  }
  let matrix
  try {
    matrix = mv_loadMatrix(db, cfg.embedModel)
    diagnostics.coverage.chunks = matrix.chunks
    diagnostics.coverage.embedded = matrix.count
    diagnostics.coverage.missing = Math.max(0, diagnostics.coverage.chunks - matrix.count)
    diagnostics.total = matrix.count
  } catch (err) {
    return degraded(`向量索引读取失败：${mv_msg(err)}`)
  }
  if (!matrix.count) {
    return degraded('向量索引为空（0 条嵌入）：请先运行 archivist_index 构建嵌入')
  }
  const key = `${cfg.embedModel}\u0000${text}`
  const cached = mv_qcache.get(key)
  let queryVec = null
  if (cached && Date.now() - cached.ts < mv_QUERY_CACHE_TTL_MS && cached.dim === matrix.dim) {
    queryVec = cached.vec
    diagnostics.cached = true
  } else {
    const embedStarted = Date.now()
    let result
    try {
      const client = await mv_ensureClient(cfg)
      result = await mv_request(
        client,
        'embed',
        { texts: [text], model: cfg.embedModel, kind: 'query' },
        Number(opts.timeoutMs) || mv_EMBED_TIMEOUT_MS,
      )
    } catch (err) {
      diagnostics.embedMs = Date.now() - embedStarted
      return degraded(`查询嵌入失败：${mv_msg(err)}`)
    }
    diagnostics.embedMs = Date.now() - embedStarted
    const vector = result && Array.isArray(result.vectors) ? result.vectors[0] : null
    if (!vector || vector.length !== matrix.dim) {
      return degraded(`查询嵌入维度不匹配（expected ${matrix.dim}）`)
    }
    queryVec = Float32Array.from(vector)
    mv_cacheQueryVector(key, queryVec, matrix.dim)
  }
  const searchStarted = Date.now()
  const n = matrix.count
  const dim = matrix.dim
  const scores = new Float32Array(n)
  const vec = matrix.vec
  for (let i = 0; i < n; i += 1) {
    let score = 0
    const offset = i * dim
    for (let d = 0; d < dim; d += 1) score += queryVec[d] * vec[offset + d]
    scores[i] = score
  }
  const order = new Array(n)
  for (let i = 0; i < n; i += 1) order[i] = i
  order.sort((a, b) => scores[b] - scores[a])
  const requested = Number(opts.topK) > 0 ? Number(opts.topK) : 100
  const topK = Math.max(1, Math.min(n, Math.min(1000, requested)))
  const hits = []
  for (let rank = 0; rank < topK; rank += 1) {
    const index = order[rank]
    hits.push({
      chunkId: matrix.ids[index],
      docId: matrix.docIds[index],
      score: mv_round(Math.max(-1, Math.min(1, scores[index])), 6),
      rank: rank + 1,
    })
  }
  diagnostics.searchMs = Date.now() - searchStarted
  return done(hits)
}

// ------------------------------------------------------------------ rerank (Phase 3 client)

async function rerankDocs(query, docs, opts = {}) {
  const started = Date.now()
  const cfg = mv_config(opts)
  const diagnostics = { model: null, ms: 0, degraded: null }
  const done = (scores = []) => {
    diagnostics.ms = Date.now() - started
    return { scores, ...diagnostics }
  }
  if (!cfg.enabled) {
    diagnostics.degraded = '向量通道已禁用（ARCHIVIST_ML=0）'
    return done([])
  }
  if (!cfg.rerank) {
    diagnostics.degraded = '重排通道已禁用（ARCHIVIST_ML_RERANK≠1）'
    return done([])
  }
  if (!Array.isArray(docs) || !docs.length) {
    diagnostics.degraded = '重排输入为空'
    return done([])
  }
  const text = query == null ? '' : String(query).trim()
  if (!text) {
    diagnostics.degraded = '重排查询为空'
    return done([])
  }
  try {
    const client = await mv_ensureClient(cfg)
    const result = await mv_request(
      client,
      'rerank',
      { query: text, docs: docs.map((doc) => (doc == null ? '' : String(doc))), topK: opts.topK || undefined },
      Number(opts.timeoutMs) || mv_RERANK_TIMEOUT_MS,
    )
    diagnostics.model = result && result.model ? result.model : null
    const scores = result && Array.isArray(result.scores) ? result.scores : []
    return done(scores)
  } catch (err) {
    diagnostics.degraded = `重排侧车调用失败：${mv_msg(err)}`
    return done([])
  }
}

// ------------------------------------------------------------------ status / lifecycle

function mlStatus(opts = {}) {
  const cfg = mv_config(opts)
  const client = mv_client
  return {
    enabled: cfg.enabled,
    home: cfg.home,
    python: cfg.python || `(probe: ${mv_PY_CANDIDATES.join(', ')})`,
    modelsDir: cfg.modelsDir,
    embedModel: cfg.embedModel,
    rerank: cfg.rerank,
    queryCache: mv_qcache.size,
    sidecar: {
      spawned: !!client,
      alive: mv_clientAlive(),
      exe: client ? client.exe : null,
      pid: mv_stats.lastPid,
      rssMb: mv_stats.lastRssMb,
      spawns: mv_stats.spawns,
      restarts: mv_stats.restarts,
      requests: mv_stats.requests,
      errors: mv_stats.errors,
      lastError: mv_stats.lastError,
      lastExit: mv_stats.lastExit,
      lastStderrTail: mv_stats.lastStderr.split('\n').filter(Boolean).slice(-2).join(' | '),
    },
    degraded: cfg.enabled ? null : '向量通道已禁用（ARCHIVIST_ML=0）',
  }
}

async function mlPing(opts = {}) {
  const cfg = mv_config(opts)
  if (!cfg.enabled) return { ok: false, degraded: '向量通道已禁用（ARCHIVIST_ML=0）' }
  const started = Date.now()
  try {
    const client = await mv_ensureClient(cfg)
    const result = await mv_request(client, 'ping', {}, Number(opts.timeoutMs) || mv_PING_TIMEOUT_MS)
    if (result && result.pid != null) mv_stats.lastPid = result.pid
    if (result && result.rss_mb != null) mv_stats.lastRssMb = result.rss_mb
    return { ok: true, ...result, ms: Date.now() - started }
  } catch (err) {
    return { ok: false, degraded: `ML 侧车不可用：${mv_msg(err)}`, ms: Date.now() - started }
  }
}

function clearEmbeddings(db, opts = {}) {
  const cfg = mv_config(opts)
  let removed = 0
  try {
    ensureVectorSchema(db)
    if (opts.all) {
      const result = db.prepare('DELETE FROM embeddings').run()
      db.prepare('DELETE FROM embedding_meta').run()
      removed = Number(result && result.changes != null ? result.changes : 0)
    } else {
      removed = mv_clearModelRows(db, cfg.embedModel)
    }
    mv_qcache.clear()
    mv_matrixCache.delete(db)
  } catch {
    return { removed: 0, degraded: '向量表不可用，无法清理' }
  }
  return { removed }
}

async function closeMl() {
  const client = mv_client
  if (!client) return
  client.closing = true
  mv_client = null
  if (client.idleTimer) clearTimeout(client.idleTimer)
  await new Promise((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      try {
        client.child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
      finish()
    }, 1500)
    if (timer.unref) timer.unref()
    client.child.once('exit', finish)
    try {
      client.child.stdin.end()
    } catch {
      finish()
    }
  })
  client.dead = true
  mv_stats.lastExit = { code: null, signal: 'shutdown-requested' }
}

export {
  mlStatus,
  mlPing,
  ensureVectorSchema,
  vectorStats,
  embedPending,
  searchDense,
  rerankDocs,
  clearEmbeddings,
  closeMl,
}
