# archivist

给 AI Agent 的**本地长期知识库**插件：把对话、文档与资料增量编译成互相链接的 markdown wiki，跨会话、跨宿主检索与复用。**纯本地、零密钥、零网络、零第三方依赖**。

- 方法论来源：Andrej Karpathy 的 [LLM Wiki 模式](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)——不用 RAG 每次重检索，而是让 LLM **一次编译、持续维护**一份持久的 wiki（复利资产）。
- 形态：**OpenCode v2 插件**（工具命名空间 `archivist.*`）+ **DeepSeek Harness (dsh) 插件**（工具 `archivist_*`），外加可选的**对话蒸馏钩子**（双端）。
- 与 `windows-tools` 不同：本插件不依赖 PowerShell，直接运行在宿主内置的 Node/TS 运行时上。

---

## 它是干什么的 / 有什么用

一句话：**给 AI 一个可检索、可备份、可演进的外部记忆**，替代"每次问答都从零翻原始资料"。

| 用途 | 说明 |
|---|---|
| 资料编译 | 把文档/笔记/网页剪藏/PDF 转出的 md 丢进 `raw/`，按 schema 编译成 `sources/entities/concepts/syntheses` 四类互链页面 |
| 对话蒸馏 | 可选钩子：安装后首次会话 AI 会询问"要不要把之前的对话蒸馏进 wiki"；之后周期提醒，把决策/结论/方法沉淀为页面 |
| 跨宿主复用 | 同一个工作区（如 `D:\archivist`），OpenCode 与 dsh 都能读写 |
| 备份与版本 | 内置**免 git 快照备份**（时间戳目录 + manifest + 轮转）；有 git 时可选 `archivist_commit` |
| 可检索的规模 | `archivist_search` 支持 `scope: wiki / raw / all`，CJK 二元组 + 短语 + IDF 稀有度加权 |

## 工具清单（13 个）

| dsh 工具 | OpenCode 工具 | 作用 |
|---|---|---|
| `archivist_init` | `archivist.init` | 显式路径建库并注册指针（重装系统不丢：挂回即可） |
| `archivist_attach` | `archivist.attach` | 挂回已有库（换机/换目录） |
| `archivist_status` | `archivist.status` | 概览：页数、token 估算、源状态、最近日志 |
| `archivist_sources` | `archivist.sources` | `raw/` 清单与摄入状态（new / changed / ingested，哈希跟踪） |
| `archivist_search` | `archivist.search` | 检索（词法级）：标题+全文，CJK 二元组/整短语/紧凑变体/IDF |
| `archivist_scan` | `archivist.scan` | **全量精确扫描**：计数 + 完整文件清单 + 覆盖声明（穷尽/统计类问题专用，不做 top-K 截断） |
| `archivist_read` | `archivist.read` | 读页（标题宽容解析、支持批量） |
| `archivist_write` | `archivist.write` | 校验并写页：frontmatter 补全、索引自动重建、源标记、可选日志 |
| `archivist_index` | `archivist.index` | 确定性重建 `index.md`（根治目录漂移） |
| `archivist_lint` | `archivist.lint` | 结构体检：断链/孤儿页/缺 frontmatter/重复标题/索引缺漏/高频未建页 |
| `archivist_log` | `archivist.log` | 追加/读取时间线日志（`grep` 友好） |
| `archivist_backup` | `archivist.backup` | 免 git 快照备份 + 轮转（建议 target 指向别的盘/云盘目录） |
| `archivist_commit` | `archivist.commit` | 可选：`git add + commit`（无 git 不影响使用） |

## 引用纪律与纠错语义（v2）

- **trust 分级**：页面默认 `medium`（有 raw 出处）或 `low`（模型派生、无出处）；`high` 保留给用户确认内容。检索会给低信任页标注`低信任`，`archivist_read`/`archivist.read` 返回状态横幅
- **raw-first 蒸馏**：对话先落 `raw/conversations/` 原文，再编译成页（`sourceFile` 锚定出处）——蒸馏产物可回查、可审计
- **纠错永不覆盖历史**：`supersedes` 写替代页（旧页自动 `superseded`，检索降权并标注替代关系）；`retract` 撤回（检索排除）；`archivist_lint`/`archivist.lint` 校验替代链完整性
- **穷尽类问题路由**：`archivist_scan`/`archivist.scan` 提供全量精确计数与完整文件清单（附覆盖声明，不做 top-K 截断）；检索检测到穷尽/计数意图时会提示改用 scan

## 对话蒸馏钩子（可选组件）

| 宿主 | 文件 | 挂点 |
|---|---|---|
| dsh | `dsh/archivist-distill.ts` | `agent/pre-step` 瀑布，向本步注入 notice 消息 |
| OpenCode | `opencode/archivist-distill.ts` | `ctx.session.hook("context")`，在派发前追加 system 文本 |

行为：**首次安装检测**——装好后第一次真实会话，AI 会被要求询问「要不要把之前的对话蒸馏进 archivist？」（只问一次，写入状态文件）；此后每 12 个模型请求轻提醒一次（advisory，不阻断；写入由 Agent 决定，避免灌水）。
开关：环境变量 `ARCHIVIST_DISTILL_STATE`（状态文件路径）/ `ARCHIVIST_DISTILL_NUDGE`（间隔，0=关闭）。

---

## 支持多大的数据量（实测数据）

**容量上限 = 磁盘**（wiki 是纯 markdown + JSON 清单；1000 万 token ≈ 30–40MB 文本）。下表是真实基准（Windows、单机 SSD、20 条查询 × 3 轮，`bench/bench-queries.mjs` 可复跑）：

| 数据量 | 文件数 | 体积 | 查询延迟 | 全量扫描（摄入哈希） |
|---|---|---|---|---|
| 39 万 token | 176 | 1.24 MB | **5.7 ms** | 24 ms |
| 314 万 token | 1,408 | 9.9 MB | **47 ms** | 167 ms |
| **1,060 万 token** | 4,752 | 33.4 MB | **160 ms**（p95 214ms） | 592 ms |

- 线性扩展（约 0.14ms/文件）；`mtime+size` 内容缓存让重复查询进入内存档
- 检索准确率：内置**分类评测台**（`bench/eval.mjs` + `bench/make-eval.mjs`，8 类断言）；实测：含中文真实库 **60/60**、含纠错场景演示库 **10/10**
- token 估算口径：CJK ≈ 1 字/token；拉丁 ≈ 4 字符/token

**边界说明（诚实声明）**：单次模型注意力仍受上下文窗口限制——"回忆 = 检索 + 重合成"。超过 ~1000 万 token 或高频查询场景，建议后续接入 ripgrep（OpenCode 自带 `~/.cache/opencode/bin/rg.exe`）或向量检索；当前版本为词法级检索，对同义改写的命中有限。

---

## AI 安装

> 面向执行安装的 AI Agent / 用户：先做前置检查，再按宿主选 A 或 B（钩子可选装），最后跑「自检」。

前置：一个支持的宿主（OpenCode v2 或源码运行的 dsh）。**无 npm/pip 依赖**，复制文件即可。

### 方式 A：OpenCode v2

```powershell
# $REPO = 本仓库克隆后的绝对路径（按实际修改）
$REPO = "$env:USERPROFILE\DeepSeek-Harness-Plugins"

$dir = "$env:USERPROFILE\.config\opencode\plugins"
New-Item -ItemType Directory -Force -Path "$dir\archivist" | Out-Null
Copy-Item "$REPO\archivist\opencode\index.ts" "$dir\archivist\index.ts" -Force

# 可选：对话蒸馏钩子（独立文件插件）
Copy-Item "$REPO\archivist\opencode\archivist-distill.ts" "$dir\archivist-distill.ts" -Force
```

**生效方式**：OpenCode 监听配置目录并热加载，无需重启。
**验证**：会话工具目录出现 `tools.archivist.*`（13 个）。

### 方式 B：dsh

> **重要**：dsh 插件文件**必须放进 dsh 源码仓库树内**（例如 `<dsh-repo>/scratch-plugin/src/`），否则 `@deepseek-ai/dsh-tools` 依赖无法解析、插件加载失败。

```powershell
# $DSHREPO = dsh 源码仓库绝对路径
$DSHREPO = "C:\path\to\deepseek-harness"

New-Item -ItemType Directory -Force -Path "$DSHREPO\scratch-plugin\src" | Out-Null
Copy-Item "<本仓库>\archivist\dsh\archivist.ts" "$DSHREPO\scratch-plugin\src\archivist.ts" -Force
Copy-Item "<本仓库>\archivist\dsh\archivist-distill.ts" "$DSHREPO\scratch-plugin\src\archivist-distill.ts" -Force
```

然后二选一挂载（覆盖层模板见 `dsh/archivist.cordis.yml`）：

- 临时覆盖层：启动时 `dsh web --patch <改好路径的 yml>`
- **profile 常驻（推荐）**：向 `%USERPROFILE%\.dsh\profiles\<profile>\cordis.patch.yml` 的 `insert` 列表追加模板中的两条（保持 UTF-8 无 BOM）。

**生效方式**：重启对应 dsh 进程。
**验证**：启动日志**不得出现** `failed to import` / `did not activate`；会话中可调用 `archivist_status`。

### 首次使用（两种宿主通用）

```
archivist_init({ path: "D:/archivist" })      # 显式选目录；建议非系统盘，配合 archivist_backup
```

之后把资料放进工作区 `raw/`，按工作区 `AGENTS.md` 的 ingest/query/lint 工作流编译。

## 自检

机器有 Node.js 时（宿主机器一般已具备）：

```powershell
cd <本仓库>\archivist
node selftest.mjs
```

预期输出：**`49 passed, 0 failed`**（覆盖：初始化/幂等挂回、源状态追踪、中文写页、索引重建、中英检索、容错解析、缓存失效、路径安全、lint、备份轮转等）。

没有 Node.js 时：安装后在会话中调用 `archivist.init` 建一个临时库，再调用 `archivist.status`；能返回 `workspace:` 行即安装成功。

## 限制与卸载

- **检索是词法级**（子串 + 统计加权）：同义改写（如"互斥机制"找 synchronized）命中有限；语义级需求待接向量/qmd
- 单次回答质量受模型窗口限制（检索 + 重合成）；超大库建议先用 `archivist_search` 缩小范围再 `archivist_read`
- 蒸馏钩子只**提醒**，写入由 Agent 决定；状态文件可删（会重新触发首次询问）
- **卸载**：OpenCode 删除对应插件文件（热加载自动卸载）；dsh 从 profile 移除 `insert` 行并重启。库数据在独立工作区目录，去留自便

## 维护与构建

- `core/archivist.mjs` 是**唯一逻辑源头**；改动后运行：
  ```powershell
  node build/build.mjs     # 重生成 opencode/index.ts 与 dsh/archivist.ts（断言 13 个工具注册）
  ```
- 两个钩子文件与 `bench/` 为静态工具，直接编辑
- 基准与统计：
  ```powershell
  node bench/bench-queries.mjs "D:/archivist" "bench-report.md"   # 20 条查询延迟分位报告
  node bench/rawstats.mjs "D:/archivist/raw"                      # 语料规模/字符/token 统计
  ```
- 分类评测（纯本地、无依赖；期望值生成时冻结，语料大改后重新生成）：
  ```powershell
  node bench/make-eval.mjs "D:/archivist" eval-set.json        # 从知识库自动出题
  node bench/eval.mjs "D:/archivist" eval-set.json report.md   # 运行评测（低于阈值退出非零 = 回归门禁）
  node bench/eval-demo-setup.mjs <临时目录>                     # 生成含替代/撤回的演示库（验证 correction 类）
  ```
  类别：lookup / phrase / needle / multihop / aggregation / correction / mixed / unanswerable；阈值可用 `EVAL_MIN_TOP1`、`EVAL_MIN_OVERALL` 调整

## 来源与致谢

- 方法论：[Karpathy 的 llm-wiki.md](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)（公开构思文件）
- 目录结构与检索/lint 算法借鉴：[SamurAIGPT/llm-wiki-agent](https://github.com/SamurAIGPT/llm-wiki-agent)（MIT）
- 命令面参考：[atomicstrata/llm-wiki-compiler](https://github.com/atomicstrata/llm-wiki-compiler)（MIT）
- 本插件为独立实现，随本仓库以 MIT 许可发布。
