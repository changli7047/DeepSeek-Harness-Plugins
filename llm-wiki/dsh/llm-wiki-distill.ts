/**
 * llm-wiki distill hook for DeepSeek Harness (scratch plugin, local dev copy).
 *
 * Injects model-facing advisory notices that steer durable conversation
 * knowledge into the llm-wiki knowledge base:
 *
 * - First run after install: asks the user once whether previous conversations
 *   should be distilled into llm-wiki (one notice, then never again — the ask
 *   is recorded in the state file);
 * - Every `LLM_WIKI_DISTILL_NUDGE` steps (default 12, 0 disables): a light
 *   reminder to file important decisions through the wiki_* tools.
 *
 * Advisory only: notices ride the `agent/pre-step` waterfall into the same
 * step's model request and never block, veto, or delay anything. State is a
 * best-effort JSON file; a failed write may re-ask once.
 *
 * Env overrides (scratch-plugin convention; a repo version would take Config):
 *   LLM_WIKI_DISTILL_STATE  — state file path (default $DSH_HOME|~/.dsh/llm-wiki-distill.json)
 *   LLM_WIKI_DISTILL_NUDGE  — nudge interval in steps (default 12; 0 disables)
 *
 * @module scratch-llm-wiki-distill
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed, MessageSource } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'llm-wiki-distill': { kind: 'llm-wiki-distill' } & ContextFormed
  }
}

export const name = 'scratch-llm-wiki-distill'

/** Producer source stamped on every notice this hook injects (the label keeps it from rendering as a user prompt). */
const NOTICE_SOURCE: MessageSource = { kind: 'llm-wiki-distill' }

const FIRST_RUN_TEXT = [
  'llm-wiki 蒸馏钩子首次运行：用户刚刚把 llm-wiki 本地知识库接入了本 harness。',
  '请先用一句话询问用户：「要不要把你之前和我的对话内容蒸馏进 llm-wiki？」',
  '说明要点：只提炼关键决策、结论与方法，不全量搬运聊天记录；可让用户指定时间范围或会话。',
  '用户同意后再执行（逐段提炼成 wiki 页面，用 wiki_write / wiki_log 写入，参考工作区 AGENTS.md 的 schema）。',
  '用户说不用就跳过，不要再问。问完后继续当前正常的任务。',
].join('\n')

const NUDGE_TEXT = [
  'llm-wiki 提醒：若刚才的对话产生了值得长期保留的内容（决策、结论、方法、重要事实），',
  '请用 llm-wiki 工具沉淀（wiki_write 写页 / wiki_log 记一条）。',
  '没有值得沉淀的请忽略本提醒——不要为填而填，也不要因此打断用户。',
].join('')

/** Build one advisory notice message. */
function notice(text: string, summary: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { ...NOTICE_SOURCE, form: 'notice', summary },
  })
}

/** Install the hook's listeners. */
export function apply(ctx: Context): void {
  const nudgeRaw = process.env.LLM_WIKI_DISTILL_NUDGE
  const nudgeEvery = nudgeRaw === undefined ? 12 : Number(nudgeRaw)
  if (!Number.isInteger(nudgeEvery) || nudgeEvery < 0) {
    throw new Error(`llm-wiki-distill: LLM_WIKI_DISTILL_NUDGE must be an integer >= 0, got ${String(nudgeRaw)}`)
  }
  const stateFile = process.env.LLM_WIKI_DISTILL_STATE
    ?? path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'llm-wiki-distill.json')

  const readState = (): Record<string, unknown> => {
    try { return JSON.parse(readFileSync(stateFile, 'utf8')) as Record<string, unknown> } catch { return {} }
  }
  const writeState = (state: Record<string, unknown>): void => {
    try {
      mkdirSync(path.dirname(stateFile), { recursive: true })
      writeFileSync(stateFile, JSON.stringify(state, null, 2))
    } catch {
      // Best-effort: a failed write may re-ask the first-run question once.
    }
  }

  const steps = new WeakMap<Agent, number>()

  ctx.on('agent/pre-step', async ({ agent }, next): Promise<PreStepDecision> => {
    const notices: UserMessage[] = []
    const state = readState()
    if (state.askedPrevDistill !== true) {
      notices.push(notice(FIRST_RUN_TEXT, 'llm-wiki first run'))
      state.askedPrevDistill = true
      state.askedAt = new Date().toISOString()
      writeState(state)
    } else if (nudgeEvery > 0) {
      const count = (steps.get(agent) ?? 0) + 1
      steps.set(agent, count)
      if (count % nudgeEvery === 0) notices.push(notice(NUDGE_TEXT, `llm-wiki nudge ×${count}`))
    }
    const downstream = await next()
    if (downstream.kind !== 'enter' || notices.length === 0) return downstream
    return { ...downstream, messages: [...notices, ...downstream.messages] }
  })
}
