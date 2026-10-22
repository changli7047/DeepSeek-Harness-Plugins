#!/usr/bin/env node
/**
 * Build the two host adapters (OpenCode v2 / dsh) from the single core source.
 *
 * The core is split across `core/mod-*.mjs` modules plus `core/archivist.mjs`.
 * Each module is standalone-runnable (real ESM imports) so Node scripts such as
 * `selftest.mjs` and `bench/eval.mjs` import the source directly; this script
 * flattens the modules into ONE module body for the two generated plugins, which
 * must stay self-contained files that a host can load by absolute path.
 *
 * Flattening rules:
 *   - relative imports (`./mod-*.mjs`) are dropped;
 *   - every `node:*` (or bare builtin) import declaration is lifted into one
 *     merged import block at the top, so duplicate bindings never collide;
 *   - `export ` prefixes are dropped; `export { a, b } from './mod-x.mjs'`
 *     becomes `export { a, b }` (the binding now lives in the same body);
 *   - the flattened body must pass `node --check` before anything is written.
 *
 * Outputs:
 *   opencode/index.ts — self-contained OpenCode plugin
 *   dsh/archivist.ts  — self-contained dsh plugin
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/** Inline order: dependencies before users; the entry file goes last. */
const MODULES = [
  'mod-chunks.mjs',
  'mod-intent.mjs',    // pure intent classifier (routing hints; no imports at all)
  'mod-vector.mjs',    // ML sidecar client + embedding storage (retrieval imports it)
  'mod-indexdb.mjs',
  'mod-claims.mjs',    // derived knowledge layer: claims/entities validity (P4)
  'mod-retrieval.mjs',
  'mod-evidence.mjs',
  'mod-verify.mjs',
]
const ENTRY = 'archivist.mjs'
/** The core registers this many archivist_* tools; the host adapters must see them all. */
const EXPECTED_TOOLS = 16

// ── import flattening ───────────────────────────────────────────────────────

const IMPORT_START = /^\s*import\b/
const SPEC_RE = /from\s+['"]([^'"]+)['"]/

/** Read one import declaration starting at `lines[i]`; returns [text, nextIndex]. */
function readImport(lines, i) {
  const start = i
  let text = lines[i]
  // A declaration ends when it contains `from '...'` or is a bare side-effect import.
  while (!SPEC_RE.test(text) && i + 1 < lines.length) {
    i++
    text += '\n' + lines[i]
    if (text.length > 4000) throw new Error(`unterminated import near line ${start + 1}`)
  }
  return [text, i + 1, start]
}

/** Parse one import declaration into { spec, def, namespace, names[] }. */
function parseImport(text) {
  const spec = SPEC_RE.exec(text)?.[1]
  if (!spec) throw new Error(`cannot parse import: ${text.slice(0, 120)}`)
  const body = text.replace(/^\s*import\s+/, '').replace(/from\s+['"][^'"]+['"]\s*$/, '').replace(/['"][^'"]+['"]\s*$/, '').trim()
  const out = { spec, def: null, namespace: null, names: [] }
  if (!body) return out
  if (body.startsWith('{')) {
    const inner = body.slice(1, body.lastIndexOf('}'))
    for (const part of inner.split(',').map((s) => s.trim()).filter(Boolean)) {
      const m = /^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/.exec(part)
      if (!m) throw new Error(`cannot parse named import specifier "${part}"`)
      out.names.push({ imported: m[1], local: m[2] || m[1] })
    }
    return out
  }
  if (body.startsWith('*')) {
    const m = /^\*\s+as\s+([A-Za-z_$][\w$]*)$/.exec(body)
    if (!m) throw new Error(`cannot parse namespace import "${body}"`)
    out.namespace = m[1]
    return out
  }
  const m = /^([A-Za-z_$][\w$]*)(?:\s*,\s*\{([\s\S]*)\})?$/.exec(body)
  if (!m) throw new Error(`cannot parse default import "${body}"`)
  out.def = m[1]
  if (m[2] !== undefined) {
    for (const part of m[2].split(',').map((s) => s.trim()).filter(Boolean)) {
      const n = /^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/.exec(part)
      if (!n) throw new Error(`cannot parse named import specifier "${part}"`)
      out.names.push({ imported: n[1], local: n[2] || n[1] })
    }
  }
  return out
}

/** Strip imports/exports from one module body and record its imports. */
function flatten(name, source, imports) {
  const lines = source.split('\n')
  const kept = []
  for (let i = 0; i < lines.length;) {
    if (IMPORT_START.test(lines[i])) {
      const [text, next] = readImport(lines, i)
      const parsed = parseImport(text)
      if (parsed.spec.startsWith('.')) {
        // relative module import: dropped, the target is inlined next to it
        if (!/^\.\/mod-[a-z]+\.mjs$/.test(parsed.spec)) throw new Error(`${name}: unexpected relative import "${parsed.spec}"`)
      } else {
        imports.push(parsed)
      }
      i = next
      continue
    }
    // `export { a, b } from './mod-x.mjs'` → `export { a, b }`
    const reexport = /^export\s*\{([^}]*)\}\s*from\s*['"]\.\/(mod-[a-z]+\.mjs)['"]\s*$/.exec(lines[i])
    if (reexport) {
      kept.push(`export {${reexport[1]}}`)
      i++
      continue
    }
    if (/^export\s+\*/.test(lines[i])) throw new Error(`${name}: star re-exports are not supported`)
    kept.push(lines[i].replace(/^export\s+(?=(?:async\s+)?(?:function|const|let|class|default)\b)/, ''))
    i++
  }
  const body = kept.join('\n')
  const leftover = body.split('\n').find((l) => /^\s*(?:import|export)\b/.test(l) && !/^\s*export\s*\{/.test(l))
  if (leftover) throw new Error(`${name}: import/export survived flattening: ${leftover.trim().slice(0, 100)}`)
  return body
}

/** Merge every collected import into one deduplicated block. */
function mergeImports(imports) {
  const bySpec = new Map()
  const seenLocal = new Map()
  const claim = (local, spec) => {
    const previous = seenLocal.get(local)
    if (previous && previous !== spec) throw new Error(`binding "${local}" imported from both "${previous}" and "${spec}"`)
    seenLocal.set(local, spec)
  }
  for (const imp of imports) {
    const entry = bySpec.get(imp.spec) ?? { def: null, namespace: null, names: new Map() }
    if (imp.def) {
      if (entry.def && entry.def !== imp.def) throw new Error(`duplicate default import "${imp.def}" from "${imp.spec}"`)
      entry.def = imp.def
      claim(imp.def, imp.spec)
    }
    if (imp.namespace) {
      if (entry.namespace && entry.namespace !== imp.namespace) throw new Error(`duplicate namespace import from "${imp.spec}"`)
      entry.namespace = imp.namespace
      claim(imp.namespace, imp.spec)
    }
    for (const { imported, local } of imp.names) {
      const existing = entry.names.get(imported)
      if (existing && existing !== local) throw new Error(`"${imported}" from "${imp.spec}" imported twice as "${existing}" and "${local}"`)
      entry.names.set(imported, local)
      claim(local, imp.spec)
    }
    bySpec.set(imp.spec, entry)
  }
  const order = [...bySpec.keys()].sort()
  const lines = []
  for (const spec of order) {
    const e = bySpec.get(spec)
    const parts = []
    if (e.def) parts.push(e.def)
    if (e.namespace) parts.push(`* as ${e.namespace}`)
    if (e.names.size) parts.push(`{ ${[...e.names].map(([imported, local]) => (imported === local ? imported : `${imported} as ${local}`)).sort().join(', ')} }`)
    lines.push(`import ${parts.join(', ')} from '${spec}'`)
  }
  return lines.join('\n')
}

// ── tool-schema gate ───────────────────────────────────────────────────────

/**
 * Walk one tool parameter schema and collect every violation of the host's
 * `defineTool` JSON-schema rules: an `object` node must state
 * `additionalProperties` explicitly (true or false), including objects nested
 * inside array items. `defineTool` throws on these, and a throw inside
 * `apply()` leaves the host with ZERO archivist tools.
 */
function walkSchema(node, where, problems) {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) {
    node.forEach((child, i) => walkSchema(child, `${where}[${i}]`, problems))
    return
  }
  if (node.type === 'object') {
    if (typeof node.additionalProperties !== 'boolean') {
      problems.push(`${where}: object schema must set additionalProperties explicitly (true or false)`)
    }
    for (const [key, child] of Object.entries(node.properties ?? {})) walkSchema(child, `${where}.${key}`, problems)
  }
  if (node.type === 'array') walkSchema(node.items, `${where}[]`, problems)
  for (const key of ['oneOf', 'anyOf', 'allOf']) {
    if (Array.isArray(node[key])) node[key].forEach((child, i) => walkSchema(child, `${where}.${key}[${i}]`, problems))
  }
}

// ── assemble ────────────────────────────────────────────────────────────────

const parts = []
for (const mod of MODULES) {
  const abs = path.join(root, 'core', mod)
  if (!existsSync(abs)) throw new Error(`missing core module: core/${mod} — the flattened plugin needs every module in MODULES`)
  parts.push([mod, readFileSync(abs, 'utf8')])
}
parts.push([ENTRY, readFileSync(path.join(root, 'core', ENTRY), 'utf8')])

const imports = []
const bodies = parts.map(([name, source]) => `// ---- inlined: ${name} ----\n${flatten(name, source, imports)}`)
const core = mergeImports(imports) + '\n\n' + bodies.join('\n\n')

if (core.includes('__CORE__')) throw new Error('core contains the __CORE__ placeholder — refusing to build')
const toolCount = (core.match(/name: 'archivist_/g) ?? []).length
if (toolCount !== EXPECTED_TOOLS) throw new Error(`expected ${EXPECTED_TOOLS} tools in the core, found ${toolCount}`)

// The flattened body must parse before it is embedded anywhere, and its tool
// schemas must be ones the host's `defineTool` accepts — a schema rejected at
// `apply()` time unregisters EVERY archivist tool in the host, so this is a
// build gate, not a runtime nicety.
const checkFile = path.join(os.tmpdir(), `archivist-core-check-${process.pid}.mjs`)
// Flattening removes every `export`, so the validation copy re-exports the one
// binding the schema gate needs; the emitted plugin files keep their own shape.
writeFileSync(checkFile, `${core}\n\nexport { TOOLS }\n`)
try {
  const check = spawnSync(process.execPath, ['--check', checkFile], { encoding: 'utf8' })
  if (check.status !== 0) {
    const stderr = String(check.stderr || check.stdout)
    const detail = [...stderr.matchAll(/Identifier '([^']+)' has already been declared/g)]
      .map(([, name]) => {
        const declaredIn = parts
          .filter(([, source]) => new RegExp(`^(?:export\\s+)?(?:async\\s+)?(?:function|const|let|var|class)\\s+${name.replace(/[$]/g, '\\$&')}\\b`, 'm').test(source))
          .map(([file]) => file)
        return `top-level "${name}" is declared in ${declaredIn.join(' and ') || '(unknown)'} — rename it (module helpers must be prefixed: ch_/ix_/rt_/ev_/vf_/mv_)`
      })
    throw new Error(`flattened core does not parse:\n${stderr}${detail.length ? '\n' + detail.join('\n') : ''}`)
  }
  const loaded = await import(`${pathToFileURL(checkFile).href}?v=${Date.now()}`)
  if (!Array.isArray(loaded.TOOLS) || loaded.TOOLS.length !== toolCount) {
    throw new Error(`flattened core did not export ${toolCount} TOOLS (got ${loaded.TOOLS?.length ?? 'none'})`)
  }
  const problems = []
  for (const tool of loaded.TOOLS) walkSchema(tool.schema, `${tool.name}.parameters`, problems)
  if (problems.length) throw new Error(`tool schemas the host would reject:\n${problems.join('\n')}`)
} finally {
  rmSync(checkFile, { force: true })
}

const jobs = [
  { template: 'opencode.template.ts', out: 'opencode/index.ts', marker: 'export default Plugin.define', registrations: 'for (const tool of TOOLS)' },
  { template: 'dsh.template.ts', out: 'dsh/archivist.ts', marker: 'export function apply', registrations: 'ctx.tools.register(defineTool' },
]

for (const job of jobs) {
  const template = readFileSync(path.join(root, 'build', job.template), 'utf8')
  if (!template.includes('__CORE__')) throw new Error(`template missing __CORE__: ${job.template}`)
  if (template.split('__CORE__').length !== 2) throw new Error(`template must contain exactly one __CORE__: ${job.template}`)
  const generated = template.split('__CORE__').join(core)
  if (!generated.includes(job.marker)) throw new Error(`generated file missing marker "${job.marker}": ${job.out}`)
  if (!generated.includes(job.registrations)) throw new Error(`generated file missing registration loop: ${job.out}`)
  if (generated.includes('__CORE__')) throw new Error(`placeholder left in ${job.out}`)
  const abs = path.join(root, job.out)
  mkdirSync(path.dirname(abs), { recursive: true })
  writeFileSync(abs, generated)
  console.log(`written ${job.out}: ${generated.length} chars`)
}
console.log(`tools: ${toolCount} | modules: ${MODULES.length} + entry | flattened core: ${core.length} chars`)
