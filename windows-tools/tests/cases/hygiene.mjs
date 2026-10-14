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
          // Element typing on WPF is an explicit error under v3 R6, so the allowed background
          // input path here is the window-level character stream (`type` with `window` only).
          await ctx.host().ok({ cmd: 'type', window: fixture.baseTitle, text: `cursor-${fixture.tag}` })
          await ctx.host().ok({ cmd: 'winop', target: fixture.baseTitle, action: 'move', x: 210, y: 150 })
          await ctx.host().ok({ cmd: 'screenshot', window: fixture.baseTitle, path: join(ctx.scratch, 'shots', 'hygiene-cursor.png') })
        }, 'the cursor is identical across a full background sequence')
        if (!guard.verified) ctx.log(`cursor check not verifiable: ${guard.reason}`)
      },
    },

    {
      id: 'hygiene/element-typing-has-no-value-pattern-leg-and-reports-activations',
      title: 'v3 R6: the element-typing chain has no ValuePattern leg, asks for no focus, and still reports any activation',
      async run(ctx) {
        const fixture = await ctx.fixture()

        // (1) Static: the ValuePattern leg is what could activate a WPF window, so it must
        // be gone from the source; and the function must still contain no focus API.
        const source = readFileSync(HOST_PS1, 'utf8')
        const body = functionBody(source, 'Invoke-WtElementType')
        ctx.check.ok(body !== null, 'the audited element-typing function exists in the host source', 'Invoke-WtElementType not found — if it was renamed, update this audit (it must not silently pass)')
        if (body !== null) {
          // Code usage, not prose: the function may *explain* that the ValuePattern leg was
          // removed (T11's refusal message does exactly that), but it must not call it. So
          // the audit looks for call sites and for the removed strategy literal.
          for (const token of ['TryGetCurrentPattern', 'SetValue(', 'uia-value-pattern']) {
            ctx.check.ok(!body.includes(token), `Invoke-WtElementType never uses ${token}`, `${token} still appears in the audited function`)
          }
          ctx.check.ok(
            !/(SetFocus|SetForegroundWindow|SetActiveWindow|ShowWindow|AttachThreadInput|BringWindowToTop|SwitchToThisWindow)/.test(body),
            'Invoke-WtElementType contains no focus/activation API',
            body.split(/\r?\n/).filter((line) => /SetFocus|SetForegroundWindow|SetActiveWindow|ShowWindow|AttachThreadInput|BringWindowToTop|SwitchToThisWindow/.test(line)).join('\n'),
          )
        }

        // (2) Runtime: read-only / non-activating operations must not activate the window.
        // The fixture logs its own system-foreground transitions, so this is local truth.
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
          await sleep(500) // the fixture polls the foreground every 200 ms
          if (!before && fixtureIsActive(fixture.activatedLog)) surprises.push(name)
        }
        ctx.check.ok(surprises.length === 0, 'find / wait_for / screenshot never activate the test window', surprises.join(', '))

        // (3) The remaining element-typing legs (wm-settext / keystream) have no obligation to
        // report an activation — but if one is observed it must still be reported honestly
        // (v3 §3). The Win32 fixture is the target here, because element typing on WPF is now
        // an explicit error (asserted in cases/strict-background.mjs). Both directions are
        // judged whenever the observation is possible, so this never needs INCONCLUSIVE:
        // these legs are not required to activate anything.
        const win32 = await ctx.fixtureWin32()
        let observed = 0
        const mismatches = []
        for (let attempt = 1; attempt <= 5; attempt++) {
          if (fixtureIsActive(win32.activatedLog)) {
            ctx.log(`attempt ${String(attempt)}: the Win32 fixture is already in the foreground; skipping this attempt`)
            continue
          }
          const pre = readActivationLog(win32.activatedLog)
          const t0 = secondsOfDay(Date.now())
          const receipt = await ctx.host().ok(
            // Classic Win32 children expose their *content* as the UIA name, so the Edit is
            // selected by className here (same reason as in the strict group).
            { cmd: 'type', window: win32.baseTitle, element: { className: 'EDIT' }, text: `act-${win32.tag}-${String(attempt)}` },
            { timeoutMs: 30000 },
          )
          const t1 = secondsOfDay(Date.now())
          await sleep(350)
          const fresh = readActivationLog(win32.activatedLog).slice(pre.length)
          const rolledOver = t1 < t0
          const inWindow = rolledOver ? [] : fresh.filter((e) => e.active && e.at >= t0 - 0.05 && e.at <= t1 + 0.05)
          const reported = activatedOf(receipt)
          if (inWindow.length > 0) {
            observed++
            if (reported !== true) mismatches.push(`attempt ${String(attempt)}: an activation happened inside the window but was not reported`)
          } else if (reported === true && !rolledOver) {
            mismatches.push(`attempt ${String(attempt)}: activated=true was claimed although nothing was activated inside the window`)
          }
        }
        ctx.log(`element typing on Win32: ${String(observed)} activation(s) observed across 5 attempts, each must be reported`)
        ctx.check.eq(mismatches.length, 0, 'observed activations are reported, and no activation is claimed when none happened', mismatches.join('\n'))
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
