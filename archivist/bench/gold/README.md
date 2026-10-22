# bench/gold — 人工金标集（P1 §8.3）

`gold-real.json`：**72 条**查询，全部由人逐页读原文后判定；**没有任何检索/打分代码参与选 gold**。
工作区语料：`D:\archivist-work\baseline-copy`（真实库副本，51 raw + 50 wiki 页，只读，勿改）。
检索 scope：`wiki`。

## 结构

每条 `{ id, query, category, goldAnchors:[{path, quote}], answerable, notes }`

- `path`：工作区相对 posix 路径（如 `wiki/concepts/...md`）。
- `quote`：该页正文里能唯一锚定答案的**逐字原文**（比较前只做 NFKC/空白归一化）；用来算 span/证据包命中。
- `requireAll: true`（仅 multihop）：两个 anchor 都必须出现才算命中；默认任一即可。
- 不可回答：`goldAnchors: []` + `answerable: false`。

## 类别与条数（合计 72，其中不可回答 10 条 = 13.9%）

| 类别 | 条数 | 说明 |
|---|---|---|
| exact-ident | 8 | 版本号/哈希/常量/数字串 |
| paraphrase | 10 | 语义改写，与原文用词基本不重合 |
| multihop | 8 | 需两页证据（requireAll） |
| temporal | 9 | 当前状态/最新版本/截至日期 |
| corrected | 8 | 页面记录了自我更正或被推翻的结论 |
| aggregation | 7 | 聚合数字（条数/倍数/占比） |
| old-fact | 6 | 被后续轮次覆盖的旧值 |
| mixed | 6 | 中英/数字混排 |
| unanswerable | 10 | 语料确实没有答案（弃权口径见 pack 评测） |

## 已知限制（诚实标注）

1. 副本**没有** `status: retracted|superseded` 页面 → 纠错维度只覆盖「内容级更正」，覆盖不了页面级 retract/supersede。
2. 语料最早 2026-10-15 → 不存在「一年前」的真实事实；`old-fact` 用**被明确覆盖的旧值**代替（notes 逐条注明）。
3. `wiki/index.md` 与 `wiki/log.md` 会复述别页结论，`validate-gold` 会报 6 条 quote 跨页 WARN——这是语料真实情况，不调 gold。
4. 本集与旧口径 `bench/eval.mjs`（116/122）**不同口径，不可混比**。

## 复跑（全部零依赖）

```bash
cd archivist
# 1) 装置自检（指标数学）
node bench/metrics.mjs --selftest
# 2) 通道消融（真实引擎开关 channels/rerank）+ 顺带 dump 生产配置 hits
node bench/ablate.mjs <workspace> bench/gold/gold-real.json --md ablation.md --dump hits.json
# 3) 三列 span 指标：page / strict(leaf) / withParent(headline)
node bench/metrics.mjs bench/gold/gold-real.json hits.json --md metrics.md --no-gate
# 4) 证据包口径（合同真正的验收面）：pack Recall@20 + token + 弃权
node bench/gold-pack.mjs <workspace> bench/gold/gold-real.json --md pack.md
# 5) 规模曲线（先生成 1m/3m/10m，再量针召回与延迟）
node bench/gen-corpus.mjs --all --root D:\archivist-work\corpora
node bench/gold-pack.mjs --scale --corpora D:\archivist-work\corpora --sizes 1m,3m,10m --md scale.md
```

注意：`hybridSearch` 会在工作区建 `.index/`。测真实库请先复制副本再跑，**不要**在只读副本上建索引。
