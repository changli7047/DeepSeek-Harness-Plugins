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
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
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

/** Content-addressed path: two plugin versions never share one helper file. */
const HOST_SCRIPT_HASH = createHash('sha256').update(HOST_SCRIPT).digest('hex').slice(0, 16)

const HOST_DIR = join(tmpdir(), 'dsh-windows-tools')
const HOST_SCRIPT_PATH = join(HOST_DIR, `wt-host-${HOST_SCRIPT_HASH}.ps1`)

/**
 * Publish the helper with a write-to-staging-then-rename, so a concurrent
 * reader (another session starting at the same moment) can never observe a
 * half-written script.
 */
function materializeHostScript(): string {
  mkdirSync(HOST_DIR, { recursive: true })
  const staging = join(HOST_DIR, `wt-host-${HOST_SCRIPT_HASH}.${String(process.pid)}.tmp`)
  writeFileSync(staging, HOST_SCRIPT, 'utf8')
  try {
    renameSync(staging, HOST_SCRIPT_PATH)
  } catch (error) {
    rmSync(staging, { force: true })
    // The path encodes the content hash, so an existing readable file is
    // equivalent; anything else is a real failure and must surface.
    if (!existsSync(HOST_SCRIPT_PATH)) throw error
  }
  return HOST_SCRIPT_PATH
}

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
  const scriptPath = materializeHostScript()
  const child = spawn(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
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

/**
 * Retention override for screenshots this plugin names itself. The helper prunes
 * only when the request carries `prune`, and the client sets that flag only for
 * its own default directory; a caller-supplied filePath is never touched.
 */
function screenshotKeep(): number | undefined {
  const raw = process.env.WINDOWS_TOOLS_SCREENSHOT_KEEP
  if (raw === undefined || raw.trim() === '') return undefined
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 1) return undefined
  return Math.min(parsed, 500)
}

/**
 * Element selector shared by windows_find / windows_read / windows_click /
 * windows_type: every given field is a case-insensitive substring test and all
 * of them must match. `index` picks among the matches of the same selector, in
 * the order windows_find prints them, so an index alone is ambiguous and is
 * rejected by the helper.
 */
function elementSelectorSchema(description: string) {
  return {
    type: 'object' as const,
    additionalProperties: false,
    description,
    properties: {
      index: { type: 'integer' as const, description: 'Optional 0-based index among the elements matching the other fields, in the order windows_find prints them; defaults to the first match.' },
      name: { type: 'string' as const, description: 'Case-insensitive substring of the element name.' },
      type: { type: 'string' as const, description: 'Case-insensitive substring of the UI Automation control type short name (Button, Edit, Text, ...); a "ControlType." prefix is accepted too.' },
      automationId: { type: 'string' as const, description: 'Case-insensitive substring of the element AutomationId.' },
      className: { type: 'string' as const, description: 'Case-insensitive substring of the element class name.' },
    },
  }
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
    description: 'Capture the desktop UI state for automation: virtual screen size, foreground window, visible windows, and the interactive element tree (buttons, edits, list items, menus, links, ...) of the foreground window, each with screen coordinates. Set `window` to capture a specific window by title substring instead. Coordinates are virtual-desktop pixels with origin at the top-left; windows_click takes CLIENT coordinates of the window you pass, so prefer windows_find plus an element selector when you want to act on a specific control.',
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
    description: 'Capture a PNG screenshot (DPI-aware, physical pixels) and return it so you can see the screen. By default the physical screen is captured; give `window` to capture one window in the background instead — this works even when that window is covered by other windows, without disturbing the user (minimized windows are not supported). Give x, y, width, height for a region and scale (1-4) to enlarge small text or icons; in window mode the region is relative to the captured window image. A region must be given completely: x, y, width and height together, never a subset. An existing filePath is refused unless overwrite is true. Prefer windows_snapshot when you need interactive element coordinates, because a screenshot shows pixels only.',
    parameters: {
      filePath: { type: 'string', description: 'Optional absolute path for the PNG file; must end with .png and must not already exist unless overwrite is true. Defaults to a fresh timestamped file under the system temporary directory.' },
      overwrite: { type: 'boolean', description: 'Allow replacing an existing file at filePath; defaults to false, in which case the call fails instead of overwriting.' },
      attachImage: { type: 'boolean', description: 'Set false to skip returning the image and only save the file; defaults to true.' },
      window: { type: 'string', description: 'Optional window target: title substring, process name (e.g. Weixin), or PID. Captures that window in the background instead of the screen.' },
      x: { type: 'integer', description: 'Optional region left edge; requires y, width and height as well.' },
      y: { type: 'integer', description: 'Optional region top edge; requires x, width and height as well.' },
      width: { type: 'integer', description: 'Optional region width; requires x, y and height as well.' },
      height: { type: 'integer', description: 'Optional region height; requires x, y and width as well.' },
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
      const generatedPath = args.filePath === undefined
      const path = args.filePath ?? defaultScreenshotPath()
      const request: Record<string, unknown> = { cmd: 'screenshot', path }
      // Retention applies only to the directory this plugin names itself.
      if (generatedPath) {
        request.prune = true
        const keep = screenshotKeep()
        if (keep !== undefined) request.pruneKeep = keep
      }
      if (args.window !== undefined) request.window = args.window
      // Forward region arguments one by one: the helper rejects a partial set
      // instead of silently capturing the whole screen.
      if (args.x !== undefined) request.x = args.x
      if (args.y !== undefined) request.y = args.y
      if (args.width !== undefined) request.width = args.width
      if (args.height !== undefined) request.height = args.height
      if (args.scale !== undefined) request.scale = args.scale
      if (args.overwrite === true) request.overwrite = true
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
    name: 'windows_find',
    description: 'Locate elements inside one window and print them one per line as `[i] <name> | <type> | automationId=<id> | rect=<screen x>,<y>,<w>,<h> | enabled=<true|false>`. `i` is exactly the `element.index` accepted by windows_click / windows_read / windows_type, so a find followed by an action on the same selector is coherent. The type vocabulary is the UI Automation short name (Button, Edit, Text, ListItem, MenuItem, Document, Pane, ...). Every given field matches case-insensitively as a substring and all fields must match. Only on-screen elements with a non-empty rectangle are listed, so a control currently scrolled out of view is not reported. No match prints `no element matched` — an empty result, not an error. No interactive-type whitelist is applied, so static text and container panes are listed too. `limit` defaults to 20 and is capped at 200; when the list is cut short, a final `truncated:` line states how many elements matched in total.',
    parameters: {
      window: { type: 'string', required: true, description: 'Window to search: title substring, process name (e.g. Weixin), or PID.' },
      name: { type: 'string', description: 'Optional case-insensitive substring of the element name.' },
      type: { type: 'string', description: 'Optional case-insensitive substring of the UI Automation control type short name (Button, Edit, Text, ...); a "ControlType." prefix is accepted too.' },
      automationId: { type: 'string', description: 'Optional case-insensitive substring of the element AutomationId.' },
      className: { type: 'string', description: 'Optional case-insensitive substring of the element class name. Classic Win32 and Qt apps expose their controls by class (e.g. WindowsForms10.EDIT...) rather than by automation id.' },
      limit: { type: 'integer', description: 'Maximum number of element lines; defaults to 20, capped at 200.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    timeoutMs: 30000,
    isConcurrencySafe: () => false,
    async execute(args) {
      const request: Record<string, unknown> = { cmd: 'find', target: args.window }
      if (args.name !== undefined) request.name = args.name
      if (args.type !== undefined) request.type = args.type
      if (args.automationId !== undefined) request.automationId = args.automationId
      if (args.className !== undefined) request.className = args.className
      if (args.limit !== undefined) request.limit = args.limit
      return callHost(request, 30000)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'windows_read',
    description: 'Read text out of a window or out of one element. With `element` (and `window` as the search root) it reads that element: UI Automation ValuePattern first, then TextPattern, then the element name. With `window` alone it returns the text of the largest readable Document/Edit control inside that window — static labels are not included, so a window whose text lives in labels reports `(no readable text control inside the window)`. With neither it reads the currently focused control. Read-only: it never changes focus and never writes.',
    parameters: {
      window: { type: 'string', description: 'Window target: title substring, process name, or PID. Omitted together with element, the focused control is read instead.' },
      element: elementSelectorSchema('Optional element to read inside `window`; requires `window` as the search root.'),
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    timeoutMs: 30000,
    isConcurrencySafe: () => false,
    async execute(args) {
      if (args.element !== undefined && args.window === undefined) throw new Error('reading an element needs window (the target window to search in)')
      const request: Record<string, unknown> = { cmd: 'read' }
      if (args.window !== undefined) request.target = args.window
      if (args.element !== undefined) request.element = args.element
      return callHost(request, 30000)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'windows_click',
    description: 'Click a mouse button by posting the message to one window. This plugin runs in strict background mode: `window` is required, the click is always posted to that window (x, y are CLIENT coordinates of it, the same space as the windows_screenshot image of that window), the cursor is never moved and no foreground input is ever injected. Instead of x/y you may pass `element` (also with `window`): the host locates the element with UI Automation and posts the click at the centre of its rectangle, reporting the targeted element, the point that was actually under that spot when the message was delivered, and `strategy=background-post`. Replies always end with `verified=false`: delivery of the message is observable, the application reacting to it is not. Known platform limits: a posted click is not turned into an input event by WPF/WinUI (measured: eight variants — Post/Send, with and without WM_MOUSEMOVE, client or screen coordinates, with WM_MOUSEACTIVATE — none of them fired a WPF button handler), and Chromium/Electron apps may ignore synthetic clicks; on those, the click can be delivered without the application reacting, and this plugin deliberately offers no foreground alternative.',
    parameters: {
      x: { type: 'integer', description: 'Client x coordinate of the click point in `window`; required unless `element` is given.' },
      y: { type: 'integer', description: 'Client y coordinate of the click point in `window`; required unless `element` is given.' },
      button: { type: 'string', enum: ['left', 'right', 'double'], description: 'Which click to perform; defaults to a single left click.' },
      window: { type: 'string', required: true, description: 'Window target: title substring, process name (e.g. Weixin), or PID. The click is posted to that window in the background.' },
      element: elementSelectorSchema('Optional element to click instead of x/y; requires `window`. The reply names the targeted element and `strategy=background-post`.'),
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    timeoutMs: 15000,
    isConcurrencySafe: () => false,
    async execute(args) {
      if (args.window === undefined) {
        throw new Error('this plugin runs in strict background mode: windows_click needs window (title substring, process name, or PID) because the click is posted to that window; there is no foreground fallback')
      }
      if (args.element !== undefined) {
        return callHost({ cmd: 'mouse', mode: 'click', button: args.button ?? 'left', window: args.window, element: args.element }, 15000)
      }
      if (args.x === undefined || args.y === undefined) throw new Error('windows_click needs x and y (client coordinates of window), or element together with window')
      return callHost({ cmd: 'mouse', mode: 'click', x: args.x, y: args.y, button: args.button ?? 'left', window: args.window }, 15000)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'windows_scroll',
    description: 'Scroll the mouse wheel inside one window by posting wheel messages to it: `amount` wheel clicks, positive scrolls up and negative scrolls down. This plugin runs in strict background mode, so `window` is required and the pointer is never moved; the scroll is delivered to that window and the application decides whether it reacts.',
    parameters: {
      amount: { type: 'integer', required: true, description: 'Number of wheel clicks; negative values scroll down.' },
      window: { type: 'string', required: true, description: 'Window target: title substring, process name, or PID; the scroll is posted to that window in the background.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    timeoutMs: 15000,
    isConcurrencySafe: () => false,
    async execute(args) {
      if (args.amount === 0) throw new Error('scroll amount must not be zero')
      if (args.window === undefined) {
        throw new Error('this plugin runs in strict background mode: windows_scroll needs window (title substring, process name, or PID) because the wheel messages are posted to that window; there is no foreground fallback')
      }
      return callHost({ cmd: 'mouse', mode: 'scroll', amount: args.amount, window: args.window }, 15000)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'windows_type',
    description: "Post text to one window in the background with exact Unicode input (spaces, punctuation, CJK and symbols are preserved). This plugin runs in strict background mode: `window` is required, the text is posted to that window, and no foreground key or clipboard input is ever injected. With `element` (plus `window` as the search root) the text is written to that element through the remaining background legs, and every reply ends with `[strategy=<leg>] [verified=<true|false>]`: `wm-settext` (WM_SETTEXT to the element's native window handle), then `keystream` (the background character stream posted to that handle). The UIA ValuePattern leg was removed because on WPF it can bring the target window to the foreground, so an element without a native window handle (for example a WPF TextBox) is refused with an explanation instead of failing silently. `verified=true` only when the text could be read back from the element; the clipboard is never written by this tool, and `clear` cannot replace a selection in the background paths. Known limits: classic Win32 and Qt apps accept posted text (WeChat 4.x byte encoding is handled automatically); WPF/WinUI do not turn posted input into input events, and WinUI/UWP apps may garble CJK.",
    parameters: {
      text: { type: 'string', required: true, description: 'The text to post to `window`.' },
      clear: { type: 'boolean', description: 'Ignored in strict background mode: posted characters cannot replace an existing selection.' },
      window: { type: 'string', required: true, description: 'Window target: title substring, process name (e.g. Weixin), or PID. The text is posted to that window in the background.' },
      element: elementSelectorSchema('Optional element to write into instead of the window-level character stream; requires `window`. The reply names the strategy leg that carried the text, whether it could be read back, and `activated=true` if the target window ended up in the foreground.'),
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    timeoutMs: 30000,
    isConcurrencySafe: () => false,
    async execute(args) {
      if (args.text.length === 0) throw new Error('text must not be empty')
      if (args.window === undefined) {
        throw new Error('this plugin runs in strict background mode: windows_type needs window (title substring, process name, or PID) because the text is posted to that window; there is no foreground fallback')
      }
      const request: Record<string, unknown> = { cmd: 'type', text: args.text, clear: args.clear === true, window: args.window }
      if (args.element !== undefined) request.element = args.element
      return callHost(request, 30000)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'windows_shortcut',
    description: "Post a keyboard shortcut to one window, for example 'ctrl+s', 'alt+tab' or a single key like 'enter'. This plugin runs in strict background mode, so `window` is required: the key messages are posted to that window and no foreground keys are ever injected. Best-effort: classic Win32 apps accept them, while Chromium/Electron and WPF/WinUI apps may ignore some or all of them. Supported names: ctrl, alt, shift, win, a-z, 0-9, f1-f12, enter, tab, esc, space, backspace, delete, insert, up, down, left, right, home, end, pageup, pagedown, minus, equal, comma, period, slash.",
    parameters: {
      keys: { type: 'string', required: true, description: "Keys joined with '+', pressed in order and released in reverse, e.g. 'ctrl+alt+delete'." },
      window: { type: 'string', required: true, description: 'Window target: title substring, process name, or PID; the keys are posted to that window in the background.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    timeoutMs: 20000,
    isConcurrencySafe: () => false,
    async execute(args) {
      if (args.window === undefined) {
        throw new Error('this plugin runs in strict background mode: windows_shortcut needs window (title substring, process name, or PID) because the keys are posted to that window; there is no foreground fallback')
      }
      return callHost({ cmd: 'keys', keys: args.keys, window: args.window }, 20000)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'windows_window',
    description: 'Move, resize, minimize, maximize, restore, close or pin a window, and report the rectangle and state measured AFTER the operation. These actions do not request the foreground: move/resize/topmost use SetWindowPos with SWP_NOACTIVATE, minimize/maximize/restore use ShowWindow, close posts WM_CLOSE, and the layer contains no foreground-request call at all (this plugin runs in strict background mode). That is not a promise that no window reaches the foreground: minimizing a window that is currently foreground hands the foreground to the next window in Z order (Windows semantics), and a target application can activate its own window by itself. The cursor is not moved by these calls. An action is reported as successful only when the fresh measurement agrees with the request — move/resize allow a 2 px rounding slack for DPI-scaled windows (farther off still fails), and the reply always carries the measured rectangle rather than an echo of the request. Consequences worth knowing: moving or resizing a minimized window cannot take effect (restore it first), and `close` waits up to 1.5 s and fails if the window is still there, e.g. because it is showing a confirmation dialog. There is deliberately no activate/focus action: this plugin runs in strict background mode and leaves bringing a window to the front to the user.',
    parameters: {
      action: { type: 'string', enum: ['move', 'resize', 'minimize', 'maximize', 'restore', 'close', 'topmost'], required: true, description: 'Operation to perform.' },
      target: { type: 'string', required: true, description: 'Window target: title substring, process name, or PID.' },
      x: { type: 'integer', description: 'Target screen x for move (required), or an optional x when resizing.' },
      y: { type: 'integer', description: 'Target screen y for move (required), or an optional y when resizing.' },
      width: { type: 'integer', description: 'Target width for resize (required, positive).' },
      height: { type: 'integer', description: 'Target height for resize (required, positive).' },
      on: { type: 'boolean', description: 'For topmost: true pins the window above others, false unpins it; defaults to true.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    timeoutMs: 20000,
    isConcurrencySafe: () => false,
    async execute(args) {
      const request: Record<string, unknown> = { cmd: 'winop', action: args.action, target: args.target }
      if (args.x !== undefined) request.x = args.x
      if (args.y !== undefined) request.y = args.y
      if (args.width !== undefined) request.width = args.width
      if (args.height !== undefined) request.height = args.height
      if (args.on !== undefined) request.on = args.on
      return callHost(request, 20000)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'windows_process',
    description: 'Enumerate top-level windows, one line per window as `<pid> <name> | <title> | visible=<true|false>`. By default only visible windows that carry a title are listed, so a process with several hidden helper windows cannot push its real window out of `limit`; pass `includeHidden: true` to list those hidden windows as well, which is the only case where a line reads visible=false. Read-only: nothing is started or terminated. `name` filters the process image name case-insensitively as a substring (a trailing .exe is ignored; a plain number is matched against the pid instead). No match prints `no process matched`. `limit` defaults to 50 and is capped at 200.',
    parameters: {
      name: { type: 'string', description: 'Optional case-insensitive substring of the process image name (e.g. Weixin, chrome); a trailing .exe is ignored, and a plain number is matched against the pid.' },
      includeHidden: { type: 'boolean', description: 'Also list hidden top-level windows of those processes; defaults to false, so every line reads visible=true.' },
      limit: { type: 'integer', description: 'Maximum number of window lines; defaults to 50, capped at 200.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    timeoutMs: 30000,
    isConcurrencySafe: () => false,
    async execute(args) {
      const request: Record<string, unknown> = { cmd: 'procs' }
      if (args.name !== undefined) request.name = args.name
      if (args.includeHidden === true) request.includeHidden = true
      if (args.limit !== undefined) request.limit = args.limit
      return callHost(request, 30000)
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
    description: 'Wait until a desktop condition becomes true instead of sleeping blindly, then return; it fails with a timeout error when the condition never appears. Conditions: foreground (the foreground window title contains `value`), window (any visible window title contains `value`), element (an element matching name/type/automationId/className appears inside `target`; the reply carries the matching element line in the same format as windows_find), windowgone (no top-level window matches `target` any more), text (the text of `target` contains `value`; same text source as windows_read with a window, so labels do not count, and a short context snippet is returned), pixel (the screen pixel at x, y changes from its color at call time), region (the average pixel difference inside x, y, width, height exceeds `threshold`, default 20; works for web-style UI that never changes window titles), settle (the region — or the whole screen when omitted — stays unchanged for `stableFrames` consecutive frames, default 3; use after any action to wait for rendering to finish). The region conditions take x, y, width and height together or not at all. Empty values are rejected: an empty title substring matches every window and would report success instantly.',
    parameters: {
      kind: { type: 'string', enum: ['foreground', 'window', 'element', 'windowgone', 'text', 'pixel', 'region', 'settle'], required: true, description: 'Condition to wait for.' },
      value: { type: 'string', description: 'Title substring for the foreground/window conditions, or the substring to look for in kind text: required and must not be empty for those kinds, unused otherwise.' },
      target: { type: 'string', description: 'Window target: for kind element/text the window to search or read, for kind windowgone the window that should disappear — title substring, process name, or PID.' },
      name: { type: 'string', description: 'Kind element: case-insensitive substring of the element name.' },
      type: { type: 'string', description: 'Kind element: case-insensitive substring of the UI Automation control type short name (Button, Edit, Text, ...).' },
      automationId: { type: 'string', description: 'Kind element: case-insensitive substring of the element AutomationId.' },
      className: { type: 'string', description: 'Kind element: case-insensitive substring of the element class name.' },
      x: { type: 'integer', description: 'Screen x coordinate: the pixel for kind pixel, or the region left edge for kind region/settle (all four region values must be given together).' },
      y: { type: 'integer', description: 'Screen y coordinate: the pixel for kind pixel, or the region top edge for kind region/settle (all four region values must be given together).' },
      width: { type: 'integer', description: 'Region width for kind region/settle; omit all four region values to watch the whole screen.' },
      height: { type: 'integer', description: 'Region height for kind region/settle; omit all four region values to watch the whole screen.' },
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
      if ((args.kind === 'foreground' || args.kind === 'window') && (args.value === undefined || args.value.length === 0)) {
        throw new Error(`wait_for kind "${args.kind}" needs a non-empty value (the title substring to wait for)`)
      }
      if (args.kind === 'element') {
        if (args.target === undefined) throw new Error('wait_for kind "element" needs target (the window to search in)')
        if (args.name === undefined && args.type === undefined && args.automationId === undefined && args.className === undefined) {
          throw new Error('wait_for kind "element" needs at least one of name, type, automationId, className')
        }
      }
      if (args.kind === 'windowgone' && args.target === undefined) {
        throw new Error('wait_for kind "windowgone" needs target (the window that should disappear)')
      }
      if (args.kind === 'text') {
        if (args.target === undefined) throw new Error('wait_for kind "text" needs target (the window whose text is read)')
        if (args.value === undefined || args.value.length === 0) throw new Error('wait_for kind "text" needs a non-empty value (the substring to look for in the window text)')
      }
      const request: Record<string, unknown> = { cmd: 'waitfor', kind: args.kind }
      if (args.value !== undefined) request.value = args.value
      if (args.target !== undefined) request.target = args.target
      if (args.name !== undefined) request.name = args.name
      if (args.type !== undefined) request.type = args.type
      if (args.automationId !== undefined) request.automationId = args.automationId
      if (args.className !== undefined) request.className = args.className
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
