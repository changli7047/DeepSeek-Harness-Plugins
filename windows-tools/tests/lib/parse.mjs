/**
 * Parsers for the frozen host output formats (plugin-review/windows-tools-protocol-v2.md).
 *
 * They are deliberately tolerant about *position* of optional decorations
 * (e.g. ` topmost` may be appended after `state=` or at the end of the line)
 * and strict about the facts the suite asserts.
 */

import { existsSync, readFileSync } from 'node:fs'

/**
 * Fixture activation log: `<HH:mm:ss.fff> isActive=<True|False>` lines written by the test
 * windows themselves. Local truth (it does not depend on the desktop having a foreground
 * window), and the basis for the "longest foreground occupancy" number the suite reports.
 */
export function readActivationLog(logPath) {
  if (!existsSync(logPath)) return []
  return readFileSync(logPath, 'utf8').trim().split(/\r?\n/)
    .map((line) => /^(\d{2}):(\d{2}):(\d{2})\.(\d{3})\s+isActive=(True|False)/.exec(line.trim()))
    .filter((m) => m !== null)
    .map((m) => ({
      at: Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000,
      active: m[5] === 'True',
    }))
}

export function fixtureIsActive(logPath) {
  const events = readActivationLog(logPath)
  return events.length > 0 ? events[events.length - 1].active : false
}

/** Seconds-of-day for a Date.now() value, comparable with the fixture's own clock. */
export function secondsOfDay(ms) {
  const d = new Date(ms)
  return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds() + d.getMilliseconds() / 1000
}

/**
 * Occupancy stats for one fixture: how many times it was activated, the longest single
 * occupancy in seconds, and whether it is still holding the foreground.
 * `now` (seconds-of-day) is only used to measure an occupancy that never closed.
 */
export function activationStats(logPath, now = null) {
  const events = readActivationLog(logPath)
  let activations = 0
  let longest = 0
  let openedAt = null
  for (const event of events) {
    if (event.active) {
      activations++
      if (openedAt === null) openedAt = event.at
    } else if (openedAt !== null) {
      longest = Math.max(longest, event.at - openedAt)
      openedAt = null
    }
  }
  const holding = openedAt !== null
  if (holding && now !== null) longest = Math.max(longest, Math.max(0, now - openedAt))
  return { activations, longest, holding, events }
}

export function parseWindowLines(statusText) {
  const out = []
  for (const raw of String(statusText ?? '').split(/\r?\n/)) {
    const marker = /^\s*\[(FG|\s*)\]/.exec(raw)
    const rect = /@\((-?\d+),(-?\d+)\s(\d+)x(\d+)\)/.exec(raw)
    const pid = /pid=(\d+)/.exec(raw)
    if (marker === null || rect === null || pid === null) continue
    const title = /"(.*)"\s*pid=/.exec(raw)
    const process = /process=(\S+)/.exec(raw)
    const state = /state=(\w+)/.exec(raw)
    out.push({
      foreground: marker[1] === 'FG',
      title: title === null ? '' : title[1],
      pid: Number(pid[1]),
      process: process === null ? '' : process[1],
      state: state === null ? 'unknown' : state[1],
      topmost: /\stopmost\b/.test(raw),
      x: Number(rect[1]), y: Number(rect[2]), w: Number(rect[3]), h: Number(rect[4]),
      raw: raw.trim(),
    })
  }
  return out
}

/** The window line whose title contains `needle` (case-insensitive). */
export function windowLineFor(statusText, needle) {
  const wanted = String(needle).toLowerCase()
  return parseWindowLines(statusText).find((w) => w.title.toLowerCase().includes(wanted)) ?? null
}

export function foregroundLine(statusText) {
  const line = /^foreground:\s"(.*)"\shandle=(.*)$/m.exec(String(statusText ?? ''))
  return line === null ? null : { title: line[1], handle: line[2].trim() }
}

export function cursorOf(statusText) {
  const m = /cursor:\s*\((-?\d+),\s*(-?\d+)\)/.exec(String(statusText ?? ''))
  return m === null ? null : { x: Number(m[1]), y: Number(m[2]) }
}

export function savedPath(screenshotOutput) {
  const m = /^saved:\s(.+?)\|width:(\d+)\|height:(\d+)\|scale:([\d.]+)\|source:(.*)$/m.exec(String(screenshotOutput ?? ''))
  return m === null ? null : { path: m[1], width: Number(m[2]), height: Number(m[3]), scale: Number(m[4]), source: m[5].trim() }
}

/** Lines produced by `find`: `[i] <name> | <type> | automationId=<id> | rect=x,y,w,h | enabled=<b>` */
export function parseFindLines(findOutput) {
  const out = []
  for (const raw of String(findOutput ?? '').split(/\r?\n/)) {
    const m = /^\[(\d+)\]\s(.*?)\s\|\s(.+?)\s\|\sautomationId=(.*?)\s\|\srect=(-?\d+),(-?\d+),(\d+),(\d+)\s\|\senabled=(true|false)\s*$/.exec(raw.trim())
    if (m === null) continue
    out.push({
      index: Number(m[1]),
      name: m[2],
      type: m[3],
      automationId: m[4],
      rect: { x: Number(m[5]), y: Number(m[6]), w: Number(m[7]), h: Number(m[8]) },
      enabled: m[9] === 'true',
      raw: raw.trim(),
    })
  }
  return out
}

export function findLineWith(findOutput, predicate) {
  return parseFindLines(findOutput).find(predicate) ?? null
}

export function strategyOf(text) {
  const m = /\[?\s*strategy[=:]\s*([a-z-]+)/.exec(String(text ?? ''))
  return m === null ? null : m[1]
}

export function verifiedOf(text) {
  const m = /\[?\s*verified[=:]\s*(true|false)/.exec(String(text ?? ''))
  return m === null ? null : m[1] === 'true'
}

export function prunedOf(text) {
  const m = /pruned=(\d+)(?:\s*\((\d+)\s+failures?\))?/.exec(String(text ?? ''))
  return m === null ? null : { count: Number(m[1]), failures: m[2] === undefined ? 0 : Number(m[2]) }
}

/**
 * v2 §20: when a call activates the target window, the receipt must say so.
 * Returns true / false / null (null = the flag is absent, which is the expected shape
 * when nothing was activated).
 */
export function activatedOf(text) {
  const m = /(?:\[|\s)activated[=:]\s*(true|false)/.exec(String(text ?? ''))
  return m === null ? null : m[1] === 'true'
}

/**
 * `winop` receipt:
 *   winop <action>: "<title>" handle=<n> [requested=x,y[,w,h] ]rect=x,y,w,h state=<...> visible=<b> topmost=<b> verified=<b>
 */
export function parseWinopReceipt(text) {
  const raw = String(text ?? '')
  const action = /winop\s+([a-z]+)\s*:/i.exec(raw)
  const rect = /rect=(-?\d+),(-?\d+),(\d+),(\d+)/.exec(raw)
  const state = /state=(\w+)/.exec(raw)
  const visible = /visible=(true|false)/.exec(raw)
  const topmost = /topmost=(true|false)/.exec(raw)
  const verified = /verified=(true|false)/.exec(raw)
  const requested = /requested=(-?\d+),(-?\d+)(?:,(\d+),(\d+))?/.exec(raw)
  return {
    raw: raw.trim(),
    action: action === null ? null : action[1],
    rect: rect === null ? null : { x: Number(rect[1]), y: Number(rect[2]), w: Number(rect[3]), h: Number(rect[4]) },
    state: state === null ? null : state[1],
    visible: visible === null ? null : visible[1] === 'true',
    topmost: topmost === null ? null : topmost[1] === 'true',
    verified: verified === null ? null : verified[1] === 'true',
    requested: requested === null ? null : {
      x: Number(requested[1]), y: Number(requested[2]),
      w: requested[3] === undefined ? null : Number(requested[3]),
      h: requested[4] === undefined ? null : Number(requested[4]),
    },
  }
}

/** `procs` lines: `<pid> <name> | <title> | visible=<b>` */
export function parseProcsLines(text) {
  const out = []
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const m = /^(\d+)\s+(\S+)\s\|\s(.*?)\s\|\svisible=(true|false)\s*$/.exec(raw.trim())
    if (m === null) continue
    out.push({ pid: Number(m[1]), name: m[2], title: m[3], visible: m[4] === 'true', raw: raw.trim() })
  }
  return out
}

export function elapsedOf(text) {
  const m = /after\s+(\d+)\s*ms/.exec(String(text ?? ''))
  return m === null ? null : Number(m[1])
}

/** v2 §5 + §11: the full token set. `background-post` is the *default* element-click
 *  path (it must not steal focus); `uia-invoke-pattern` is only reachable through an
 *  explicit allowForeground:true, which this suite never sends. */
export const STRATEGY_VALUES = ['background-post', 'uia-invoke-pattern', 'uia-value-pattern', 'wm-settext', 'keystream']
