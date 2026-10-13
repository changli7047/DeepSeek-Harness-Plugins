/**
 * Windows desktop tools for OpenCode v2, registered as a Code Mode plugin.
 *
 * Drives the persistent PowerShell helper host (wt-host.ps1, sibling file)
 * over one-JSON-per-line stdin/stdout: UI Automation snapshots, background
 * window screenshots, exact Unicode input, mouse, clipboard, activation and
 * deterministic waiting. The maintained source of truth of the host script is
 * scratch-plugin/host/wt-host.ps1 in the deepseek-harness repo.
 */
import { Plugin } from "@opencode/plugin"
import { spawn } from "node:child_process"
import { mkdirSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const HOST_PATH = join(dirname(fileURLToPath(import.meta.url)), "wt-host.ps1")
const POWERSHELL = process.env.SystemRoot !== undefined
  ? join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
  : "powershell.exe"

interface PendingCall {
  resolve: (output: string) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

interface HostState {
  child: ReturnType<typeof spawn>
  pending: PendingCall[]
  buffer: string
}

export default Plugin.define({
  id: "windows-tools",
  async setup(ctx) {
    let host: HostState | undefined

    const killHost = (error: Error): void => {
      const current = host
      host = undefined
      if (current === undefined) return
      for (const call of current.pending.splice(0)) {
        clearTimeout(call.timer)
        call.reject(error)
      }
      current.child.kill()
    }

    const ensureHost = (): HostState => {
      if (host !== undefined) return host
      const child = spawn(POWERSHELL, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", HOST_PATH], {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      })
      const state: HostState = { child, pending: [], buffer: "" }
      host = state

      const handleLine = (line: string): void => {
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
        if (message.ok === true) call.resolve(String(message.output ?? ""))
        else call.reject(new Error(String(message.error ?? "windows helper command failed")))
      }

      child.stdout?.on("data", (chunk: Buffer) => {
        state.buffer += chunk.toString("utf8")
        let index = state.buffer.indexOf("\n")
        while (index >= 0) {
          const line = state.buffer.slice(0, index)
          state.buffer = state.buffer.slice(index + 1)
          if (line.trim().length > 0) handleLine(line)
          index = state.buffer.indexOf("\n")
        }
      })
      child.stderr?.setEncoding("utf8")
      child.stderr?.on("data", () => {})
      child.on("close", () => {
        if (host !== state) return
        host = undefined
        for (const call of state.pending.splice(0)) {
          clearTimeout(call.timer)
          call.reject(new Error("windows helper exited unexpectedly"))
        }
      })
      return state
    }

    const encodeRequest = (request: Record<string, unknown>): string =>
      JSON.stringify(request).replace(/[\u007f-\uffff]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`)

    const callHost = (request: Record<string, unknown>, timeoutMs = 30000): Promise<string> => {
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

    const defaultShotPath = (): string => {
      const dir = join(tmpdir(), "opencode-windows-tools")
      mkdirSync(dir, { recursive: true })
      const stamp = new Date().toISOString().replace(/[:.]/g, "-")
      return join(dir, `screenshot-${stamp}.png`)
    }

    // Retention override for screenshots this plugin names itself. The helper
    // prunes only when the request carries `prune`, and that flag is set only for
    // the plugin's own default directory, never for a caller-supplied filePath.
    const screenshotKeep = (): number | undefined => {
      const raw = process.env.WINDOWS_TOOLS_SCREENSHOT_KEEP
      if (raw === undefined || raw.trim() === "") return undefined
      const parsed = Number.parseInt(raw, 10)
      if (!Number.isFinite(parsed) || parsed < 1) return undefined
      return Math.min(parsed, 500)
    }

    // Element selector shared by windows.find/read/click/type: every given field
    // matches case-insensitively as a substring and all of them must match.
    const elementSelector = (description: string) => ({
      type: "object",
      additionalProperties: false,
      description,
      properties: {
        index: { type: "integer", description: "0-based index among the elements matching the other fields, in the order windows.find prints them; defaults to the first match." },
        name: { type: "string", description: "Case-insensitive substring of the element name." },
        type: { type: "string", description: "Case-insensitive substring of the UIA control type short name (Button, Edit, Text, ...)." },
        automationId: { type: "string", description: "Case-insensitive substring of the element AutomationId." },
        className: { type: "string", description: "Case-insensitive substring of the element class name." },
      },
    })

    const asText = (content: string) => ({ content })

    await ctx.tool.transform((editor) => {
      editor.namespace({ name: "windows", description: "Windows desktop observation and automation" })

      editor.add({
        name: "status",
        description: "Environment overview of the Windows desktop: virtual screen and monitor layout, cursor position, foreground window, and every visible top-level window with rectangle, process name, state, and foreground marker. Cheap; use windows.snapshot when you need interactive element coordinates.",
        input: { type: "object", properties: {}, additionalProperties: false },
        options: { namespace: "windows", codemode: true },
        execute: async () => asText(await callHost({ cmd: "status" }, 15000)),
      })

      editor.add({
        name: "snapshot",
        description: "Capture the desktop UI state: screen and foreground window, visible windows, and the full interactive element tree (buttons, edits, list items, menus, links, ...) of the foreground window with screen coordinates. Set `target` for a specific window by title substring. Coordinates are virtual-desktop pixels; pass them to windows.click/move/drag.",
        input: {
          type: "object",
          properties: { target: { type: "string", description: "Window target: title substring, process name, or PID; captures that window's element tree instead of the foreground window." } },
          additionalProperties: false,
        },
        options: { namespace: "windows", codemode: true },
        execute: async (input) => {
          const args = input as { target?: string }
          const request: Record<string, unknown> = { cmd: "snapshot" }
          if (args.target !== undefined) request.target = args.target
          return asText(await callHost(request, 60000))
        },
      })

      editor.add({
        name: "screenshot",
        description: "Capture a PNG screenshot (DPI-aware, physical pixels). Default captures the whole screen; `window` captures one window in the background (works when occluded; minimized windows are not supported); x/y/width/height select a region and must be given together; scale (1-4) enlarges it. An existing filePath is refused unless overwrite is true. Returns the saved file path — read it with the read tool to view the image.",
        input: {
          type: "object",
          properties: {
            filePath: { type: "string", description: "Absolute path for the PNG; must end with .png and must not already exist unless overwrite is true. Defaults to a fresh timestamped temp file." },
            overwrite: { type: "boolean", description: "Allow replacing an existing file at filePath; defaults to false, in which case the call fails instead of overwriting." },
            window: { type: "string", description: "Window target: title substring, process name (e.g. Weixin), or PID; captures that window in the background." },
            x: { type: "number", description: "Region left edge (requires y, width and height as well)." },
            y: { type: "number", description: "Region top edge (requires x, width and height as well)." },
            width: { type: "number", description: "Region width (requires x, y and height as well)." },
            height: { type: "number", description: "Region height (requires x, y and width as well)." },
            scale: { type: "number", description: "Enlargement factor 1-4; defaults to 1." },
          },
          additionalProperties: false,
        },
        options: { namespace: "windows", codemode: true },
        execute: async (input) => {
          const args = input as { filePath?: string; overwrite?: boolean; window?: string; x?: number; y?: number; width?: number; height?: number; scale?: number }
          const generatedPath = args.filePath === undefined
          const path = args.filePath ?? defaultShotPath()
          const request: Record<string, unknown> = { cmd: "screenshot", path }
          // Retention applies only to the directory this plugin names itself.
          if (generatedPath) {
            request.prune = true
            const keep = screenshotKeep()
            if (keep !== undefined) request.pruneKeep = keep
          }
          if (args.window !== undefined) request.window = args.window
          // Forward region arguments one by one: the helper rejects a partial set
          // instead of silently capturing the whole screen.
          if (args.x !== undefined) request.x = Math.round(args.x)
          if (args.y !== undefined) request.y = Math.round(args.y)
          if (args.width !== undefined) request.width = Math.round(args.width)
          if (args.height !== undefined) request.height = Math.round(args.height)
          if (args.scale !== undefined) request.scale = args.scale
          if (args.overwrite === true) request.overwrite = true
          const response = await callHost(request, 60000)
          const geometry = /^saved: (.+)\|width:(\d+)\|height:(\d+)\|scale:([0-9.]+)\|source:/.exec(response)
          if (geometry === null) throw new Error(`screenshot helper returned an unexpected result: ${response}`)
          const finalPath = geometry[1] ?? path
          const width = Number(geometry[2])
          const height = Number(geometry[3])
          const scale = Number(geometry[4])
          const bytes = statSync(finalPath).size
          const scaledNote = scale > 1 ? ` Image is ${String(scale)}x enlarged: divide image coordinates by ${String(scale)} for screen coordinates.` : ""
          return asText(`Screenshot saved to ${finalPath} (${String(width)}x${String(height)} px, ${String(bytes)} bytes).${scaledNote}`)
        },
      })

      editor.add({
        name: "find",
        description: "Locate elements inside one window: one line per element as `[i] <name> | <type> | automationId=<id> | rect=<screen x>,<y>,<w>,<h> | enabled=<true|false>`. `i` is the same `element.index` that windows.click/read/type accept. Type names are the UIA short names (Button, Edit, Text, ...). Each field matches case-insensitively as a substring and all given fields must match. Only on-screen elements with a non-empty rectangle are listed. No match prints `no element matched`. All descendant elements are considered (no interactive-type whitelist). `limit` defaults to 20, capped at 200; a trailing `truncated:` line reports the total when the list is cut short.",
        input: {
          type: "object",
          properties: {
            window: { type: "string", description: "Window to search: title substring, process name (e.g. Weixin), or PID." },
            name: { type: "string", description: "Case-insensitive substring of the element name." },
            type: { type: "string", description: "Case-insensitive substring of the UIA control type short name (Button, Edit, Text, ...)." },
            automationId: { type: "string", description: "Case-insensitive substring of the element AutomationId." },
            className: { type: "string", description: "Case-insensitive substring of the element class name. Classic Win32/Qt apps expose controls by class rather than automation id." },
            limit: { type: "number", description: "Maximum number of element lines; default 20, cap 200." },
          },
          required: ["window"],
          additionalProperties: false,
        },
        options: { namespace: "windows", codemode: true },
        execute: async (input) => {
          const args = input as { window: string; name?: string; type?: string; automationId?: string; className?: string; limit?: number }
          const request: Record<string, unknown> = { cmd: "find", target: args.window }
          if (args.name !== undefined) request.name = args.name
          if (args.type !== undefined) request.type = args.type
          if (args.automationId !== undefined) request.automationId = args.automationId
          if (args.className !== undefined) request.className = args.className
          if (args.limit !== undefined) request.limit = Math.round(args.limit)
          return asText(await callHost(request, 30000))
        },
      })

      editor.add({
        name: "read",
        description: "Read text from a window or one element. With `element` (plus `window` as the search root) it reads that element: UIA ValuePattern, then TextPattern, then the element name. With `window` alone it returns the text of the largest readable Document/Edit control inside that window — labels are not included, so a window whose text lives in labels reports `(no readable text control inside the window)`. With neither it reads the focused control. Read-only: it never changes focus.",
        input: {
          type: "object",
          properties: {
            window: { type: "string", description: "Window target: title substring, process name, or PID." },
            element: elementSelector("Element to read inside `window`; requires `window`."),
          },
          additionalProperties: false,
        },
        options: { namespace: "windows", codemode: true },
        execute: async (input) => {
          const args = input as { window?: string; element?: Record<string, unknown> }
          if (args.element !== undefined && args.window === undefined) throw new Error("reading an element needs window (the target window to search in)")
          const request: Record<string, unknown> = { cmd: "read" }
          if (args.window !== undefined) request.target = args.window
          if (args.element !== undefined) request.element = args.element
          return asText(await callHost(request, 30000))
        },
      })

      editor.add({
        name: "click",
        description: "Click a mouse button. Default: screen coordinates on the real desktop (moves the cursor, changes focus). With `window`: x, y are CLIENT coordinates and the click is posted in the background without moving the mouse or changing focus — reliable for classic Win32 and Qt apps incl. WeChat 4.x, but a posted click is NOT turned into an input event by WPF/WinUI (measured: eight variants — Post/Send, with and without WM_MOUSEMOVE, client or screen coordinates, with WM_MOUSEACTIVATE — none fired a WPF button handler), and Chromium/Electron may ignore synthetic clicks too. To actually fire an element in WPF/WinUI pass `allowForeground: true` with `element`, which may bring the target window to the foreground. Instead of x/y you may pass `element` with `window`: the host locates the element and reports the element it hit plus the `strategy` used. The default element strategy is `background-post` (posted click at the element rectangle centre); `uia-invoke-pattern` is attempted only with `allowForeground`. Click replies always end with `verified=false`: delivery is observable, the application reacting is not.",
        input: {
          type: "object",
          properties: {
            x: { type: "number", description: "X coordinate (client x when window is set); required unless element is given." },
            y: { type: "number", description: "Y coordinate (client y when window is set); required unless element is given." },
            button: { type: "string", enum: ["left", "right", "double"], description: "Which click; defaults to single left click. Only a left click can use uia-invoke-pattern." },
            window: { type: "string", description: "Window target: title substring, process name (e.g. Weixin), or PID; posts the click in the background. Required with element." },
            element: elementSelector("Element to click instead of x/y; requires window. The response names the strategy: background-post (default) or uia-invoke-pattern (only with allowForeground)."),
            allowForeground: { type: "boolean", description: "Allow UIA InvokePattern for an element click, which may bring the target window to the foreground; default false." },
          },
          additionalProperties: false,
        },
        options: { namespace: "windows", codemode: true },
        execute: async (input) => {
          const args = input as { x?: number; y?: number; button?: string; window?: string; element?: Record<string, unknown>; allowForeground?: boolean }
          if (args.element !== undefined) {
            if (args.window === undefined) throw new Error("clicking an element needs window (the target window to search in)")
            const request: Record<string, unknown> = { cmd: "mouse", mode: "click", button: args.button ?? "left", window: args.window, element: args.element }
            if (args.allowForeground === true) request.allowForeground = true
            return asText(await callHost(request, 15000))
          }
          if (args.x === undefined || args.y === undefined) throw new Error("click needs x and y, or an element selector with window")
          const request: Record<string, unknown> = { cmd: "mouse", mode: "click", x: Math.round(args.x), y: Math.round(args.y), button: args.button ?? "left" }
          if (args.window !== undefined) request.window = args.window
          return asText(await callHost(request, 15000))
        },
      })

      editor.add({
        name: "move",
        description: "Move the mouse pointer to the given screen coordinates without pressing any button.",
        input: {
          type: "object",
          properties: { x: { type: "number" }, y: { type: "number" } },
          required: ["x", "y"],
          additionalProperties: false,
        },
        options: { namespace: "windows", codemode: true },
        execute: async (input) => {
          const args = input as { x: number; y: number }
          return asText(await callHost({ cmd: "mouse", mode: "move", x: Math.round(args.x), y: Math.round(args.y) }, 15000))
        },
      })

      editor.add({
        name: "drag",
        description: "Drag with the left mouse button held: press at (fromX, fromY), move, release at (x, y).",
        input: {
          type: "object",
          properties: { fromX: { type: "number" }, fromY: { type: "number" }, x: { type: "number" }, y: { type: "number" } },
          required: ["fromX", "fromY", "x", "y"],
          additionalProperties: false,
        },
        options: { namespace: "windows", codemode: true },
        execute: async (input) => {
          const args = input as { fromX: number; fromY: number; x: number; y: number }
          return asText(await callHost({
            cmd: "mouse",
            mode: "drag",
            fromX: Math.round(args.fromX),
            fromY: Math.round(args.fromY),
            x: Math.round(args.x),
            y: Math.round(args.y),
          }, 15000))
        },
      })

      editor.add({
        name: "scroll",
        description: "Scroll the mouse wheel vertically by `amount` wheel clicks (positive up, negative down) and report the UI element under the pointer. With `window` the scroll is posted to that window in the background.",
        input: {
          type: "object",
          properties: {
            amount: { type: "number", description: "Wheel clicks; negative scrolls down." },
            x: { type: "number", description: "Optional pointer x before scrolling." },
            y: { type: "number", description: "Optional pointer y before scrolling." },
            window: { type: "string", description: "Window title substring, process name, or PID; posts the scroll in the background." },
          },
          required: ["amount"],
          additionalProperties: false,
        },
        options: { namespace: "windows", codemode: true },
        execute: async (input) => {
          const args = input as { amount: number; x?: number; y?: number; window?: string }
          if (args.amount === 0) throw new Error("scroll amount must not be zero")
          const request: Record<string, unknown> = { cmd: "mouse", mode: "scroll", amount: Math.round(args.amount) }
          if (args.x !== undefined && args.y !== undefined) {
            request.x = Math.round(args.x)
            request.y = Math.round(args.y)
          }
          if (args.window !== undefined) request.window = args.window
          return asText(await callHost(request, 15000))
        },
      })

      editor.add({
        name: "type",
        description: "Type text into the focused control with exact Unicode input; the focused control is read back and the call fails if the text did not land. Mode 'keys' (default) types per character; 'paste' uses the clipboard for bulk text (the only path that writes the clipboard). `clear` selects all first; `activate` brings a window forward atomically; `window` posts to that window in the background (clear ignored; CJK is handled automatically for WeChat 4.x and classic Win32, may garble in WinUI/UWP apps). With `element` plus `window` the text goes to that element and the response ends with `[strategy=<leg>] [verified=<true|false>]`: `uia-value-pattern`, then `wm-settext`, then `keystream`. Classic Win32/Qt apps expose no ValuePattern, so they land on wm-settext or keystream. The background and element paths never touch the clipboard. The host layer contains no SetForegroundWindow/SetActiveWindow, but the target application's own UI Automation provider may still bring its window forward: on WPF the element path can do that (reproduced in three independent comparisons — 3 of 28 element writes, against 0 of 32 control writes), and the reply then carries `activated=true` instead of staying silent about it. Do not assume the element path leaves the foreground untouched.",
        input: {
          type: "object",
          properties: {
            text: { type: "string", description: "Text to type." },
            clear: { type: "boolean", description: "Select all (Ctrl+A) before typing; default false. Ignored by the background/keystream paths." },
            mode: { type: "string", enum: ["keys", "paste"], description: "Input method; default 'keys'." },
            activate: { type: "string", description: "Window title substring, process name, or PID to activate first, atomically." },
            window: { type: "string", description: "Window target: title substring, process name (e.g. Weixin), or PID; posts the text in the background. Required with element." },
            element: elementSelector("Element to type into instead of the focused control; requires window."),
          },
          required: ["text"],
          additionalProperties: false,
        },
        options: { namespace: "windows", codemode: true },
        execute: async (input) => {
          const args = input as { text: string; clear?: boolean; mode?: string; activate?: string; window?: string; element?: Record<string, unknown> }
          if (args.text.length === 0) throw new Error("text must not be empty")
          if (args.element !== undefined && args.window === undefined) throw new Error("typing into an element needs window (the target window to search in)")
          const request: Record<string, unknown> = { cmd: "type", text: args.text, clear: args.clear === true, mode: args.mode ?? "keys" }
          if (args.activate !== undefined) request.activate = args.activate
          if (args.window !== undefined) request.window = args.window
          if (args.element !== undefined) request.element = args.element
          return asText(await callHost(request, 30000))
        },
      })

      editor.add({
        name: "shortcut",
        description: "Press a keyboard shortcut like 'ctrl+s', 'alt+tab', 'ctrl+shift+esc' or a single key like 'win'. `activate` brings a window forward atomically first; `window` posts the keys to that window in the background (best-effort). Supported names: ctrl, alt, shift, win, a-z, 0-9, f1-f12, enter, tab, esc, space, backspace, delete, insert, arrows, home, end, pageup, pagedown, minus, equal, comma, period, slash.",
        input: {
          type: "object",
          properties: {
            keys: { type: "string", description: "Keys joined with '+', pressed in order and released in reverse." },
            activate: { type: "string", description: "Window title substring, process name, or PID to activate first, atomically." },
            window: { type: "string", description: "Window title substring, process name, or PID; posts the keys in the background." },
          },
          required: ["keys"],
          additionalProperties: false,
        },
        options: { namespace: "windows", codemode: true },
        execute: async (input) => {
          const args = input as { keys: string; activate?: string; window?: string }
          const request: Record<string, unknown> = { cmd: "keys", keys: args.keys }
          if (args.activate !== undefined) request.activate = args.activate
          if (args.window !== undefined) request.window = args.window
          return asText(await callHost(request, 20000))
        },
      })

      editor.add({
        name: "app",
        description: "Launch an application, document or URL (action launch; reports the new window title when one appears) or bring an existing window to the foreground (action activate; target is a title substring, process name, or PID; minimized windows are restored).",
        input: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["launch", "activate"], description: "launch starts something new; activate focuses an existing window." },
            target: { type: "string", description: "Executable/document/URL for launch; title substring, process name, or PID for activate." },
            args: { type: "string", description: "Optional command-line arguments for launch." },
          },
          required: ["action", "target"],
          additionalProperties: false,
        },
        options: { namespace: "windows", codemode: true },
        execute: async (input) => {
          const args = input as { action: string; target: string; args?: string }
          if (args.action === "activate") return asText(await callHost({ cmd: "activate", target: args.target }, 15000))
          const request: Record<string, unknown> = { cmd: "launch", target: args.target }
          if (args.args !== undefined) request.args = args.args
          return asText(await callHost(request, 20000))
        },
      })

      editor.add({
        name: "window",
        description: "Move, resize, minimize, maximize, restore, close or pin a window, and report the rectangle and state measured AFTER the operation. These actions do not request the foreground: move/resize/topmost use SetWindowPos with SWP_NOACTIVATE, minimize/maximize/restore use ShowWindow, close posts WM_CLOSE, and the layer contains no SetForegroundWindow/SetActiveWindow. That is not a promise that no window reaches the foreground: minimizing a window that is currently foreground hands the foreground to the next window in Z order (Windows semantics), and a target application can activate its own window by itself. The cursor is not moved by these calls. An action counts as successful only when the fresh measurement agrees with the request — move/resize allow a 2 px rounding slack for DPI-scaled windows (farther off still fails), and the reply always carries the measured rectangle rather than an echo of the request. Moving or resizing a minimized window cannot take effect (restore it first); `close` waits up to 1.5 s and fails if the window is still there (e.g. a confirmation dialog). There is no activate/focus action — use windows.app with action activate.",
        input: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["move", "resize", "minimize", "maximize", "restore", "close", "topmost"], description: "Operation to perform." },
            target: { type: "string", description: "Window target: title substring, process name, or PID." },
            x: { type: "number", description: "Target x for move (required); optional x when resizing." },
            y: { type: "number", description: "Target y for move (required); optional y when resizing." },
            width: { type: "number", description: "Target width for resize (required, positive)." },
            height: { type: "number", description: "Target height for resize (required, positive)." },
            on: { type: "boolean", description: "topmost: true pins the window above others, false unpins; default true." },
          },
          required: ["action", "target"],
          additionalProperties: false,
        },
        options: { namespace: "windows", codemode: true },
        execute: async (input) => {
          const args = input as { action: string; target: string; x?: number; y?: number; width?: number; height?: number; on?: boolean }
          const request: Record<string, unknown> = { cmd: "winop", action: args.action, target: args.target }
          if (args.x !== undefined) request.x = Math.round(args.x)
          if (args.y !== undefined) request.y = Math.round(args.y)
          if (args.width !== undefined) request.width = Math.round(args.width)
          if (args.height !== undefined) request.height = Math.round(args.height)
          if (args.on !== undefined) request.on = args.on
          return asText(await callHost(request, 20000))
        },
      })

      editor.add({
        name: "process",
        description: "Enumerate top-level windows, one line per window as `<pid> <name> | <title> | visible=<true|false>`. By default only visible windows that carry a title are listed, so a process with several hidden helper windows cannot push its real window out of `limit`; pass `includeHidden: true` to list those hidden windows as well, which is the only case where a line reads visible=false. Read-only: nothing is started or terminated. `name` filters the process image name case-insensitively as a substring (a trailing .exe is ignored; a plain number matches the pid). No match prints `no process matched`. `limit` defaults to 50, cap 200.",
        input: {
          type: "object",
          properties: {
            name: { type: "string", description: "Case-insensitive substring of the process image name (e.g. Weixin, chrome); trailing .exe ignored; a number matches the pid." },
            includeHidden: { type: "boolean", description: "Also list hidden top-level windows of those processes; default false, so every line reads visible=true." },
            limit: { type: "number", description: "Maximum number of window lines; default 50, cap 200." },
          },
          additionalProperties: false,
        },
        options: { namespace: "windows", codemode: true },
        execute: async (input) => {
          const args = input as { name?: string; includeHidden?: boolean; limit?: number }
          const request: Record<string, unknown> = { cmd: "procs" }
          if (args.name !== undefined) request.name = args.name
          if (args.includeHidden === true) request.includeHidden = true
          if (args.limit !== undefined) request.limit = Math.round(args.limit)
          return asText(await callHost(request, 30000))
        },
      })

      editor.add({
        name: "clipboard",
        description: "Read or replace the Windows clipboard text.",
        input: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["get", "set"], description: "get returns the clipboard text; set replaces it." },
            text: { type: "string", description: "Text to place on the clipboard when action is set." },
          },
          required: ["action"],
          additionalProperties: false,
        },
        options: { namespace: "windows", codemode: true },
        execute: async (input) => {
          const args = input as { action: string; text?: string }
          if (args.action === "set") {
            if (args.text === undefined) throw new Error("clipboard set requires text")
            return asText(await callHost({ cmd: "clipboard", action: "set", text: args.text }, 15000))
          }
          const text = await callHost({ cmd: "clipboard", action: "get" }, 15000)
          return asText(text.length === 0 ? "(clipboard is empty)" : text)
        },
      })

      editor.add({
        name: "wait_for",
        description: "Wait until a desktop condition becomes true (fails with a timeout error otherwise): foreground (foreground window title contains value), window (any visible window title contains value), element (an element matching name/type/automationId/className appears inside target; the reply carries the matching element line in windows.find format), windowgone (no top-level window matches target any more), text (the text of target contains value; same text source as windows.read, so labels do not count, and a short context snippet is returned), pixel (screen pixel at x,y changes), region (average pixel difference in x,y,width,height exceeds threshold, default 20 — works for web-style UI), settle (region or whole screen unchanged for stableFrames consecutive frames, default 3 — wait for rendering after any action). The region conditions take x, y, width and height together or not at all. Empty values are rejected.",
        input: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["foreground", "window", "element", "windowgone", "text", "pixel", "region", "settle"], description: "Condition to wait for." },
            value: { type: "string", description: "Title substring for foreground/window, or the substring for kind text: required and non-empty for those kinds." },
            target: { type: "string", description: "Kind element/text: the window to search or read. Kind windowgone: the window that should disappear." },
            name: { type: "string", description: "Kind element: case-insensitive substring of the element name." },
            type: { type: "string", description: "Kind element: case-insensitive substring of the UIA control type short name (Button, Edit, Text, ...)." },
            automationId: { type: "string", description: "Kind element: case-insensitive substring of the element AutomationId." },
            className: { type: "string", description: "Kind element: case-insensitive substring of the element class name." },
            x: { type: "number", description: "Pixel x or region left edge (all four region values must be given together)." },
            y: { type: "number", description: "Pixel y or region top edge (all four region values must be given together)." },
            width: { type: "number", description: "Region width; omit all four region values to watch the whole screen." },
            height: { type: "number", description: "Region height; omit all four region values to watch the whole screen." },
            threshold: { type: "number", description: "Region difference threshold; default 20." },
            stableFrames: { type: "number", description: "Consecutive unchanged frames for settle; default 3." },
            timeoutSeconds: { type: "number", description: "Max wait in seconds; default 10, cap 60." },
          },
          required: ["kind"],
          additionalProperties: false,
        },
        options: { namespace: "windows", codemode: true },
        execute: async (input) => {
          const args = input as { kind: string; value?: string; target?: string; name?: string; type?: string; automationId?: string; className?: string; x?: number; y?: number; width?: number; height?: number; threshold?: number; stableFrames?: number; timeoutSeconds?: number }
          if (args.kind === "pixel" && (args.x === undefined || args.y === undefined)) throw new Error("pixel condition requires x and y")
          if ((args.kind === "foreground" || args.kind === "window") && (args.value === undefined || args.value.length === 0)) throw new Error(`wait_for kind "${args.kind}" needs a non-empty value`)
          if (args.kind === "element") {
            if (args.target === undefined) throw new Error('wait_for kind "element" needs target (the window to search in)')
            if (args.name === undefined && args.type === undefined && args.automationId === undefined && args.className === undefined) throw new Error('wait_for kind "element" needs at least one of name, type, automationId, className')
          }
          if (args.kind === "windowgone" && args.target === undefined) throw new Error('wait_for kind "windowgone" needs target (the window that should disappear)')
          if (args.kind === "text") {
            if (args.target === undefined) throw new Error('wait_for kind "text" needs target (the window whose text is read)')
            if (args.value === undefined || args.value.length === 0) throw new Error('wait_for kind "text" needs a non-empty value (the substring to look for in the window text)')
          }
          const request: Record<string, unknown> = { cmd: "waitfor", kind: args.kind }
          if (args.value !== undefined) request.value = args.value
          if (args.target !== undefined) request.target = args.target
          if (args.name !== undefined) request.name = args.name
          if (args.type !== undefined) request.type = args.type
          if (args.automationId !== undefined) request.automationId = args.automationId
          if (args.className !== undefined) request.className = args.className
          if (args.x !== undefined) request.x = Math.round(args.x)
          if (args.y !== undefined) request.y = Math.round(args.y)
          if (args.width !== undefined) request.width = Math.round(args.width)
          if (args.height !== undefined) request.height = Math.round(args.height)
          if (args.threshold !== undefined) request.threshold = args.threshold
          if (args.stableFrames !== undefined) request.stableFrames = args.stableFrames
          if (args.timeoutSeconds !== undefined) request.timeoutSeconds = args.timeoutSeconds
          return asText(await callHost(request, 65000))
        },
      })
    })
  },
})
