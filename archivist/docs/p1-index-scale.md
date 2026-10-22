# P1 索引规模与并发实测（impl-chunks）

> 测量日期 2026-10-22 · 机器：Windows 10/11，Node v24.21.0，`node:sqlite`（SQLite 3.53.4）
> 被测代码：`core/mod-chunks.mjs` + `core/mod-indexdb.mjs`（当前 HEAD）
> 语料：`node bench/gen-corpus.mjs --all --root D:\archivist-work\corpora`（1m/3m/10m，seed 42，确定性生成）
> 方法：每档把语料复制到临时目录并**先删掉旧 `.index/`**（冷启动全量建库），再用同一进程测查询与增量；
> 10M 档最后用 **两个独立 OS 进程**各开一个连接并发查询。测量脚本为临时探针（不入库），数字为单次运行结果。

## 1. 结果总表

| 档位 | 文件数 | 叶子 chunk | 全量建库 | DB `.index/archivist.db` | `searchLexical` warm p50 / p95 | `hybridSearch` warm p50 / p95 | 单文件增量 | 空转 sync（仅 stat 扫描） | integrity_check |
|---|---|---|---|---|---|---|---|---|---|
| 真实库 `baseline-copy`（干净副本） | 102 | 968 | **0.20 s** | 2.8 MB | 0.43 / **1.01 ms** | 9.26 / **14.69 ms** | **17.2 ms** | 3.6 ms | ok |
| 1m | 587 | 4 223 | 1.18 s | 11.5 MB | 0.47 / 24.47 ms | 23.40 / 71.99 ms | 24.2 ms | 22.4 ms | ok |
| 3m | 1 793 | 12 705 | 3.90 s | 32.3 MB | 0.50 / 65.96 ms | 69.89 / 152.31 ms | 54.0 ms | 61.1 ms | ok |
| 10m | 5 929 | 42 373 | **13.37 s** | **107.1 MB** | 0.67 / **208.01 ms** | 150.58 / **334.99 ms** | 187.8 ms | 191.5 ms | ok |

补充行数（`indexStats`）：真实库 docs 102 / chunks 1 884 / fts 968；1m 587 / 8 403 / 4 223；3m 1 793 / 25 292 / 12 705；10m 5 929 / 84 303 / 42 373。全量建库后 `PRAGMA wal_checkpoint(TRUNCATE)` 的 WAL 为 0，DB 体积即上表值。
查询口径：`searchLexical` scope='all' limit=100；`hybridSearch` scope='all' limit=10（合成语料正文全在 `raw/`，wiki 只有 index.md，默认 wiki 口径无命中）。每档 warmup 3 条后再采样（真实库 20 条×20 轮；合成档 20 条×10 轮，hybrid 20×5 轮）。

## 2. 合同门槛对照（§2.2 / §4 / §8.5）

| 门槛 | 结果 | 判定 |
|---|---|---|
| 10M-token 全量建索引 ≤ 120 s | 13.37 s（≈75 万 token/s） | ✅ |
| 真实库查询 p95 ≤ 30 ms | `searchLexical` 1.01 ms / `hybridSearch` 14.69 ms | ✅ |
| 10M 合成库查询 p95 ≤ 300 ms | `searchLexical` 208 ms ✅；`hybridSearch` 335 ms ❌ | ⚠ 差 12%（原因见 §3） |
| 单文件增量 ≤ 100 ms | 真实库 17.2 ms ✅；1m 24.2 ms ✅；3m 54.0 ms ✅；10m 187.8 ms ❌ | ⚠ 10M 文件数过大时扫描成为下限（见 §3） |
| 内存峰值增量 ≤ 200 MB | 10M 建库后进程 RSS 278 MB（含 Node 基线）；未做逐秒峰值采样 | ⚠ 仅近似 |

## 3. 关键发现（报忧）

1. **10M 的 `hybridSearch` p95 335 ms 超 300 ms 门槛，但超出的部分主要是每次检索前的增量同步，不是检索本身。**
   `syncIndex` 空转（无任何改动）在 5 929 文件时要 191.5 ms，几乎全部是逐文件 `statSync`（Windows + Defender 下约 32 µs/次）。
   `searchLexical` 本身 10M p95 只有 208 ms。建议（在 retrieval 域）：`hybridSearch` 对 `syncIndex` 做时间节流（如 1 s 一次，
   合同只要求「改文件后下一次 search ≤1 次 sync 反映」，没有要求每次 search 都同步），或给 `syncIndex` 加目录级 stat 缓存。
   同一现象也解释了 10M「单文件增量 187.8 ms」：增量逻辑只处理 1 个文件（~2 k token），耗时几乎全是 5 929 文件的扫描。
   若合同要求 10M 档也满足 ≤100 ms，需要接受降低扫描频率或引入缓存；这不是分块/索引正确性问题。
2. **旧 `.index` 会跨版本保留旧分块结果。** `D:\archivist-work\baseline-copy` 里遗留的 `.index`（schema 1）中存在 21 个 >500 token 的
   leaf，是更早版本分块器的产物；因为 `(mtime,size)` 未变，`syncIndex` 按 §2.2 正确跳过，所以旧数据不会被自动重算。
   干净副本重测后 **>500 token 的 leaf = 0**。建议：在 `meta` 里加一个「分块器/索引逻辑版本」并在不匹配时强制重建（当前只有 `schema_version`，
   只能捕捉 DDL 变化）；或接受「升级后需手动 archivist_index」并在 README 写明。
3. **叶子尺寸分布**：真实库 79.6% 的 leaf < 300 token（771/968），1m/3m/10m 为 62.3%；**>500 token 的 leaf 在所有新索引中为 0**。
   短 leaf 来自短章节（一个 section 内不足 300 token，整节即一个 leaf，无法拆分也不会跨节借内容）；这是语料结构，不是分块器越界。
4. **索引体积 ≈ 11 bytes / leaf-token**（10M：9.62 M leaf token → 107.1 MB）。体积主要来自 `chunks.text` 的 section+leaf 两级正文
   （section 供 parent 展开，必然与 leaf 重复一份）加 FTS5 词表，属合同 schema 的固有代价。
5. **两进程并发（10M，同一 DB）：** 两个独立进程各开连接、各跑 50 次 `hybridSearch`（其中一个进程先 append 一个文件触发一次写事务，制造读写竞争）：
   - 两个进程均 exit 0，`errorCount=0`，`diagnostics.degraded=0`（**未出现 SQLITE_BUSY / 死锁，无降级需要触发**）；
   - 单进程 p50 195/198 ms、p95 479/472 ms、max 1360/1302 ms（首个查询含 WAL 打开+首次 sync，max 属冷启动）；
   - 写进程结束后另一进程的下一次检索立即读到新内容；恢复原文件后一次 sync 正常（changed=1）。
   WAL + `busy_timeout=3000` 在真实双进程下有效。
6. **`estimateTokens` 只剩一份定义**：`core/archivist.mjs` 无本地 `function estimateTokens`，只有
   `import { … estimateTokens … } from './mod-chunks.mjs'` + 为兼容旧脚本的 `export { estimateTokens } from './mod-chunks.mjs'`。
7. **命名前缀 100% 合规**：`mod-chunks.mjs` 21 个顶层声明、`mod-indexdb.mjs` 55 个顶层声明，去掉前缀/冻结 API 白名单后 **0 个违规**
   （脚本按 `^(export )?(async )?(function|const|let|class) name` 扫描；`build/build.mjs` 的 `node --check` 兜底）。

## 4. 复现方式

```powershell
node archivist/bench/gen-corpus.mjs --all --root D:\archivist-work\corpora      # 1m/3m/10m，确定性 seed 42
# 冷启动：复制 1m/3m/10m 到临时目录并删掉其中的 .index/，然后
#   openIndex(dir) → t0 → syncIndex(dir) → dt                 （全量建库）
#   searchLexical(db, tokenize(q), {limit:100, scope:'all'})  × 200 次 → p50/p95
#   hybridSearch(dir, q, {limit:10, scope:'all'})             × 100 次 → p50/p95
#   append 一个文件 → syncIndex 计时                          （单文件增量）
#   两进程：各自 new openIndex，各 50 次 hybridSearch
# 真实库用 D:\archivist-work\baseline-copy 的干净副本（不带旧 .index）
```

## 5. 本次没验证到的

- 内存峰值增量没有逐次采样（只在建库结束时读 RSS=278 MB），无法严格断言「峰值增量 ≤200 MB」。
- 双进程只覆盖了「一个写 + 一个读」的检索场景，没有覆盖两进程同时建库/同时增量写同一 DB 的极端竞争。
- 数字是单次运行、单机（D: 为语料来源盘，测试副本在 C: 临时目录），未做多轮取中位数；机械硬盘/不同杀软下 stat 扫描成本会变。
- 1m/3m/10m 档用 `scope='all'` 是因为合成语料正文都在 `raw/`；真实库的 wiki/raw 分档 p95 见 `bench/` 报告（本次真实库只测 all）。
