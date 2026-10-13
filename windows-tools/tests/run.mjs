#!/usr/bin/env node
/**
 * windows-tools regression suite.
 *
 *   node windows-tools/tests/run.mjs
 *
 * Exit code 0 = every case passed (SKIPs are allowed, FAILs are not).
 * Exit code 1 = at least one case failed; each failure prints the exact clause that
 * broke plus the host's verbatim reply.
 *
 * Red lines this suite obeys (and checks):
 *   * background mode only — no real mouse movement, no foreground key/mouse input;
 *   * the one test window is created by the suite itself (WPF, never activated) and is
 *     closed when the run ends; no user application is ever used as a target;
 *   * the clip board is never touched;
 *   * only the run's own scratch directory (and the plugin's own disposable screenshot
 *     directory under a redirected TEMP) is written.
 */

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Check, CheckFail, Inconclusive, Skip } from './lib/checks.mjs'
import {
  HOST_PS1, WT_DIR, Host, cleanScratch, makeScratch, sha256File, startFixture,
} from './lib/host.mjs'
import { activationStats, secondsOfDay } from './lib/parse.mjs'

import basic from './cases/basic.mjs'
import bElement from './cases/b-element.mjs'
import cWindow from './cases/c-window.mjs'
import errors from './cases/errors.mjs'
import hygiene from './cases/hygiene.mjs'
import build from './cases/build.mjs'
import dsh from './cases/dsh.mjs'

const GROUPS = [basic, bElement, cWindow, errors, hygiene, build, dsh].filter((group) => {
  const only = process.env.WT_ONLY
  if (only === undefined || only.trim() === '') return true
  return only.split(',').map((name) => name.trim()).includes(group.name)
})

function tempBaseline() {
  const temp = process.env.TEMP ?? process.env.TMP ?? ''
  if (temp === '') return []
  const dirs = [join(temp, 'dsh-windows-tools'), join(temp, 'opencode-windows-tools')]
  return dirs.map((dir) => ({ dir, files: existsSync(dir) ? readdirSync(dir) : [] }))
}

const scratch = makeScratch()
const cleanups = []
let mainHost = null
let fixtureOne = null
let fixtureTwo = null
let fixtureWin32P = null
const tagSeed = Date.now().toString(36).slice(-5)

const ctx = {
  scratch,
  tempBaseline: tempBaseline(),
  check: null,
  log(message) {
    process.stdout.write(`        · ${message}\n`)
  },
  addCleanup(fn) {
    cleanups.push(fn)
  },
  host() {
    const get = () => {
      if (mainHost === null) mainHost = Host.start({ label: 'main' })
      return mainHost
    }
    // A thin lazy proxy: cases call ctx.host().ok(...) / .err(...) without awaiting the
    // process start-up first, and every call resolves the same long-lived host.
    return {
      ok: async (request, options) => (await get()).ok(request, options),
      err: async (request, options) => (await get()).err(request, options),
      request: async (request, options) => (await get()).request(request, options),
    }
  },
  fixture() {
    if (fixtureOne === null) fixtureOne = startFixture({ tag: `${tagSeed}a`, scratch, lifetimeSeconds: 900 })
    return fixtureOne
  },
  fixture2() {
    if (fixtureTwo === null) fixtureTwo = startFixture({ tag: `${tagSeed}b`, scratch, lifetimeSeconds: 900, y: 360 })
    return fixtureTwo
  },
  fixtureWin32() {
    if (fixtureWin32P === null) fixtureWin32P = startFixture({ tag: `${tagSeed}w`, scratch, lifetimeSeconds: 900, y: 400, kind: 'win32' })
    return fixtureWin32P
  },
}

function indent(text, pad) {
  return String(text).split('\n').map((line) => `${' '.repeat(pad)}${line}`).join('\n')
}

function clip(text, max = 1200) {
  const value = String(text ?? '')
  return value.length <= max ? value : `${value.slice(0, max)}\n… (${String(value.length - max)} more chars)`
}

const results = []
const warnedDead = new Set()

console.log('windows-tools regression suite')
console.log(`  repo:    ${WT_DIR}`)
console.log(`  host:    ${HOST_PS1}`)
console.log(`  host sha256: ${sha256File(HOST_PS1).slice(0, 16)}…`)
console.log(`  scratch: ${scratch}`)
console.log(`  DSH_REPO: ${process.env.DSH_REPO ?? '(unset — the dsh load smoke will SKIP)'}`)

for (const group of GROUPS) {
  console.log(`\n── ${group.name} (${String(group.cases.length)} cases) ──`)
  for (const testCase of group.cases) {
    // Watchdog: a fixture whose process died takes its window with it, and every later
    // case would fail with "no window matches" — say so explicitly instead. Only
    // fixture-1 is watched: fixture-2 is *supposed* to exit when window/winop-close
    // closes it, and its descriptor is exactly what the windowgone case checks against.
    if (fixtureOne !== null) {
      const fixture = await fixtureOne.catch(() => null)
      if (fixture !== null && fixture.dead() && !warnedDead.has('fixture-1')) {
        warnedDead.add('fixture-1')
        console.log(`  WARN  fixture-1 (${fixture.baseTitle}) is gone: ${fixture.deadReason()}`)
        fixtureOne = null
      }
    }
    const check = new Check()
    const started = Date.now()
    const runCtx = { ...ctx, check }
    try {
      await testCase.run(runCtx)
      results.push({ group: group.name, id: testCase.id, status: 'pass', ms: Date.now() - started })
      console.log(`  PASS  ${testCase.id}`)
    } catch (error) {
      const ms = Date.now() - started
      if (error instanceof Skip) {
        results.push({ group: group.name, id: testCase.id, status: 'skip', ms, reason: error.message })
        console.log(`  SKIP  ${testCase.id} — ${error.message}`)
        continue
      }
      if (error instanceof Inconclusive) {
        // A case whose precondition was not met judged nothing — it must not be reported
        // as a pass, and the summary must show it as its own class.
        results.push({ group: group.name, id: testCase.id, status: 'inconclusive', ms, reason: error.message })
        console.log(`  INCONC ${testCase.id} — ${error.message}`)
        continue
      }
      const detail = error instanceof CheckFail
        ? `✗ ${error.label}${error.detail === '' ? '' : `\n${indent(error.detail, 2)}`}`
        : `${error.name}: ${error.message}`
      results.push({ group: group.name, id: testCase.id, status: 'fail', ms, detail, passedBefore: check.passed.length })
      console.log(`  FAIL  ${testCase.id}  (${String(ms)} ms)`)
      console.log(indent(clip(detail), 8))
    }
  }
}

console.log('\n── test-window foreground accounting ──')
// This is the number the user is owed: how long the *test scaffold* ever held the system
// foreground. The fixtures hand it straight back (they only ever hold it because a target
// application's UIA provider activated them), and each one logs its own IsActive
// transitions, so the measurement does not depend on the desktop state.
const fixtureStates = []
for (const [name, pending] of [['fixture-1', fixtureOne], ['fixture-2', fixtureTwo], ['fixture-win32', fixtureWin32P]]) {
  if (pending === null) continue
  const fixture = await pending.catch(() => null)
  if (fixture === null || fixture.activatedLog === undefined) continue
  const alive = !fixture.dead()
  // An activation that was never released only counts while the window still exists: a
  // fixture closed by window/winop-close cannot hold anybody's foreground afterwards, and
  // measuring it up to "now" would report a phantom multi-second occupancy.
  const stats = activationStats(fixture.activatedLog, alive ? secondsOfDay(Date.now()) : null)
  fixtureStates.push({ name, alive, stats })
}
if (fixtureStates.length === 0) {
  console.log('  no fixture ran in this invocation')
} else {
  let activations = 0
  let longest = 0
  let longestName = null
  const holding = []
  const unreleasedButGone = []
  for (const state of fixtureStates) {
    activations += state.stats.activations
    if (state.stats.longest > longest) {
      longest = state.stats.longest
      longestName = state.name
    }
    if (state.stats.holding) {
      if (state.alive) holding.push(state.name)
      else unreleasedButGone.push(state.name)
    }
  }
  console.log(`  longest single foreground occupancy: ${longest.toFixed(3)} s (${String(activations)} activation(s) across ${String(fixtureStates.length)} fixture(s); longest in ${String(longestName)})`)
  for (const state of fixtureStates) {
    console.log(`    ${state.name}: ${String(state.stats.activations)} activation(s), longest ${state.stats.longest.toFixed(3)} s, holding=${String(state.stats.holding)}${state.alive ? '' : ' (fixture had already exited)'}`)
  }
  if (unreleasedButGone.length > 0) console.log(`  NOTE  ${unreleasedButGone.join(', ')} logged an activation that was never released, but the fixture (and its window) had already exited, so it is not counted`)
  if (holding.length > 0) console.log(`  WARNING  still holding the foreground when the run ended: ${holding.join(', ')}`)
  if (longest >= 1) console.log(`  WARNING  a single occupancy reached ${longest.toFixed(3)} s (target: < 1 s)`)
}

console.log('\n── cleanup ──')
for (const [name, pending] of [['fixture-1', fixtureOne], ['fixture-2', fixtureTwo], ['fixture-win32', fixtureWin32P]]) {
  if (pending === null) continue
  try {
    const fixture = await pending
    const wasDead = fixture.dead()
    await fixture.close()
    console.log(`  closed ${name} (${fixture.baseTitle})${wasDead ? ` — NOTE: the process had already exited: ${fixture.deadReason()}` : ''}`)
  } catch (error) {
    console.log(`  could not close ${name}: ${error.message}`)
  }
}
for (const cleanup of cleanups.splice(0)) {
  try {
    await cleanup()
  } catch (error) {
    console.log(`  cleanup failed: ${error.message}`)
  }
}
if (mainHost !== null) {
  try {
    const host = await mainHost
    await host.stop()
    console.log('  stopped the main host')
  } catch (error) {
    console.log(`  could not stop the main host: ${error.message}`)
  }
}

const passed = results.filter((r) => r.status === 'pass').length
const skipped = results.filter((r) => r.status === 'skip')
const inconclusive = results.filter((r) => r.status === 'inconclusive')
const failed = results.filter((r) => r.status === 'fail')

console.log('\n── summary ──')
console.log(`  ${String(passed)} passed, ${String(failed.length)} failed, ${String(skipped.length)} skipped, ${String(inconclusive.length)} inconclusive`)
for (const item of skipped) console.log(`  SKIP    ${item.id} — ${item.reason}`)
for (const item of inconclusive) console.log(`  INCONC  ${item.id} — ${item.reason}`)
if (failed.length > 0) {
  console.log('\n  failures:')
  for (const item of failed) {
    const first = String(item.detail).split('\n').find((line) => line.trim() !== '') ?? ''
    console.log(`    ${item.id} — ${first.trim()}`)
  }
}
if (failed.length > 0 || inconclusive.length > 0) {
  console.log(`\n  scratch kept for inspection: ${scratch}`)
} else {
  cleanScratch(scratch)
  console.log('  scratch removed (all green)')
}

// 0 = every case judged and passed; 1 = at least one failure; 2 = nothing failed but at
// least one judgement could not be exercised (never reported as green on its own).
process.exitCode = failed.length > 0 ? 1 : (inconclusive.length > 0 ? 2 : 0)
