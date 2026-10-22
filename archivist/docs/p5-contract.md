# Archivist Phase 5 合同（聚合意图 + deep mode 路由）— 冻结版 v1

> 前置：P1–P4。文档 §1「Deep mode」与 §3.6「Aggregation / 全局问题」明确：
> top-K 检索天生不适合"列出全部/所有/总共"这类问题，必须**路由**而不是硬答。
> 本阶段把路由做成确定性的、可被模型看到的信号；**不把 800K token 塞进上下文**（那是显式 deep 请求才做的事）。

## 1. 意图分类（确定性，无模型）

`classifyIntent(query)` → `lookup | current-state | explanation | aggregation | timeline`，规则：
- aggregation：`全部|所有|每一个|每一|一共|总共|合计|数量|多少个|几条|几项|几次|清单|列出所有|count|how many|list all|\ball\b|\bevery\b|\btotal\b`（沿用现有 `looksExhaustive`，扩充）。
- current-state：`现在|目前|当前|最新|最新版|现在是多少|current|latest|currently|as of`。
- timeline：`什么时候|何时|历史|变更|改过几次|时间线|timeline|when did`。
- 默认 lookup/explanation 由长度与疑问词区分（`为什么|如何|怎么` → explanation）。

输出写进 `archivist_evidence` / `archivist_search` 的 `diagnostics.intent`，并在证据包头部/检索结果尾部给一行路由建议：
- aggregation → 「这是聚合问题：top-K 不能代表全库。请用 `archivist_scan` 取精确计数，或 `archivist_claim` 的 list/聚合；回答时必须声明覆盖（基于 N 条/X 页）」
- current-state → 「当前状态问题：优先采信 `valid_to=null` 的 claims；冲突值要同时给日期」
- timeline → 「时间线问题：按事件时间排序并给日期」

## 2. `archivist_evidence` 的 deep 选项

- 新参数 `deep: boolean`（默认 false）+ `maxTokens` 上限提到 **120000**（deep 时）。
- deep=true 时：候选扩到 200–400 块，按文档/时间分组，**先给模型一个"覆盖表"**（命中了哪些文档、每个文档多少块、时间跨度），再给证据；输出头部必须写：
  「deep 模式：本次证据约 X token（约 Y 倍常规），耗时约 Z 秒；仅在你显式要求全量梳理时使用」。
- 插件**不做** map-reduce（无 LLM）；deep 只负责"把筛选后的证据尽量给全 + 覆盖声明"。
- 硬上限：deep 模式证据 token 不超过 120000，超出**必须**在截断处写明截断文档数与原因。

## 3. 覆盖声明（聚合答案的强制字段）

`archivist_evidence` 在 `intent=aggregation` 时的输出尾部必须含：
`覆盖：检索命中 N 个文档 / M 个块；其中 C 个文档含 claims；未覆盖部分：<原因>`
`archivist_search` 在 aggregation 意图时已经把用户导向 `archivist_scan`（P1 已有，保留）。

## 4. 验收

1. `selftest.mjs` 新增 ≥6 条：五类意图判定各 1 条 + deep 模式头部/截断声明 + aggregation 覆盖声明存在。
2. 分类准确率：手工 40 条意图标注（impl-eval 建，`bench/gold/intents.json`），规则分类 **≥85%**；错例逐条列出。
3. deep 模式：10M 语料下 deep 查询 p95 ≤ 5s、token ≤120000、内存增量 ≤200MB；不触发时不增加常规路径延迟（±5%）。
4. 覆盖声明：aggregation 类 gold（7 条）里，答案必须带覆盖数字（100%）。
5. 边界：deep 关闭时 `maxTokens` 上限仍是 60000（防误用）；deep=true 但 ML 不可用时仍可工作（纯词法）。

## 5. 写域

| 文件 | owner |
|---|---|
| `core/mod-intent.mjs`（分类器，纯函数） | Lead |
| `core/archivist.mjs`（evidence/search 接线、deep 参数、覆盖声明） | Lead |
| `core/mod-evidence.mjs`（deep 渲染分支） | impl-tools（若在忙则 Lead 代做并留注释） |
| `bench/gold/intents.json` + 跑分 | impl-eval |
| `selftest.mjs` 断言 | Lead |

## 6. P5 实测状态（2026-10-22）

**已交付**：`core/mod-intent.mjs`（5 类意图，正则可解释；优先级 aggregation > current-state > timeline > explanation > lookup）+ core 接线：
- `archivist_search` 在非聚合意图时附一行路由建议（聚合/当前状态/时间线）；
- `archivist_evidence` 支持 `deep: true`：预算上限 60000 → 120000，输出头部写明「deep 模式：证据约 X token（上限 Y）；仅全局梳理时使用」，聚合意图追加「覆盖：命中 N 文档 / M 证据块」；
- 非 deep 请求的 maxTokens 硬上限 60000（防误填）。
**selftest**：新增 7 条意图/路由断言，全绿（231 passed）。
**待办**：`bench/gold/intents.json`（40 条人工标注、规则准确率 ≥85%）由 impl-eval 建；10M deep 延迟/内存门槛未测（需先修 10M dense 缓存）。
