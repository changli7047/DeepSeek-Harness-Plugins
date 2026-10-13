/**
 * Group 4 — error paths: everything here MUST fail loudly.
 *
 * A silent success (falling back to the full screen, to the foreground window, or
 * to "pretend it worked") is the bug these cases exist for, so the assertion is
 * inverted: `check.fails` marks the case red when the command succeeds.
 */

import { cursorGuard } from '../lib/checks.mjs'

const MISSING = 'WT-TEST-NO-SUCH-WINDOW-zzz'

export default {
  name: 'errors',
  cases: [
    {
      id: 'errors/mouse-out-of-bounds-is-refused',
      title: 'a point outside the virtual desktop is refused before any real move',
      async run(ctx) {
        const guard = await cursorGuard(ctx, async () => {
          await ctx.check.fails(
            () => ctx.host().ok({ cmd: 'mouse', mode: 'click', x: -1000000, y: -1000000 }),
            'an out-of-bounds foreground click fails',
            { expect: 'outside the virtual desktop' },
          )
        }, 'the refused click did not move the real cursor')
        if (!guard.verified) ctx.log(`cursor check not verifiable: ${guard.reason}`)
      },
    },

    {
      id: 'errors/mouse-unknown-mode-is-refused',
      title: 'an unknown mouse mode is refused',
      async run(ctx) {
        await ctx.check.fails(
          () => ctx.host().ok({ cmd: 'mouse', mode: 'wiggle', x: 10, y: 10 }),
          'an unknown mouse mode fails',
          { expect: 'unknown mouse mode' },
        )
      },
    },

    {
      id: 'errors/mouse-background-drag-is-refused',
      title: 'the background (window) mode refuses unsupported gestures',
      async run(ctx) {
        const fixture = await ctx.fixture()
        const guard = await cursorGuard(ctx, async () => {
          await ctx.check.fails(
            () => ctx.host().ok({ cmd: 'mouse', window: fixture.baseTitle, mode: 'drag', fromX: 1, fromY: 1, x: 20, y: 20 }),
            'background drag fails instead of falling back to the real cursor',
          )
        }, 'the refused background drag did not move the real cursor')
        if (!guard.verified) ctx.log(`cursor check not verifiable: ${guard.reason}`)
      },
    },

    {
      id: 'errors/waitfor-unknown-kind-is-refused',
      title: 'an unknown wait_for kind is refused instead of being ignored',
      async run(ctx) {
        await ctx.check.fails(
          () => ctx.host().ok({ cmd: 'waitfor', kind: 'unicorn', timeoutSeconds: 1 }, { timeoutMs: 20000 }),
          'an unknown wait_for kind fails',
          { expect: 'unknown' },
        )
      },
    },

    {
      id: 'errors/waitfor-region-out-of-bounds-is-refused',
      title: 'a wait_for region outside the virtual desktop is refused',
      async run(ctx) {
        await ctx.check.fails(
          () => ctx.host().ok({ cmd: 'waitfor', kind: 'region', x: -1000000, y: -1000000, width: 10, height: 10, timeoutSeconds: 1 }, { timeoutMs: 20000 }),
          'an out-of-bounds wait_for region fails',
          { expect: 'outside the virtual desktop' },
        )
      },
    },

    {
      id: 'errors/unknown-command-is-refused',
      title: 'an unknown command is refused',
      async run(ctx) {
        await ctx.check.fails(
          () => ctx.host().ok({ cmd: 'frobnicate' }),
          'an unknown cmd fails',
          { expect: 'unknown command' },
        )
      },
    },

    {
      id: 'errors/type-into-missing-window-is-refused',
      title: 'typing into a non-existent window is refused (no foreground fallback)',
      async run(ctx) {
        const guard = await cursorGuard(ctx, async () => {
          await ctx.check.fails(
            () => ctx.host().ok({ cmd: 'type', window: MISSING, text: 'must-not-be-typed' }),
            'type with an unknown window fails',
            { expect: 'no window' },
          )
        }, 'the refused type did not touch the real input state')
        if (!guard.verified) ctx.log(`cursor check not verifiable: ${guard.reason}`)
      },
    },

    {
      id: 'errors/find-missing-window-is-refused',
      title: 'find in a non-existent window is refused',
      async run(ctx) {
        await ctx.check.fails(
          () => ctx.host().ok({ cmd: 'find', target: MISSING, automationId: 'anything' }),
          'find with an unknown target fails',
          { expect: 'no window' },
        )
      },
    },

    {
      id: 'errors/read-missing-window-is-refused',
      title: 'read of a non-existent window is refused',
      async run(ctx) {
        await ctx.check.fails(
          () => ctx.host().ok({ cmd: 'read', target: MISSING }),
          'read with an unknown target fails',
          { expect: 'no window' },
        )
      },
    },

    {
      id: 'errors/element-blank-selector-is-refused',
      title: 'an empty element selector is refused',
      async run(ctx) {
        const fixture = await ctx.fixture()
        await ctx.check.fails(
          () => ctx.host().ok({ cmd: 'click', window: fixture.baseTitle, element: {} }),
          'an element selector with no discriminator fails',
        )
      },
    },
  ],
}
