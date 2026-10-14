/**
 * Host client + one-shot fixture window plumbing for the windows-tools suite.
 *
 * The host (host/wt-host.ps1) is a long-lived PowerShell process speaking a
 * JSON-lines protocol: it prints {"ok":true,"ready":true} first, then one
 * response line per request line. Responses are strictly ordered, so this
 * client matches them FIFO and can attribute a late reply to a timed-out
 * request instead of mis-reading it as the next one.
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const TESTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const WT_DIR = dirname(TESTS_DIR)
export const REPO_DIR = dirname(WT_DIR)
export const HOST_PS1 = join(WT_DIR, 'host', 'wt-host.ps1')
export const BUILD_MJS = join(WT_DIR, 'build', 'build.mjs')
export const FIXTURE_PS1 = join(TESTS_DIR, 'lib', 'fixture.ps1')
export const FIXTURE_WIN32_PS1 = join(TESTS_DIR, 'lib', 'fixture-win32.ps1')
export const POWERSHELL = process.env.WT_POWERSHELL ?? 'powershell.exe'
export const READY_LINE = '{"ok":true,"ready":true}'

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** Host-side failure ({ok:false}) surfaced as an exception. */
export class HostError extends Error {
  constructor(message, request) {
    super(message)
    this.name = 'HostError'
    this.raw = message
    this.request = request
  }
}

class Pending {
  constructor(request, timeoutMs, resolve, reject) {
    this.request = request
    this.timeoutMs = timeoutMs
    this.resolve = resolve
    this.reject = reject
    this.settled = false
    this.timer = setTimeout(() => {
      if (this.settled) return
      this.settled = true
      reject(new Error(`host request timed out after ${String(timeoutMs)} ms: ${JSON.stringify(request)}`))
    }, timeoutMs)
  }
}

export class Host {
  constructor(child) {
    this.child = child
    this.queue = []
    this.buffer = ''
    this.stderr = ''
    this.log = []
    this.exited = false
    this.ready = false
    this.exitInfo = null
    this.onReady = null
    this.onExit = null

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => this.#onData(chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      this.stderr += chunk
    })
    child.on('exit', (code, signal) => {
      this.exited = true
      this.exitInfo = { code, signal }
      const error = new Error(`host process exited (code=${String(code)}, signal=${String(signal)}); stderr: ${this.stderr.trim().slice(0, 400)}`)
      for (const p of this.queue.splice(0)) {
        clearTimeout(p.timer)
        if (!p.settled) {
          p.settled = true
          p.reject(error)
        }
      }
      if (this.onExit !== null) this.onExit(error)
    })
  }

  static async start({ env = process.env, cwd = REPO_DIR, readyTimeoutMs = 30000, label = 'host', script = HOST_PS1 } = {}) {
    // `script` lets a case run a *copy* of the host from a prepared directory, which is how
    // the cache-retention cases control the directory the host sees as its own.
    const child = spawn(POWERSHELL, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], {
      cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    })
    const host = new Host(child)
    host.label = label
    const spawnError = await new Promise((resolve_) => {
      child.once('error', (error) => resolve_(error))
      setTimeout(() => resolve_(null), 250)
    })
    if (spawnError !== null) throw new Error(`cannot start the host (${label}): ${spawnError.message}`)
    await new Promise((resolveReady, rejectReady) => {
      const timer = setTimeout(() => rejectReady(new Error(`host ${label} did not print the ready line within ${String(readyTimeoutMs)} ms; stderr: ${host.stderr.trim().slice(0, 400)}`)), readyTimeoutMs)
      host.onReady = () => {
        clearTimeout(timer)
        resolveReady()
      }
      host.onExit = (error) => {
        clearTimeout(timer)
        rejectReady(error)
      }
    })
    return host
  }

  #onData(chunk) {
    this.buffer += chunk
    let index = this.buffer.indexOf('\n')
    while (index >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, '')
      this.buffer = this.buffer.slice(index + 1)
      if (line.trim() !== '') this.#onLine(line)
      index = this.buffer.indexOf('\n')
    }
  }

  #onLine(line) {
    this.log.push(line)
    if (this.log.length > 400) this.log.shift()
    if (!this.ready) {
      this.ready = true
      if (line !== READY_LINE) {
        const error = new Error(`unexpected ready line: ${JSON.stringify(line)}`)
        if (this.onReady !== null) this.onExit(error)
        return
      }
      if (this.onReady !== null) this.onReady()
      return
    }
    const pending = this.queue.shift()
    if (pending === undefined) {
      this.stderr += `[unattributed line] ${line}\n`
      return
    }
    clearTimeout(pending.timer)
    if (pending.settled) return // late reply to a request that already timed out
    pending.settled = true
    let parsed
    try {
      parsed = JSON.parse(line)
    } catch {
      pending.reject(new Error(`host replied with non-JSON: ${JSON.stringify(line)}`))
      return
    }
    parsed.raw = line
    pending.resolve(parsed)
  }

  async request(request, { timeoutMs = 30000 } = {}) {
    if (this.exited) throw new Error(`host ${this.label ?? ''} is not running: ${this.exitInfo === null ? '' : JSON.stringify(this.exitInfo)}`)
    const response = await new Promise((resolveResponse, rejectResponse) => {
      this.queue.push(new Pending(request, timeoutMs, resolveResponse, rejectResponse))
      this.child.stdin.write(`${JSON.stringify(request)}\n`)
    })
    return response
  }

  /** Request that must succeed; returns the output text. */
  async ok(request, options) {
    const response = await this.request(request, options)
    if (response.ok !== true) throw new HostError(response.error ?? response.raw, request)
    return String(response.output ?? '')
  }

  /** Request that must fail; returns the error text (asserts ok:false). */
  async err(request, options) {
    const response = await this.request(request, options)
    if (response.ok === true) {
      throw new Error(`expected {"ok":false} for ${JSON.stringify(request)}, got: ${JSON.stringify(response.output ?? '')}`)
    }
    return String(response.error ?? '')
  }

  async stop() {
    if (this.exited) return
    try {
      this.child.stdin.end()
    } catch { /* already closed */ }
    const exited = await Promise.race([
      new Promise((r) => this.child.once('exit', () => r(true))),
      sleep(3000).then(() => false),
    ])
    if (!exited) {
      try { this.child.kill() } catch { /* ignore */ }
    }
  }
}

/**
 * Start one PowerShell test window that is never activated.
 * `kind: 'wpf'` (default) runs lib/fixture.ps1, `kind: 'win32'` runs the WinForms
 * variant used to prove that a background click really drives a classic Win32 control.
 * Returns the descriptor written by the fixture plus close helpers.
 */
export async function startFixture({ tag, scratch, lifetimeSeconds = 240, x = 40, y = 40, kind = 'wpf' } = {}) {
  const safeTag = String(tag).replace(/[^A-Za-z0-9_-]/g, '')
  const infoPath = join(scratch, `fixture-${safeTag}.json`)
  const cmdPath = join(scratch, `fixture-${safeTag}.cmd`)
  rmSync(infoPath, { force: true })
  rmSync(cmdPath, { force: true })
  const script = kind === 'win32' ? FIXTURE_WIN32_PS1 : FIXTURE_PS1
  const args = [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-Title', `WT-TEST-${safeTag}`,
    '-Tag', safeTag,
    '-InfoPath', infoPath,
    '-CmdPath', cmdPath,
    '-LifetimeSeconds', String(lifetimeSeconds),
    '-X', String(x), '-Y', String(y),
  ]
  if (kind === 'win32') args.push('-MarkerPath', join(scratch, `clicked-${safeTag}.txt`))
  const child = spawn(POWERSHELL, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })

  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })

  const deadline = Date.now() + 30000
  while (!existsSync(infoPath)) {
    if (child.exitCode !== null) throw new Error(`fixture "${safeTag}" exited early (code=${String(child.exitCode)}): ${stderr.trim().slice(0, 600)}`)
    if (Date.now() > deadline) {
      try { child.kill() } catch { /* ignore */ }
      throw new Error(`fixture "${safeTag}" never wrote its descriptor; stderr: ${stderr.trim().slice(0, 600)}`)
    }
    await sleep(100)
  }
  const info = JSON.parse(readFileSync(infoPath, 'utf8'))
  return {
    ...info,
    cmdPath,
    child,
    stderrOf: () => stderr,
    /** true once the fixture process is gone (its window is gone with it). */
    dead: () => child.exitCode !== null || child.signalCode !== null,
    deadReason: () => (child.exitCode !== null || child.signalCode !== null
      ? `exit code=${String(child.exitCode)} signal=${String(child.signalCode)}; stderr: ${stderr.trim().slice(0, 400) || '(empty)'}`
      : null),
    async close() {
      writeFileSync(cmdPath, 'close')
      const gone = await Promise.race([
        new Promise((r) => child.once('exit', () => r(true))),
        sleep(4000).then(() => false),
      ])
      if (!gone) {
        try { child.kill() } catch { /* ignore */ }
      }
    },
  }
}

/** One-shot host process, used for the `{"cmd":"status"}` self-check. */
export async function runHostOnce(requestLine, { env = process.env, timeoutMs = 60000 } = {}) {
  const child = spawn(POWERSHELL, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', HOST_PS1], {
    cwd: REPO_DIR, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => { stderr += chunk })
  child.stdin.write(`${requestLine}\n`)
  child.stdin.end()
  const code = await Promise.race([
    new Promise((r) => child.once('exit', (c) => r(c))),
    sleep(timeoutMs).then(() => {
      try { child.kill() } catch { /* ignore */ }
      return 'timeout'
    }),
  ])
  return { code, stdout, stderr, lines: stdout.split(/\r?\n/).filter((l) => l.trim() !== '') }
}

export function makeScratch(prefix = 'wt-regression-') {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  return dir
}

export function cleanScratch(dir) {
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
}

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true })
  return dir
}

export function fileSize(path) {
  return statSync(path).size
}
