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
          const path = args.filePath ?? defaultShotPath()
          const request: Record<string, unknown> = { cmd: "screenshot", path }
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
        name: "click",
        description: "Click a mouse button and report the UI element under the point (UIA hit-test). Default: screen coordinates on the real desktop (moves the cursor, changes focus). With `window`: x, y are CLIENT coordinates and the click is posted in the background without moving the mouse or changing focus (best-effort; classic Win32 and Qt apps incl. WeChat 4.x are reliable, Chromium/Electron may ignore).",
        input: {
          type: "object",
          properties: {
            x: { type: "number", description: "X coordinate (client x when window is set)." },
            y: { type: "number", description: "Y coordinate (client y when window is set)." },
            button: { type: "string", enum: ["left", "right", "double"], description: "Which click; defaults to single left click." },
            window: { type: "string", description: "Window target: title substring, process name (e.g. Weixin), or PID; posts the click in the background." },
          },
          required: ["x", "y"],
          additionalProperties: false,
        },
        options: { namespace: "windows", codemode: true },
        execute: async (input) => {
          const args = input as { x: number; y: number; button?: string; window?: string }
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
        description: "Type text into the focused control with exact Unicode input; the focused control is read back and the call fails if the text did not land. Mode 'keys' (default) types per character; 'paste' uses the clipboard for bulk text. `clear` selects all first; `activate` brings a window forward atomically; `window` posts to that window in the background (no focus change, not verified, clear ignored; CJK is handled automatically for WeChat 4.x and classic Win32, may garble in WinUI/UWP apps).",
        input: {
          type: "object",
          properties: {
            text: { type: "string", description: "Text to type." },
            clear: { type: "boolean", description: "Select all (Ctrl+A) before typing; default false." },
            mode: { type: "string", enum: ["keys", "paste"], description: "Input method; default 'keys'." },
            activate: { type: "string", description: "Window title substring, process name, or PID to activate first, atomically." },
            window: { type: "string", description: "Window target: title substring, process name (e.g. Weixin), or PID; posts the text in the background." },
          },
          required: ["text"],
          additionalProperties: false,
        },
        options: { namespace: "windows", codemode: true },
        execute: async (input) => {
          const args = input as { text: string; clear?: boolean; mode?: string; activate?: string; window?: string }
          if (args.text.length === 0) throw new Error("text must not be empty")
          const request: Record<string, unknown> = { cmd: "type", text: args.text, clear: args.clear === true, mode: args.mode ?? "keys" }
          if (args.activate !== undefined) request.activate = args.activate
          if (args.window !== undefined) request.window = args.window
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
        description: "Wait until a desktop condition becomes true (fails with a timeout error otherwise): foreground (foreground window title contains value), window (any visible window title contains value), pixel (screen pixel at x,y changes), region (average pixel difference in x,y,width,height exceeds threshold, default 20 — works for web-style UI), settle (region or whole screen unchanged for stableFrames consecutive frames, default 3 — wait for rendering after any action). The region conditions take x, y, width and height together or not at all.",
        input: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["foreground", "window", "pixel", "region", "settle"], description: "Condition to wait for." },
            value: { type: "string", description: "Title substring for foreground/window: required and must not be empty for those kinds." },
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
          const args = input as { kind: string; value?: string; x?: number; y?: number; width?: number; height?: number; threshold?: number; stableFrames?: number; timeoutSeconds?: number }
          if (args.kind === "pixel" && (args.x === undefined || args.y === undefined)) throw new Error("pixel condition requires x and y")
          const request: Record<string, unknown> = { cmd: "waitfor", kind: args.kind }
          if (args.value !== undefined) request.value = args.value
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
