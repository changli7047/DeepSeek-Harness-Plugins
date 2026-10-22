#!/usr/bin/env node
/**
 * End-to-end smoke test of the GENERATED dsh plugin, without restarting the host.
 *
 * What it proves (each line has bitten before):
 *   1. the generated `dsh/archivist.ts` is byte-identical to the copy the profile
 *      patch actually loads (`<dsh-repo>/scratch-plugin/src/archivist.ts`);
 *   2. it imports under the host's module resolution (`tsx` ESM from the dsh repo),
 *      so bare `@deepseek-ai/dsh-tools` imports resolve;
 *   3. `apply()` accepts every tool schema — `defineTool` rejects loose JSON
 *      schemas, and ONE rejection leaves the host with zero archivist tools;
 *   4. a representative call set actually returns the expected shapes.
 *
 * Usage (Node must be able to resolve `tsx` from the dsh repo — run from there,
 * or let this script set cwd for its child process):
 *   node bench/plugin-smoke.mjs [--dsh <dsh-repo>] [--ws <workspace>]
 *
 * Exit code 0 = all assertions passed; 1 = a failure with a concrete message.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf('--' + name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const dshRepo = path.resolve(flag('dsh', process.env.ARCHIVIST_DSH_REPO || 'C:/Users/长离/Documents/deepseek-harness/deepseek-harness'))
const workspace = path.resolve(flag('ws', process.env.ARCHIVIST_SMOKE_WS || 'D:/archivist-work/baseline-copy'))
const generated = path.join(here, 'dsh', 'archivist.ts')
const deployed = path.join(dshRepo, 'scratch-plugin', 'src', 'archivist.ts')
const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')

const fail = (message) => { console.error('FAIL ' + message); process.exit(1) }
const ok = (message) => console.log('PASS ' + message)

// ── inner half: runs inside the dsh repo with the host's loader ─────────────
if (process.env.ARCHIVIST_SMOKE_INNER === '1') {
  const mod = await import(pathToFileURL(deployed).href)
  if (typeof mod.apply !== 'function') fail('generated plugin has no apply() export')
  const registrations = []
  const ctx = { tools: { register: (def) => { registrations.push(def); return () => {} } }, get: () => undefined, effect: () => {} }
  try {
    mod.apply(ctx)
  } catch (error) {
    fail(`apply() threw (the host would register ZERO archivist tools): ${error?.message || error}`)
  }
  console.log(JSON.stringify({ toolCount: registrations.length, names: registrations.map((r) => r.name) }))
  if (registrations.length !== 16) fail(`expected 16 registered tools, got ${registrations.length}`)

  process.env.ARCHIVIST_BUG_REPORT = '0'
  const byName = new Map(registrations.map((r) => [r.name, r]))
  const call = async (name, callArgs) => {
    const def = byName.get(name)
    if (!def) throw new Error(`${name} is not registered`)
    return String(await def.execute(callArgs))
  }
  const checks = []
  const check = (label, condition) => { checks.push({ label, ok: !!condition }); if (condition) ok(label) }

  const status = await call('archivist_status', { workspace })
  check('archivist_status reports pages', /pages:\s*\d+/.test(status))
  const search = await call('archivist_search', { workspace, query: '全国地图 尺寸', limit: 5 })
  check('archivist_search returns anchored results', /↳ \S+@[0-9a-f]{8}#c\d+\[\d+:\d+\]/.test(search))
  const evidence = await call('archivist_evidence', { workspace, query: '全国地图现在接入引擎的是什么尺寸', maxTokens: 3000 })
  check('archivist_evidence returns numbered blocks', /\[S1\]/.test(evidence) && /回答规则/.test(evidence))
  const verifyGood = await call('archivist_verify', { workspace, citations: [{ id: 'S1', path: 'wiki/syntheses/三国志建造-全国地图v2落地.md', quote: '204×208' }] })
  const verifyBad = await call('archivist_verify', { workspace, citations: [{ id: 'S1', path: 'wiki/syntheses/三国志建造-全国地图v2落地.md', quote: '这句话原文里根本没有' }] })
  check('archivist_verify accepts a real quote', /✅/.test(verifyGood) && !/❌/.test(verifyGood))
  check('archivist_verify rejects a fabricated quote', /❌/.test(verifyBad))
  const readAnchor = await call('archivist_read', { workspace, path: 'wiki/syntheses/三国志建造-全国地图v2落地.md#c1' })
  check('archivist_read accepts a bare anchor', /#c1 \[\d+:\d+\]/.test(readAnchor))
  // A stale chunk number is a loud, actionable failure (the host surfaces the
  // thrown message to the model) — not a silent empty read.
  let staleError = ''
  try { await call('archivist_read', { workspace, path: 'wiki/syntheses/三国志建造-全国地图v2落地.md#c999' }) } catch (error) { staleError = String(error?.message || error) }
  check('archivist_read rejects a stale chunk number loudly', /not found/.test(staleError) && /ords/.test(staleError))
  // P4 claims: a claim without a verifiable anchor+quote must be refused, not stored.
  const claimBad = await call('archivist_claim', { workspace, action: 'add', file: 'smoke', claims: [{ subject: 'SmokeTest', predicate: 'p', object: 'o', anchor: 'wiki/overview.md#c0', quote: '这段引文原文里绝对没有' }] })
  check('archivist_claim refuses a claim whose quote is not in the anchor', /rejected 1/.test(claimBad), claimBad.slice(0, 160))
  const claimList = await call('archivist_claim', { workspace, action: 'list', subject: 'SmokeTest' })
  check('archivist_claim list answers', /no active claims|条/.test(claimList))

  const failed = checks.filter((c) => !c.ok)
  if (failed.length) fail(`${failed.length}/${checks.length} behaviour checks failed: ${failed.map((c) => c.label).join('; ')}`)
  ok(`all ${checks.length} behaviour checks passed`)
  process.exit(0)
}

// ── outer half: preconditions, then run the inner half in the dsh repo ──────
if (!existsSync(generated)) fail(`missing generated plugin ${generated} — run build/build.mjs first`)
if (!existsSync(deployed)) fail(`missing deployed plugin ${deployed} — run build/deploy.mjs first`)
const a = sha(generated)
const b = sha(deployed)
ok(`deployed copy matches the generated plugin (sha256 ${a.slice(0, 16)}…)`)
if (a !== b) fail(`deployed plugin is stale: generated ${a.slice(0, 16)} = ${readFileSync(generated).length}B vs deployed ${b.slice(0, 16)} = ${readFileSync(deployed).length}B — run build/deploy.mjs`)
if (!existsSync(path.join(dshRepo, 'node_modules', 'tsx'))) fail(`tsx is not installed in ${dshRepo} — run pnpm install there first`)
console.log(`running the plugin under ${dshRepo} with tsx/esm (workspace: ${workspace})`)
const child = spawnSync(process.execPath, ['--import', 'tsx/esm', fileURLToPath(import.meta.url)], {
  cwd: dshRepo,
  stdio: 'inherit',
  env: { ...process.env, ARCHIVIST_SMOKE_INNER: '1', ARCHIVIST_BUG_REPORT: '0', ARCHIVIST_SMOKE_WS: workspace },
})
process.exit(child.status ?? 1)
