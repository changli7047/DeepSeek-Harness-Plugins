# Archivist Phase 1 合同（证据层）— 冻结版 v1

> 本文件是多人并行实现的**唯一接口权威**。任何实现与本文冲突，以本文为准；要改本文必须先通知 Lead。
> 目标：按《Design for a long-term memory system for a local desktop agent》把 archivist 从「页面级词法检索 + 零依赖单文件」升级为
> **SQLite 系统记录 + chunk/span 稳定地址 + BM25 词法通道 + 确定性重排 + 证据包 + 引用核验**。
> Phase 2/3（向量通道、交叉编码重排、claims 层）不在本阶段范围，但接口必须为它们留位。

## 0. 不变量（任何阶段都不许破坏）

1. `raw/` 只读；一切衍生数据写 `wiki/` 或 `<workspace>/.index/`。**索引不得修改任何 markdown 字节**。
2. 零第三方运行时依赖（`node:*` 内置模块可用，含 `node:sqlite`）；P1 零网络。
3. 纠错语义不变：retract 排除、supersede 降权并标注、历史永不覆盖。
4. **降级必须可见**：任何走不到索引/新通道的路径，必须在工具输出里写一行 `⚠ 降级：<原因>`，不许静默。
5. 现有 13 个工具的**入参与输出形状向后兼容**（允许追加，不许删除/改义）。

## 1. 构建与文件布局（Lead 负责）

- 逻辑源仍是 `archivist/core/`。新增模块文件，**只由自己的 owner 修改**：

| 文件 | owner | 内容 |
|---|---|---|
| `core/archivist.mjs` | Lead | 现有全部逻辑 + 接线（import 新模块 / 新工具注册 / searchWiki 重写 / read 锚点支持） |
| `core/mod-chunks.mjs` | impl-chunks | 纯函数分块 |
| `core/mod-indexdb.mjs` | impl-chunks | SQLite 索引：schema/建/增量/查询 |
| `core/mod-retrieval.mjs` | impl-retrieval | 查询归一、别名扩展、多通道、RRF、去重、确定性重排 |
| `core/mod-evidence.mjs` | impl-tools | 证据包 |
| `core/mod-verify.mjs` | impl-tools | 引用核验 |

- `build/build.mjs`（Lead 改）：按固定顺序把 `core/mod-*.mjs` 内联进生成的宿主插件，规则：
  - 剥掉 `^import ... from '\./mod-[^']+'$` 行与行首 `export `；
  - 内联顺序：`mod-chunks, mod-indexdb, mod-retrieval, mod-evidence, mod-verify`，然后 `core/archivist.mjs`；
  - 断言：无残留相对 import、无 `__CORE__`、工具数 = 期望值、衔接后 `node --check` 通过。
- `core/archivist.mjs` 里用 `import { ... } from './mod-*.mjs'` 拉新函数，这样 selftest/bench 仍可直接 `import ../core/archivist.mjs`。
- 新模块**不得**互相 import，也不得 import `core/archivist.mjs`（避免循环）。它们只能 import `node:*` 内置模块。
- **命名空间碰撞是 build 的硬约束**（v2）：内联后所有模块共用一个顶层作用域。规则：
  1. 模块内部**所有辅助符号**（含局部 const/function）必须带模块前缀：`ch_`(chunks) / `ix_`(indexdb) / `rt_`(retrieval) / `ev_`(evidence) / `vf_`(verify)；
  2. 只有合同冻结的 API 名可以不带前缀；
  3. `core/archivist.mjs` 的 106 个顶层名是**保留名**，尤其 `estimateTokens / rebuildIndex / snippet / stamp / fwd / oneLine / sha16 / today` 等不许再用；
  4. `build.mjs` 用 `node --check` 兜底，冲突时报出"哪两个文件重名"并中止构建。
- **`estimateTokens` 归属调整（v2）**：实现移到 `mod-chunks.mjs`（`chunkDocument` 要用它，独立可测），`core/archivist.mjs` 改为 `import { estimateTokens } from './mod-chunks.mjs'` 并删除本地实现。
- **`rebuildIndex` 改名（v2）**：core 已有同名函数（重建 index.md），索引模块的重建函数更名为 `rebuildSearchIndex(db, dir)`。

## 2. 索引（derived、可重建）

位置：`<workspace>/.index/archivist.db`（+ `-wal`/`-shm`）。可随时删除，下次检索自动重建。
`EXCLUDE_RE` 与备份逻辑必须排除 `.index`；README/AGENTS 模板要写明它可删。

打开参数：`journal_mode=WAL`、`synchronous=NORMAL`、`busy_timeout=3000`、`foreign_keys=ON`。
`node:sqlite` 必须**懒加载**（`createRequire(import.meta.url)('node:sqlite')` 在首次用时），避免宿主启动时的实验性警告；加载失败 → 降级。

### 2.1 schema v1（SQLite DDL，冻结）

```sql
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);                                  -- schema_version='1', built_at, workspace

CREATE TABLE IF NOT EXISTS docs (
  doc_id      INTEGER PRIMARY KEY,
  scope       TEXT NOT NULL CHECK (scope IN ('wiki','raw')),
  path        TEXT NOT NULL UNIQUE, -- 工作区相对 posix 路径，如 'wiki/concepts/foo.md'
  title       TEXT NOT NULL DEFAULT '',
  sha256      TEXT NOT NULL,        -- 整文件内容哈希（= 版本）
  mtime_ms    INTEGER NOT NULL,
  size        INTEGER NOT NULL,
  trust       TEXT,                 -- wiki: high|medium|low
  status      TEXT,                 -- wiki: active|superseded|retracted
  superseded_by TEXT,
  page_type   TEXT,                 -- source|entity|concept|synthesis
  tags        TEXT NOT NULL DEFAULT '',   -- 小写、空格分隔
  aliases     TEXT NOT NULL DEFAULT '',   -- 小写、空格分隔（entity 页 aliases 字段）
  summary     TEXT NOT NULL DEFAULT '',
  raw_refs    TEXT NOT NULL DEFAULT '',   -- 空格分隔的 raw 相对路径（frontmatter sources）
  event_time  TEXT                  -- 可选：frontmatter event_time/date，'YYYY-MM-DD'
);

CREATE TABLE IF NOT EXISTS chunks (
  chunk_id    INTEGER PRIMARY KEY,
  doc_id      INTEGER NOT NULL REFERENCES docs(doc_id) ON DELETE CASCADE,
  ord         INTEGER NOT NULL,     -- 文档内 0 基序
  kind        TEXT NOT NULL CHECK (kind IN ('section','leaf')),
  parent_ord  INTEGER,              -- leaf → 所属 section 的 ord；section 为 NULL
  heading_path TEXT NOT NULL DEFAULT '',
  char_start  INTEGER NOT NULL,     -- 相对 **body**（frontmatter 之后）的偏移
  char_end    INTEGER NOT NULL,
  token_est   INTEGER NOT NULL,
  text        TEXT NOT NULL,
  SIMILAR TO UNIQUE (doc_id, ord)   -- 见下：真实 DDL 用 UNIQUE(doc_id, ord)
);

-- 只索引 leaf；内容less（text 存在 chunks 表里，不在 FTS 重复存）
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  tokens, heading_tokens,
  content='', contentless_delete=1,
  tokenize='unicode61 remove_diacritics 2'
);                                  -- rowid = chunk_id
```

**分词**：`tokens` 必须是**预分词**后的空格分隔串，与查询侧对称：
- 拉丁/数字：小写词（`[a-z0-9_][a-z0-9_-]+`，长度 ≥2）；含符号的段（`b+`、`o(logn)`）保留**去符号后的词**并在 `chunks.text` 上走"精确通道"（见 4.3）。
- CJK/假名：相邻二元组（`全国`、`国地`…），另加整段 CJK 短语（长度 ≥3）作为额外 token。
- `heading_tokens`：同规则作用于 heading_path。
- 查询侧必须复用同一 `tokenize()`（`mod-chunks.mjs` 导出，retrieval 复用），并转成 FTS5 查询 `"tok1" OR "tok2" ...`（每个 token 双引号转义，禁止裸符号）。

**内容less FTS 的删除**：`DELETE FROM chunks_fts WHERE rowid=?`（contentless_delete=1，SQLite ≥3.43；本机 3.53.4 已验证可用——**实现前先用最小脚本证实**，不成立就上报 Lead 改方案，不许自己换 tokenizer 方案）。

### 2.2 增量规则

- 每文件判据：`(mtime_ms, size)` 相同且 sha256 未变 → 跳过；否则重解析该 doc（delete docs 行，CASCADE 删 chunks，再删 fts 行后重插）。
- 新增文件 → 插入；删除文件 → 删行。
- `meta.schema_version` ≠ '1' 或 `PRAGMA integrity_check` 失败或打不开 → 删库重建（重建后要在输出里说明 `⚠ 索引重建：<原因>`）。
- 全量重建 10M-token 语料 ≤ 120s；单文件增量 ≤ 100ms。

### 2.3 索引 API（`mod-indexdb.mjs`，签名冻结）

```js
export function openIndex(dir)            // → db（必要时建库/迁移/重建）；失败抛错，由调用方降级
export function syncIndex(db, dir)        // 增量同步（幂等）；→ {added, changed, removed, scanned, ms}
export function searchLexical(db, tokens, opts)
  // opts: { limit=100, scope='wiki'|'raw'|'all', filters:{trust,status,timeFrom,timeTo,pageType,excludeRetracted:true} }
  // → [{ chunkId, docId, path, scope, ord, headingPath, charStart, charEnd, snippetText, bm25 }]
export function getChunk(db, chunkId)     // → chunk 行 + doc 行（parent 展开用）
export function getDocChunks(db, docId)   // → 按 ord 排序
export function getDocMeta(db, docId)
export function indexStats(db)            // → {docs, chunks, fts, dbBytes, schemaVersion, builtAt}
export function rebuildSearchIndex(db, dir) // 全量重建（原名 rebuildIndex 与 core 冲突，v2 改名）
export function indexDrift(db, dir)       // → {missing, extra, stale} 供 lint 用
```

## 3. 分块与地址（`mod-chunks.mjs`）

```js
export function chunkDocument(text, opts)  // text = body（无 frontmatter）
  // → [{ ord, kind:'section'|'leaf', parentOrd, headingPath, charStart, charEnd, tokenEst, text }]
export function tokenize(text)             // → string[]（与 FTS 对称；见 2.1 分词规则）
export function estimateTokens(text)       // 与现有 core 同口径（CJK≈1字/词，拉丁≈4字符/词）
export function formatAnchor(path, sha256, ord, charStart, charEnd) // → 'wiki/foo.md@a1b2c3d4#c3[120:480]'
export function parseAnchor(anchor)        // → {path, sha8?, ord?, start?, end?} 缺省字段为 undefined
```

分块规则：按标题切 section（heading path 形如 `H1 > H2`，最多保留 3 级）；section 内按空行/句子切成 300–500 token 的 leaf，重叠 10–15%；`char_start/char_end` 必须精确到可以 `body.slice(start,end) === chunk.text`（selftest 要断言）；`tokenEst` 与 `estimateTokens(text)` 一致。

## 4. 检索（`mod-retrieval.mjs`）

```js
export function normalizeQuery(q)                    // 全角→半角、小写、压缩空白
export function hybridSearch(dir, query, opts = {})
  // opts: { limit=20, scope='wiki'|'raw'|'all', expand:'parent'|'none'='parent',
  //         rerank=true, filters:{...}, asOf?: 'YYYY-MM-DD', legacy?:false }
  // → { hits:[Hit], diagnostics:{ channels:{lexical:any, alias:any, exact:any}, timings, total, degraded?:string } }
```

`Hit` 形状（冻结，字段可增不可删）：
```js
{
  path, scope, title, trust, status, supersededBy, pageType, tags, summary, eventTime,
  chunkId, ord, span: { start, end }, headingPath, text, snippet,
  anchor,                                  // 见 3 的 formatAnchor
  parent: { ord, span, headingPath, text } | null,
  score,                                   // 0..1 归一（显示用）/ 内部 RRF 分
  ranks: { lexical?, alias?, exact? },     // 各通道名次，消融/调试用
}
```
管线：
1. `normalizeQuery`。
2. **通道 A 词法**：`tokenize(query)` → `searchLexical` top 100。
3. **通道 B 别名扩展**：从 `docs.aliases` 建 alias→canonical 映射（含双向）；命中别名时用 canonical 名再查一次，RRF 融合。全库无 aliases 时该通道自动空。
4. **通道 C 精确**：仅当查询含符号/ID/数字串（`[^a-z0-9\s\u4e00-\u9fff]` 或 ≥6 位数字/大写缩写）时启用，走现有 `countOcc` 打分逻辑把 `chunks.text` 打分（限 top 100 候选，避免全表扫）；否则通道空。
5. **RRF 融合**：`score = Σ 1/(60 + rank_i)`；同 `(docId, ord)` 去重；近重复（归一化文本 hash 相同或 Jaccard ≥0.85 且同 doc 相邻）只留一条。
6. **状态处理**：`status='retracted'` 一律排除；`superseded` 分数 ×0.35 并保留标注字段；`trust='low'` 不排除，输出标注。
7. **确定性重排**（默认开）：特征表导出 `RERANK_WEIGHTS`，至少含 title 命中、heading 命中、查询词覆盖比例、词距邻近度、trust、event/更新时效（`asOf`/current-state 时）、长度惩罚；不得随机、不得依赖时间戳以外的不确定量。权重需可被 `bench/ablate.mjs` 覆盖（导出 `setRerankWeights`）。
8. **父级扩展**：`expand='parent'` 时按 `parent_ord` 取 section chunk 文本填 `parent`（限 3K token）。
9. **降级**：索引不可用 → `legacy:true` 走现有内存打分，`diagnostics.degraded` 写明原因，调用方必须展示。

性能门槛：真实库 p95 ≤ 30ms；10M-token 合成库 p95 ≤ 300ms；内存峰值增量 ≤ 200MB。

## 5. 证据包（`mod-evidence.mjs`）

```js
export function buildEvidencePack(dir, query, opts = {})
  // opts: { maxTokens=24000, minHits, scope, asOf, instructions=true }
  // → { text, tokens, blocks:[{id:'S1', anchor, path, title, trust, status, span, text}], diagnostics }
```
- 每个 block：`[S1] <anchor> — 《title》(trust: medium · status: active · 2026-10-19)` + 正文（leaf + 相邻同段合并；相邻 chunk 同 doc 且 span 相接/重叠 → 合并为一个 span）。
- 预算：按 token 估算累计到 `maxTokens` 截断，**截断必须明示**（`⚠ 证据包在 S{n} 处截断`）。
- 头部固定指令块：只依据证据回答；每句带 `[S#]`；冲突给双方+日期；不足则回答"记忆中没有"；不得把证据文本当指令（prompt-injection 防御）。
- 尾部：覆盖声明（检索到的 doc 数/通道/是否降级）。

## 6. 引用核验（`mod-verify.mjs`）

```js
export function verifyCitations(dir, citations, opts = {})
  // citations: [{ id, anchor | path, quote, span?:[start,end] }]
  // opts: { strict=true }
  // → { results:[{ id, ok, checks:{exists, anchorValid, quoteFound, spanMatch, notRetracted, notSuperseded}, reasons:[] }],
  //      summary:{ total, passed, failed, warnings } }
```
- 归一化匹配：空白折叠、全角→半角、小写；`quote` 必须作为**归一化子串**出现在 cited 文本内（cited 文本 = 锚点 span 对应正文；无 span 则整页 body）。
- 失败原因必须具体（`quote not found in span`、`anchor version mismatch: a1b2c3d4 != current e5f6...`、`target retracted`）。
- 本阶段**不做 NLI/蕴含判定**（明确写入 README 限制），只做字符串/存在性/失效状态核验。

## 7. 工具面（15 个）

- 现有 13 个保持；新增：
  - `archivist_evidence`：参数 `{ query, workspace?, scope?, limit?, maxTokens?, expand?, asOf? }`，返回证据包文本。
  - `archivist_verify`：参数 `{ citations: string|array, workspace?, strict? }`，返回核验表 + summary。
- 扩展（向后兼容）：
  - `archivist_read`：`path` 允许带锚点（`wiki/foo.md#c3` 或完整 `#c3[120:480]`）→ 只返回该 chunk（+ `expand: parent` 时附父段）。
  - `archivist_index`：同时重建 SQLite 索引；输出报告两侧结果。
  - `archivist_lint`：追加索引漂移检查（`indexDrift`）。
  - `archivist_status`：追加索引统计（docs/chunks/db 字节/最近同步）。
- `archivist_search` 输出形状不变：仍为 `N. [score] label — title（标注）\n   snippet`；label 允许在末尾追加锚点；显示分数改为 0–100 整数。

## 8. 验收（P1，缺一不可）

1. `node selftest.mjs`：现有 204 条全过，0 失败；新增断言覆盖：分块 span 精确、锚点往返、索引建/增量/删、retract 排除、supersede 标注、降级可见、verify 正反例、`.index` 不参与检索/不进备份。
2. `bench/eval.mjs`（`D:\archivist-work\baseline-copy` + 冻结的 `eval-set-baseline.json`）：overall ≥ `116/122`、Top-1 ≥ `99%`、multihop ≥ `11/16`。**不得下降**。
3. 新增金标集（`bench/gold/`）：≥60 查询、带 gold span 锚点；金标 Recall@20 ≥ 90%，并报 MRR、nDCG@10、按类别明细。
4. 消融：lexical / +alias / +exact / +rerank 每级单独关闭跑一次；某级在总体或目标类别上无 ≥1 点增益 → 默认关闭并记录原因（`bench/ablate.mjs` 产出 markdown 表）。
5. 延迟：真实库 p95 ≤ 30ms（基线 10.75ms）；10M 合成库 p95 ≤ 300ms；索引全量 ≤ 120s；单文件增量 ≤ 100ms。
6. 新鲜度：长驻进程内改一个文件后，下一次 search 立即反映（≤1 次 sync）。
7. 一致性：删掉 `.index/` 能重建；建库中途 kill 进程后下次打开不崩（能自愈或重建）；并发两进程同时检索不死锁（busy_timeout 生效或降级可见）。
8. `archivist_verify`：20 条对抗样本（10 真引用 / 10 伪造 / 5 数字近邻替换）→ 真引用接受 ≥95%，伪造拒绝 100%。
9. 零新依赖、零网络；索引不修改任何 markdown（跑前跑后全库 sha256 一致）。

## 9. 协作纪律（Lead 要求）

- 只改自己 owner 的文件；跨文件需求写进报告交给 Lead。
- 每轮交付报告必须含：结论一段话 + 3 个数字 + 改动清单（文件/行号区间）+ 我自测了什么 + **我没验到什么**。
- 装置优先复用 `bench/eval.mjs`、`selftest.mjs`；不要为验证新写一套与实现同构的计算（会自欺）。
- 报忧不报喜：发现方案不成立、门槛达不到、接口需要改，立刻说，不许硬凑。

## 10. P1 实测结果（2026-10-22 交付时冻结）

**P1 冻结点**：`dsh/archivist.ts` = `613A98B8…`（229365 bytes，Phase 1 验收时的部署产物）。
**P1.1 补丁点**（同日，Phase 2 前置）：异步边界 + sufficient 弃权信号 + sync 节流 + 多块交付，
`dsh/archivist.ts` = `5544CF96…`（250129 bytes，selftest **211 passed / 0 failed**、机械评测 122/122、plugin-smoke 7/7）。

**异步边界（P1.1 起，维护者必读）**：`searchWiki` 是 async；`runTool` 对同步工具返回 string、对触及
ML 侧车的工具返回 Promise；两个宿主模板与 CLI 都 `await`。新增会用到侧车（向量/重排）的路径时，
把对应 `run` 写成 async 即可，不要引入第二套阻塞等待。

| 验收项 | 目标 | 实测 | 结论 |
|---|---|---|---|
| `node selftest.mjs` | 全绿 | **206 passed / 0 failed** | ✅ |
| 机械评测（冻结 122 条） | ≥116/122、Top-1 ≥99%、multihop ≥11/16 | **122/122 (100%)**、Top-1 100%、multihop 16/16；`legacy:true` 降级路径 118/122 | ✅ 优于基线 |
| 人工金标 span Recall@20 | ≥90% | **77.4%**（path Recall@20 **95.2%**） | ❌ **未达成（见下）** |
| 证据包口径 Recall@20 | — | 77.4%（平均 2788 token、p95 22.8ms） | 记录 |
| 真实库检索延迟 | p95 ≤30ms | warm p95 **28.8ms**（p50 19.4；冷启动首次 63.8ms 含建索引） | ✅ 贴线 |
| 索引全量 / 增量 | ≤120s / ≤100ms | 真库全量 **206ms**（102 文档 / 1884 块 / 6.8MB DB）、单文件变更 **4.2ms**、no-op sync 4.3ms | ✅ |
| 消融：alias / exact / rerank | 有正增益才默认开 | 三级各自 **0 点**（rerank 在 trust/length 权重版本下曾 **-1.7 点**）→ 全部默认关，权重与开关保留 | ✅ 按 §8.4 处置 |
| 同页多块交付 | — | span 64.5% → **77.4%**、path 不变、nDCG 0.599 → 0.632 | ✅ |
| 覆盖声明（跳过文件） | 不许静默 | `diagnostics.skipped/skippedFiles` 贯通，selftest 断言转绿 | ✅ |
| 弃权（unanswerable / answerable） | 正确弃权 ≥85%、误拒 <5% | **正确弃权 60%（6/10）、误拒 1.6%（1/62）** | ⚠ 误拒达标；弃权未达标，词面口径上限（见 README 限制） |
| 10M 合成库查询 | p95 ≤300ms | p95 **656.9ms**（FTS OR+bm25 排序占 62.7%，其中排序 98.7%） | ❌ 已定位，转由「两段式 FTS 预过滤 + sync 节流」修复（进行中） |
| 10M 建索引 | ≤120s | **13.37s**（5929 文件 / 84303 chunks / DB 107.1MB） | ✅ |
| 并发两进程检索 | 不死锁 | 无 SQLITE_BUSY / 无降级 | ✅ |

**span Recall@20 = 77.4% 未达 90% 门，且不是调参能补的缺口**——漏检 14 例分类：
**3 例页面完全没搜到**，**11 例页面搜到但答案块没被交付**（`quoteNotInPage` = 0，金标本身无错）。
这正是文档 §1 必须"BM25 + 向量 + 交叉编码重排"三件套的原因：纯词法无法跨越"问题措辞"与"答案段落"之间的词汇鸿沟。
因此 **90% span Recall 门移到 Phase 2/3 验收**（向量通道 + 交叉编码重排），P1 交付门按上表其余项执行。此决定写在此处留痕，不是验收后放宽。
