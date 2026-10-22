# Archivist Phase 3 合同（交叉编码重排 + 时效/聚合路由）— 冻结版 v1

> 前置：Phase 2 的侧车与向量通道就绪（`ARCHIVIST_ML_*` 配置、`ml/sidecar.py` 的 `embed`/`rerank`）。
> Phase 1 实测：纯词法 span Recall@20 = 77.4%，主要失分在 multihop / aggregation / old-fact / temporal；
> Phase 2 用向量通道补召回，本阶段用**交叉编码器**补"同一页内选对块"的能力（Phase 1 有 11/14 漏检是"页对块错"）。

## 0. 本机实测（不要重复探测）

| 项 | 结果 |
|---|---|
| 重排模型 | `Xenova/bge-reranker-base` int8 ONNX（约 280MB fp32 → int8 更小） |
| CPU 速度 | **p50 10.2ms/对，p95 12.9ms/对**（短文本对；长块会更慢，按 token 数近线性） |
| 判别力 | 相关句 0.979 vs 无关句 0.00–0.01（sigmoid 后），排序正确 |
| 预算 | 30 对 ≈ 0.3–0.5s；40 对 ≈ 0.4–0.7s。文档 §1 给重排的预算是 250–500ms → **默认重排 30 对** |
| 语言 | bge-reranker-base 支持中英混排；CJK 长句会拆分，需 truncation=512 |

## 1. 重排阶段（`mod-retrieval.mjs` + 侧车 `rerank`）

- 触发：`hybridSearch(dir, q, { rerank: true })`；**默认值由消融决定**（当前 Phase 1 特征重排是负增益、已默认关；本阶段用真交叉编码器重新测，只有正增益才默认开）。
- 候选：RRF/多块交付后的前 `RERANK_CANDIDATES`（默认 30）条；不足 30 条不补齐。
- 调用：一次批量请求 `{query, docs:[chunkText...]}`，侧车批量前向（batch 8–16）并返回 `[{index, score}]`。
- 融合：`finalScore = rrfScore * (1 + w * rerankScore)` 或**纯重排排序**二选一，由消融决定；参数 `RERANK_WEIGHTS` 导出可调。
- 熔断：侧车不可用/超时（>3s）→ 用 RRF 顺序，`diagnostics.degraded` 写明；**不许整次查询失败**。
- 缓存：同一 `(query, chunkId)` 结果缓存 5 分钟（上限 4096），避免重复略读。
- 延迟门槛：真库 p95 总查询 ≤ 1.2s；10M 语料 ≤ 2.5s（含 30 对重排）。

## 2. 时效与"当前状态"（文档 §3.2）

- `asOf` 语义已有过滤；本阶段补：
  - `archivist_evidence(asOf: "YYYY-MM-DD")` 的证据块按 `event_time ?: mtime` 排序并在块头显示日期；
  - 冲突提示：同一 `(entity, predicate)` 在证据里出现多个日期/值 → 证据包尾部加「可能过时：A 于 2026-03-02 改为 B」提示（用 claims 表或简单文本规则，Phase 4 前先用后者）。
- 量化：时序类 gold（9 条）与 old-fact（6 条）命中率必须比 Phase 2 提升 ≥5 点（否则回退并在报告中写原因）。

## 3. 聚合/深读路由（文档 §1 Deep mode、§3.6）

- 问题分类：查询含 `全部/所有/一共/总共/多少/how many/list all` 等 → 标 `aggregation`；由 `archivist_evidence` 的 `diagnostics.intent` 暴露。
- 聚合路径（v1，不引 LLM）：
  - 若查询命中 `claims` 表（Phase 4 前先空表）→ SQL 聚合；
  - 否则走 `archivist_scan` 的精确计数（已有）+ 证据包附「覆盖声明」（已有）。
  - `archivist_evidence` 在 `intent=aggregation` 时必须输出「本答案基于 N 条命中/覆盖 X 个文件」并提示用户可用 `archivist_scan` 取精确计数。
- 明确不做：把 800K token 塞进长上下文（文档的 deep mode v2 留到后面，需要用户显式确认代价）。

## 4. 验收

1. `selftest.mjs` 全绿 + 新增重排/熔断/缓存断言（≥6 条）。
2. 真库：重排开启后 **span Recall@20 必须比 Phase 2 有正增益**，否则默认关；消融表给 lexical / +dense / +dense+rerank / rerank-only 四档。
3. 延迟：真库查询 p95 ≤1.2s（重排开）；`ARCHIVIST_ML=0` 时不 spawn、不降速。
4. 降级：侧车 kill -9 后下一次查询仍返回结果（RRF 顺序）+ 明示降级；恢复后自动重连（≤1 次重启）。
5. 缓存命中率与收益：重复查询 p95 降幅 >50%。
6. 聚合/时序两类 gold 的类别命中率报告（不是必须达标，但必须报）。

## 5. 写域

| 文件 | owner |
|---|---|
| `ml/archivist_ml/*`（batch rerank 方法 + 批量前向） | impl-ml |
| `core/mod-retrieval.mjs`（重排阶段、缓存、熔断、intent） | impl-retrieval |
| `core/mod-evidence.mjs`（时效排序、冲突提示、intent 输出） | impl-tools |
| `core/archivist.mjs`（配置、工具输出接线） | Lead |
| `bench/**`（消融、延迟、缓存、降级跑分） | impl-eval |

## 6. P3 实测结果（2026-10-22）

**已实现并收口**：
- 交叉编码器：`opts.rerank:true` → 前 **10** 条 leaf（1500 字符→400 字符兜底截断）→ `rerankDocs`；**自适应**：仅当 top1/top2 相对分差 <5% 或 lexical/dense top1 不一致时才调用（gold 72 条中 12 条跳过、60 条真重排）；3s 熔断、5 分钟缓存、降级可见。
- 特征重排独立为 `featureRerank`，默认 on（否则机械评测 122→114）。
- **denseWeight 默认 0.5**：dense 通道不再以等权 RRF 挤掉稀疏候选。

**gold 四档（62 条可回答，limit 20；`quote 判定` = 同页任意交付块含金标引文，`span` = 合同口径）**

| 档 | span | path | MRR | quote 判定 | p50 | p95 |
|---|---|---|---|---|---|---|
| ① lexical+meta | 77.4% | 95.2% | 0.613 | 82.3% | 16.8ms | 25.1ms |
| ② +dense(w=0.5) | 77.4% | 95.2% | 0.614 | **88.7%（+6.4）** | 44.9ms | 55.4ms |
| ③ +dense+自适应交叉重排 | **80.6%（+3.2）** | 95.2% | **0.630（+0.016）** | 88.7% | 879.6ms | **1101.3ms ✅（≤1.2s）** |
| ④ 交叉重排-only（仅 dense 候选） | 72.6% | 93.5% | 0.522 | 79.0% | 357.6ms | 923.5ms |

生产默认路径（ML + `ARCHIVIST_ML_RERANK=1` 自动开自适应重排）：p50 597.5 / p95 869.4ms。

**侧车速度（已修复）**：根因不是实现比 ORT 慢，而是**默认 truncation=512**（真库块 mean 297/max 512 token，512 截断下与直接 Python 完全等价 179.3 vs 177.4ms/对）。
改为 `maxTokens=128`（可 16–512 覆盖）+ batch 8 + 批内动态 padding + session/tokenizer 复用后：**30.2ms/对、30 条 907ms**（侧车自检 14/14 含该门槛用例）。
自适应把候选压到 10 条，p95 落在 1.1s 内；放宽到 20 条仍有 0.6s 预算余量（待测）。

**10M dense-on（已修复）**：根因是矩阵缓存用 db 句柄做 key，每次查询重载 34.5K×384≈52MB。
改为 `embedding_meta` 指纹（model|count|built_at|dim）跨句柄缓存 + `iterate()` 流式构建后实测：
冷首查 **3780ms**（侧车 spawn 292 + e5 加载 756 + 建矩阵 + 首查），**warm p50 87.4ms / p95 272.6ms（≤300ms 门 PASS）**，RSS 增量 +55MB（≤120MB）。
注意：**每个新进程仍需付一次 ~1.1s 冷启动**（模型加载+建矩阵），指纹缓存不跨进程；bench 必须同进程 warm 才是稳态数字。

**未验**：侧车 kill -9 后自动重连、缓存命中 ≥50% 降幅的对照测量、20 候选档的重排收益。
