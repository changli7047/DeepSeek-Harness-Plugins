/**
 * Windows desktop tools for DeepSeek Harness (scratch plugin).
 *
 * Registers model-facing tools that observe and operate the local Windows
 * desktop: UI Automation snapshots, DPI-aware screenshots returned as images,
 * precise Unicode keyboard input, mouse, clipboard, application
 * launch/activation, and deterministic waiting. Modeled on the tool surface
 * of Windows-MCP (CursorTouch). Windows-only.
 *
 * A single persistent PowerShell helper process is started lazily and speaks
 * one-JSON-request-per-line over stdin/stdout; every tool call is a round trip
 * to that process, so no per-call PowerShell startup or C# compile happens.
 *
 * Load with: pnpm dsh web --patch ./scratch-plugin/windows-tools.cordis.yml
 * @module scratch-windows-tools
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { createInterface } from 'node:readline'
import type { Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment/types'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'scratch-windows-tools'

export const inject = ['tools']

const POWERSHELL = process.env.SystemRoot !== undefined
  ? join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : 'powershell.exe'

const HOST_SCRIPT = String.raw`__PS_HOST__`

const HOST_SCRIPT_PATH = join(tmpdir(), 'dsh-windows-tools', 'wt-host.ps1')

/** One in-flight helper call waiting for its response line. */
interface PendingCall {
  resolve: (output: string) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

/** Live helper process plus its FIFO request queue. */
interface HostState {
  child: ChildProcess
  pending: PendingCall[]
}

let host: HostState | undefined

/** Reject every pending call and stop the helper process. */
function killHost(error: Error): void {
  const current = host
  host = undefined
  if (current === undefined) return
  for (const call of current.pending.splice(0)) {
    clearTimeout(call.timer)
    call.reject(error)
  }
  current.child.kill()
}

/** Start the helper on first use; keep it for the life of the plugin. */
function ensureHost(): HostState {
  if (host !== undefined) return host
  mkdirSync(join(tmpdir(), 'dsh-windows-tools'), { recursive: true })
  writeFileSync(HOST_SCRIPT_PATH, HOST_SCRIPT, 'utf8')
  const child = spawn(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', HOST_SCRIPT_PATH], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const state: HostState = { child, pending: [] }
  host = state
  const reader = createInterface({ input: child.stdout as NodeJS.ReadableStream })
  reader.on('line', (line: string) => {
    let message: { ready?: boolean; ok?: boolean; output?: unknown; error?: unknown }
    try {
      message = JSON.parse(line) as typeof message
    } catch {
      return
    }
    if (message.ready === true) return
    const call = state.pending.shift()
    if (call === undefined) return
    clearTimeout(call.timer)
    if (message.ok === true) call.resolve(String(message.output ?? ''))
    else call.reject(new Error(String(message.error ?? 'windows helper command failed')))
  })
  child.on('close', () => {
    if (host !== state) return
    host = undefined
    for (const call of state.pending.splice(0)) {
      clearTimeout(call.timer)
      call.reject(new Error('windows helper exited unexpectedly'))
    }
  })
  child.stderr?.setEncoding('utf8')
  // Keep the pipe drained; helper failures surface through exit codes and responses.
  child.stderr?.on('data', () => {})
  return state
}

/** Serialize one request as pure-ASCII JSON so stdin decoding cannot garble non-ASCII text. */
function encodeRequest(request: Record<string, unknown>): string {
  return JSON.stringify(request).replace(/[\u007f-\uffff]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

/** Send one command to the helper and await its response. */
function callHost(request: Record<string, unknown>, timeoutMs: number): Promise<string> {
  const state = ensureHost()
  return new Promise((resolve, reject) => {
    const call: PendingCall = {
      resolve,
      reject,
      timer: setTimeout(() => {
        killHost(new Error(`windows helper timed out after ${String(timeoutMs)} ms`))
      }, timeoutMs),
    }
    state.pending.push(call)
    state.child.stdin?.write(`${encodeRequest(request)}\n`)
  })
}

/** Default screenshot destination outside the workspace. */
function defaultScreenshotPath(): string {
  const dir = join(tmpdir(), 'dsh-windows-tools')
  mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return join(dir, `screenshot-${stamp}.png`)
}

/** Minimal surface of the attachment store used to return screenshots to the model. */
interface ImageSaver {
  saveImages: (inputs: readonly { data: Uint8Array; mediaType: string; name?: string }[]) => Promise<readonly ImageAttachmentRef[]>
}

/** Register the Windows desktop tools on the host tools registry. */
export function apply(ctx: Context): void {
  if (process.platform !== 'win32') return

  ctx.effect(() => () => {
    killHost(new Error('windows helper disposed'))
  })

  ctx.tools.register(defineTool({
    name: 'windows_status',
    description: 'Environment overview of the Windows desktop: virtual screen size and the full monitor layout, current cursor position, the foreground window, and every visible top-level window with its rectangle, owning process name, window state (normal/minimized/maximized), and a foreground marker. Cheap to call; use windows_snapshot when you need interactive element coordinates.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    timeoutMs: 15000,
    isConcurrencySafe: () => false,
    async execute() {
      return callHost({ cmd: 'status' }, 15000)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'windows_snapshot',
    description: 'Capture the desktop UI state for automation: virtual screen size, foreground window, visible windows, and the interactive element tree (buttons, edits, list items, menus, links, ...) of the foreground window, each with screen coordinates. Set `window` to capture a specific window by title substring instead. Coordinates are virtual-desktop pixels with origin at the top-left; pass them to windows_click / windows_move / windows_drag.',
    parameters: {
      window: { type: 'string', description: 'Optional window target: title substring, process name, or PID; when set, the element tree of the matching top-level window is captured instead of the foreground window.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    timeoutMs: 45000,
    isConcurrencySafe: () => false,
    async execute(args) {
      const request: Record<string, unknown> = { cmd: 'snapshot' }
      if (args.window !== undefined) request.target = args.window
      return callHost(request, 45000)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'windows_screenshot',
    description: 'Capture a PNG screenshot (DPI-aware, physical pixels) and return it so you can see the screen. By default the physical screen is captured; give `window` to capture one window in the background instead — this works even when that window is covered by other windows, without disturbing the user (minimized windows are not supported). Give x, y, width, height for a region and scale (1-4) to enlarge small text or icons; in window mode the region is relative to the captured window image. Prefer windows_snapshot when you need interactive element coordinates, because a screenshot shows pixels only.',
    parameters: {
      filePath: { type: 'string', description: 'Optional absolute path for the PNG file; defaults to a timestamped file under the system temporary directory.' },
      attachImage: { type: 'boolean', description: 'Set false to skip returning the image and only save the file; defaults to true.' },
      window: { type: 'string', description: 'Optional window target: title substring, process name (e.g. Weixin), or PID. Captures that window in the background instead of the screen.' },
      x: { type: 'integer', description: 'Optional region left edge in screen pixels.' },
      y: { type: 'integer', description: 'Optional region top edge in screen pixels.' },
      width: { type: 'integer', description: 'Optional region width; requires x and y.' },
      height: { type: 'integer', description: 'Optional region height; requires x and y.' },
      scale: { type: 'number', description: 'Optional enlargement factor 1-4 applied to the captured image; defaults to 1.' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string', required: true },
          bytes: { type: 'number', required: true },
          width: { type: 'number', required: true },
          height: { type: 'number', required: true },
          scale: { type: 'number', required: true },
          image: {
            type: 'object',
            properties: {
              attachmentId: { type: 'string', required: true },
              mediaType: { type: 'string', required: true },
              bytes: { type: 'number', required: true },
              width: { type: 'number', required: true },
              height: { type: 'number', required: true },
              name: { type: 'string' },
            },
            additionalProperties: true,
          },
        },
        additionalProperties: false,
      },
      render: (_args, value) => {
        const scaledNote = value.scale > 1
          ? ` The image is enlarged ${String(value.scale)}x: divide image coordinates by ${String(value.scale)} to get screen coordinates.`
          : ''
        const blocks: ContentBlock[] = [{
          type: 'text',
          text: `Screenshot saved to ${value.path} (${String(value.width)}x${String(value.height)} px).${scaledNote}`,
        }]
        if (value.image !== undefined) blocks.push({ type: 'image', attachment: value.image as ImageAttachmentRef })
        return blocks
      },
    },
    timeoutMs: 45000,
    isConcurrencySafe: () => false,
    async execute(args) {
      const path = args.filePath ?? defaultScreenshotPath()
      const request: Record<string, unknown> = { cmd: 'screenshot', path }
      if (args.window !== undefined) request.window = args.window
      if (args.x !== undefined && args.y !== undefined && args.width !== undefined && args.height !== undefined) {
        request.x = args.x
        request.y = args.y
        request.width = args.width
        request.height = args.height
      }
      if (args.scale !== undefined) request.scale = args.scale
      const response = await callHost(request, 45000)
      const geometry = /^saved: (.+)\|width:(\d+)\|height:(\d+)\|scale:([0-9.]+)\|source:/.exec(response)
      if (geometry === null) throw new Error(`screenshot helper returned an unexpected result: ${response}`)
      const finalPath = geometry[1] ?? path
      const width = Number(geometry[2])
      const height = Number(geometry[3])
      const scale = Number(geometry[4])
      const bytes = statSync(finalPath).size
      if (args.attachImage !== false) {
        const store = ctx.get('attachments') as ImageSaver | undefined
        if (store !== undefined) {
          try {
            const refs = await store.saveImages([{ data: readFileSync(finalPath), mediaType: 'image/png', name: basename(finalPath) }])
            return refs[0] !== undefined ? { path: finalPath, bytes, width, height, scale, image: refs[0] } : { path: finalPath, bytes, width, height, scale }
          } catch {
            // Image admission refused the capture; keep the file-only result.
          }
        }
      }
      return { path: finalPath, bytes, width, height, scale }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'windows_click',
    description: 'Click a mouse button and report the UI element under the point (UIA hit-test) so you can confirm the target. Default: screen coordinates in virtual-desktop pixels, executed on the real desktop (moves the cursor and changes focus). With `window`: x, y are CLIENT coordinates of that window and the click is posted in the background without moving the mouse or changing focus — best-effort, reliable for classic Win32 and Qt apps (including WeChat 4.x, whose message routing and encoding are handled automatically), while Chromium/Electron apps may ignore synthetic clicks.',
    parameters: {
      x: { type: 'integer', required: true, description: 'Screen x coordinate of the click point (client x when window is set).' },
      y: { type: 'integer', required: true, description: 'Screen y coordinate of the click point (client y when window is set).' },
      button: { type: 'string', enum: ['left', 'right', 'double'], description: 'Which click to perform; defaults to a single left click.' },
      window: { type: 'string', description: 'Optional window target: title substring, process name (e.g. Weixin), or PID. Posts the click to that window in the background (x, y are client coordinates, the same space as the windows_screenshot image of that window).' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    timeoutMs: 15000,
    isConcurrencySafe: () => false,
    async execute(args) {
      const request: Record<string, unknown> = { cmd: 'mouse', mode: 'click', x: args.x, y: args.y, button: args.button ?? 'left' }
      if (args.window !== undefined) request.window = args.window
      return callHost(request, 15000)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'windows_move',
    description: 'Move the mouse pointer to the given screen coordinates without pressing any button.',
    parameters: {
      x: { type: 'integer', required: true, description: 'Target screen x coordinate.' },
      y: { type: 'integer', required: true, description: 'Target screen y coordinate.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    timeoutMs: 15000,
    isConcurrencySafe: () => false,
    async execute(args) {
      return callHost({ cmd: 'mouse', mode: 'move', x: args.x, y: args.y }, 15000)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'windows_drag',
    description: 'Drag with the left mouse button held: press at (fromX, fromY), move, and release at (x, y).',
    parameters: {
      fromX: { type: 'integer', required: true, description: 'Drag start screen x coordinate.' },
      fromY: { type: 'integer', required: true, description: 'Drag start screen y coordinate.' },
      x: { type: 'integer', required: true, description: 'Drag end screen x coordinate.' },
      y: { type: 'integer', required: true, description: 'Drag end screen y coordinate.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    timeoutMs: 15000,
    isConcurrencySafe: () => false,
    async execute(args) {
      return callHost({ cmd: 'mouse', mode: 'drag', fromX: args.fromX, fromY: args.fromY, x: args.x, y: args.y }, 15000)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'windows_scroll',
    description: 'Scroll the mouse wheel vertically by `amount` wheel clicks (positive scrolls up, negative scrolls down) and report the UI element under the pointer, so you can confirm the scroll target. With `window` the scroll is posted to that window in the background (no cursor movement).',
    parameters: {
      amount: { type: 'integer', required: true, description: 'Number of wheel clicks; negative values scroll down.' },
      x: { type: 'integer', description: 'Optional screen x coordinate to move the pointer to before scrolling.' },
      y: { type: 'integer', description: 'Optional screen y coordinate to move the pointer to before scrolling.' },
      window: { type: 'string', description: 'Optional window title substring, process name, or PID; posts the scroll to that window in the background.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    timeoutMs: 15000,
    isConcurrencySafe: () => false,
    async execute(args) {
      if (args.amount === 0) throw new Error('scroll amount must not be zero')
      const request: Record<string, unknown> = { cmd: 'mouse', mode: 'scroll', amount: args.amount }
      if (args.x !== undefined && args.y !== undefined) {
        request.x = args.x
        request.y = args.y
      }
      if (args.window !== undefined) request.window = args.window
      return callHost(request, 15000)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'windows_type',
    description: "Type text into the focused control with exact Unicode input (spaces, punctuation, CJK and symbols are preserved). After typing, the focused control is read back and the call fails if the text did not land. Mode 'keys' (default) synthesizes per-character Unicode input; mode 'paste' uses the clipboard for bulk text. Set `clear` to select all (Ctrl+A) first; set `activate` to bring a window forward atomically before typing. With `window`, the text is posted to that window in the background (no focus change, result not verified, `clear` is ignored) — best-effort: ASCII is reliable; CJK is reliable for classic Win32 and Qt apps including WeChat 4.x (byte encoding handled automatically) but may be garbled or dropped by modern WinUI/UWP apps, so prefer foreground mode with `activate` there.",
    parameters: {
      text: { type: 'string', required: true, description: 'The text to type into the focused control.' },
      clear: { type: 'boolean', description: 'Select all existing content (Ctrl+A) before typing; defaults to false.' },
      mode: { type: 'string', enum: ['keys', 'paste'], description: "Input method; defaults to 'keys' (exact per-character Unicode input). 'paste' is faster for large text." },
      activate: { type: 'string', description: 'Optional window title substring, process name, or PID to activate first, in the same call.' },
      window: { type: 'string', description: 'Optional window target: title substring, process name (e.g. Weixin), or PID. Posts the text to that window in the background instead of the focused control.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    timeoutMs: 30000,
    isConcurrencySafe: () => false,
    async execute(args) {
      if (args.text.length === 0) throw new Error('text must not be empty')
      const request: Record<string, unknown> = { cmd: 'type', text: args.text, clear: args.clear === true, mode: args.mode ?? 'keys' }
      if (args.activate !== undefined) request.activate = args.activate
      if (args.window !== undefined) request.window = args.window
      return callHost(request, 30000)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'windows_shortcut',
    description: "Press a keyboard shortcut, for example 'ctrl+s', 'alt+tab', 'ctrl+shift+esc', or a single key like 'win', 'enter', 'esc'. Set `activate` to bring a window forward first, in the same call, so the shortcut cannot land in another window. With `window`, the key messages are posted to that window in the background (no focus change) — best-effort: classic Win32 apps accept them, Chromium/Electron apps may ignore some. Supported names: ctrl, alt, shift, win, a-z, 0-9, f1-f12, enter, tab, esc, space, backspace, delete, insert, up, down, left, right, home, end, pageup, pagedown, minus, equal, comma, period, slash.",
    parameters: {
      keys: { type: 'string', required: true, description: "Keys joined with '+', pressed in order and released in reverse, e.g. 'ctrl+alt+delete'." },
      activate: { type: 'string', description: 'Optional window title substring, process name, or PID to activate first, in the same call.' },
      window: { type: 'string', description: 'Optional window title substring, process name, or PID; posts the keys to that window in the background instead of the focused window.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    timeoutMs: 20000,
    isConcurrencySafe: () => false,
    async execute(args) {
      const request: Record<string, unknown> = { cmd: 'keys', keys: args.keys }
      if (args.activate !== undefined) request.activate = args.activate
      if (args.window !== undefined) request.window = args.window
      return callHost(request, 20000)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'windows_app',
    description: 'Launch an application, document, or URL (action launch, ShellExecute semantics, optional args; reports the new window title when one appears), or bring an existing window to the foreground (action activate; target is a window title substring, process name, or PID; minimized windows are restored).',
    parameters: {
      action: { type: 'string', enum: ['launch', 'activate'], required: true, description: 'launch starts something new; activate focuses an existing window.' },
      target: { type: 'string', required: true, description: 'Executable path, document, or URL for launch; window title substring, process name, or PID for activate.' },
      args: { type: 'string', description: 'Optional command line arguments for launch.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    timeoutMs: 15000,
    isConcurrencySafe: () => false,
    async execute(args) {
      if (args.action === 'activate') return callHost({ cmd: 'activate', target: args.target }, 15000)
      const request: Record<string, unknown> = { cmd: 'launch', target: args.target }
      if (args.args !== undefined) request.args = args.args
      return callHost(request, 15000)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'windows_clipboard',
    description: 'Read or replace the Windows clipboard text.',
    parameters: {
      action: { type: 'string', enum: ['get', 'set'], required: true, description: 'get returns the current clipboard text; set replaces it.' },
      text: { type: 'string', description: 'The text to place on the clipboard when action is set.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    timeoutMs: 15000,
    isConcurrencySafe: () => false,
    async execute(args) {
      if (args.action === 'set') {
        if (args.text === undefined) throw new Error('clipboard set requires text')
        return callHost({ cmd: 'clipboard', action: 'set', text: args.text }, 15000)
      }
      const text = await callHost({ cmd: 'clipboard', action: 'get' }, 15000)
      return text.length === 0 ? '(clipboard is empty)' : text
    },
  }))

  ctx.tools.register(defineTool({
    name: 'windows_wait',
    description: 'Wait for a number of seconds (0.1-30) so the desktop can settle after an action, instead of polling in a tight loop.',
    parameters: {
      seconds: { type: 'number', required: true, description: 'Seconds to wait; between 0.1 and 30.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    timeoutMs: 45000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      if (!(args.seconds >= 0.1 && args.seconds <= 30)) throw new Error('seconds must be between 0.1 and 30')
      await new Promise<void>((resolveWait) => {
        const timer = setTimeout(resolveWait, Math.round(args.seconds * 1000))
        exec.signal.addEventListener('abort', () => {
          clearTimeout(timer)
          resolveWait()
        }, { once: true })
      })
      return `waited ${String(args.seconds)} seconds`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'windows_wait_for',
    description: 'Wait until a desktop condition becomes true instead of sleeping blindly, then return; it fails with a timeout error when the condition never appears. Conditions: foreground (the foreground window title contains `value`), window (any visible window title contains `value`), pixel (the screen pixel at x, y changes from its color at call time), region (the average pixel difference inside x, y, width, height exceeds `threshold`, default 20; works for web-style UI that never changes window titles), settle (the region — or the whole screen when omitted — stays unchanged for `stableFrames` consecutive frames, default 3; use after any action to wait for rendering to finish).',
    parameters: {
      kind: { type: 'string', enum: ['foreground', 'window', 'pixel', 'region', 'settle'], required: true, description: 'Condition to wait for.' },
      value: { type: 'string', description: 'Title substring for foreground/window conditions; unused otherwise.' },
      x: { type: 'integer', description: 'Screen x coordinate: the pixel for kind pixel, or the region left edge for kind region/settle.' },
      y: { type: 'integer', description: 'Screen y coordinate: the pixel for kind pixel, or the region top edge for kind region/settle.' },
      width: { type: 'integer', description: 'Region width for kind region/settle; omit to watch the whole screen.' },
      height: { type: 'integer', description: 'Region height for kind region/settle; omit to watch the whole screen.' },
      threshold: { type: 'number', description: 'Average pixel-difference threshold for kind region; defaults to 20.' },
      stableFrames: { type: 'number', description: 'Consecutive unchanged frames required by kind settle; defaults to 3.' },
      timeoutSeconds: { type: 'number', description: 'Maximum wait in seconds; defaults to 10, capped at 60.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    timeoutMs: 65000,
    isConcurrencySafe: () => false,
    async execute(args) {
      if (args.kind === 'pixel' && (args.x === undefined || args.y === undefined)) {
        throw new Error('pixel condition requires x and y')
      }
      const request: Record<string, unknown> = { cmd: 'waitfor', kind: args.kind }
      if (args.value !== undefined) request.value = args.value
      if (args.x !== undefined) request.x = args.x
      if (args.y !== undefined) request.y = args.y
      if (args.width !== undefined) request.width = args.width
      if (args.height !== undefined) request.height = args.height
      if (args.threshold !== undefined) request.threshold = args.threshold
      if (args.stableFrames !== undefined) request.stableFrames = args.stableFrames
      if (args.timeoutSeconds !== undefined) request.timeoutSeconds = args.timeoutSeconds
      return callHost(request, 65000)
    },
  }))
}
