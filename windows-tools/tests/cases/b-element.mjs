/**
 * Group 2 — element location (v2 §1/§2/§5/§8): find, element click, element type,
 * read-back, strategy/verified reporting.
 *
 * The fixture window is created by tests/lib/fixture.ps1 with three controls whose
 * accessible names / automation ids are derived from the run tag:
 *   txtInput (Edit,  name Edit-<tag>), btnGo (Button, name Go-<tag>), lblNote (Text, name Note-<tag>).
 * A background click appends "+c" to the text box and bumps "|clicks=N" in the title.
 */

import { existsSync, readFileSync, rmSync } from 'node:fs'
import { sleep } from '../lib/host.mjs'
import { cursorGuard } from '../lib/checks.mjs'
import {
  STRATEGY_VALUES, findLineWith, parseFindLines, strategyOf, verifiedOf, windowLineFor,
} from '../lib/parse.mjs'

/** The `point hit: ...` description from a click receipt ('' when absent). */
function hitDescription(receipt) {
  const m = /point hit:\s*(.+?)\s*\[strategy=/.exec(String(receipt ?? ''))
  return m === null ? '' : m[1]
}

/** Delivery counters published by the Win32 fixture's counting Panel. */
function readCounters(path) {
  if (!existsSync(path)) return { down: 0, up: 0 }
  const m = /down=(\d+)\s+up=(\d+)/.exec(readFileSync(path, 'utf8'))
  return m === null ? { down: 0, up: 0 } : { down: Number(m[1]), up: Number(m[2]) }
}

async function waitForMarker(path, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(path)) return true
    await sleep(150)
  }
  return false
}

/** The canonical wire form for an element click (implementer-host: `{cmd:'click'}` is
 *  only an alias of this). Centralised so every click case drives the documented one. */
function clickRequest(fixture, element, extra = {}) {
  return { cmd: 'mouse', mode: 'click', window: fixture.baseTitle, element, ...extra }
}

async function clickCount(ctx, baseTitle) {
  const out = await ctx.host().ok({ cmd: 'status' })
  const line = windowLineFor(out, baseTitle)
  const m = line === null ? null : /\|clicks=(\d+)/.exec(line.title)
  return m === null ? 0 : Number(m[1])
}

export default {
  name: 'element',
  cases: [
    {
      id: 'element/find-by-name',
      title: 'find locates a control by accessible name',
      async run(ctx) {
        const fixture = await ctx.fixture()
        const out = await ctx.host().ok({ cmd: 'find', target: fixture.baseTitle, name: fixture.buttonName })
        const hit = findLineWith(out, (l) => l.automationId === fixture.buttonId)
        ctx.check.ok(hit !== null, `find by name "${fixture.buttonName}" hits the button`, out.slice(0, 500))
        ctx.check.contains(hit.type, 'Button', 'the hit is reported as a Button', hit.raw)
      },
    },

    {
      id: 'element/find-by-type-is-case-insensitive',
      title: 'find type matching is case-insensitive',
      async run(ctx) {
        const fixture = await ctx.fixture()
        const out = await ctx.host().ok({ cmd: 'find', target: fixture.baseTitle, type: 'edit' })
        const hit = findLineWith(out, (l) => l.automationId === fixture.textBoxId)
        ctx.check.ok(hit !== null, 'lowercase type "edit" hits the text box', out.slice(0, 500))
        ctx.check.eq(hit.type, 'Edit', 'the hit is reported with the short UIA type name')
      },
    },

    {
      id: 'element/find-by-type-tolerates-controltype-prefix',
      title: 'find type accepts a ControlType. prefix',
      async run(ctx) {
        const fixture = await ctx.fixture()
        const out = await ctx.host().ok({ cmd: 'find', target: fixture.baseTitle, type: 'ControlType.Button' })
        const hit = findLineWith(out, (l) => l.automationId === fixture.buttonId)
        ctx.check.ok(hit !== null, 'type "ControlType.Button" hits the button', out.slice(0, 500))
      },
    },

    {
      id: 'element/find-by-automationId',
      title: 'find locates a static label by automationId (no "interesting type" whitelist)',
      async run(ctx) {
        const fixture = await ctx.fixture()
        const out = await ctx.host().ok({ cmd: 'find', target: fixture.baseTitle, automationId: fixture.labelId })
        const hit = findLineWith(out, (l) => l.automationId === fixture.labelId)
        ctx.check.ok(hit !== null, `find by automationId "${fixture.labelId}" hits the label`, out.slice(0, 500))
        ctx.check.eq(hit.type, 'Text', 'the label is reported as a Text control')
      },
    },

    {
      id: 'element/find-no-hit-is-not-an-error',
      title: 'find with no match returns ok with the documented message',
      async run(ctx) {
        const fixture = await ctx.fixture()
        const out = await ctx.host().ok({ cmd: 'find', target: fixture.baseTitle, automationId: 'wt-no-such-automation-id' })
        ctx.check.eq(out.trim(), 'no element matched', 'a miss is reported as "no element matched", not as an error', out.slice(0, 200))
      },
    },

    {
      id: 'element/find-limit-says-when-it-truncated',
      title: 'find announces truncation instead of pretending the list is complete',
      async run(ctx) {
        const fixture = await ctx.fixture()
        const out = await ctx.host().ok({ cmd: 'find', target: fixture.baseTitle, limit: 1 })
        const lines = parseFindLines(out)
        ctx.check.eq(lines.length, 1, 'limit=1 returns exactly one element line', out.slice(0, 500))
        ctx.check.match(out, /truncat/i, 'the output says the list was truncated', out.slice(0, 500))
      },
    },

    {
      id: 'element/click-by-automationId',
      title: 'element click posts to the named element and reports verified honestly',
      async run(ctx) {
        const fixture = await ctx.fixture()
        const before = await clickCount(ctx, fixture.baseTitle)
        // No allowForeground: v2 §11 fixes the default element-click path to
        // background-post, which must not take the foreground.
        let response
        const guard = await cursorGuard(ctx, async () => {
          response = await ctx.host().ok(clickRequest(fixture, { automationId: fixture.buttonId }))
        }, 'the background click did not move the real cursor')
        if (!guard.verified) ctx.log(`cursor check not verifiable: ${guard.reason}`)
        ctx.check.eq(strategyOf(response), 'background-post', 'the default element click uses the background path', response.slice(0, 300))
        ctx.check.contains(response, `automationId=${fixture.buttonId}`, 'the receipt names the element that was clicked', response.slice(0, 400))

        // v2 §5/§11 define click's `verified` as "the message was delivered", not "the
        // application reacted", and background-post provably cannot drive WPF's routed
        // input (windows-tools/README.md 限制节: 8-variant ablation — no synthetic mouse
        // message reaches a WPF control; only InvokePattern does, and that needs
        // allowForeground, which this suite never sends). So the property this case holds
        // the implementation to is consistency in *both* directions: verified must match
        // what is actually observable, and the receipt must not claim an effect that did
        // not happen (the reported W6 failure mode).
        const after = await clickCount(ctx, fixture.baseTitle)
        const text = await ctx.host().ok({ cmd: 'read', target: fixture.baseTitle })
        const effectObserved = after === before + 1 && text.includes('+c')
        ctx.log(`the fixture button handler ran: ${String(effectObserved)} (on WPF, background-post is not expected to reach it)`)
        ctx.check.eq(verifiedOf(response), effectObserved, 'verified agrees with whether the application actually reacted', `verified=${String(verifiedOf(response))} effect=${String(effectObserved)}\n${response.slice(0, 400)}`)
      },
    },

    {
      id: 'element/click-by-filtered-index',
      title: 'element index selects the Nth match of the same selector',
      async run(ctx) {
        const fixture = await ctx.fixture()
        // Deliberately an Edit, not a Button: a WPF window's caption buttons
        // (Minimize/Maximize/Close) are `Button` elements too, so `type=Button, index=0`
        // hit the window chrome instead of the fixture button (observed: it minimized the
        // window and cascaded into every later case). The only Edit in this window is the
        // fixture text box, so index 0 must resolve to it.
        const out = await ctx.host().ok(clickRequest(fixture, { type: 'Edit', index: 0 }))
        ctx.check.contains(out, `automationId=${fixture.textBoxId}`, 'index 0 of type=Edit resolves to the fixture text box', out.slice(0, 400))
        ctx.check.eq(strategyOf(out), 'background-post', 'the indexed element click used the background path', out.slice(0, 300))
        const line = windowLineFor(await ctx.host().ok({ cmd: 'status' }), fixture.baseTitle)
        ctx.check.ok(line !== null && line.state === 'normal', 'the indexed click left the window in its normal state', line === null ? 'window not listed' : line.raw)
      },
    },

    {
      id: 'element/click-index-only-errors',
      title: 'an index-only element selector is refused',
      async run(ctx) {
        const fixture = await ctx.fixture()
        await ctx.check.fails(
          () => ctx.host().ok(clickRequest(fixture, { index: 0 })),
          'element with only an index fails (ambiguous selector)',
        )
      },
    },

    {
      id: 'element/click-requires-window',
      title: 'element click without a target window is refused',
      async run(ctx) {
        await ctx.check.fails(
          () => ctx.host().ok({ cmd: 'mouse', mode: 'click', element: { automationId: 'btnGo' } }),
          'element click without window fails',
        )
      },
    },

    {
      id: 'element/click-no-hit-errors',
      title: 'element click with no match is an error, not a silent no-op',
      async run(ctx) {
        const fixture = await ctx.fixture()
        await ctx.check.fails(
          () => ctx.host().ok(clickRequest(fixture, { automationId: 'wt-no-such-automation-id' })),
          'element click that matches nothing fails',
        )
      },
    },

    {
      id: 'element/type-then-read-roundtrip',
      title: 'element type reaches the control and can be read back',
      async run(ctx) {
        const fixture = await ctx.fixture()
        const text = `typed-${fixture.tag}`
        const out = await ctx.host().ok({ cmd: 'type', window: fixture.baseTitle, element: { automationId: fixture.textBoxId }, text })
        ctx.check.ok(STRATEGY_VALUES.includes(strategyOf(out)), `type reports a documented strategy (got ${String(strategyOf(out))})`, out.slice(0, 300))
        ctx.check.ok(verifiedOf(out) !== null, 'type reports a verified flag', out.slice(0, 300))
        const readBack = await ctx.host().ok({ cmd: 'read', target: fixture.baseTitle })
        ctx.check.contains(readBack, text, 'read returns the typed text', JSON.stringify(readBack.slice(0, 300)))
      },
    },

    {
      id: 'element/type-verified-matches-readback',
      title: 'type does not claim verified=true when the text is not readable',
      async run(ctx) {
        const fixture = await ctx.fixture()
        const text = `verify-${fixture.tag}`
        const out = await ctx.host().ok({ cmd: 'type', window: fixture.baseTitle, element: { automationId: fixture.textBoxId }, text })
        const verified = verifiedOf(out)
        const readBack = await ctx.host().ok({ cmd: 'read', target: fixture.baseTitle })
        const present = readBack.includes(text)
        ctx.check.eq(verified, present, 'verified reflects what read() can actually see', `verified=${String(verified)} readable=${String(present)}\n${out.slice(0, 300)}`)
      },
    },

    {
      id: 'element/type-prefers-value-pattern-on-wpf',
      title: 'element type uses the first available leg of the documented chain (WPF has ValuePattern)',
      async run(ctx) {
        const fixture = await ctx.fixture()
        const out = await ctx.host().ok({ cmd: 'type', window: fixture.baseTitle, element: { automationId: fixture.textBoxId }, text: `chain-${fixture.tag}` })
        ctx.check.eq(strategyOf(out), 'uia-value-pattern', 'the WPF fixture is typed through ValuePattern, the first documented leg', out.slice(0, 300))
      },
    },

    {
      id: 'element/click-delivers-to-a-win32-control',
      title: 'a background element click really delivers its mouse messages to a classic Win32 control',
      async run(ctx) {
        const fixture = await ctx.fixtureWin32()
        // Effect channel: a custom Panel whose own WndProc counts WM_LBUTTONDOWN/WM_LBUTTONUP.
        // It reflects delivery only — which is the claim being tested — and does not depend
        // on where the real cursor happens to be (see the Button case below).
        const baseline = readCounters(fixture.counterPath)
        const out = await ctx.host().ok({ cmd: 'mouse', mode: 'click', window: fixture.baseTitle, element: { name: fixture.probeName } })
        ctx.check.eq(strategyOf(out), 'background-post', 'the element click used the background path', out.slice(0, 300))
        ctx.check.contains(out, fixture.probeName, 'the receipt names the element that received the click', out.slice(0, 400))

        let seen = null
        const deadline = Date.now() + 8000
        while (Date.now() < deadline) {
          const counters = readCounters(fixture.counterPath)
          if (counters !== null && counters.down > baseline.down && counters.up > baseline.up) { seen = counters; break }
          await sleep(150)
        }
        ctx.check.ok(
          seen !== null,
          'the control received WM_LBUTTONDOWN and WM_LBUTTONUP (delivery, not cursor position)',
          `counters before=${JSON.stringify(baseline)} after=${JSON.stringify(readCounters(fixture.counterPath))}\nreceipt: ${out.slice(0, 400)}`,
        )
      },
    },

    {
      id: 'element/click-on-a-winforms-button-is-a-platform-detail',
      title: 'a WinForms Button decides Click from the real cursor position (documented platform detail)',
      async run(ctx) {
        const fixture = await ctx.fixtureWin32()
        rmSync(fixture.markerPath, { force: true })
        const out = await ctx.host().ok({ cmd: 'mouse', mode: 'click', window: fixture.baseTitle, element: { name: fixture.buttonName } })
        // What the suite holds the plugin to here: the click went out on the background path
        // and the host matched and reported the right element.
        ctx.check.eq(strategyOf(out), 'background-post', 'the element click used the background path', out.slice(0, 300))
        ctx.check.contains(out, 'automationId=', 'the receipt reports the matched element', out.slice(0, 400))
        // Deliberately NOT asserted: whether the button's Click handler ran. WinForms' Button
        // decides Click on mouse-up by testing Control.MousePosition (the REAL cursor)
        // against its own rectangle, so a posted click only fires when the user's pointer
        // happens to be over the control (measured 0/6 with the cursor elsewhere). Making it
        // fire would mean moving the user's mouse, which is forbidden here — delivery is
        // asserted by element/click-delivers-to-a-win32-control instead.
        const clicked = await waitForMarker(fixture.markerPath, 2500)
        ctx.log(`WinForms Button.Click fired: ${String(clicked)} (depends on the real cursor position; observed, not asserted)`)
      },
    },

    {
      id: 'element/find-works-on-a-classic-win32-window',
      title: 'find locates a Win32 child control by name and className',
      async run(ctx) {
        const fixture = await ctx.fixtureWin32()
        const byName = await ctx.host().ok({ cmd: 'find', target: fixture.baseTitle, name: fixture.buttonName })
        ctx.check.contains(byName, 'rect=', 'find by name returns element lines for a Win32 child control', byName.slice(0, 400))
        // Win32 children are exposed through the default HWND provider: ControlType is
        // Pane and the AutomationId is the decimal handle, so className/name are the
        // usable selectors there (windows-tools/README.md 限制节).
        const byClass = await ctx.host().ok({ cmd: 'find', target: fixture.baseTitle, className: 'BUTTON' })
        ctx.check.contains(byClass, 'rect=', 'find by className reaches the same control', byClass.slice(0, 400))
      },
    },

    {
      id: 'element/click-strategy-and-verified-reported',
      title: 'click reports both strategy and verified',
      async run(ctx) {
        const fixture = await ctx.fixture()
        const out = await ctx.host().ok(clickRequest(fixture, { automationId: fixture.buttonId }))
        const strategy = strategyOf(out)
        ctx.check.ok(STRATEGY_VALUES.includes(strategy), 'click strategy is one of the documented tokens', out.slice(0, 300))
        ctx.check.ok(verifiedOf(out) !== null, 'click reports a verified flag', out.slice(0, 300))
      },
    },

    {
      id: 'element/read-target-window-text',
      title: 'read returns readable window text instead of failing on the label',
      async run(ctx) {
        const fixture = await ctx.fixture()
        await sleep(100)
        // The editable control is the only Document/Edit in the window, so this is the
        // same text source wait_for kind=text must use (v2 §3). Earlier cases may have
        // replaced or appended to the seed, so assert on the run tag, not the seed.
        const out = await ctx.host().ok({ cmd: 'read', target: fixture.baseTitle })
        ctx.check.contains(out, fixture.tag, 'read returns the text box contents', JSON.stringify(out.slice(0, 300)))
      },
    },

    {
      id: 'element/read-element-text',
      title: 'read accepts an element selector (target required)',
      async run(ctx) {
        const fixture = await ctx.fixture()
        const out = await ctx.host().ok({ cmd: 'read', target: fixture.baseTitle, element: { automationId: fixture.textBoxId } })
        ctx.check.contains(out, fixture.tag, 'read with an element selector returns that control text', JSON.stringify(out.slice(0, 300)))
      },
    },

    {
      id: 'element/read-element-requires-target',
      title: 'read with an element but no target is refused',
      async run(ctx) {
        await ctx.check.fails(
          () => ctx.host().ok({ cmd: 'read', element: { automationId: 'txtInput' } }),
          'read with element but no target fails',
        )
      },
    },

    {
      id: 'element/read-focused-control',
      title: 'read without target/element reads the focused control and does not fail',
      async run(ctx) {
        const out = await ctx.host().ok({ cmd: 'read' })
        ctx.check.ok(out.trim().length > 0, 'read with no selector returns a non-empty explanation or text', JSON.stringify(out.slice(0, 300)))
      },
    },
  ],
}
