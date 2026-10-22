# Archivist Phase 2 合同（向量通道）— 冻结版 v1

> 前置：Phase 1 已交付（SQLite 索引 + chunk/span 地址 + 混合词法检索 + 证据包 + 引用核验，selftest 全绿）。
> Phase 1 的实测缺口（人工金标 62 条可回答）：**span Recall@20 77.4%，path Recall@20 95.2%** ——
> 页面几乎都找得到，但"答案块"没被交付（13/14 漏检是"页对块错"）。这一阶段就是补这个缺口的第一个通道。

## 0. 本机实测事实（别再重复探测）

| 项 | 结果 |
|---|---|
| 宿主 | Electron 44 / Node 24.21（ABI 149）→ **原生 onnxruntime 装不进宿主进程** |
| 方案 | **独立 Python 侧车进程**（uv 管理 venv），插件用 stdio JSON-RPC 调用；宿主只做编排 |
| GPU | AMD RX 6750 GRE 10GB，CUDA 无，**DirectML 可用但实测 30× 慢于 CPU**（e5-small int8：DML p50 101ms vs CPU 3.2ms）→ **用 CPU** |
| 嵌入（小） | `Xenova/multilingual-e5-small` int8 ONNX，384 维，112MB，CPU **p50 3.2ms/条** |
| 重排 | `Xenova/bge-reranker-base` int8，CPU **p50 10.2ms/对**，相关 0.979 vs 无关 0.00–0.01 |
| 模型来源 | huggingface.co 不通；`HF_ENDPOINT=https://hf-mirror.com` 可达 |
| 内存 | 总 15.8GB，空闲 ~4.5GB；侧车加载两模型预计 +400–700MB RSS，须支持空闲卸载 |

## 1. 侧车协议（`ml/sidecar.py`）

- 启动：`python -m archivist_ml.sidecar`（由插件用配置的 python 路径拉起；也可独立跑做自检）。
- 传输：**一行一个 JSON 请求 / 一行一个 JSON 响应**（UTF-8，stdin/stdout）。日志一律走 stderr。
- 请求：`{"id":1,"method":"embed","params":{"texts":[...],"model":"e5-small"}}`
- 响应：`{"id":1,"ok":true,"result":{"dim":384,"vectors":[[...],...],"ms":12.3}}` 或 `{"id":1,"ok":false,"error":{"code":"...","message":"..."}}`
- 方法集（v1，只这三个）：
  - `ping` → `{pid, models_loaded, rss_mb, version}`
  - `embed` → 批量文本 → 归一化 Float32 向量（mean pooling + L2）
  - `rerank` → `{query, docs:[str], topK?}` → `[{index, score}]`（sigmoid 后的 0..1）
- 要求：模型**懒加载**；任何未加载方法报可读错误而不是崩；`SIGTERM` 优雅退出；单请求失败不影响后续请求。
- 单条请求超时：embed 5s / rerank 15s；超时由插件侧 kill 该请求并标注降级（不是静默）。

## 2. 存储（schema v2）

`node:sqlite` 仍是系统记录；新增两表，索引仍需可整删重建：

```sql
CREATE TABLE IF NOT EXISTS embeddings (
  chunk_id INTEGER PRIMARY KEY REFERENCES chunks(chunk_id) ON DELETE CASCADE,
  model    TEXT NOT NULL,        -- 如 'e5-small'
  dim      INTEGER NOT NULL,
  vec      BLOB NOT NULL         -- Float32Array 小端字节；int8 量化时需带 scale 表
);
CREATE TABLE IF NOT EXISTS embedding_meta (
  model TEXT PRIMARY KEY,
  dim INTEGER NOT NULL,
  built_at TEXT NOT NULL,
  count INTEGER NOT NULL
);
```
- `meta.schema_version` 升到 `'2'`；旧库**不迁移**，直接删库重建（派生数据，重建成本可接受；重建要在输出里说明）。
- 向量检索在 **JS 侧**做暴力余弦（现在 968 块 / 384 维 ≈ 1.5MB 内存；10M 语料 25K 块 ≈ 38MB Float32，可接受）。**不引入 sqlite-vec / FAISS**。
- 嵌入是**增量**的：只为缺失/模型变更的 chunk 生成；批量 64 条一次请求。
- 查询侧嵌入缓存：同一查询 60 秒内复用（`Map`，上限 256 条）。

## 3. 检索融合（mod-vector.mjs / mod-retrieval.mjs）

- 新通道 `dense`：查询嵌入 → 余弦 top 100 → 与 lexical/alias/exact 一起做 RRF(k=60)。
- 通道开关沿用 `opts.channels`：`{lexical, alias, exact, dense}`；**默认值必须由消融数字决定**（无正增益就默认关）。
- 降级：侧车不可用/超时/模型缺失 → `diagnostics.degraded` 写明原因，检索回退到词法通道（输出可见 `⚠ 降级：向量通道不可用（…）`）。
- 证据包：`buildEvidencePack` 的 `diagnostics.models` 记录用了哪些模型与耗时。

## 4. 配置（不写死在代码里）

插件读环境变量（缺省即关闭，不联网、不自动下载）：
- `ARCHIVIST_ML_PYTHON`：侧车 python 绝对路径（缺省尝试 `uvx`/`python`，找不到就禁用向量通道）
- `ARCHIVIST_ML_MODELS`：模型目录（缺省 `<workspace>/.index/models`）
- `ARCHIVIST_ML_EMBED_MODEL`：`e5-small` | `bge-m3`（缺省 `e5-small`）
- `ARCHIVIST_ML_RERANK`：`0|1`（默认 0，Phase 3 再开）
- 关闭开关 `ARCHIVIST_ML=0` 必须让插件**完全不 spawn 侧车**（回归测试要断言：没有子进程、没有网络）。

## 5. 验收

1. `selftest.mjs` 全绿（现有 206 条 + 新增向量/降级/无侧车时的断言 ≥8 条），且 **`ARCHIVIST_ML=0` 时零子进程**。
2. 侧车自检：`python -m archivist_ml.sidecar --selftest` 覆盖 embed/rerank/ping/坏请求/超时。
3. 真库（`D:\archivist-work\baseline-copy`）：嵌入 968 块 ≤ 60s（CPU）；单块增量 ≤ 100ms；查询 p95 增量 ≤ 60ms。
4. 金标集：**dense 通道开启后 span Recall@20 必须比 Phase 1 的 77.4% 有正增益**；消融要给出 lexical / +dense / +dense+rerank 三档数字；无增益就默认关并记录。
5. 10M 合成语料：25K 块嵌入 ≤ 25 分钟（后台可接受），查询 p95 ≤ 400ms，内存增量 ≤ 200MB。
6. 失败可见：侧车崩溃/超时/模型缺失三种情形都有明确输出行，且检索仍可用（词法回退）。
7. 模型下载**不由插件自动做**：安装步骤写进 README（一条 `hf-mirror` + `snapshot_download` 命令），由人执行。

## 6. 写域

| 文件 | owner |
|---|---|
| `ml/sidecar.py`, `ml/archivist_ml/*`, `ml/README.md` | impl-ml |
| `core/mod-vector.mjs`（嵌入存储读写 + 余弦 + 侧车客户端） | impl-ml |
| `core/mod-retrieval.mjs`（dense 通道接入 + RRF） | impl-retrieval |
| `core/archivist.mjs`（配置读取、降级文案、工具输出） | Lead |
| `selftest.mjs`（新增断言） | Lead |
| `bench/**` 的金标与消融装置 | impl-eval |

## 7. P2 实测结果（2026-10-22，Lead 复验）

**组件（真库 CPU）**
- 侧车 `--selftest`：**13 passed / 0 failed**，约 7s（`python -m archivist_ml.sidecar --selftest --models-dir <models>`）。
- 968 leaf 块冷嵌入 **37.7s**（含 spawn + 模型加载，≤60s 门 ✅）；单块增量 **27ms**；查询嵌入+968×384 余弦 p50 15.9ms / p95 18.5ms。
- 侧车 RSS **868MB**（e5-small 加载后；slotBudget=2048 后峰值从 2.4GB 降下来）。
- 踩坑记录：**numpy 的 C 扩展若在 stdin 读线程阻塞之后再 import 会死锁**（faulthandler 证实），已改为进程启动时 eager import 运行库、session 仍懒加载。

**gold 集（62 条可回答，`bench/gold/gold-real.json`，真库 baseline-copy）**

| 配置 | span Recall@20 | page Recall@20 | 备注 |
|---|---|---|---|
| 词法 only（P1） | 77.4% | 95.2% | multihop 4/8、temporal 6/9、old-fact 3/6 |
| **+ dense（e5-small）** | **83.9%（+6.5 点）** | **96.8%** | multihop 6/8、temporal 7/9、old-fact 4/6、paraphrase 9/10 |
| + 特征 rerank | 83.9%（0 点） | 96.8% | 特征重排确认无效，继续默认关 |

**结论**：向量通道达到 §5.4「必须有正增益」的门槛，ML 可用时 dense **默认开**；交叉编码重排（Phase 3）在此基础上继续补"同一页内选对块"。

**未验/已知边界**：dense 查询 avg 延迟首测偏高（含首次 spawn）；10M 语料 dense 曲线实测：冷首查 3780ms、**warm p50 87.4 / p95 272.6ms（≤300 门 PASS）**（矩阵缓存修复后）；侧车内存 RSS 868MB（e5 加载后）+ 矩阵 55MB；`ARCHIVIST_ML=0` 的零子进程断言由 impl-ml 探针覆盖，宿主内未复验。
