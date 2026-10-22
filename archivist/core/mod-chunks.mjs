/**
 * archivist Phase 1 — pure chunking / tokenizing / anchor helpers.
 * Owner: impl-chunks. Authority: docs/p1-contract.md §2.1 (tokenizer), §3 (chunking + address).
 *
 * No imports at all: keeps the module directly runnable (`node core/mod-chunks.mjs`) and
 * inlinable by build/build.mjs (which strips relative imports / leading `export `).
 *
 * Namespace rule (contract §1 v2): every internal symbol carries the `ch_` prefix — after
 * inlining all modules share one top-level scope. Only the frozen API names are unprefixed.
 *
 * Invariant enforced by chunkDocument: for every returned chunk
 *   body.slice(charStart, charEnd) === text
 * (char offsets are relative to the body — i.e. the text after frontmatter; callers pass body).
 */

// ---------------------------------------------------------------- constants

// Same character class as core's legacy tokenizeQuery so the query side and the document
// side agree: latin/digit words, lowercase, length >= 2.
const ch_LATIN_RE = /[a-z0-9_][a-z0-9_-]+/g
// CJK ideographs + kana (same ranges as core tokenizeQuery).
const ch_CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]+/g
const ch_WS_RE = /\s/
const ch_SENT_END_RE = /[。！？；!?;]/
const ch_HEADING_RE = /^(#{1,6})[ \t]+(\S.*?)[ \t]*#*[ \t]*$/
const ch_FENCE_RE = /^[ \t]*(`{3,}|~{3,})/
const ch_ANCHOR_RE = /^(.*?)(?:@([0-9a-fA-F]{6,64}))?(?:#c(\d+))?(?:\[(\d+):(\d+)\])?$/

/**
 * Chunking/tokenizing logic version. Stored in the index meta; a change means every stored
 * chunk was produced by older logic, so mod-indexdb rebuilds the index on open.
 * Bump when chunk boundaries, heading paths or tokenize() output change.
 */
export const ch_CHUNKER_VERSION = 1

/** CJK/kana/full-width code points — the exact classification used by core's estimateTokens. */
function ch_isCjkCp(cp) {
  return (cp >= 0x3040 && cp <= 0x30ff) || (cp >= 0x3400 && cp <= 0x4dbf)
    || (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0xf900 && cp <= 0xfaff)
    || (cp >= 0x3000 && cp <= 0x303f) || (cp >= 0xff00 && cp <= 0xffef)
}

// ---------------------------------------------------------------- estimate / tokenize

/** Token estimate, identical in accounting to core `estimateTokens` (CJK≈1/char, latin≈4 chars). */
export function estimateTokens(text) {
  const s = String(text ?? '')
  let cjk = 0
  let other = 0
  for (let i = 0; i < s.length;) {
    const cp = s.codePointAt(i)
    if (ch_isCjkCp(cp)) cjk++
    else other++
    i += cp > 0xffff ? 2 : 1
  }
  return Math.round(cjk + other / 4)
}

/**
 * Pre-tokenizer shared by the index writer and the query side (contract §2.1):
 *   latin/digits → lowercase words (`[a-z0-9_][a-z0-9_-]+`, len >= 2);
 *   CJK/kana     → adjacent bigrams (全国, 国地 …) + the whole run when len >= 3;
 *   single-char CJK runs are kept as one token so a 1-char query still matches.
 * Full-width ASCII and U+3000 are folded to half-width first so a normalised query and a
 * raw document tokenize identically.
 * Returns string[] preserving multiplicity (term frequency feeds bm25); callers building an
 * FTS MATCH string must de-duplicate and drop tokens that are pure symbols.
 */
export function tokenize(text) {
  const out = []
  const lower = String(text ?? '')
    .replace(/[\uff01-\uff5e]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, ' ')
    .toLowerCase()
  for (const m of lower.matchAll(ch_LATIN_RE)) out.push(m[0])
  for (const m of lower.matchAll(ch_CJK_RE)) {
    const run = m[0]
    if (run.length === 1) { out.push(run); continue }
    for (let i = 0; i < run.length - 1; i++) out.push(run.slice(i, i + 2))
    if (run.length >= 3) out.push(run)
  }
  return out
}

// ---------------------------------------------------------------- anchors

/**
 * 'wiki/foo.md@a1b2c3d4#c3[120:480]'. Optional pieces are omitted when their argument is
 * null/undefined, so the same helper also renders the shorter read-tool spellings
 * ('wiki/foo.md#c3', 'wiki/foo.md@a1b2c3d4').
 */
export function formatAnchor(anchorPath, sha256, ord, charStart, charEnd) {
  let out = String(anchorPath ?? '').replace(/\\/g, '/')
  if (sha256) out += '@' + String(sha256).slice(0, 8)
  if (ord !== null && ord !== undefined && Number.isFinite(Number(ord))) out += '#c' + Number(ord)
  if (charStart !== null && charStart !== undefined && charEnd !== null && charEnd !== undefined) {
    out += '[' + Number(charStart) + ':' + Number(charEnd) + ']'
  }
  return out
}

/** Inverse of formatAnchor; absent parts stay undefined ({path, sha8?, ord?, start?, end?}). */
export function parseAnchor(anchor) {
  const raw = String(anchor ?? '').trim()
  const m = ch_ANCHOR_RE.exec(raw)
  if (!m) return { path: raw.replace(/\\/g, '/') }
  const out = { path: m[1].replace(/\\/g, '/') }
  if (m[2]) out.sha8 = m[2].toLowerCase()
  if (m[3] !== undefined) out.ord = Number(m[3])
  if (m[4] !== undefined) { out.start = Number(m[4]); out.end = Number(m[5]) }
  return out
}

// ---------------------------------------------------------------- chunking helpers

function ch_clampInt(v, dflt, lo, hi) {
  const n = Math.trunc(Number(v))
  if (!Number.isFinite(n)) return dflt
  return Math.min(hi, Math.max(lo, n))
}
function ch_clampNum(v, dflt, lo, hi) {
  const n = Number(v)
  if (!Number.isFinite(n)) return dflt
  return Math.min(hi, Math.max(lo, n))
}
function ch_trimEnd(text, end, start) {
  while (end > start && ch_WS_RE.test(text[end - 1])) end--
  return end
}

/** ATX headings outside fenced code blocks, each with its (max 3 level) heading path. */
function ch_scanHeadings(text) {
  const out = []
  const stack = []
  const len = text.length
  let fence = ''
  let pos = 0
  while (pos <= len) {
    let nl = text.indexOf('\n', pos)
    if (nl < 0) nl = len
    const line = text.slice(pos, nl)
    if (nl > pos) {
      const fm = ch_FENCE_RE.exec(line)
      if (fm) {
        const mark = fm[1][0]
        if (!fence) fence = mark
        else if (fence === mark) fence = ''
      } else if (!fence) {
        const hm = ch_HEADING_RE.exec(line)
        if (hm) {
          const level = hm[1].length
          const title = hm[2].trim()
          while (stack.length && stack[stack.length - 1].level >= level) stack.pop()
          // Deeper-than-3 headings keep the deepest 3 levels (self + nearest ancestors):
          // the section's own title is the strongest signal for heading matching.
          const headingPath = [...stack.map((s) => s.title), title].slice(-3).join(' > ')
          stack.push({ level, title })
          out.push({ start: pos, lineEnd: nl, path: headingPath })
        }
      }
    }
    if (nl >= len) break
    pos = nl + 1
  }
  return out
}

function ch_collectSections(text) {
  const headings = ch_scanHeadings(text)
  const len = text.length
  const sections = []
  const preambleEnd = headings.length ? headings[0].start : len
  const pe = ch_trimEnd(text, preambleEnd, 0)
  let ps = 0
  while (ps < pe && ch_WS_RE.test(text[ps])) ps++
  if (pe > ps) sections.push({ start: ps, end: pe, contentStart: ps, path: '' })
  for (let i = 0; i < headings.length; i++) {
    const h = headings[i]
    const next = i + 1 < headings.length ? headings[i + 1].start : len
    let cs = h.lineEnd < len ? h.lineEnd + 1 : len
    while (cs < next && ch_WS_RE.test(text[cs])) cs++
    sections.push({ start: h.start, end: next, contentStart: cs, path: h.path })
  }
  return sections
}

/** Next word start at/after pos; falls back to pos when there is no whitespace before limit. */
function ch_snapForward(text, pos, limit) {
  let p = pos
  while (p < limit && !ch_WS_RE.test(text[p])) p++
  if (p >= limit) return pos
  while (p < limit && ch_WS_RE.test(text[p])) p++
  return p
}

/**
 * End offset of one leaf starting at `start`: accumulate token cost up to maxTokens, then
 * snap back to the last sentence / paragraph break if that keeps >= ~60% of the budget.
 * Per-char accounting matches estimateTokens, so tokenEst never exceeds maxTokens.
 */
function ch_leafEnd(text, start, regionEnd, maxTokens, minBoundary) {
  let tok = 0
  let i = start
  let lastBoundary = -1
  const budget = maxTokens - 1 // rounding slack for estimateTokens' Math.round
  while (i < regionEnd) {
    const cp = text.codePointAt(i)
    const size = cp > 0xffff ? 2 : 1
    if (tok + (ch_isCjkCp(cp) ? 1 : 0.25) > budget) break
    tok += ch_isCjkCp(cp) ? 1 : 0.25
    i += size
    if (size === 1) {
      const ch = text[i - 1]
      if (ch === '\n') {
        let j = i
        while (j < regionEnd && (text[j] === ' ' || text[j] === '\t' || text[j] === '\r')) j++
        if (j < regionEnd && text[j] === '\n') lastBoundary = j + 1
      } else if (ch_SENT_END_RE.test(ch)) {
        lastBoundary = i
      }
    }
  }
  if (i >= regionEnd) return ch_trimEnd(text, regionEnd, start)
  const budgetEnd = i
  if (lastBoundary > start && lastBoundary - start >= Math.max(minBoundary, Math.round((budgetEnd - start) * 0.6))) {
    return ch_trimEnd(text, lastBoundary, start)
  }
  let cut = budgetEnd
  while (cut > start && !ch_WS_RE.test(text[cut - 1])) cut--
  if (cut <= start) cut = budgetEnd
  return cut
}

/** Leaves of one section content region: ~300–500 tokens, ~12% character overlap, exact spans. */
function ch_buildLeaves(text, regionStart, regionEnd, opts) {
  const leaves = []
  let cursor = regionStart
  let guard = 0
  while (cursor < regionEnd) {
    let start = cursor
    while (start < regionEnd && ch_WS_RE.test(text[start])) start++
    if (start >= regionEnd) break
    const end = ch_leafEnd(text, start, regionEnd, opts.maxTokens, opts.minBoundary)
    if (end <= start) break
    leaves.push({ start, end })
    if (end >= regionEnd) break
    const span = end - start
    const overlapChars = Math.max(1, Math.round(span * opts.overlapRatio))
    let ns = end - overlapChars
    if (ns <= start) ns = start + 1
    ns = ch_snapForward(text, ns, end)
    if (ns >= end) ns = end - 1
    if (ns <= start) ns = start + 1
    cursor = ns
    if (++guard > 200000) break
  }
  // A tiny tail leaf reads like a fragment; fold it into the previous leaf, but never past
  // maxTokens (a leaf above the budget would break the "300–500 token" contract).
  if (leaves.length > 1) {
    const last = leaves[leaves.length - 1]
    const prev = leaves[leaves.length - 2]
    if (estimateTokens(text.slice(prev.start, last.end)) <= opts.maxTokens) {
      leaves.pop()
      prev.end = last.end
    }
  }
  return leaves
}

/**
 * Two-level chunks of a body (frontmatter already removed). Contract §3.
 * opts: { targetTokens=400, maxTokens=500, overlapRatio=0.12 }.
 * @returns {{ord:number, kind:'section'|'leaf', parentOrd:number|null, headingPath:string,
 *            charStart:number, charEnd:number, tokenEst:number, text:string}[]}
 */
export function chunkDocument(text, opts = {}) {
  const body = text == null ? '' : String(text)
  if (!body.trim()) return []
  const targetTokens = ch_clampInt(opts.targetTokens, 400, 80, 2000)
  const maxTokens = ch_clampInt(opts.maxTokens, 500, Math.max(targetTokens, 120), 4000)
  const overlapRatio = ch_clampNum(opts.overlapRatio, 0.12, 0.1, 0.15)
  const minBoundary = Math.max(40, targetTokens - 100)
  const out = []
  let ord = 0
  for (const sec of ch_collectSections(body)) {
    const secStart = sec.start
    const secEnd = ch_trimEnd(body, sec.end, secStart)
    if (secEnd <= secStart) continue
    const secText = body.slice(secStart, secEnd)
    if (!secText.trim()) continue
    const secOrd = ord++
    out.push({
      ord: secOrd, kind: 'section', parentOrd: null, headingPath: sec.path,
      charStart: secStart, charEnd: secEnd, tokenEst: estimateTokens(secText), text: secText,
    })
    if (sec.contentStart >= secEnd) continue
    for (const leaf of ch_buildLeaves(body, sec.contentStart, secEnd, { maxTokens, overlapRatio, minBoundary })) {
      const leafText = body.slice(leaf.start, leaf.end)
      out.push({
        ord: ord++, kind: 'leaf', parentOrd: secOrd, headingPath: sec.path,
        charStart: leaf.start, charEnd: leaf.end, tokenEst: estimateTokens(leafText), text: leafText,
      })
    }
  }
  return out
}

// ---------------------------------------------------------------- runnable self-check
// `node core/mod-chunks.mjs` — the invariant this module exists for: spans round-trip exactly.
if (process.argv[1] && /mod-chunks\.mjs$/.test(process.argv[1])) {
  const ch_body = [
    '# 全国土地制度', '',
    '土地制度是全国性的制度安排。'.repeat(40), '',
    '## 城市土地', '',
    '```md', '## 这不是标题', '```', '',
    ('城市土地规划需要兼顾效率与公平。' + 'planning efficiency matters. '.repeat(10) + '\n\n').repeat(6),
    '### 深一层', '', 'a'.repeat(1200), '',
    '#### 第四级', '', 'deep heading truncation check.',
  ].join('\n')
  const ch_chunks = chunkDocument(ch_body)
  let ch_bad = 0
  for (const c of ch_chunks) {
    if (ch_body.slice(c.charStart, c.charEnd) !== c.text) ch_bad++
    if (c.tokenEst !== estimateTokens(c.text)) ch_bad++
  }
  const ch_leaves = ch_chunks.filter((c) => c.kind === 'leaf')
  console.log(JSON.stringify({
    chunks: ch_chunks.length,
    leaves: ch_leaves.length,
    spanErrors: ch_bad,
    leafTokens: ch_leaves.map((c) => c.tokenEst),
    paths: [...new Set(ch_chunks.map((c) => c.headingPath))],
    anchor: parseAnchor(formatAnchor('wiki/a.md', 'a1b2c3d4e5f6', 3, 120, 480)),
    tokens: tokenize('全国土地制度 B+ o(logn) ＡＢＣ'),
  }, null, 2))
  if (ch_bad || !ch_chunks.length || !ch_leaves.length) process.exitCode = 1
}
