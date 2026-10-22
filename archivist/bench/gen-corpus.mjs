/**
 * Deterministic synthetic-corpus generator for the archivist scale curve
 * (contract §4 performance gates / §8.5).
 *
 * Writes a valid archivist workspace (raw/gen/*.md + wiki/index.md + AGENTS.md)
 * with CN/EN mixed prose, rare IDs, long digit strings, and near-duplicate pages.
 * Also plants "needles" and writes their gold positions, so Recall@k can be
 * measured at 1M / 3M / 10M tokens. No retrieval code is involved in choosing
 * the needles — the generator plants them and exports their positions.
 *
 * Zero dependencies; fixed seed => byte-identical output for the same args.
 * Token count uses core's own estimateTokens (mod-chunks) so the size label is
 * the same口径 as the index's token_est.
 *
 * Usage:
 *   node bench/gen-corpus.mjs --out D:\archivist-work\corpora\1m --tokens 1000000 [--seed 42] [--needles 24]
 *   node bench/gen-corpus.mjs --all --root D:\archivist-work\corpora [--seed 42]
 * Output: <out>/raw/gen/*.md | <out>/wiki/index.md | <out>/AGENTS.md | <out>/MANIFEST.json
 *         <root>/gold-needles-<label>.json   (same gold schema as gold-real.json)
 */
import { mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { estimateTokens } from '../core/mod-chunks.mjs'

// --- deterministic RNG (mulberry32) ---
function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const pick = (r, xs) => xs[Math.floor(r() * xs.length) % xs.length]
const int = (r, lo, hi) => lo + Math.floor(r() * (hi - lo + 1))

const CN = ('荆州 襄阳 江陵 赤壁 曹操 刘备 孙权 屯田 营寨 木场 官道 关隘 山脉 地形 栅格 算法 缓存 渲染 指针 拾取 断言 回归 验证 种子 回合 部队 粮草 攻城 伏兵 夜袭 扎营 渡口 郡治 考据 词频 原文 建模 法兰 支架 光伏 立柱 檩条 图纸 标注 字体 图层 像素 精灵 材质 体积 光照 阴影 河道 城墙 隘口 栈道 转运 补给 侦察 士气 兵力 地形图 六边形 坐标系').split(' ')
const EN = 'bm25 sqlite fts5 tokenize chunk anchor rerank recall ndcg pipeline index hash seed turn hex tile camera shader audio buffer schema metric latency budget corpus evidence verify query'.split(' ')

function sentence(r) {
  const form = int(r, 0, 5)
  if (form === 0) return `${pick(r, CN)}的${pick(r, CN)}在${pick(r, CN)}里表现为 ${int(r, 2, 999)}% 的${pick(r, CN)}变化。`
  if (form === 1) return `${pick(r, EN)} 通道命中 ${int(r, 2, 40)} 条候选，${pick(r, CN)}评分 ${(r() * 100).toFixed(2)}。`
  if (form === 2) return `第 ${int(r, 1, 480)} 回合，${pick(r, CN)}方以 ${int(r, 3, 90)} 支部队推进 ${int(r, 1, 40)} 格。`
  if (form === 3) return `实验记录：${pick(r, CN)}与${pick(r, CN)}的 ${pick(r, EN)} 比值约 ${int(r, 1, 9)}.${int(r, 10, 99)}。`
  if (form === 4) return `The ${pick(r, EN)} path took ${int(r, 1, 900)} ms over ${int(r, 1, 5000)} ${pick(r, EN)} units.`
  return `${pick(r, CN)}${pick(r, CN)}：${pick(r, CN)}不可通行，需绕行 ${int(r, 1, 30)} 格。`
}
const paragraph = (r) => Array.from({ length: int(r, 4, 8) }, () => sentence(r)).join('')
const rareId = (r) => {
  const h = () => int(r, 0, 65535).toString(16).toUpperCase().padStart(4, '0')
  return `KI-${h()}-${int(r, 1000, 9999)}`
}
const longNumber = (r) => String(int(r, 100000, 999999)) + String(int(r, 10, 99))

function makeBody(r, i, needle) {
  const id = 'gen-' + String(i).padStart(5, '0')
  const sections = [`# 合成文档 ${id}\n\n> 生成器文档（seed 固定，勿手改）。主题：${pick(r, CN)} / ${pick(r, EN)}\n`]
  for (let s = 0, n = int(r, 3, 7); s < n; s++) {
    const paras = Array.from({ length: int(r, 2, 4) }, () => paragraph(r))
    sections.push(`## ${s + 1}. ${pick(r, CN)}${pick(r, CN)}（${pick(r, EN)}）\n\n${paras.join('\n\n')}`)
  }
  const ids = Array.from({ length: int(r, 1, 3) }, () => rareId(r))
  const nums = Array.from({ length: int(r, 1, 3) }, () => longNumber(r))
  sections.push(`## 附录：标识符与统计\n\n${ids.map((x) => `- 标识 ${x}`).join('\n')}\n- 统计值 ${nums.join(' / ')}`)
  if (needle) {
    sections.push(`## 隐性记录 ${needle.id}\n\n${needle.sentence}`)
    needle.file = `raw/gen/${id}.md`
    needle.quote = needle.sentence
  }
  return sections.join('\n\n') + '\n'
}

function main() {
  const args = process.argv.slice(2)
  const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d }
  const seed = Number(flag('--seed', 42)) >>> 0
  const root = flag('--root', 'D:\\archivist-work\\corpora')
  const sizes = args.includes('--all')
    ? [{ label: '1m', tokens: 1_000_000, needles: 24 }, { label: '3m', tokens: 3_000_000, needles: 60 }, { label: '10m', tokens: 10_000_000, needles: 200 }]
    : [{ label: flag('--label', 'custom'), tokens: Number(flag('--tokens', 1_000_000)) || 1_000_000, needles: Number(flag('--needles', 24)) }]
  mkdirSync(root, { recursive: true })

  for (const spec of sizes) {
    const out = args.includes('--all') ? path.join(root, spec.label) : flag('--out', path.join(root, spec.label))
    const t0 = performance.now()
    const r = rng(seed)
    rmSync(out, { recursive: true, force: true })
    mkdirSync(path.join(out, 'raw', 'gen'), { recursive: true })
    mkdirSync(path.join(out, 'wiki'), { recursive: true })

    const needles = Array.from({ length: spec.needles }, (_, k) => {
      const code = rareId(r)
      const ctx = `${pick(r, CN)}${pick(r, CN)}`
      return {
        id: `N${String(k + 1).padStart(3, '0')}`,
        code,
        sentence: `「${ctx}」相关的唯一记录编号为 ${code}，登记人 ${pick(r, EN)}-${int(r, 100, 999)}，用于规模曲线定位。`,
        query: `唯一记录编号 ${code} 的登记内容是什么`,
      }
    })
    // spread needles evenly over the file sequence so every shard has some
    const needleAt = new Map(needles.map((n, k) => [Math.max(1, Math.floor((k + 0.5) * spec.tokens / spec.needles / 3000)), n]))

    let total = 0, files = 0, prevBody = ''
    while (total < spec.tokens) {
      files++
      const needle = needleAt.get(files) || null
      let body = makeBody(r, files, needle)
      // ~6% near-duplicates: copy the previous body and mutate ~3% of CJK bigrams,
      // so dedup/similarity logic has something real to collapse at scale.
      if (files > 2 && r() < 0.06 && prevBody) {
        body = prevBody.replace(/[\u4e00-\u9fff]{2}/g, (m) => (r() < 0.03 ? pick(r, CN) : m))
        body = body.replace(/^# 合成文档 gen-\d+/, `# 合成文档 gen-${String(files).padStart(5, '0')}-dup`)
      }
      writeFileSync(path.join(out, 'raw', 'gen', `gen-${String(files).padStart(5, '0')}.md`), body)
      total += estimateTokens(body)
      prevBody = body
    }
    writeFileSync(path.join(out, 'wiki', 'index.md'), '# Wiki Index\n\n- 合成语料索引（生成器产出，无人工内容）\n')
    writeFileSync(path.join(out, 'AGENTS.md'), '# AGENTS\n\n合成测试语料，可随时删除重建。\n')

    const cases = needles.filter((n) => n.file).map((n) => ({
      id: n.id, query: n.query, category: 'needle',
      goldAnchors: [{ path: n.file, quote: n.quote }],
      answerable: true,
      notes: `稀有 ID ${n.code}；合成语料规模曲线用针（${spec.label}），由生成器埋入并导出，未用检索反推。`,
    }))
    const bytes = readdirSync(path.join(out, 'raw', 'gen')).reduce((a, f) => a + Number(f.length), 0)
    const manifest = {
      generator: 'bench/gen-corpus.mjs', seed, label: spec.label,
      requestedTokens: spec.tokens, estimatedTokens: total, files,
      note: 'files 为文件个数；estimatedTokens 用 core/mod-chunks.estimateTokens 累加。',
      needles: cases.length, builtAt: new Date().toISOString(),
    }
    writeFileSync(path.join(out, 'MANIFEST.json'), JSON.stringify(manifest, null, 2))
    writeFileSync(path.join(root, `gold-needles-${spec.label}.json`), JSON.stringify({
      name: `synthetic needle gold (${spec.label})`,
      workspace: out,
      workspaceNote: '合成语料 raw/gen/*.md；针由生成器同时埋入并导出，人工未参与，只用于规模曲线，不与 gold-real.json 混用。',
      generatedAt: new Date().toISOString(), seed, cases,
    }, null, 2))
    console.log(JSON.stringify({ label: spec.label, out, targetTokens: spec.tokens, estTokens: total, files, needles: cases.length, ms: +(performance.now() - t0).toFixed(0) }))
  }
}

if (process.argv[1]?.endsWith('gen-corpus.mjs')) main()
