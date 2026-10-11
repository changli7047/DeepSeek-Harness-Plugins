/**
 * Raw-corpus statistics: file count, bytes, chars, CJK split, rough token estimate.
 * Usage: node rawstats.mjs <dir>
 */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

const root = process.argv[2]
if (!root) { console.error('usage: node rawstats.mjs <dir>'); process.exit(1) }

let files = 0, bytes = 0, chars = 0, cjk = 0, other = 0
const stack = ['']
while (stack.length) {
  const rel = stack.pop()
  const cur = rel ? path.join(root, rel) : root
  for (const e of readdirSync(cur, { withFileTypes: true })) {
    const childRel = rel ? rel + '/' + e.name : e.name
    if (e.isDirectory()) { stack.push(childRel); continue }
    if (!/\.(md|txt)$/i.test(e.name)) continue
    let text
    try { text = readFileSync(path.join(cur, e.name), 'utf8') } catch { continue }
    files++
    bytes += Buffer.byteLength(text)
    chars += text.length
    for (const ch of text) {
      const c = ch.codePointAt(0)
      if ((c >= 0x3040 && c <= 0x30ff) || (c >= 0x3400 && c <= 0x4dbf) || (c >= 0x4e00 && c <= 0x9fff) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0x3000 && c <= 0x303f) || (c >= 0xff00 && c <= 0xffef)) cjk++
      else other++
    }
  }
}
console.log(JSON.stringify({
  files, mb: +(bytes / 1048576).toFixed(2), chars, cjk, other,
  tokens_estimate: Math.round(cjk + other / 4),
}, null, 2))
