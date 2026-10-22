# P1 索引查询性能：FTS 两段式 + 版本门 + 快同步（impl-chunks）

> 日期 2026-10-22 · Node v24.21.0 / `node:sqlite` 3.53.4 · 被测：`core/mod-chunks.mjs`、`core/mod-indexdb.mjs`
> 装置：`node bench/query-profile.mjs --samples 20`（impl-eval，hybridSearch(limit=20, scope=all, expand=parent)，每档取 gold-needles 前 20 条；FTS 段 = `searchLexical(db, tokenize(q), {limit:100})` 独立计时）
> 「before」= 同一装置在本次改动前的 `D:\archivist-work\eval\perf-profile.md`；「after」= 本次改动后同装置复跑（临时输出，未覆盖 impl-eval 的报告文件）。

## 1. before / after（同装置、同查询、同机器）

| 档位 | FTS p50 | FTS p95 | total p50 | total p95 |
|---|---|---|---|---|
| 1M before | 31.90 ms | 49.26 ms | 66.90 ms | 78.16 ms |
| **1M after** | **2.95 ms** | **4.80 ms** | **9.05 ms** | **11.70 ms** |
| 3M before | 85.30 ms | 122.74 ms | 148.26 ms | 197.07 ms |
| **3M after** | **4.57 ms** | **7.28 ms** | **20.73 ms** | **25.46 ms** |
| 10M before | 347.66 ms | 401.86 ms | 554.57 ms | 656.87 ms |
| **10M after** | **5.07 ms** | **9.07 ms** | **54.64 ms** | **56.59 ms** |

门槛对照：10M 查询 p95 门槛 ≤300 ms → after **56.6 ms**；真实库 p95 ≤30 ms → 未受影响（见 §4，真实库走原 SQL，`hybridSearch` p50/p95 = 32.0/40.8 ms 为本机 async 直测，pack 基线口径 17.3/23.5 ms 见 §5 阻塞项）。
sync 段（查询实付）：before 9.15 / 27.06 / 121.02 ms → after 0.55 / 1.02 / 3.07 ms（retrieval 侧 stamp 节流已在 impl-retrieval 落地；本模块另提供 `syncIndex(db, dir, {fast:true})`，实测 10M 空转 7.5 ms vs 全量 80–110 ms）。

## 2. 为什么原来慢：不是匹配，是 bm25 对巨量 OR 匹配集的排序

impl-eval 的 `--fts-probe` 已证实：同一 MATCH 下 `OR + ORDER BY bm25` 在 10M 上 260.7 ms，去掉 ORDER BY 只需 3.47 ms，全 token `AND + bm25` 0.28 ms —— 98.7% 的成本花在对 OR 匹配集（约 2.8 万条）逐条做 bm25。真实 10M 索引上 15 个 token（CJK bigram + 短语 + 稀有 ID）的 OR 集尤其大。

## 3. 改法：分层锚点查询（执行策略变化，打分函数不变）

`searchLexical` 现在按「锚点层级」执行，每个层级的 MATCH 是：

```
( <最具体的 k 个 token> OR ... ) AND ( <全部查询 token OR ...> )
```

- 锚点 = **多字符 token**（长度 ≥3，按长度降序）：CJK 整段短语、稀有 ID/拉丁词。2 字 CJK bigram 通常极常见，一旦作为锚点会把匹配集和 bm25 成本拉回原样，因此**不**做锚点。
- 第二个括号包含全部查询 token，所以 `bm25()` 仍然对**全部查询短语**求和 —— 同一个 chunk 在任一层级的 bm25 分数与旧单查询完全一致，变的只是候选池大小。
- 层级 k 从 1 递增（嵌套匹配集）；第一个返回 `limit` 条结果的层级即为答案。若所有锚点层级都不足 `limit`，返回「最宽锚点层级」的**有界结果**，不再用全 OR 集凑数（精度优先、成本恒定）。
- 候选池足够大时结果与旧实现逐条一致；锚点不足时是旧结果的**子集**且顺序不变（见 §5 语义说明）。
- 兜底：`opts.explain` 可传入对象，得到 `{mode:'tiered'|'legacy', tiers:[{k,expr,rows,ms}], ordered, totalMs}` 的非破坏统计。

实测单查询（10M needle）：tier k=1（稀有 ID）1 行 ≈0.3 ms；k=2/k=3 各 ≈0.2 ms；四档 p50 见上表。`guard`：索引「规模代理」`max(chunk_id) ≤ 4000` 时**完全走旧 SQL**（真实库 1 884 chunks），因此真实库/小库结果逐字节不变。

## 4. 索引版本门（分块器/索引器变更不沿用旧块）

- `meta` 新增 `chunker_version`（来自 `mod-chunks.mjs` 的 `ch_CHUNKER_VERSION`）与 `indexer_version`（`ix_INDEXER_VERSION`）。
- `openIndex` 读到版本缺失/不一致且库里有数据 → **清空并全量重建**，`indexRebuildNote(db)` 返回
  `⚠ 索引重建：分块器/索引器版本变化（chunker vN→vM，indexer vN→vM）`。升级后第一次 open 会做一次重建
  （实测 1M 0.4 s、3M 1.2 s、10M ≈1.9 s 含 integrity quick_check），之后正常打开。
- schema_version 未变（meta 是 key/value，不需要 DDL 变更）；老库（无版本键）会被判为 v0 → 重建一次。
- 「(mtime,size) 不变则跳过」只对**同版本**索引有效；版本门保证旧分块器产物不会在升级后继续被检索。

## 5. 语义说明（差在哪、为什么可接受）

1. **小库不变**：`max(chunk_id) ≤ 4000` 时仍执行改动前的那条 `OR + ORDER BY bm25` SQL（同参数、同 ORDER BY），真实库/自检库结果逐字节相同 → 真库 gold recall、机械评测不应有任何变化（实测见 §6）。
2. **大库（>4000 chunks）候选池收窄**：只取「包含最长若干 token 之一」的 chunk，但这些 chunk 的 bm25 仍按全部查询短语计算、排序规则不变。当锚点匹配集不足 `limit` 时返回有界集合，不再用低覆盖率的 OR 弱匹配填充。
   影响：`archivist_search` 在同一 10M 库上可能少于 100 条候选；对证据包/重排来说 top-k 次序不变而尾部更干净。合成语料的 needle top-1 实测 1M 21/24、3M 59/60、10M 188/200（未中项均为「近重复副本路径与 gold 路径不同」，非 quote 丢失）。
3. **`syncIndex({fast:true})` 是显式选项**：默认仍是全量扫描（写工具/自检走默认，§8.6 不受影响）。retrieval 目前用 impl-retrieval 的 workspace-stamp + 60 s 全量节流，未使用该选项（其未变更分支直接跳过 sync，收益等价）。

## 6. 回归验证

- `node selftest.mjs`：**211 passed, 0 failed**（HEAD 当前断言数）。
- 机械评测：`node bench/eval.mjs D:\archivist-work\baseline-copy D:\archivist-work\reports\eval-set-baseline.json` → **122/122（100%）**，gate PASS。
- 实库检索（`hybridSearch` limit=40, scope=all, expand=parent，62 条可回答 gold）：页面命中 100%、quote 文本命中 **85.5%**、空结果 0 条；p50 32.0 / p95 40.8 ms。
- 分块/版本自检：`node core/mod-indexdb.mjs` 全绿（span 精确、两段式排序与旧单查询在小库逐条一致、`fast` 空转 0 变更、版本键存在）。

## 7. 未能验证 / 阻塞项

- **pack 口径 Recall@20 = 77.4% 的 against-HEAD 复核被外部阻塞**：HEAD 的 `bench/gold-pack.mjs` 跑实库得到 `packRecall=0`（`blocks=0`、`sufficientReason="没有任何命中"`）。原因不在索引：`core/mod-retrieval.mjs` 的 `hybridSearch` 已是 `async`，而 `core/mod-evidence.mjs:341` 仍按同步调用（`search = hybridSearch(...)`，未 await，347 行读 `search.hits` 得 undefined）。这是 impl-retrieval/impl-tools 之间的集成缺口，不在我的写域；`mod-evidence` 修好后请用 `node bench/gold-pack.mjs <workspace> bench/gold/gold-real.json` 复测 77.4%。
  本模块对该指标的可控风险已知且为零：真实库走的是与改动前完全相同的 SQL 路径（§5.1），且实库直测 quote 命中 85.5%（evidence-pack 只会在此基础上做父段合并）。
- 1M/3M/10M 的数字来自合成语料 + gold-needles 查询；未在「自然语言大库」上验证 tiered 路径（自然中文里 3 字短语可能常见 → 锚点集变宽；届时成本会向旧路径靠拢但不正确性风险，因为仍是同一 bm25）。
- 未测多进程并发下 tiered 查询的竞争效应（单进程内 SQLite 查询只读，WAL 下无写竞争）。
