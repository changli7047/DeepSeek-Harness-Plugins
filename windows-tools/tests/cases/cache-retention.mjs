/**
 * Group 9 — host-script cache retention (protocol v3 hygiene / T14 spec).
 *
 * The dsh client materialises the host script into a per-plugin cache directory
 * (`%TEMP%\dsh-windows-tools\wt-host-<16 hex>.ps1`, the OpenCode side the same under
 * `opencode-windows-tools`), so every host-script revision leaves a copy behind. The host
 * now prunes its own copies at startup:
 *
 *   * only files matching `^wt-host-[0-9a-f]{16}\.ps1$` are candidates;
 *   * the newest 3 survive by default, `WINDOWS_TOOLS_HOST_KEEP` overrides (clamped 1–20);
 *   * the whole sweep is enabled only when the directory's basename is one of the two
 *     plugin cache names — a copy started from anywhere else must not delete anything.
 *
 * Every case below builds its own throw-away cache directory inside the run scratch and
 * points the host's TEMP at it, so the user's real `%TEMP%\dsh-windows-tools\` (their
 * screenshots) is never in scope.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { HOST_PS1, Host, ensureDir, sleep } from '../lib/host.mjs'

const HOST_COPY = /^wt-host-[0-9a-f]{16}\.ps1$/
const SCREENSHOT = 'screenshot-20200102-030405-678.png'

/** 16-hex names, deliberately ordered oldest → newest by the index. */
const hexNames = [
  '0123456789abcdef', '1111111111111111', '2222222222222222', '3333333333333333', 'ffffffffffffffff',
]

function copiesIn(dir) {
  return existsSync(dir) ? readdirSync(dir).filter((name) => HOST_COPY.test(name)) : []
}

/**
 * Build a fake host-cache directory: 5 matching scripts with increasing mtimes (the newest
 * is a real copy of the repository host, so it can actually be started), plus the three
 * kinds of file that must survive the sweep.
 */
function buildCache(ctx, { dirName, count = 5, withRealHostAtNewest = true }) {
  const root = ensureDir(join(ctx.scratch, `cache-${dirName}-${String(Date.now() % 100000)}`))
  const dir = ensureDir(join(root, dirName))
  const names = hexNames.slice(0, count)
  const base = Date.now() - 600000
  names.forEach((hex, index) => {
    const path = join(dir, `wt-host-${hex}.ps1`)
    if (withRealHostAtNewest && index === count - 1) {
      copyFileSync(HOST_PS1, path)
    } else {
      writeFileSync(path, `# stale host copy ${String(index)}\n`)
    }
    const stamp = new Date(base + index * 60000)
    utimesSync(path, stamp, stamp)
  })
  const screenshot = join(dir, SCREENSHOT)
  const notes = join(dir, 'notes.txt')
  const plainHost = join(dir, 'wt-host.ps1')
  writeFileSync(screenshot, 'not a real png, but it matches the screenshot naming pattern')
  writeFileSync(notes, 'user file, must survive')
  writeFileSync(plainHost, '# no hash in the name: not a cache copy\n')
  return {
    root,
    dir,
    names,
    newest: join(dir, `wt-host-${names[names.length - 1]}.ps1`),
    oldest: join(dir, `wt-host-${names[0]}.ps1`),
    secondOldest: join(dir, `wt-host-${names[1]}.ps1`),
    screenshot,
    notes,
    plainHost,
  }
}

/** Wait until `predicate()` holds, or give up after `timeoutMs` (assertions decide). */
async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(200)
  }
  return predicate()
}

/** Start the newest copy with TEMP redirected into the scratch tree, and stop it after. */
async function withHostFromCache(ctx, cache, { keep = null, extraEnv = {} } = {}) {
  const env = { ...process.env, TEMP: cache.root, TMP: cache.root, ...extraEnv }
  if (keep !== null) env.WINDOWS_TOOLS_HOST_KEEP = String(keep)
  const host = await Host.start({ script: cache.newest, env, label: 'cache-host' })
  ctx.addCleanup(() => host.stop())
  return host
}

export default {
  name: 'cache',
  cases: [
    {
      id: 'cache/prunes-old-copies-and-keeps-three',
      title: 'startup keeps the newest 3 host copies and deletes only the aged ones',
      async run(ctx) {
        const cache = buildCache(ctx, { dirName: 'dsh-windows-tools' })
        ctx.log(`before: ${copiesIn(cache.dir).sort().join(', ')}`)
        const host = await withHostFromCache(ctx, cache)
        await host.ok({ cmd: 'status' })
        await waitFor(() => copiesIn(cache.dir).length === 3, 8000)
        const remaining = copiesIn(cache.dir)
        ctx.log(`after:  ${remaining.slice().sort().join(', ')}`)
        ctx.check.eq(remaining.length, 3, 'exactly three host copies survive', `directory: ${remaining.join(', ')}`)
        ctx.check.ok(remaining.includes(basename(cache.newest)), 'the copy that is running is kept', remaining.join(', '))
        ctx.check.ok(!remaining.includes(basename(cache.oldest)), 'the oldest copy was pruned', remaining.join(', '))
        ctx.check.ok(!remaining.includes(basename(cache.secondOldest)), 'the second oldest copy was pruned', remaining.join(', '))
        ctx.check.ok(existsSync(cache.screenshot), 'a screenshot-*.png in the same directory is untouched')
        ctx.check.ok(existsSync(cache.notes), 'a user file (notes.txt) is untouched')
        ctx.check.ok(existsSync(cache.plainHost), 'a wt-host.ps1 without a hash suffix is untouched')
      },
    },

    {
      id: 'cache/keep-env-var-overrides-the-count',
      title: 'WINDOWS_TOOLS_HOST_KEEP=1 leaves exactly one host copy',
      async run(ctx) {
        const cache = buildCache(ctx, { dirName: 'opencode-windows-tools' })
        const host = await withHostFromCache(ctx, cache, { keep: 1 })
        await host.ok({ cmd: 'status' })
        await waitFor(() => copiesIn(cache.dir).length === 1, 8000)
        const remaining = copiesIn(cache.dir)
        ctx.check.eq(remaining.length, 1, 'the keep override is honoured', `directory: ${remaining.join(', ')}`)
        ctx.check.ok(remaining.includes(basename(cache.newest)), 'the surviving copy is the one that is running', remaining.join(', '))
        ctx.check.ok(existsSync(cache.notes), 'the user file still survives')
      },
    },

    {
      id: 'cache/directory-guard-disables-pruning',
      title: 'the sweep is disabled when the directory is not a plugin cache directory',
      async run(ctx) {
        // Same files, but the directory is not named *-windows-tools: nothing may be deleted.
        const cache = buildCache(ctx, { dirName: 'not-a-plugin-cache' })
        const before = copiesIn(cache.dir).sort()
        const host = await withHostFromCache(ctx, cache)
        await host.ok({ cmd: 'status' })
        await sleep(2500) // give a wrongly-enabled sweep time to act
        const after = copiesIn(cache.dir).sort()
        ctx.check.eq(after.length, before.length, 'no host copy was deleted outside a plugin cache directory', `before=${before.join(', ')} after=${after.join(', ')}`)
        ctx.check.eq(after.join('|'), before.join('|'), 'the set of host copies is unchanged')
        ctx.check.ok(existsSync(cache.oldest), 'even the oldest copy is still there')
      },
    },

    {
      id: 'cache/undeletable-copy-does-not-break-the-host',
      title: 'a file that cannot be deleted does not break the sweep or the host',
      async run(ctx) {
        const cache = buildCache(ctx, { dirName: 'dsh-windows-tools' })
        // Hold the oldest copy open with FileShare.None from a separate process: any delete
        // attempt on it fails while the lock is held.
        const { spawn } = await import('node:child_process')
        const holderScript = `$s = [System.IO.File]::Open('${cache.oldest}', 'Open', 'Read', 'None'); Start-Sleep -Seconds 60`
        const holder = spawn('powershell.exe', ['-NoProfile', '-Command', holderScript], { stdio: 'ignore', windowsHide: true })
        ctx.addCleanup(() => { try { holder.kill() } catch { /* already gone */ } })
        await sleep(1500) // let the lock be taken before the host starts

        const host = await withHostFromCache(ctx, cache)
        const status = await host.ok({ cmd: 'status' })
        ctx.check.ok(status.startsWith('screen:'), 'the host started and answered normally despite the undeletable file', status.slice(0, 120))
        await waitFor(() => copiesIn(cache.dir).length <= 4, 8000)
        const remaining = copiesIn(cache.dir)
        ctx.check.ok(remaining.includes(basename(cache.newest)), 'the running copy is still kept', remaining.join(', '))
        ctx.check.ok(existsSync(cache.oldest), 'the locked copy could not be deleted and is still present (the sweep did not pretend success)', remaining.join(', '))
        ctx.check.ok(remaining.length <= 4, 'the sweep did not leave every old copy behind', `remaining: ${remaining.join(', ')}`)
        ctx.check.ok(existsSync(cache.notes) && existsSync(cache.screenshot) && existsSync(cache.plainHost), 'the non-candidate files are still untouched')
      },
    },
  ],
}
