# Archivist Phase 2 — ML 侧车（向量通道）

独立 Python 进程，提供 **嵌入** 与 **重排** 两个模型能力；dsh/OpenCode 宿主只做编排，
原因是 Electron 44 (ABI 149) 装不进原生 onnxruntime。

- 传输：stdin/stdout **一行一个 JSON**；日志只走 stderr。
- 模型：**懒加载**（首次 embed/rerank 才加载）；空闲 600s 自动卸载。
- 设备：**CPUExecutionProvider only** —— 本机 AMD RX 6750 GRE 的 DirectML 实测比 CPU 慢 30×。
- 网络：**零网络、不自动下载**；缺模型返回可读的 `MODEL_MISSING`。

## 安装（由人执行，一次）

```powershell
# 1) 专用 venv（不要装进宿主）：在 archivist/ml 目录下
uv venv .index/ml-venv --python 3.12
uv pip install --python .index/ml-venv/Scripts/python.exe -r requirements.txt
# 或： python -m venv .index/ml-venv ; .index/ml-venv/Scripts/pip install -r requirements.txt

# 2) 下载模型（HF 直连不通，走镜像；模型目录即 ARCHIVIST_ML_MODELS）
$env:HF_ENDPOINT = 'https://hf-mirror.com'
uvx --from huggingface_hub hf download Xenova/multilingual-e5-small --include 'onnx/model_int8.onnx' 'tokenizer.json' 'config.json' --local-dir .index/models/e5-small
uvx --from huggingface_hub hf download Xenova/bge-reranker-base --include 'onnx/model_int8.onnx' 'tokenizer.json' 'config.json' --local-dir .index/models/bge-reranker-base
```

目录结构（代码自动在子目录里找 `onnx/*.onnx` 与 `tokenizer.json`）：

```
<ARCHIVIST_ML_MODELS>/
  e5-small/{onnx/model_int8.onnx,tokenizer.json,config.json}
  bge-reranker-base/{onnx/model_int8.onnx,tokenizer.json,config.json}
```

## 接入插件（环境变量，插件读，不写死）

| 变量 | 缺省 | 说明 |
|---|---|---|
| `ARCHIVIST_ML` | `1` | **`0` = 完全禁用**：插件与 JS 模块都不会 spawn 任何子进程 |
| `ARCHIVIST_ML_PYTHON` | 探测 `python`/`python3` | 侧车解释器绝对路径（指向上面 venv 的 python.exe） |
| `ARCHIVIST_ML_MODELS` | `<workspace>/.index/models` | 模型根目录 |
| `ARCHIVIST_ML_EMBED_MODEL` | `e5-small` | 嵌入模型子目录名 |
| `ARCHIVIST_ML_EMBED_MAX_TOKENS` | `512` | embed 截断长度（dynamic padding 也按 batch 内最长补齐） |
| `ARCHIVIST_ML_RERANK_MAX_TOKENS` | `128` | rerank 截断长度（512 时实测 179ms/对，128 时 32ms/对，Phase 3 用默认） |
| `ARCHIVIST_ML_RERANK_BATCH` | `8` | rerank 每批候选数（request 里可用 `batch` 覆盖） |
| `ARCHIVIST_ML_RERANK` | `0` | `1` 才允许 rerank（Phase 3 再开） |
| `ARCHIVIST_ML_IDLE_UNLOAD_S` | `600` | 空闲卸载秒数，`0` = 从不卸载 |
| `ARCHIVIST_ML_HOME` | 自动（模块旁 `../ml`） | 侧车 `ml/` 目录 |

## 自检（<60s）

```powershell
# 在 archivist/ml 目录下：
D:\...\ml-venv\Scripts\python.exe -m archivist_ml.sidecar --selftest --models-dir D:\...\models
# 预期末行： [archivist-ml] selftest: 14 passed, 0 failed, 14 total
# 退出码：0=全过，1=失败，2=模型缺失（不 spawn、不重试、立刻返回）
```

覆盖：ping / 懒加载 / 坏 JSON / 未知方法 / embed(单条+64 批) / 单位范数 / 超大输入 /
rerank(sigmoid 0..1 排序) / **rerank 30×160-token 性能门（≤45ms/对、≤1.5s）** /
输入 EOF 优雅退出 / 宿主超时 kill 路径。stderr 会打印实际加载的模型文件
（必须是 `model_int8.onnx`）、provider（必须是 `CPUExecutionProvider`）与 `max_tokens`。

## 协议（`docs/p2-contract.md` §1）

请求：`{"id":1,"method":"embed","params":{"texts":["..."],"model":"e5-small","kind":"passage"}}`

| 方法 | params | result |
|---|---|---|
| `ping` | `{}` | `{pid, version, python, models_dir, models_loaded, rss_mb}` |
| `embed` | `{texts, model?, kind?:'query'\|'passage'\|'none'}` | `{model, kind, dim, count, vectors, ms}`（mean pooling + L2，Float32） |
| `rerank` | `{query, docs, topK?, model?}` | `{model, scores:[{index,score}], count, ms}`（sigmoid 0..1，降序） |

错误响应：`{"id":1,"ok":false,"error":{"code":"MODEL_MISSING","message":"..."}}`。
错误码：`BAD_JSON / BAD_REQUEST / BAD_PARAMS / TOO_LARGE / UNKNOWN_METHOD /
MODEL_MISSING / RUNTIME_MISSING / MODEL_LOAD_FAILED / RERANK_DISABLED / INTERNAL`。
坏请求只回错误行，进程继续服务；单请求超时由**宿主侧** kill（ONNX 调用不可抢占）。

## 限制（必须知道）

- 只支持 ONNX（int8 或 fp32）+ `tokenizer.json`；不支持 PyTorch 权重。
- 只用 CPU；GPU 需自行改 `providers`（本机实测 DirectML 更慢，不是笔误）。
- 每个侧车进程常驻约 50MB，加载 e5-small 后 ~180MB、再加载 reranker 后 ~600MB；
  空闲卸载可回收，但宿主 RSS 不保证立即归还 OS。
- 单次请求文本上限：embed 256 条 / 200 万字符；rerank 256 条候选。
- `ARCHIVIST_ML_RERANK=0`（默认）时 `rerank` 返回 `RERANK_DISABLED`，插件 Phase 3 才用。
- 时间戳/评分仅用于排序，不构成语义蕴含判定。
