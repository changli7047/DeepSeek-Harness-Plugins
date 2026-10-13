/**
 * Group 1 — basics: status / snapshot / screenshot (background, window mode).
 *
 * Host-level field note: the host request field is `path`; `filePath` is only the
 * alias the dsh tool layer (dsh/windows-tools.ts) maps onto it.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ensureDir, fileSize, sha256File } from '../lib/host.mjs'
import { cursorOf, parseFindLines, savedPath, windowLineFor } from '../lib/parse.mjs'

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function isPng(path) {
  if (!existsSync(path)) return false
  const head = readFileSync(path).subarray(0, 8)
  return head.equals(PNG_MAGIC)
}

export default {
  name: 'basic',
  cases: [
    {
      id: 'basic/status-shape',
      title: 'status returns the documented sections',
      async run(ctx) {
        const out = await ctx.host().ok({ cmd: 'status' })
        for (const part of ['screen: ', 'cursor: (', 'foreground: "', 'windows (']) {
          ctx.check.contains(out, part, `status output contains "${part}"`, `status said:\n${out.slice(0, 400)}`)
        }
        ctx.check.ok(cursorOf(out) !== null, 'status reports a parseable cursor position')
      },
    },

    {
      id: 'basic/status-lists-fixture-window',
      title: 'status lists the test window with its real pid and rect',
      async run(ctx) {
        const fixture = await ctx.fixture()
        const out = await ctx.host().ok({ cmd: 'status' })
        const line = windowLineFor(out, fixture.baseTitle)
        ctx.check.ok(line !== null, 'status lists the fixture window', `looked for title containing ${fixture.baseTitle}\n${out.slice(0, 800)}`)
        ctx.check.eq(line.pid, fixture.pid, 'the listed window belongs to the fixture process')
        ctx.check.ok(line.w > 0 && line.h > 0, 'the listed window has a non-empty rect', line.raw)
        ctx.check.ok(!line.foreground, 'the fixture window is not the foreground window (never activated)', line.raw)
      },
    },

    {
      id: 'basic/snapshot-target-filter',
      title: 'snapshot with a target captures that window\'s element tree',
      async run(ctx) {
        const fixture = await ctx.fixture()
        const out = await ctx.host().ok({ cmd: 'snapshot', target: fixture.baseTitle })
        ctx.check.contains(out, `target-window: "${fixture.baseTitle}"`, 'snapshot echoes the resolved target window')
        ctx.check.contains(out, 'elements:', 'snapshot has an elements section')
        ctx.check.contains(out, fixture.buttonName, 'the element tree contains the fixture button', out.slice(0, 800))
        const count = /element-count:\s*(\d+)/.exec(out)
        ctx.check.ok(count !== null && Number(count[1]) >= 3, 'snapshot reports at least the three fixture controls', out.slice(-300))
      },
    },

    {
      id: 'basic/screenshot-window-mode',
      title: 'background (window) screenshot writes a real PNG',
      async run(ctx) {
        const fixture = await ctx.fixture()
        const path = join(ensureDir(join(ctx.scratch, 'shots')), 'basic-window.png')
        const out = await ctx.host().ok({ cmd: 'screenshot', window: fixture.baseTitle, path })
        const saved = savedPath(out)
        ctx.check.ok(saved !== null, 'screenshot output matches the documented geometry line', out.slice(0, 300))
        ctx.check.eq(saved.path, path, 'screenshot saved to the requested path')
        ctx.check.ok(saved.width > 0 && saved.height > 0, 'reported image has a non-empty size', out)
        ctx.check.contains(saved.source, 'window', 'the capture source is the target window, not the physical screen')
        ctx.check.ok(isPng(path), 'the file on disk is a PNG', `${path} (${String(existsSync(path) ? fileSize(path) : -1)} bytes)`)
        ctx.check.ok(fileSize(path) > 100, 'the PNG is not an empty stub')
      },
    },

    {
      id: 'basic/screenshot-region-ok',
      title: 'a complete region is cropped to exactly the requested size',
      async run(ctx) {
        const fixture = await ctx.fixture()
        const path = join(ctx.scratch, 'shots', 'basic-region.png')
        const out = await ctx.host().ok({ cmd: 'screenshot', window: fixture.baseTitle, path, x: 5, y: 5, width: 64, height: 48 })
        const saved = savedPath(out)
        ctx.check.ok(saved !== null, 'region screenshot reported geometry', out.slice(0, 300))
        ctx.check.eq(saved.width, 64, 'cropped width equals the requested width')
        ctx.check.eq(saved.height, 48, 'cropped height equals the requested height')
        ctx.check.ok(isPng(path), 'the cropped file is a PNG')
      },
    },

    {
      id: 'basic/screenshot-region-partial-errors',
      title: 'a partial region is refused instead of silently capturing everything',
      async run(ctx) {
        const fixture = await ctx.fixture()
        const path = join(ctx.scratch, 'shots', 'basic-partial.png')
        await ctx.check.fails(
          () => ctx.host().ok({ cmd: 'screenshot', window: fixture.baseTitle, path, x: 0, y: 0, width: 10 }),
          'screenshot with only three of the four region values fails',
          { expect: 'x, y, width and height' },
        )
        ctx.check.ok(!existsSync(path), 'the refused screenshot wrote no file')
      },
    },

    {
      id: 'basic/screenshot-non-png-refused',
      title: 'a non-.png path is refused',
      async run(ctx) {
        const path = join(ctx.scratch, 'shots', 'basic-wrong-ext.jpg')
        await ctx.check.fails(
          () => ctx.host().ok({ cmd: 'screenshot', path }),
          'screenshot to a .jpg path fails',
          { expect: '.png' },
        )
        ctx.check.ok(!existsSync(path), 'no .jpg file was written')
      },
    },

    {
      id: 'basic/screenshot-existing-file-refused',
      title: 'an existing file is not overwritten by default',
      async run(ctx) {
        const path = join(ctx.scratch, 'shots', 'basic-existing.png')
        writeFileSync(path, 'do-not-touch')
        const before = sha256File(path)
        await ctx.check.fails(
          () => ctx.host().ok({ cmd: 'screenshot', path }),
          'screenshot onto an existing file fails without overwrite=true',
          { expect: 'already exists' },
        )
        ctx.check.eq(sha256File(path), before, 'the existing file is byte-identical after the refusal')
      },
    },

    {
      id: 'basic/screenshot-overwrite-true',
      title: 'overwrite=true replaces an existing file',
      async run(ctx) {
        const path = join(ctx.scratch, 'shots', 'basic-overwrite.png')
        writeFileSync(path, 'placeholder')
        const out = await ctx.host().ok({ cmd: 'screenshot', path, overwrite: true })
        ctx.check.ok(savedPath(out) !== null, 'overwrite screenshot reported geometry', out.slice(0, 300))
        ctx.check.ok(isPng(path), 'the file was replaced by a real PNG')
      },
    },

    {
      id: 'basic/screenshot-unknown-window-errors',
      title: 'screenshot of a non-existent window fails instead of capturing the screen',
      async run(ctx) {
        await ctx.check.fails(
          () => ctx.host().ok({ cmd: 'screenshot', window: 'WT-TEST-NO-SUCH-WINDOW-zzz', path: join(ctx.scratch, 'shots', 'basic-nope.png') }),
          'screenshot of an unknown window fails',
          { expect: 'no window' },
        )
      },
    },

    {
      id: 'basic/status-window-line-shape',
      title: 'the window list lines carry the documented fields',
      async run(ctx) {
        const fixture = await ctx.fixture()
        const out = await ctx.host().ok({ cmd: 'status' })
        const line = windowLineFor(out, fixture.baseTitle)
        ctx.check.ok(line !== null, 'the fixture window line is parseable', out.slice(0, 800))
        if (line !== null) {
          ctx.check.ok(['normal', 'minimized', 'maximized'].includes(line.state), 'the line carries a state=', line.raw)
          ctx.check.match(line.raw, /process=\S+/, 'the line carries the owning process name', line.raw)
        }
      },
    },

    {
      id: 'basic/snapshot-unknown-window-errors',
      title: 'snapshot of a non-existent window fails',
      async run(ctx) {
        await ctx.check.fails(
          () => ctx.host().ok({ cmd: 'snapshot', target: 'WT-TEST-NO-SUCH-WINDOW-zzz' }),
          'snapshot with an unknown target fails',
          { expect: 'no window' },
        )
      },
    },

    {
      id: 'basic/find-line-format-is-parseable',
      title: 'find output uses the frozen line format',
      async run(ctx) {
        const fixture = await ctx.fixture()
        const out = await ctx.host().ok({ cmd: 'find', target: fixture.baseTitle, automationId: fixture.buttonId })
        const lines = parseFindLines(out)
        ctx.check.ok(lines.length >= 1, 'find returned at least one line in the documented format', out.slice(0, 400))
        if (lines.length > 0) {
          ctx.check.eq(lines[0].automationId, fixture.buttonId, 'the first hit carries the requested automationId')
          ctx.check.ok(lines[0].rect.w > 0 && lines[0].rect.h > 0, 'the hit has a non-empty rect', lines[0].raw)
        }
      },
    },
  ],
}
