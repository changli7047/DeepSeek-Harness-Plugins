/**
 * archivist Phase 5 — deterministic intent classifier.
 *
 * Contract: docs/p5-contract.md §1. Pure functions, no imports, no model: the
 * point is to ROUTE a question (top-K vs scan vs claims vs timeline), not to
 * understand it. Every rule is regex-based and explainable, so a wrong verdict is
 * reproducible and fixable by editing one pattern.
 *
 * Exported API (frozen):
 *   classifyIntent(query)          → { intent, matched, reasons: string[] }
 *   intentRoutingHint(intent)      → string  (one line to append to tool output)
 *   intentWantsClaims(intent)      → boolean
 *
 * Intent values: 'aggregation' | 'current-state' | 'timeline' | 'explanation' | 'lookup'.
 * Priority: aggregation > current-state > timeline > explanation > lookup.
 */

/** Marker words per intent; CJK and English mixed on purpose (the corpus is mixed). */
const p5_RULES = [
  {
    intent: 'aggregation',
    patterns: [
      /全部|所有|每一个|每一|一共|总共|合计|数量|多少个?|多少条|多少项|几条|几项|几次|几个|哪些|清单|列出|列一下|汇总|统计/,
      /\b(count|how many|list all|list every|all of|every|total|aggregate)\b/i,
    ],
  },
  {
    intent: 'current-state',
    patterns: [
      /现在|目前|当前|最新|最新版|如今|当前值|现在是多少|还在用|截至|到今天|现在还是|还有效/,
      /\b(current|currently|latest|as of|now|up to date)\b/i,
    ],
  },
  {
    intent: 'timeline',
    patterns: [
      /什么时候|何时|历史|变更|改过几次|时间线|先后|演进|迭代|后来|哪天|哪一天|二〇|日期是/,
      // An explicit date in the question is an as-of / point-in-time question:
      // "2026-12-01 时全国地图尺寸" must route to the dated-history path (and the
      // claims layer), not to a plain lookup.
      /\d{4}\s*[-./年]\s*\d{1,2}/,
      /\b(timeline|history|when did|changelog|which day)\b/i,
    ],
  },
  {
    intent: 'explanation',
    patterns: [
      /为什么|为何|如何|怎么|原因|原理|机制|怎么实现/,
      /\b(why|how does|explain|reason)\b/i,
    ],
  },
]

/** Count-unit words: an aggregation cue only outranks current-state when the
 *  question actually asks for a tally ("多少条/多少张/一共/哪些"), not when a
 *  current-state marker ("现在/截至/当前") is combined with a value question
 *  ("是多少格/是多少"). Without this, "现在全国图是多少格" was routed to
 *  aggregation and got told to run a scan instead of a claims lookup. */
const p5_COUNT_UNIT = /一共|总共|合计|数量|多少[条项个张座次家门种层]|几条|几项|几次|几个|哪些|清单|列出|统计/

/**
 * Classify one query. Collects every rule that matches, then resolves the two
 * ambiguous combinations instead of relying on rule order alone:
 *   aggregation × current-state → count-unit words decide;
 *   timeline × explanation    → timeline wins (a "why did it change when"
 *                                question still needs the dated history).
 * @param {string} query raw query text
 * @returns {{intent: string, matched: string[], reasons: string[]}}
 */
export function classifyIntent(query) {
  const text = String(query ?? '')
  if (!text.trim()) return { intent: 'lookup', matched: [], reasons: ['empty query'] }
  const hits = new Map()
  for (const rule of p5_RULES) {
    const matched = []
    for (const pattern of rule.patterns) {
      const m = pattern.exec(text)
      if (m) matched.push(m[0])
    }
    if (matched.length) hits.set(rule.intent, matched)
  }
  if (hits.size === 0) {
    const question = /[?？]|吗|呢/.test(text)
    return {
      intent: question ? 'explanation' : 'lookup',
      matched: [],
      reasons: [question ? 'question form, no specific cue → explanation' : 'no cue → lookup'],
    }
  }
  if (hits.has('aggregation') && hits.has('current-state')) {
    if (p5_COUNT_UNIT.test(text)) {
      return { intent: 'aggregation', matched: [...hits.get('aggregation'), ...hits.get('current-state')], reasons: ['aggregation × current-state → count-unit words present, keep aggregation'] }
    }
    return { intent: 'current-state', matched: [...hits.get('current-state'), ...hits.get('aggregation')], reasons: ['aggregation × current-state → value question ("多少/多少格"), route current-state'] }
  }
  // Priority order of the rule table wins for every other combination.
  for (const rule of p5_RULES) {
    if (hits.has(rule.intent)) {
      return { intent: rule.intent, matched: hits.get(rule.intent), reasons: [`matched ${rule.intent} cue(s): ${hits.get(rule.intent).join(', ')}`] }
    }
  }
  return { intent: 'lookup', matched: [], reasons: ['no rule matched'] }
}

/** One-line routing advice appended to tool output. Empty for lookup/explanation. */
export function intentRoutingHint(intent) {
  switch (intent) {
    case 'aggregation':
      return '⚠ 这是聚合问题：top-K 结果不能代表全库。请用 archivist_scan 取精确计数（或 archivist_claim 的 list），并在答案里声明覆盖（基于 N 条 / X 个文件）。'
    case 'current-state':
      return '⚠ 这是当前状态问题：优先采信 claims 中 valid_to=null 的当前值；若同一属性有多个历史值，必须同时给出日期。'
    case 'timeline':
      return '⚠ 这是时间线问题：按事件时间排序，每个节点带日期与出处锚点；不要只给一个结论。'
    default:
      return ''
  }
}

/** Whether the claims table can answer this intent better than plain retrieval. */
export function intentWantsClaims(intent) {
  return intent === 'current-state' || intent === 'timeline' || intent === 'aggregation'
}
