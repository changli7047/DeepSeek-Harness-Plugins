/**
 * Minimal assertion helpers for the windows-tools regression suite.
 *
 * Every check throws CheckFail with a machine-readable label plus the raw
 * evidence, so a failing run shows *which clause* broke and *what the host
 * actually said* instead of "expected true, got false".
 */

/** Thrown by a case that cannot run in this environment; reported as SKIP, not FAIL. */
export class Skip extends Error {
  constructor(reason) {
    super(reason)
    this.name = 'Skip'
  }
}

/**
 * Thrown when a case's preconditions were not met, so its judgement could not be
 * exercised (e.g. the test window was already in the foreground, so "did this call
 * activate it?" cannot be answered). Reported as INCONCLUSIVE — never as a pass: a case
 * that judged nothing must not pretend it did.
 */
export class Inconclusive extends Error {
  constructor(reason) {
    super(reason)
    this.name = 'Inconclusive'
  }
}

export class CheckFail extends Error {
  constructor(label, detail) {
    super(label)
    this.name = 'CheckFail'
    this.label = label
    this.detail = detail ?? ''
  }
}

export class Check {
  constructor() {
    this.passed = []
  }

  #fail(label, detail) {
    throw new CheckFail(label, detail)
  }

  ok(condition, label, detail = '') {
    if (!condition) this.#fail(label, detail)
    this.passed.push(label)
  }

  eq(actual, expected, label, detail = '') {
    if (actual !== expected) {
      this.#fail(label, `${detail}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`.trim())
    }
    this.passed.push(label)
  }

  contains(haystack, needle, label, detail = '') {
    const text = String(haystack ?? '')
    if (!text.includes(needle)) {
      this.#fail(label, `${detail}\n  wanted substring: ${JSON.stringify(needle)}\n  in: ${JSON.stringify(clip(text))}`.trim())
    }
    this.passed.push(label)
  }

  notContains(haystack, needle, label, detail = '') {
    const text = String(haystack ?? '')
    if (text.includes(needle)) {
      this.#fail(label, `${detail}\n  unwanted substring: ${JSON.stringify(needle)}\n  in: ${JSON.stringify(clip(text))}`.trim())
    }
    this.passed.push(label)
  }

  match(value, pattern, label, detail = '') {
    const text = String(value ?? '')
    if (!pattern.test(text)) {
      this.#fail(label, `${detail}\n  wanted pattern: ${String(pattern)}\n  in: ${JSON.stringify(clip(text))}`.trim())
    }
    this.passed.push(label)
  }

  /**
   * A command that MUST fail loudly: success here is the bug being tested.
   * Only host-level failures count — a harness error (timeout, TypeError, bad path)
   * is re-thrown so it can never be mistaken for the expected refusal.
   */
  async fails(fn, label, { expect = null } = {}) {
    let value
    try {
      value = await fn()
    } catch (error) {
      if (error instanceof CheckFail) throw error
      if (typeof error.raw !== 'string') throw error // not a host refusal: a real harness failure
      const raw = error.raw
      if (expect !== null && !String(raw).includes(expect)) {
        this.#fail(`${label} (wrong error text)`, `  wanted error containing: ${JSON.stringify(expect)}\n  got: ${JSON.stringify(clip(String(raw)))}`)
      }
      this.passed.push(label)
      return String(raw)
    }
    this.#fail(`${label} (silently succeeded)`, `  the command was expected to fail, but returned:\n  ${JSON.stringify(clip(String(value)))}`)
  }
}

function clip(text, max = 600) {
  return text.length <= max ? text : `${text.slice(0, max)}… (${text.length} chars)`
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Red-line guard: did `operation()` move the real mouse pointer?
 *
 * A bare "cursor before === cursor after" check is not usable on a machine where a
 * human is working (their own pointer movement looks identical to a stolen cursor).
 * So the guard first measures whether the pointer is drifting *on its own*: if the
 * environment is moving the pointer, the check reports itself as unverifiable (and the
 * caller logs it) instead of inventing either a pass or a failure.
 *
 * Returns { verified, reason? }. Uses ctx.host() and ctx.check.
 */
export async function cursorGuard(ctx, operation, label) {
  const { cursorOf } = await import('./parse.mjs')
  const read = async () => cursorOf(await ctx.host().ok({ cmd: 'status' }))
  const idle1 = await read()
  await sleep(400)
  const idle2 = await read()
  const environmentMoves = idle1 === null || idle2 === null || idle1.x !== idle2.x || idle1.y !== idle2.y

  const before = idle2
  await operation()
  const after = await read()
  if (before === null || after === null) {
    return { verified: false, reason: 'status did not report a cursor position' }
  }
  if (before.x === after.x && before.y === after.y) {
    ctx.check.passed.push(label)
    return { verified: true }
  }
  if (environmentMoves) {
    return { verified: false, reason: `the pointer was already moving on its own (${JSON.stringify(idle1)} -> ${JSON.stringify(idle2)}), so the change cannot be attributed to the operation` }
  }
  const tail1 = await read()
  await sleep(400)
  const tail2 = await read()
  if (tail1 !== null && tail2 !== null && (tail1.x !== tail2.x || tail1.y !== tail2.y)) {
    return { verified: false, reason: 'the pointer started moving on its own right after the operation (user activity)' }
  }
  ctx.check.ok(false, label, `  cursor moved across the operation: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`)
  return { verified: true }
}

