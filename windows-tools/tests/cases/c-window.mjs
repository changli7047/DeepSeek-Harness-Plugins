/**
 * Group 3 — C items (v2 §4/§6/§7): winop actions, procs enumeration, new waitfor kinds.
 *
 * Ground truth for window state/rect/topmost is `status` (v2 §7), not the tool's own
 * receipt: the receipt is checked *and* cross-checked against status.
 *
 * `winop focus` does not exist any more (v2 §6) — an unknown action must fail.
 */

import { sleep } from '../lib/host.mjs'
import {
  activationStats, elapsedOf, fixtureIsActive, parseProcsLines, parseWinopReceipt, secondsOfDay, windowLineFor,
} from '../lib/parse.mjs'

const NEAR = 2 // pixels of tolerance between a requested rect and the measured one

async function statusLine(ctx, fixture) {
  const out = await ctx.host().ok({ cmd: 'status' })
  return windowLineFor(out, fixture.baseTitle)
}

async function winop(ctx, fixture, action, extra = {}) {
  return ctx.host().ok({ cmd: 'winop', target: fixture.baseTitle, action, ...extra })
}

function near(actual, expected, tolerance = NEAR) {
  return Math.abs(Number(actual) - Number(expected)) <= tolerance
}

export default {
  name: 'window',
  cases: [
    {
      id: 'window/winop-move',
      title: 'winop move reports and produces the requested position',
      async run(ctx) {
        const fixture = await ctx.fixture()
        const receipt = parseWinopReceipt(await winop(ctx, fixture, 'move', { x: 150, y: 120 }))
        ctx.check.eq(receipt.action, 'move', 'receipt names the action')
        ctx.check.ok(receipt.rect !== null, 'receipt carries a measured rect', receipt.raw)
        ctx.check.ok(receipt.requested !== null, 'receipt carries the requested rect', receipt.raw)
        ctx.check.ok(near(receipt.rect.x, 150) && near(receipt.rect.y, 120), 'measured rect matches the requested position', receipt.raw)
        const line = await statusLine(ctx, fixture)
        ctx.check.ok(line !== null && near(line.x, 150) && near(line.y, 120), 'status independently shows the new position', line === null ? 'window not listed' : line.raw)
      },
    },

    {
      id: 'window/winop-resize',
      title: 'winop resize reports and produces the requested size',
      async run(ctx) {
        const fixture = await ctx.fixture()
        const receipt = parseWinopReceipt(await winop(ctx, fixture, 'resize', { width: 520, height: 320 }))
        ctx.check.ok(receipt.rect !== null && receipt.requested !== null, 'resize receipt carries both rects', receipt.raw)
        ctx.check.ok(near(receipt.rect.w, 520) && near(receipt.rect.h, 320), 'measured size matches the requested size', receipt.raw)
        const line = await statusLine(ctx, fixture)
        ctx.check.ok(line !== null && near(line.w, 520) && near(line.h, 320), 'status independently shows the new size', line === null ? 'window not listed' : line.raw)
      },
    },

    {
      id: 'window/winop-minimize',
      title: 'winop minimize is reflected by status',
      async run(ctx) {
        const fixture = await ctx.fixture()
        const receipt = parseWinopReceipt(await winop(ctx, fixture, 'minimize'))
        ctx.check.eq(receipt.state, 'minimized', 'receipt reports the measured state')
        const line = await statusLine(ctx, fixture)
        ctx.check.ok(line !== null && line.state === 'minimized', 'status independently reports minimized', line === null ? 'window not listed' : line.raw)
      },
    },

    {
      id: 'window/winop-maximize',
      title: 'winop maximize is reflected by status',
      async run(ctx) {
        const fixture = await ctx.fixture()
        const receipt = parseWinopReceipt(await winop(ctx, fixture, 'maximize'))
        ctx.check.eq(receipt.state, 'maximized', 'receipt reports the measured state')
        const line = await statusLine(ctx, fixture)
        ctx.check.ok(line !== null && line.state === 'maximized', 'status independently reports maximized', line === null ? 'window not listed' : line.raw)
      },
    },

    {
      id: 'window/winop-restore',
      title: 'winop restore returns the window to normal',
      async run(ctx) {
        const fixture = await ctx.fixture()
        const receipt = parseWinopReceipt(await winop(ctx, fixture, 'restore'))
        ctx.check.eq(receipt.state, 'normal', 'receipt reports the measured state')
        const line = await statusLine(ctx, fixture)
        ctx.check.ok(line !== null && line.state === 'normal', 'status independently reports normal', line === null ? 'window not listed' : line.raw)
        ctx.check.ok(line !== null && line.w > 0 && line.h > 0, 'the restored window has a real rect again', line === null ? '' : line.raw)
      },
    },

    {
      id: 'window/winop-topmost-on-off',
      title: 'winop topmost is independently visible in status, and reversible',
      async run(ctx) {
        const fixture = await ctx.fixture()
        const before = await statusLine(ctx, fixture)
        ctx.check.ok(before !== null, 'the fixture window is listed before the change', 'status did not list the fixture window')
        ctx.check.ok(before !== null && !before.topmost, 'the fixture window starts non-topmost', before === null ? '' : before.raw)

        const onReceipt = parseWinopReceipt(await winop(ctx, fixture, 'topmost', { on: true }))
        ctx.check.eq(onReceipt.topmost, true, 'the on-receipt reports the measured topmost flag from the re-read', onReceipt.raw)
        const during = await statusLine(ctx, fixture)
        ctx.check.ok(during !== null && during.topmost, 'status shows the window as topmost while it is on', during === null ? 'window not listed' : during.raw)

        const offReceipt = parseWinopReceipt(await winop(ctx, fixture, 'topmost', { on: false }))
        ctx.check.eq(offReceipt.topmost, false, 'the off-receipt reports the measured topmost flag', offReceipt.raw)
        const after = await statusLine(ctx, fixture)
        ctx.check.ok(after !== null && !after.topmost, 'status no longer marks the window topmost', after === null ? 'window not listed' : after.raw)

        ctx.check.ok(
          before !== null && after !== null && near(before.x, after.x) && near(before.y, after.y) && near(before.w, after.w) && near(before.h, after.h),
          'toggling topmost did not move or resize the window',
          `${before === null ? '' : before.raw} -> ${after === null ? '' : after.raw}`,
        )
      },
    },

    {
      id: 'window/winop-close',
      title: 'winop close really closes the target window',
      async run(ctx) {
        const fixture = await ctx.fixture2()
        const receipt = parseWinopReceipt(await winop(ctx, fixture, 'close'))
        ctx.check.eq(receipt.action, 'close', 'receipt names the close action', receipt.raw)
        const deadline = Date.now() + 6000
        let gone = false
        while (Date.now() < deadline) {
          const line = await statusLine(ctx, fixture)
          if (line === null) { gone = true; break }
          await sleep(200)
        }
        ctx.check.ok(gone, 'the closed window disappears from status within 6 s')
      },
    },

    {
      id: 'window/winop-unknown-action-errors',
      title: 'an illegal winop action fails (focus was removed by v2 §6)',
      async run(ctx) {
        const fixture = await ctx.fixture()
        for (const action of ['focus', 'teleport']) {
          const message = await ctx.check.fails(
            () => winop(ctx, fixture, action),
            `winop action "${action}" is refused`,
          )
          ctx.check.match(message, /(unknown|invalid|unsupported|not supported|no such)/i, `the refusal for "${action}" explains itself`, JSON.stringify(message))
        }
      },
    },

    {
      id: 'window/winop-unknown-window-errors',
      title: 'winop on a non-existent window fails',
      async run(ctx) {
        await ctx.check.fails(
          () => ctx.host().ok({ cmd: 'winop', target: 'WT-TEST-NO-SUCH-WINDOW-zzz', action: 'minimize' }),
          'winop on an unknown window fails',
          { expect: 'no window' },
        )
      },
    },

    {
      id: 'window/procs-lists-fixture',
      title: 'procs lists the process that owns the fixture window',
      async run(ctx) {
        const fixture = await ctx.fixture()
        const out = await ctx.host().ok({ cmd: 'procs' })
        const lines = parseProcsLines(out)
        ctx.check.ok(lines.length > 0, 'procs returned at least one parseable line', out.slice(0, 500))
        const mine = lines.filter((l) => l.pid === fixture.pid)
        ctx.check.ok(mine.length >= 1, `procs lists the fixture process (pid ${String(fixture.pid)})`, out.slice(0, 800))
        // v2 §12: the default listing is visible, titled windows only, so the fixture's own
        // hidden helper windows never appear here.
        ctx.check.ok(
          mine.some((l) => l.visible && l.title.includes(fixture.baseTitle)),
          'the fixture window is listed as a visible window of that process',
          JSON.stringify(mine.slice(0, 5)),
        )
        ctx.check.eq(lines.filter((l) => !l.visible).length, 0, 'the default listing contains no visible=false lines', out.slice(0, 600))
        ctx.check.eq(lines.filter((l) => l.title.trim() === '').length, 0, 'the default listing contains no untitled windows', out.slice(0, 600))
      },
    },

    {
      id: 'window/procs-includeHidden',
      title: 'procs includeHidden adds the hidden windows without changing the visible set',
      async run(ctx) {
        const fixture = await ctx.fixture()
        const visible = parseProcsLines(await ctx.host().ok({ cmd: 'procs' }))
        const hidden = parseProcsLines(await ctx.host().ok({ cmd: 'procs', includeHidden: true }))
        const key = (l) => `${String(l.pid)}|${l.title}`
        const hiddenKeys = new Set(hidden.map(key))
        const missing = visible.map(key).filter((k) => !hiddenKeys.has(k))
        ctx.check.eq(missing.length, 0, 'includeHidden is a superset of the default listing', JSON.stringify(missing.slice(0, 5)))
        ctx.check.ok(hidden.length >= visible.length, 'includeHidden never returns fewer lines', `${String(visible.length)} -> ${String(hidden.length)}`)
        ctx.check.ok(
          visible.every((l) => l.visible),
          'the default listing is entirely visible=true',
          JSON.stringify(visible.filter((l) => !l.visible).slice(0, 3)),
        )
        // Whether a hidden top-level window exists at all depends on the desktop (IME and
        // framework helper windows), so that part is reported rather than asserted.
        const hiddenOnly = hidden.filter((l) => !l.visible)
        ctx.log(`includeHidden added ${String(hiddenOnly.length)} hidden line(s)${hiddenOnly.length > 0 ? `, e.g. ${hiddenOnly.slice(0, 3).map((l) => `${l.name}/${l.title}`).join(', ')}` : ''} (fixture pid ${String(fixture.pid)})`)
      },
    },

    {
      id: 'window/procs-name-filter-is-case-insensitive',
      title: 'procs name filter is a case-insensitive substring of the image name',
      async run(ctx) {
        const fixture = await ctx.fixture()
        for (const filter of ['powershell', 'PowerShell', 'POWERSHELL']) {
          const out = await ctx.host().ok({ cmd: 'procs', name: filter })
          const lines = parseProcsLines(out)
          ctx.check.ok(lines.some((l) => l.pid === fixture.pid), `name="${filter}" still lists the fixture process`, out.slice(0, 500))
        }
      },
    },

    {
      id: 'window/procs-limit-is-honoured',
      title: 'procs limit caps the number of lines',
      async run(ctx) {
        const out = await ctx.host().ok({ cmd: 'procs', limit: 1 })
        const lines = parseProcsLines(out)
        ctx.check.ok(lines.length <= 1, 'limit=1 returns at most one line', out.slice(0, 400))
      },
    },

    {
      id: 'window/procs-no-hit-is-not-an-error',
      title: 'procs with no match returns the documented message and ok',
      async run(ctx) {
        const out = await ctx.host().ok({ cmd: 'procs', name: 'wt-no-such-process-zzz' })
        ctx.check.eq(out.trim(), 'no process matched', 'a procs miss is "no process matched", not an error', out.slice(0, 200))
      },
    },

    {
      id: 'window/winop-resize-within-tolerance-succeeds',
      title: 'a resize the window manager clamps by <=2 px is accepted and reports the measured rect',
      async run(ctx) {
        const fixture = await ctx.fixture()
        // T6: move/resize compare measured vs requested with a ±2 px tolerance (a maximized
        // window is clamped by the window manager, so an exact match cannot be demanded).
        await winop(ctx, fixture, 'maximize')
        const line = windowLineFor(await ctx.host().ok({ cmd: 'status' }), fixture.baseTitle)
        ctx.check.ok(line !== null && line.w > 0, 'the maximized window has a measurable rect', line === null ? 'window not listed' : line.raw)
        const requested = { width: line.w + 1, height: line.h + 1 }
        const receipt = parseWinopReceipt(await winop(ctx, fixture, 'resize', requested))
        ctx.check.ok(receipt.rect !== null, 'the receipt carries the measured rect', receipt.raw)
        ctx.check.ok(
          near(receipt.rect.w, requested.width) && near(receipt.rect.h, requested.height),
          'the measured size is within 2 px of the request (clamped by the window manager)',
          `requested=${String(requested.width)}x${String(requested.height)} ${receipt.raw}`,
        )
        await winop(ctx, fixture, 'restore')
      },
    },

    {
      id: 'window/winop-resize-beyond-tolerance-fails',
      title: 'a resize the window manager must clamp by far more than 2 px is refused',
      async run(ctx) {
        const fixture = await ctx.fixture()
        await winop(ctx, fixture, 'maximize')
        const line = windowLineFor(await ctx.host().ok({ cmd: 'status' }), fixture.baseTitle)
        ctx.check.ok(line !== null && line.w > 0, 'the maximized window has a measurable rect', line === null ? 'window not listed' : line.raw)
        const message = await ctx.check.fails(
          () => winop(ctx, fixture, 'resize', { width: line.w + 50, height: line.h + 50 }),
          'a request the window manager clamps by 50 px is refused instead of reported as success',
        )
        ctx.check.match(message, /did not take effect|tolerance|clamp|mismatch/i, 'the refusal explains the measured mismatch', JSON.stringify(message))
        await winop(ctx, fixture, 'restore')
      },
    },

    {
      id: 'window/winop-foreground-side-effects',
      title: 'winop minimize/maximize/restore never leave the test window holding the foreground',
      async run(ctx) {
        const fixture = await ctx.fixture()
        const log = fixture.activatedLog
        // The verifier observed the fixture becoming foreground for ~1.1 s around these
        // three actions; attribution was undecided. Whatever the cause, the scaffold must
        // not hold the user's foreground — so this case reports what it sees ("suspected")
        // and asserts the bounded property: no single occupancy reaches one second.
        const suspected = []
        for (const action of ['minimize', 'maximize', 'restore']) {
          const before = fixtureIsActive(log)
          await winop(ctx, fixture, action)
          await sleep(700)
          if (!before && fixtureIsActive(log)) suspected.push(action)
        }
        const stats = activationStats(log, secondsOfDay(Date.now()))
        ctx.log(`fixture foreground occupancy: ${String(stats.activations)} activation(s), longest ${stats.longest.toFixed(3)} s, holding=${String(stats.holding)}`)
        if (suspected.length > 0) {
          ctx.log(`suspected foreground side effect during: ${suspected.join(', ')} (the fixture handed the foreground straight back)`)
        }
        ctx.check.ok(!stats.holding, 'the test window is not left holding the foreground', `holding=${String(stats.holding)} longest=${stats.longest.toFixed(3)} s`)
        ctx.check.ok(stats.longest < 1.0, 'no single foreground occupancy reached 1 s (self-demotion worked)', `longest=${stats.longest.toFixed(3)} s over ${String(stats.activations)} activation(s)`)
      },
    },

    {
      id: 'window/waitfor-element-hit',
      title: 'wait_for kind=element returns as soon as the element exists',
      async run(ctx) {
        const fixture = await ctx.fixture()
        const started = Date.now()
        // The timeout is far above the "returned on match" bound, so a timeout-out cannot
        // pass this clause while a match always does.
        const out = await ctx.host().ok(
          { cmd: 'waitfor', kind: 'element', target: fixture.baseTitle, automationId: fixture.textBoxId, timeoutSeconds: 15 },
          { timeoutMs: 30000 },
        )
        const elapsed = Date.now() - started
        ctx.log(`waitfor kind=element returned after ${String(elapsed)} ms`)
        ctx.check.ok(elapsed < 5000, 'the hit returns on match instead of waiting for the timeout', `took ${String(elapsed)} ms of a 15000 ms timeout`)
        ctx.check.match(out, /condition met/i, 'the hit is reported as met', out.slice(0, 300))
        ctx.check.contains(out, `automationId=${fixture.textBoxId}`, 'the hit line describes the matched element', out.slice(0, 400))
      },
    },

    {
      id: 'window/waitfor-element-timeout-errors',
      title: 'wait_for kind=element times out with an error',
      async run(ctx) {
        const fixture = await ctx.fixture()
        const started = Date.now()
        await ctx.check.fails(
          () => ctx.host().ok({ cmd: 'waitfor', kind: 'element', target: fixture.baseTitle, automationId: 'wt-no-such-automation-id', timeoutSeconds: 1 }, { timeoutMs: 20000 }),
          'element wait that never matches fails',
          { expect: 'timed out' },
        )
        ctx.check.ok(Date.now() - started >= 900, 'the failure really waited for the timeout')
      },
    },

    {
      id: 'window/waitfor-element-needs-a-filter',
      title: 'wait_for kind=element without a selector is refused',
      async run(ctx) {
        const fixture = await ctx.fixture()
        await ctx.check.fails(
          () => ctx.host().ok({ cmd: 'waitfor', kind: 'element', target: fixture.baseTitle, timeoutSeconds: 1 }),
          'element wait without name/type/automationId fails immediately',
        )
      },
    },

    {
      id: 'window/waitfor-windowgone-hit',
      title: 'wait_for kind=windowgone returns promptly once the window is gone',
      async run(ctx) {
        const fixture = await ctx.fixture2() // closed by window/winop-close, which runs before this case
        const started = Date.now()
        const out = await ctx.host().ok(
          { cmd: 'waitfor', kind: 'windowgone', target: fixture.baseTitle, timeoutSeconds: 15 },
          { timeoutMs: 30000 },
        )
        ctx.check.ok(Date.now() - started < 5000, 'the gone condition returns on the first check', `took ${String(Date.now() - started)} ms of a 15000 ms timeout`)
        ctx.check.match(out, /condition met|gone/i, 'the disappearance is reported', out.slice(0, 300))
      },
    },

    {
      id: 'window/waitfor-windowgone-timeout-errors',
      title: 'wait_for kind=windowgone times out while the window is alive',
      async run(ctx) {
        const fixture = await ctx.fixture()
        await ctx.check.fails(
          () => ctx.host().ok({ cmd: 'waitfor', kind: 'windowgone', target: fixture.baseTitle, timeoutSeconds: 1 }, { timeoutMs: 20000 }),
          'windowgone on a live window fails after the timeout',
          { expect: 'timed out' },
        )
      },
    },

    {
      id: 'window/waitfor-text-hit',
      title: 'wait_for kind=text matches text readable from the window',
      async run(ctx) {
        const fixture = await ctx.fixture()
        const readBack = await ctx.host().ok({ cmd: 'read', target: fixture.baseTitle })
        const needle = readBack.trim().slice(0, 12)
        ctx.check.ok(needle.length >= 4, 'the window exposes readable text to search for', JSON.stringify(readBack.slice(0, 200)))
        const started = Date.now()
        const out = await ctx.host().ok(
          { cmd: 'waitfor', kind: 'text', target: fixture.baseTitle, value: needle, timeoutSeconds: 15 },
          { timeoutMs: 30000 },
        )
        ctx.check.ok(Date.now() - started < 5000, 'the text condition returns on match', `took ${String(Date.now() - started)} ms of a 15000 ms timeout`)
        ctx.check.match(out, /condition met/i, 'the text hit is reported', out.slice(0, 300))
      },
    },

    {
      id: 'window/waitfor-text-timeout-errors',
      title: 'wait_for kind=text times out with an error',
      async run(ctx) {
        const fixture = await ctx.fixture()
        await ctx.check.fails(
          () => ctx.host().ok({ cmd: 'waitfor', kind: 'text', target: fixture.baseTitle, value: 'wt-no-such-text-zzz', timeoutSeconds: 1 }, { timeoutMs: 20000 }),
          'text wait that never matches fails',
          { expect: 'timed out' },
        )
      },
    },

    {
      id: 'window/waitfor-text-empty-value-errors',
      title: 'wait_for kind=text with an empty value is refused',
      async run(ctx) {
        const fixture = await ctx.fixture()
        await ctx.check.fails(
          () => ctx.host().ok({ cmd: 'waitfor', kind: 'text', target: fixture.baseTitle, value: '', timeoutSeconds: 1 }),
          'empty text value fails',
        )
      },
    },

    {
      id: 'window/waitfor-text-source-matches-read',
      title: 'wait_for text and read agree on the text source',
      async run(ctx) {
        const fixture = await ctx.fixture()
        const marker = `m-${fixture.tag}`
        await ctx.host().ok({ cmd: 'type', window: fixture.baseTitle, element: { automationId: fixture.textBoxId }, text: marker })
        const readBack = await ctx.host().ok({ cmd: 'read', target: fixture.baseTitle })
        ctx.check.contains(readBack, marker, 'read sees the freshly typed marker', JSON.stringify(readBack.slice(0, 200)))
        const out = await ctx.host().ok(
          { cmd: 'waitfor', kind: 'text', target: fixture.baseTitle, value: marker, timeoutSeconds: 3 },
          { timeoutMs: 15000 },
        )
        ctx.check.match(out, /condition met/i, 'the same marker is a text-wait hit', out.slice(0, 300))
        ctx.check.ok(elapsedOf(out) !== null, 'the hit reports how long it waited', out.slice(0, 200))
      },
    },
  ],
}
