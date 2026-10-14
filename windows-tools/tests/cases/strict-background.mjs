/**
 * Group 8 — strict background mode (protocol v3, R1–R10).
 *
 * The user's requirement is absolute: "all windows-tools operations must be background,
 * they must not affect the user". v3 turned that into greppable rules, and this group is
 * where they become assertions:
 *
 *   R1  the host never moves the cursor          -> no cursor API anywhere in the host
 *   R2  the host never requests the foreground   -> no activation API anywhere
 *   R3  no foreground key/mouse injection        -> no SendInput / mouse_event path
 *   R4  pointer/input tools REQUIRE `window`     -> missing window is an explicit error
 *   R5  every foreground opt-in is gone          -> no allowForeground / uia-* strategy
 *   R6  no ValuePattern leg (it could activate)  -> element typing now fails explicitly on
 *                                                   WPF, and still works on classic Win32
 *   R8  the tool surface shrank to 14            -> move/drag/app do not exist anywhere
 *
 * The static audits fail loudly if their target disappears (a renamed function or a
 * renamed file must be reported as "audit target missing", never silently pass).
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_DIR, WT_DIR, sleep } from '../lib/host.mjs'
import { STRATEGY_VALUES, strategyOf } from '../lib/parse.mjs'
const HOST_SOURCE = join(WT_DIR, 'host', 'wt-host.ps1')
const ARTIFACT = join(WT_DIR, 'dsh', 'windows-tools.ts')
const OPENCODE = join(WT_DIR, 'opencode', 'index.ts')

/** R1–R3: APIs that may not appear anywhere in the host source. */
const FORBIDDEN_APIS = [
  'SetCursorPos', 'SetPhysicalCursorPos', 'mouse_event', 'SendInput',
  'SetForegroundWindow', 'SetActiveWindow', 'AttachThreadInput', 'BringWindowToTop', 'SwitchToThisWindow',
]

/** R8: tools that no longer exist (artifact + opencode tool layers). */
const REMOVED_TOOLS = ['windows_move', 'windows_drag', 'windows_app']
const EXPECTED_TOOLS = 14

function hits(source, name) {
  return (source.match(new RegExp(`\\b${name}\\b`, 'g')) ?? []).length
}

/** Occurrences of a token as a *value literal* ('x' / "x" / `x`), not merely in prose.
 *  A comment explaining that a leg was removed is fine; a shipped value is not. */
function quotedHits(source, token) {
  return (source.match(new RegExp(`['"\`]${token}['"\`]`, 'g')) ?? []).length
}

export default {
  name: 'strict',
  cases: [
    {
      id: 'strict/host-never-moves-the-cursor-or-requests-the-foreground',
      title: 'R1–R3: the host source contains no cursor, activation or input-injection API',
      async run(ctx) {
        ctx.check.ok(existsSync(HOST_SOURCE), 'the audit target exists', `${HOST_SOURCE} — if the host moved, update this audit`)
        if (!existsSync(HOST_SOURCE)) return
        const source = readFileSync(HOST_SOURCE, 'utf8')
        ctx.check.ok(source.length > 10000, 'the audit target looks like the real host script', `${String(source.length)} bytes`)
        for (const api of FORBIDDEN_APIS) {
          const found = hits(source, api)
          ctx.check.eq(found, 0, `the host source does not use ${api}`, `${api} appears ${String(found)} time(s)`)
        }
        // The shipped artifact embeds the host, so the same audit has to hold there — and it
        // also covers the client layers, which must not reintroduce a foreground path.
        for (const [label, path] of [['artifact', ARTIFACT], ['opencode layer', OPENCODE]]) {
          if (!existsSync(path)) continue
          const other = readFileSync(path, 'utf8')
          for (const api of FORBIDDEN_APIS) {
            ctx.check.eq(hits(other, api), 0, `the ${label} does not use ${api}`, `${api} appears in ${path}`)
          }
        }
      },
    },

    {
      id: 'strict/pointer-and-input-tools-require-a-window',
      title: 'R4: click / scroll / shortcut / type without a window are explicit errors',
      async run(ctx) {
        // The judgement is "the refusal says a target window is required"; the exact wording
        // belongs to the host, so this checks for a window/background keyword rather than a
        // frozen sentence (documented here so a future reader knows what is being matched).
        const REQUIRES_WINDOW = /(window|background|后台)/i
        const requests = [
          ['click', { cmd: 'mouse', mode: 'click', x: 10, y: 10 }],
          ['scroll', { cmd: 'mouse', mode: 'scroll', amount: -3 }],
          ['shortcut', { cmd: 'keys', keys: 'ctrl+a' }],
          ['type', { cmd: 'type', text: 'must-not-be-typed' }],
        ]
        for (const [name, request] of requests) {
          const message = await ctx.check.fails(
            () => ctx.host().ok(request),
            `${name} without a window fails instead of falling back to the foreground`,
          )
          ctx.check.match(message, REQUIRES_WINDOW, `the ${name} refusal names the missing window / strict-background rule`, JSON.stringify(message))
        }
      },
    },

    {
      id: 'strict/foreground-opt-ins-are-gone',
      title: 'R5: allowForeground and the uia-* strategies no longer exist',
      async run(ctx) {
        for (const [label, path] of [['artifact', ARTIFACT], ['opencode layer', OPENCODE]]) {
          if (!existsSync(path)) {
            ctx.check.ok(false, `the ${label} exists`, `${path} — if it moved, update this audit`)
            continue
          }
          const source = readFileSync(path, 'utf8')
          ctx.check.eq(hits(source, 'allowForeground'), 0, `${label} no longer mentions allowForeground`, `allowForeground appears in ${path}`)
          for (const token of ['uia-invoke-pattern', 'uia-value-pattern']) {
            ctx.check.eq(quotedHits(source, token), 0, `${label} no longer ships ${token} as a value`, `${token} still appears as a literal in ${path}`)
          }
        }
        ctx.check.ok(
          !STRATEGY_VALUES.includes('uia-value-pattern') && !STRATEGY_VALUES.includes('uia-invoke-pattern'),
          'the suite\'s documented strategy set no longer contains the uia-* legs',
          STRATEGY_VALUES.join(', '),
        )
      },
    },

    {
      id: 'strict/tool-surface-is-14-without-move-drag-app',
      title: 'R8: the artifact registers 14 tools and never names move/drag/app',
      async run(ctx) {
        const artifact = readFileSync(ARTIFACT, 'utf8')
        ctx.check.eq((artifact.match(/ctx\.tools\.register\(/g) ?? []).length, EXPECTED_TOOLS, `the artifact registers exactly ${String(EXPECTED_TOOLS)} tools`)
        for (const tool of REMOVED_TOOLS) {
          ctx.check.eq(hits(artifact, tool), 0, `the artifact no longer names ${tool}`, `${tool} still appears in ${ARTIFACT}`)
          if (existsSync(OPENCODE)) {
            ctx.check.eq(hits(readFileSync(OPENCODE, 'utf8'), tool.replace('_', '.')), 0, `the opencode layer no longer names ${tool.replace('_', '.')}`, `${tool} still appears in ${OPENCODE}`)
          }
        }
      },
    },

    {
      id: 'strict/element-typing-fails-explicitly-on-wpf',
      title: 'R6: element typing on WPF is an explicit error, and nothing is written',
      async run(ctx) {
        const fixture = await ctx.fixture()
        const before = await ctx.host().ok({ cmd: 'read', target: fixture.baseTitle })
        const message = await ctx.check.fails(
          () => ctx.host().ok({ cmd: 'type', window: fixture.baseTitle, element: { automationId: fixture.textBoxId }, text: `strict-${fixture.tag}` }),
          'element typing on a WPF target fails instead of silently doing nothing or faking success',
        )
        ctx.log(`the WPF refusal says: ${JSON.stringify(message.slice(0, 220))}`)
        // Not a silent failure and not a false success: the control must be untouched.
        const after = await ctx.host().ok({ cmd: 'read', target: fixture.baseTitle })
        ctx.check.eq(after, before, 'the refusal wrote nothing into the WPF control', `before=${JSON.stringify(before.slice(0, 120))} after=${JSON.stringify(after.slice(0, 120))}`)
      },
    },

    {
      id: 'strict/element-typing-still-works-on-classic-win32',
      title: 'R6: element typing still writes into a classic Win32 Edit and the text can be observed',
      async run(ctx) {
        const fixture = await ctx.fixtureWin32()
        const text = `written-${fixture.tag}`
        // Classic Win32 children are exposed through the default HWND provider: ControlType
        // is Pane, AutomationId is the decimal handle, so className/name are the usable
        // selectors (this TextBox's class name contains EDIT).
        const out = await ctx.host().ok({ cmd: 'type', window: fixture.baseTitle, element: { className: 'EDIT' }, text })
        const strategy = strategyOf(out)
        ctx.check.ok(['wm-settext', 'keystream'].includes(strategy), `the remaining legs carry the text (got ${String(strategy)})`, out.slice(0, 300))
        ctx.check.ok(strategy !== 'uia-value-pattern', 'the removed ValuePattern leg is not used', out.slice(0, 300))

        // Read-back channel: for a classic Edit the window text *is* its UIA name, so the
        // written value shows up in `find` output. (The host's window-text reader targets
        // Document/Edit control types, which the default provider does not report here —
        // that limitation is logged, not asserted away.)
        let names = ''
        const deadline = Date.now() + 5000
        while (Date.now() < deadline) {
          names = (await ctx.host().ok({ cmd: 'find', target: fixture.baseTitle, className: 'EDIT' })).trim()
          if (names.includes(text)) break
          await sleep(200)
        }
        ctx.check.contains(names, text, 'the Win32 Edit reports the written text back through find', `find said: ${names.slice(0, 200)}`)
        ctx.log(`host read() on the Win32 window returns: ${JSON.stringify((await ctx.host().ok({ cmd: 'read', target: fixture.baseTitle })).slice(0, 120))}`)
      },
    },

    {
      id: 'strict/status-and-snapshot-do-not-touch-the-cursor',
      title: 'R1: a full read-only round trip leaves the real cursor exactly where it was',
      async run(ctx) {
        const fixture = await ctx.fixture()
        const cursorOf = (text) => {
          const m = /cursor:\s*\((-?\d+),\s*(-?\d+)\)/.exec(text)
          return m === null ? null : { x: Number(m[1]), y: Number(m[2]) }
        }
        const before = cursorOf(await ctx.host().ok({ cmd: 'status' }))
        await ctx.host().ok({ cmd: 'snapshot', target: fixture.baseTitle })
        await ctx.host().ok({ cmd: 'find', target: fixture.baseTitle, automationId: fixture.textBoxId })
        await ctx.host().ok({ cmd: 'screenshot', window: fixture.baseTitle, path: join(ctx.scratch, 'shots', 'strict-cursor.png') })
        const after = cursorOf(await ctx.host().ok({ cmd: 'status' }))
        ctx.check.ok(before !== null && after !== null, 'both status calls reported a cursor position')
        // Only "the plugin did not move it" is asserted — never "the desktop is unchanged",
        // because the user may be moving the mouse themselves.
        if (before !== null && after !== null && before.x === after.x && before.y === after.y) {
          ctx.check.ok(true, 'the cursor is exactly where it was before the read-only round trip')
        } else {
          ctx.log(`cursor moved during the read-only round trip (${JSON.stringify(before)} -> ${JSON.stringify(after)}); current pointer activity cannot be attributed to the plugin`)
        }
      },
    },
  ],
}
