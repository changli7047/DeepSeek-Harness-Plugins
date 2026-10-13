/**
 * Group 5 — D items and red lines: host self-check, no focus/cursor theft,
 * screenshot retention (`prune`), and proof that the suite never touches the
 * user's real screenshot directories.
 *
 * Red line note (measured by implementer-host): UIA `InvokePattern.Invoke()` on a
 * WPF target pulls that window to the foreground even with WS_EX_NOACTIVATE — that is
 * the provider's own behaviour, so this suite asserts the no-focus-steal property for
 * every *other* background operation and only *records* the click observation.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { HOST_PS1, Host, READY_LINE, ensureDir, runHostOnce, sleep } from '../lib/host.mjs'
import { Inconclusive, cursorGuard } from '../lib/checks.mjs'
import { activatedOf, fixtureIsActive, prunedOf, readActivationLog, savedPath, secondsOfDay, strategyOf } from '../lib/parse.mjs'

const PLUGIN_SHOT = /^screenshot-.*\.png$/i
const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

let pruneState = null

/** A second host whose TEMP points inside the run scratch dir, so the host's own
 *  default screenshot directory is disposable. The real %TEMP%\dsh-windows-tools is
 *  never referenced (v2 §10: it holds the user's 56 real screenshots). */
function pruneHost(ctx) {
  if (pruneState === null) {
    pruneState = (async () => {
      const temp = ensureDir(join(ctx.scratch, 'prune-temp'))
      const host = await Host.start({ env: { ...process.env, TEMP: temp, TMP: temp }, label: 'prune-host' })
      ctx.addCleanup(() => host.stop())
      return { temp, host, dir: null }
    })()
  }
  return pruneState
}

/** Take one screenshot without `path` so the host uses its own default directory,
 *  then remember that directory (derived from the reply, never hard-coded). */
async function defaultShotDir(ctx) {
  const state = await pruneHost(ctx)
  if (state.dir === null) {
    const fixture = await ctx.fixture()
    const out = await state.host.ok({ cmd: 'screenshot', window: fixture.baseTitle })
    const saved = savedPath(out)
    ctx.check.ok(saved !== null, 'the host saved a screenshot to its own default path', out.slice(0, 300))
    state.dir = dirname(saved.path)
  }
  return state
}

function seedPluginScreenshots(dir, count) {
  const names = []
  for (let i = 0; i < count; i++) {
    const name = `screenshot-20000101-${String(i).padStart(6, '0')}-${String(i).padStart(3, '0')}.png`
    writeFileSync(join(dir, name), PNG_HEAD)
    names.push(name)
  }
  return names
}

const matchingCount = (dir) => readdirSync(dir).filter((name) => PLUGIN_SHOT.test(name)).length

/** The body of one top-level PowerShell function, for the v2 §20 static audit. */
function functionBody(source, name) {
  const start = source.indexOf(`function ${name}`)
  if (start < 0) return null
  const rest = source.slice(start)
  const end = rest.indexOf('\nfunction ')
  return end < 0 ? rest : rest.slice(0, end)
}

export default {
  name: 'hygiene',
  cases: [
    {
      id: 'hygiene/host-selfcheck-two-lines',
      title: 'the host banner and a status response are exactly two JSON lines',
      async run(ctx) {
        const run = await runHostOnce('{"cmd":"status"}')
        ctx.check.eq(run.code, 0, 'the one-shot host exits cleanly', run.stderr.slice(0, 300))
        ctx.check.eq(run.lines.length, 2, 'stdout is exactly the ready line plus one response', JSON.stringify(run.lines.slice(0, 4)))
        ctx.check.eq(run.lines[0], READY_LINE, 'the first line is the frozen ready banner')
        const parsed = JSON.parse(run.lines[1])
        ctx.check.eq(parsed.ok, true, 'the status response is ok', run.lines[1].slice(0, 300))
        ctx.check.ok(String(parsed.output).startsWith('screen:'), 'status output starts with the screen summary', String(parsed.output).slice(0, 200))
      },
    },

    {
      id: 'hygiene/background-ops-never-move-the-cursor',
      title: 'find/read/type/winop/screenshot leave the real cursor alone',
      async run(ctx) {
        const fixture = await ctx.fixture()
        const guard = await cursorGuard(ctx, async () => {
          await ctx.host().ok({ cmd: 'find', target: fixture.baseTitle, automationId: fixture.buttonId })
          await ctx.host().ok({ cmd: 'read', target: fixture.baseTitle })
          await ctx.host().ok({ cmd: 'type', window: fixture.baseTitle, element: { automationId: fixture.textBoxId }, text: `cursor-${fixture.tag}` })
          await ctx.host().ok({ cmd: 'winop', target: fixture.baseTitle, action: 'move', x: 210, y: 150 })
          await ctx.host().ok({ cmd: 'screenshot', window: fixture.baseTitle, path: join(ctx.scratch, 'shots', 'hygiene-cursor.png') })
        }, 'the cursor is identical across a full background sequence')
        if (!guard.verified) ctx.log(`cursor check not verifiable: ${guard.reason}`)
      },
    },

    {
      id: 'hygiene/type-element-leg-activations-are-reported',
      title: 'the type element leg asks for no focus, and any activation it causes is reported (v2 §20)',
      async run(ctx) {
        const fixture = await ctx.fixture()

        // (1) Static half of §20: the audited leg must contain no focus API at all. WPF's
        // UIA provider sometimes activates the window inside ValuePattern.SetValue, which
        // the host cannot prevent — but it must never *ask* for the foreground.
        const source = readFileSync(HOST_PS1, 'utf8')
        const body = functionBody(source, 'Invoke-WtElementType')
        ctx.check.ok(body !== null, 'the audited type-element function exists in the host source', 'Invoke-WtElementType not found — update this check if it was renamed')
        if (body !== null) {
          ctx.check.ok(
            !/(SetFocus|SetForegroundWindow|ShowWindow|AttachThreadInput|BringWindowToTop|SetActiveWindow)/.test(body),
            'Invoke-WtElementType contains no focus/activation API',
            body.split(/\r?\n/).filter((line) => /SetFocus|SetForegroundWindow|ShowWindow|AttachThreadInput|BringWindowToTop|SetActiveWindow/.test(line)).join('\n'),
          )
        }

        // (2) Runtime half: read-only / non-activating operations must not activate the
        // window at all. The fixture logs its own IsActive transitions, so this is local
        // truth and does not depend on what the rest of the desktop is doing.
        if (fixtureIsActive(fixture.activatedLog)) {
          throw new Inconclusive('the test window was already in the foreground at case start, so "did this call activate it?" cannot be judged (INCONCLUSIVE, not a pass)')
        }
        const quiet = [
          ['find', { cmd: 'find', target: fixture.baseTitle, automationId: fixture.textBoxId }],
          ['waitfor element', { cmd: 'waitfor', kind: 'element', target: fixture.baseTitle, automationId: fixture.textBoxId, timeoutSeconds: 5 }],
          ['screenshot', { cmd: 'screenshot', window: fixture.baseTitle, path: join(ctx.scratch, 'shots', 'hygiene-focus.png') }],
        ]
        const surprises = []
        for (const [name, request] of quiet) {
          const before = fixtureIsActive(fixture.activatedLog)
          await ctx.host().ok(request, { timeoutMs: 30000 })
          await sleep(500) // the fixture polls IsActive every 200 ms
          if (!before && fixtureIsActive(fixture.activatedLog)) surprises.push(name)
        }
        ctx.check.ok(surprises.length === 0, 'find / wait_for / screenshot never activate the test window', surprises.join(', '))

        // (3) The type element leg may activate the window (platform behaviour, ~1/10 per
        // call). That is accepted — but it must be *reported*. Attribution follows the
        // host's own observation window (v2 §20): the receipt covers
        // [write start, write end + 250 ms], so an activation outside it belongs to nobody
        // and must NOT be counted (round-level attribution produced exactly that false red).
        //
        // Because a single attempt usually misses, the case retries: the positive branch
        // (observed activation ⇒ activated=true) is only *covered* once a hit happens. If
        // 20 attempts all miss, the case is INCONCLUSIVE — never a pass, because the branch
        // that matters was never exercised.
        const attempts = 20
        let coveredAt = null
        const unobservable = []
        for (let attempt = 1; attempt <= attempts; attempt++) {
          if (fixtureIsActive(fixture.activatedLog)) {
            throw new Inconclusive(`the test window was in the foreground before attempt ${String(attempt)}; a fresh activation cannot be judged`)
          }
          const pre = readActivationLog(fixture.activatedLog)
          const t0 = secondsOfDay(Date.now())
          const receipt = await ctx.host().ok({ cmd: 'type', window: fixture.baseTitle, element: { automationId: fixture.textBoxId }, text: `focus-${fixture.tag}-${String(attempt)}` }, { timeoutMs: 30000 })
          const t1 = secondsOfDay(Date.now())
          await sleep(350) // let the fixture's 200 ms polling flush anything it saw
          const fresh = readActivationLog(fixture.activatedLog).slice(pre.length)
          const rolledOver = t1 < t0 // midnight; skip the timestamp alignment rather than mis-attribute
          const inWindow = rolledOver ? [] : fresh.filter((e) => e.active && e.at >= t0 - 0.05 && e.at <= t1 + 0.05)
          const outside = rolledOver ? [] : fresh.filter((e) => e.active && !(e.at >= t0 - 0.05 && e.at <= t1 + 0.05))
          const reported = activatedOf(receipt)

          if (inWindow.length > 0 && !rolledOver) {
            // How long did the scaffold actually hold the foreground? The scaffold hands it
            // straight back (that is the whole point of the self-demotion), which can make
            // the activation shorter than the host's 10 ms sampling interval — then it is
            // physically unobservable, and a miss is not dishonesty.
            const hitIndex = fresh.findIndex((e) => e.active)
            let releaseAt = null
            for (let k = hitIndex + 1; k < fresh.length; k++) {
              if (!fresh[k].active) { releaseAt = fresh[k].at; break }
            }
            const heldMs = releaseAt === null ? null : (releaseAt - fresh[hitIndex].at) * 1000
            if (reported === true) {
              ctx.check.eq(reported, true, 'an activation inside the call\'s observation window is reported as activated=true', String(receipt).slice(0, 400))
              ctx.log(`type element leg attempt ${String(attempt)}: observed=true reported=true (held ≈${heldMs === null ? '?' : heldMs.toFixed(0)} ms) — positive branch covered`)
              coveredAt = attempt
              break
            }
            if (heldMs !== null && heldMs < 15) {
              unobservable.push(`attempt ${String(attempt)}: held ${heldMs.toFixed(0)} ms`)
              continue
            }
            ctx.check.eq(reported, true, 'a reported-able activation is reported as activated=true', `held≈${heldMs === null ? '?' : heldMs.toFixed(0)} ms\n${String(receipt).slice(0, 400)}`)
            coveredAt = attempt
            break
          }
          if (outside.length > 0) ctx.log(`attempt ${String(attempt)}: ${String(outside.length)} activation(s) fell outside the host's observation window (not this call's responsibility)`)
          ctx.check.ok(reported !== true, 'activated is not claimed when nothing was activated inside the window', `attempt ${String(attempt)} inWindow=${String(inWindow.length)} outside=${String(outside.length)}\n${String(receipt).slice(0, 400)}`)
        }
        if (coveredAt === null) {
          throw new Inconclusive(`positive branch not observed in ${String(attempts)} attempts; ${String(unobservable.length)} activation(s) were seen but each lasted under the host's 10 ms sampling interval (${unobservable.slice(0, 3).join('; ')}) so they could not be reported (INCONCLUSIVE, not a pass)`)
        }
      },
    },

    {
      id: 'hygiene/element-click-does-not-steal-focus',
      title: 'the default element click (background-post) does not pull the test window forward',
      async run(ctx) {
        const fixture = await ctx.fixture()
        // v2 §11/§20: background-post must not steal focus. The fixture logs its own
        // IsActive transitions, so this needs no global foreground state.
        if (fixtureIsActive(fixture.activatedLog)) {
          throw new Inconclusive('the test window was already in the foreground before the click, so "did the click activate it?" cannot be judged (INCONCLUSIVE, not a pass)')
        }
        const out = await ctx.host().ok({ cmd: 'mouse', mode: 'click', window: fixture.baseTitle, element: { automationId: fixture.buttonId } })
        await sleep(500)
        const after = fixtureIsActive(fixture.activatedLog)
        ctx.check.eq(strategyOf(out), 'background-post', 'the click really took the background path (no allowForeground)', String(out).slice(0, 300))
        ctx.check.ok(!after, 'the background click did not activate the test window', `activatedBefore=false activatedAfter=${String(after)}`)
      },
    },

    {
      id: 'hygiene/screenshot-prune-keeps-only-plugin-files',
      title: 'prune=true keeps the newest N plugin screenshots and touches nothing else',
      async run(ctx) {
        const state = await defaultShotDir(ctx)
        const seeded = seedPluginScreenshots(state.dir, 25)
        writeFileSync(join(state.dir, 'notes.png'), 'not-ours')
        writeFileSync(join(state.dir, 'keep.txt'), 'not-ours')
        const fixture = await ctx.fixture()
        const out = await state.host.ok({ cmd: 'screenshot', window: fixture.baseTitle, prune: true })
        const saved = savedPath(out)
        ctx.check.ok(saved !== null, 'the pruning screenshot reported geometry', out.slice(0, 300))
        ctx.check.ok(prunedOf(out) !== null, 'the reply reports pruned=<n>', out.slice(0, 300))
        ctx.check.ok(matchingCount(state.dir) <= 20, 'at most 20 plugin-named screenshots survive', `directory ${state.dir}: ${String(matchingCount(state.dir))} matching files of ${String(seeded.length + 2)} total`)
        ctx.check.ok(saved !== null && existsSync(saved.path), 'the newest screenshot is the one kept')
        ctx.check.ok(existsSync(join(state.dir, 'notes.png')), 'a .png that is not plugin-named is not deleted')
        ctx.check.ok(existsSync(join(state.dir, 'keep.txt')), 'an unrelated file is not deleted')
      },
    },

    {
      id: 'hygiene/screenshot-pruneKeep-overrides-the-default',
      title: 'pruneKeep bounds how many plugin screenshots survive',
      async run(ctx) {
        const state = await defaultShotDir(ctx)
        seedPluginScreenshots(state.dir, 10)
        const fixture = await ctx.fixture()
        const out = await state.host.ok({ cmd: 'screenshot', window: fixture.baseTitle, prune: true, pruneKeep: 3 })
        ctx.check.ok(savedPath(out) !== null, 'the pruning screenshot reported geometry', out.slice(0, 300))
        ctx.check.ok(matchingCount(state.dir) <= 3, 'pruneKeep=3 leaves at most three plugin screenshots', `directory ${state.dir}: ${String(matchingCount(state.dir))} matching files`)
      },
    },

    {
      id: 'hygiene/screenshot-explicit-path-is-never-pruned',
      title: 'an explicitly requested path is not a pruning target',
      async run(ctx) {
        const dir = ensureDir(join(ctx.scratch, 'explicit-dir'))
        const seeded = seedPluginScreenshots(dir, 25)
        const fixture = await ctx.fixture()
        const path = join(dir, 'explicit.png')
        const out = await ctx.host().ok({ cmd: 'screenshot', path, window: fixture.baseTitle })
        ctx.check.ok(savedPath(out) !== null, 'the explicit-path screenshot reported geometry', out.slice(0, 300))
        const missing = seeded.filter((name) => !existsSync(join(dir, name)))
        ctx.check.eq(missing.length, 0, 'nothing in a caller-specified directory was deleted', JSON.stringify(missing.slice(0, 5)))
      },
    },

    {
      id: 'hygiene/user-screenshot-dirs-untouched',
      title: 'the suite never deleted a pre-existing file from the real temp dirs',
      async run(ctx) {
        for (const entry of ctx.tempBaseline) {
          const missing = entry.files.filter((name) => !existsSync(join(entry.dir, name)))
          ctx.check.eq(missing.length, 0, `no pre-existing file disappeared from ${entry.dir}`, JSON.stringify(missing.slice(0, 5)))
        }
      },
    },
  ],
}
