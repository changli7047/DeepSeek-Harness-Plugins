/**
 * Demo: build a throwaway workspace with supersede/retract cases to prove the
 * evaluator's correction category end-to-end. Restores the previous active
 * workspace pointer afterwards (initWorkspace would otherwise switch to the demo).
 * Usage: node eval-demo-setup.mjs <workspaceDir>
 */
import { initWorkspace, writePage, attachWorkspace } from '../core/archivist.mjs'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

const ws = process.argv[2]
if (!ws) { console.error('usage: node eval-demo-setup.mjs <workspaceDir>'); process.exit(1) }

const ptrFile = process.env.ARCHIVIST_POINTER
  ?? path.join(process.env.APPDATA ?? path.join(homedir(), '.config'), 'archivist', 'pointer.json')
let previous = null
try { previous = JSON.parse(readFileSync(ptrFile, 'utf8')).dir || null } catch { }

initWorkspace(ws)
writePage(ws, { path: 'concepts/原方案.md', title: '原方案', body: '# 原方案\n\n这是一份会被替代的旧方案页面内容测试。\n' })
writePage(ws, {
  path: 'concepts/新方案.md',
  title: '新方案',
  body: '# 新方案\n\n这是替代后的新版页面内容测试。\n',
  supersedes: 'concepts/原方案.md',
})
writePage(ws, { path: 'concepts/废止页.md', title: '废止页', body: '# 废止页\n\n这是一份会被撤回的页面内容测试。\n' })
writePage(ws, { path: 'concepts/废止页.md', retract: true, retractReason: '演示撤回' })
writePage(ws, { path: 'concepts/普通页.md', title: '普通页', body: '# 普通页\n\n普通内容文本，用于对照。\n' })

if (previous && path.resolve(previous) !== path.resolve(ws)) {
  attachWorkspace(previous)
  console.log(`demo workspace ready: ${ws} (pointer restored to ${previous})`)
} else {
  console.log(`demo workspace ready: ${ws}`)
}

