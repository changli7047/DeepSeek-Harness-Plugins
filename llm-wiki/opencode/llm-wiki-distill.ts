/**
 * llm-wiki distill hook for OpenCode v2 (local plugin).
 *
 * Injects advisory system notes that steer durable conversation knowledge into
 * the llm-wiki knowledge base:
 * - first run after install: asks the user once whether previous conversations
 *   should be distilled into llm-wiki (recorded in the state file; asked once);
 * - every `LLM_WIKI_DISTILL_NUDGE` agent-loop requests per session (default 12,
 *   0 disables): a light reminder to file important decisions via the wiki.*
 *   tools.
 *
 * Scope: `ctx.session.hook("context")` — runs for the agent loop (including
 * tool-driven continuations) immediately before provider dispatch; changes
 * affect only the outgoing request, never persisted history.
 *
 * Env overrides:
 *   LLM_WIKI_DISTILL_STATE  state file (default ~/.config/opencode/llm-wiki-distill.json)
 *   LLM_WIKI_DISTILL_NUDGE  nudge interval in requests (default 12; 0 disables)
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { Plugin } from "@opencode/plugin"

const STATE_FILE = process.env.LLM_WIKI_DISTILL_STATE ?? join(homedir(), ".config", "opencode", "llm-wiki-distill.json")

const FIRST_RUN_TEXT = [
  "llm-wiki 蒸馏钩子首次运行：用户刚刚把 llm-wiki 本地知识库接入了本 harness。",
  "请先用一句话询问用户：「要不要把你之前和我的对话内容蒸馏进 llm-wiki？」",
  "说明要点：只提炼关键决策、结论与方法，不全量搬运聊天记录；可让用户指定时间范围或会话。",
  "用户同意后再执行（逐段提炼成 wiki 页面，用 wiki.write / wiki.log 写入，参考工作区 AGENTS.md 的 schema）。",
  "用户说不用就跳过，不要再问。问完后继续当前正常的任务。",
].join("\n")

const NUDGE_TEXT = [
  "llm-wiki 提醒：若刚才的对话产生了值得长期保留的内容（决策、结论、方法、重要事实），",
  "请用 llm-wiki 工具沉淀（wiki.write 写页 / wiki.log 记一条）。",
  "没有值得沉淀的请忽略本提醒——不要为填而填，也不要因此打断用户。",
].join("")

const readState = (): Record<string, unknown> => {
  try { return JSON.parse(readFileSync(STATE_FILE, "utf8")) as Record<string, unknown> } catch { return {} }
}
const writeState = (state: Record<string, unknown>): void => {
  try {
    mkdirSync(dirname(STATE_FILE), { recursive: true })
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
  } catch {
    // Best-effort: a failed write may re-ask the first-run question once.
  }
}

export default Plugin.define({
  id: "llm-wiki-distill",
  async setup(ctx) {
    const raw = process.env.LLM_WIKI_DISTILL_NUDGE
    const nudgeEvery = raw === undefined ? 12 : Number(raw)
    if (!Number.isInteger(nudgeEvery) || nudgeEvery < 0) {
      throw new Error(`llm-wiki-distill: LLM_WIKI_DISTILL_NUDGE must be an integer >= 0, got ${String(raw)}`)
    }

    const perSession = new Map<string, number>()

    await ctx.session.hook("context", (event) => {
      const notices: string[] = []
      const state = readState()
      if (state.askedPrevDistill !== true) {
        if (Array.isArray(event.messages) && event.messages.length > 0) {
          notices.push(FIRST_RUN_TEXT)
          state.askedPrevDistill = true
          state.askedAt = new Date().toISOString()
          writeState(state)
        }
      } else if (nudgeEvery > 0) {
        const key = String(event.sessionID)
        const count = (perSession.get(key) ?? 0) + 1
        perSession.set(key, count)
        if (count % nudgeEvery === 0) notices.push(NUDGE_TEXT)
      }
      for (const text of notices) event.system.push({ type: "text", text })
    })
  },
})
