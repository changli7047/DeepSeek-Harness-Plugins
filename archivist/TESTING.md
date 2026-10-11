# 测试与评测

archivist 的完整验证体系：**纯本地、零依赖、确定性输出**（无 LLM 参与、无网络请求）。分三层，逐层加深。

## 三层验证

| 层 | 命令 | 说明 |
|---|---|---|
| ① 逻辑自检 | `node selftest.mjs` | 63 项断言；在系统临时目录建沙箱库跑完整工作流（独立临时指针，不触碰你的真实库） |
| ② 分类评测台 | `node bench/make-eval.mjs <库>` + `node bench/eval.mjs <库> <评测集>` | **自动出题**（从任意知识库机械生成）+ 8 类断言 + **回归门禁**（低于阈值退出非零） |
| ③ 纠错演示库 | `node bench/eval-demo-setup.mjs <临时目录>` | 机械生成含"替代/撤回"场景的演示库，验证 correction 类（结束后自动恢复你的活动工作区指针） |

## ① 逻辑自检覆盖（63 项断言）

初始化/幂等/挂回 · 源文件状态追踪（new/ingested/changed 哈希比对） · 写页（按标题建概念页、索引重建、更新） · 批量读取与错误处理 · 中英检索（拉丁/中文/空结果/raw/all 范围） · lint（断链/孤儿/缺失页/修复） · 路径安全（越界写入拒绝、index/log 保护） · 日志读写 · **v2 纪律**（trust 分级、替代链翻页与标注、撤回排除、状态计数） · **穷尽扫描**（精确计数、文件清单、覆盖声明、零命中提示、穷尽意图提示） · 符号短语分词（`B+ Tree`、`O(log n)`） · raw 索引缓存失效 · 备份（快照/多份/轮转/自排除） · 解析与 token 估算 · 13 工具注册表

## ② 分类评测台（8 类断言）

| 类别 | 断言 | 说明 |
|---|---|---|
| lookup | 标题查询 → 本页 Top-1 | 页名精确查找 |
| phrase | 库内唯一片段（≥10 字）→ 本页 Top-1 | 生成器先验证全库唯一性再出题 |
| needle | raw 原文长句片段 → 源文件 Top-1 | 深度召回（长短语加权） |
| multihop | 互链页双词查询 → 两页均进 Top-3 | 覆盖性断言（非推理） |
| aggregation | 查询词精确计数 = 冻结值 | 计数回归锚点 |
| correction | 撤回页查无 ✓；替代页带「已被…替代」标注 ✓ | 纠错语义实弹 |
| mixed | 中文标题 + 英文标识符 → 本页 Top-3 | 中英混排 |
| unanswerable | 诱饵词（全库零出现）→ 必须无命中 | 防误报 |

门禁阈值：`EVAL_MIN_TOP1`（默认 0.9）、`EVAL_MIN_OVERALL`（默认 0.8），低于即非零退出。

## 最新全量自测（2026-10-11）

| 板块 | 结果 |
|---|---|
| 逻辑自检 | **63/63** |
| 真实库分类评测（60 用例：中英混排 + 中文 raw 深召回） | **60/60 = 100%**（lookup 8/8 · phrase 8/8 · needle 7/7 · multihop 15/15 · aggregation 10/10 · mixed 9/9 · unanswerable 3/3） |
| 纠错演示库评测（10 用例） | **10/10 = 100%**（correction 2/2） |
| 双端部署一致性 | 4 个已部署文件逐一哈希 **4/4 MATCH**（无"改了源码忘记部署"漂移） |
| 发布物独立自检 | 从 GitHub **全新克隆** → `selftest.mjs` **63/63**；重新 `build` → 与提交产物 **零 diff** |
| 宿主活性 | dsh 正常监听、加载日志无错误 |
| Live 工具抽查 | status / lint（0 问题）/ scan（精确计数）/ search（信任标注）/ read（状态横幅）全部符合预期 |

> **「发布物独立自检」为什么重要**：它模拟"别人从 GitHub 拿到仓库"的完整流程。自检通过说明发布物自洽；重构建零 diff 说明**提交的生成物与源码零漂移**，任何人可复现。

## 复现

```powershell
git clone https://github.com/changli7047/DeepSeek-Harness-Plugins
cd DeepSeek-Harness-Plugins\archivist

# ① 逻辑自检
node selftest.mjs                                    # 预期 63 passed, 0 failed

# ② 评测你自己的知识库
node bench/make-eval.mjs "D:/your-wiki" eval-set.json      # 自动出题
node bench/eval.mjs "D:/your-wiki" eval-set.json report.md # 评测 + 门禁

# ③ 纠错场景演示库
node bench/eval-demo-setup.mjs "$env:TEMP\archivist-demo"
node bench/make-eval.mjs "$env:TEMP\archivist-demo" demo-set.json
node bench/eval.mjs "$env:TEMP\archivist-demo" demo-set.json demo-report.md
```

## 说明

- 评测集**期望值在生成时冻结**（作为回归锚点）；你的语料大改后请重新生成
- 大库性能基准与语料统计见 README「数据量」一节（`bench/bench-queries.mjs` / `bench/rawstats.mjs` 可复跑）
