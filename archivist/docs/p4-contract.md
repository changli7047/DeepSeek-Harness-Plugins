# Archivist Phase 4 合同（claims / 实体时效层）— 冻结版 v1

> 前置：P1 索引、P2 向量、P3 交叉编码重排。本阶段补文档 §1「Derived knowledge」与 §3.2/§3.5：
> **实体 + 别名、claims（subject, predicate, object, valid_from, valid_to, source_span）、冲突检测、当前状态查询**。
> 目标不是把 wiki 变成知识图谱，而是让"当前状态/已更正/时序"这三类问题可机械回答，并且**每条 claim 都能回到 raw 证据的 span**。

## 0. 不变量

1. claims 是**派生数据**：真相仍在 raw/ 与 wiki/ 页面。claims 文件是**持久化的抽取产物**（不是索引），
   删掉可重抽，但重抽要花钱/时间，所以它本身也要备份（放 `wiki/claims/`，不是 `.index/`）。
2. 每条 claim 必须带 `anchor`（指向页面 chunk 的稳定锚点）与 `quote`（原文片段）；
   **没有原文锚定的 claim 不允许入库**（宁缺勿造）。
3. 更正语义与页面一致：`retract` 排除、`supersede` 关闭旧 claim 的 `validTo` 并指向新的，历史不覆盖。
4. 抽取由 **Agent（LLM）** 做，插件只做确定性校验/存储/检索/冲突检测；插件不调 LLM。
5. 一切新增能力向后兼容：不改变现有 15 个工具的既有语义。

## 1. 存储（`wiki/claims/<slug>.jsonl`，append-only）

每条一行 JSON：

```jsonc
{
  "claim_id": "c_<8hex>",              // 内容哈希（含 anchor+object），重复添加幂等
  "subject": "三国志建造",              // 实体规范名（必须能在 entities/ 找到或可规范化）
  "predicate": "全国地图尺寸",          // 谓词的规范短语（自由文本，但同义要归一）
  "object": "204×208",                 // 值（字符串；数字/日期保留原文）
  "object_type": "string|number|date|bool",
  "valid_from": "2026-10-21",          // 可选：事实生效时间（event_time）
  "valid_to": null,                    // 关闭时间；null = 仍有效
  "anchor": "wiki/syntheses/三国志建造-全国地图v2落地.md@1a2b3c4d#c4[1200:1380]",
  "quote": "50×50 荆州四城图 → 204×208 全国 42 城图，已在引擎里跑通",
  "confidence": 0.9,
  "extractor_ver": "agent-2026-10-22",
  "status": "active|superseded|retracted",
  "superseded_by": null,               // claim_id
  "reason": "",                        // retract/supersede 理由
  "created_at": "2026-10-22T03:00:00Z"
}
```

- 文件名 slug 由调用方给（通常对应页面），插件校验路径不越界。
- 写入是 append-only；修改状态 = 再 append 一条同 `claim_id` 的事件行（后者覆盖前者，读取时 fold）。
- `archivist_claim` 的 `verify:true` 会先用 `archivist_verify` 的逻辑核对 `anchor`+`quote` 确实存在，未通过则**拒绝写入**并说明原因。

## 2. 索引（schema v2 起）

```sql
CREATE TABLE IF NOT EXISTS claims (
  claim_id TEXT PRIMARY KEY,
  subject TEXT NOT NULL, subject_norm TEXT NOT NULL,
  predicate TEXT NOT NULL, predicate_norm TEXT NOT NULL,
  object TEXT NOT NULL, object_type TEXT,
  valid_from TEXT, valid_to TEXT,
  anchor TEXT NOT NULL, quote TEXT NOT NULL,
  confidence REAL, extractor_ver TEXT,
  status TEXT NOT NULL, superseded_by TEXT, reason TEXT, created_at TEXT,
  page_path TEXT, chunk_id INTEGER                  -- 能解析出 chunk 时填
);
CREATE INDEX IF NOT EXISTS claims_sp ON claims(subject_norm, predicate_norm, status);
```
- 重建：`archivist_claim(action='reindex')` 从 `wiki/claims/*.jsonl` 全量重建 claims 表；`meta.claims_version` 变化也自动重建。
- 与页面 supersede/retract 联动：页面被 retract → 其下 claims 读时标记 `orphaned:true`（不删，输出标注）。

## 3. 工具面（16 个）

新增 `archivist_claim`，action：
- `add`：参数 `{claims: [{subject, predicate, object, validFrom?, validTo?, anchor, quote, confidence?, page?}], file?}`
  → 逐条校验（anchor 存在、quote 落在 span、subject 能对上实体页或给出 warning），append 写入，返回 `{added, rejected:[{index, reason}]}`。
  同一 `(subject_norm, predicate_norm)` 已有 status=active 且 object 不同 → **不拒绝**，但返回 `conflicts:[{claim_id, oldObject, newObject, validFrom}]` 并在输出里明示"可用 action=supersede 关闭旧值"。
- `supersede`：`{claimId, newObject?, validFrom?, reason}` → 关闭旧 claim（append valid_to + status=superseded），可选等价于 add 一条新 claim。
- `retract`：`{claimId, reason}` → status=retracted。
- `list`：`{subject?, predicate?, asOf?, status?='active', limit?}` → 表格化输出（含 anchor/日期/confidence/冲突标记）。
- `conflicts`：`{}` → 列出所有同 (subject,predicate) 的 active 冲突。
- `reindex`：从 jsonl 重建表。

## 4. 检索/证据集成（Lead 接线）

- `archivist_evidence` 增加可选 `asOf`：已有；本阶段让 claims 参与：
  - 证据包在 `diagnostics.claims` 里给出命中的 active claims（≤10 条）与 `conflicts`；
  - 若问题含"现在/目前/最新"等 current-state 意图，pack 头提示"以下是当前有效值（valid_to=null）与变更历史"。
- `archivist_search` 结果：命中的页面若有关联 claims，在结果行尾加 `〔claims: 3 active〕`（轻量，不展开）。
- 聚合问题（"所有 X 的 Y"）：有 claims 时用 SQL 聚合，输出"基于 N 条 claims（覆盖 M 页）"的覆盖声明。

## 5. 验收

1. `selftest.mjs` 全绿 + 新增 ≥10 条断言：add/supersede/retract/list/conflicts/reindex、无锚点拒绝、quote 不匹配拒绝、页面 retract 后 orphan 标注、幂等（同 claim 重复 add 不重复）。
2. gold 集新增 **claims 子集 ≥10 条**（时序/当前状态/已更正各 ≥3）：在 claims 已建立的前提下，`archivist_claim(action='list', asOf)` 的答案正确率 = 100%（机械可判），`archivist_evidence` 的 current-state 提示出现率 ≥90%。
3. 冲突检测：构造 2 组"同 subject+predicate 不同 object"→ conflicts 全部列出；supersede 后旧 claim 的 `valid_to` 被填、active 列表只剩新值。
4. 幂等/可重建：删掉 claims 表，`reindex` 后行数与 jsonl 一致；重复 reindex 不变。
5. 性能：5000 条 claims 下 `list`/`conflicts` ≤ 20ms；不影响现有检索 p95（±10%）。
6. 零 LLM、零网络：插件只做确定性操作。

## 6. 写域

| 文件 | owner |
|---|---|
| `core/mod-claims.mjs`（存储/校验/查询/冲突） | impl-tools |
| `core/archivist.mjs`（工具注册、evidence/search 接线） | Lead |
| `AGENTS_TEMPLATE`（claims 工作流写进工作区 schema） | Lead |
| `bench/**`（gold claims 子集、跑分） | impl-eval |
| `selftest.mjs` 断言 | Lead |

## 7. P4 实测状态（2026-10-22）

**已交付并接线**：`core/mod-claims.mjs`（append-only `wiki/claims/*.jsonl` + SQLite fold 表、写入前 anchor/quote 必验、幂等、冲突检测、supersede/retract 状态机、asOf、页面 retract → orphaned、reindex 自愈）；`archivist_claim` 工具注册（16 工具）；`AGENTS_TEMPLATE` 已加 Claims 工作流。
**数字（impl-tools 探针）**：5000 条 active claims → `claimsList`（limit 50）p50 **2.0ms** / p95 **10.0ms**，`claimsConflicts` p50 5.1 / p95 9.8ms（门槛 ≤20ms）；reindex 行数 5005=5005 且重复不变；无锚点 / quote 不在 span / sha8 过期 / span 越界全部拒写且原因具体；幂等重复 add → added 0 / skipped。
**selftest**：新增 9 条 claims 断言（写入/幂等/伪造拒写/冲突/列表/supersede/retract/reindex），全绿（231 passed）。
**未验/待办**：证据包 `diagnostics.claims` 集成（字段已备 `claimsForPack`/`claimsCountsByPage`，接线待做）；claims gold 子集（时序/当前/更正各 ≥3）由 impl-eval 建；真实 LLM 抽取质量不在插件范围（抽取由 Agent 做）。
