/**
 * Group 7 — the dsh (DeepSeek Harness) side of the plugin.
 *
 * Always on: a static shape check of the generated artifact (17 registrations, the four
 * new tools, exactly one apply export).
 *
 * Env-gated: a real load smoke that imports the generated plugin with a stub for
 * `@deepseek-ai/dsh-tools`, calls `apply()` with a fake context and counts the tools it
 * registers. It only runs when DSH_REPO points at a dsh checkout with `node_modules`;
 * otherwise the case reports SKIP and the suite still passes.
 *
 * The smoke never writes into the dsh checkout: the plugin is copied into the run
 * scratch dir and the dependency is re-exported from there.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { WT_DIR, ensureDir } from '../lib/host.mjs'
import { Skip } from '../lib/checks.mjs'

export const TOOL_NAMES = [
  'windows_status', 'windows_snapshot', 'windows_screenshot', 'windows_click', 'windows_scroll',
  'windows_type', 'windows_shortcut', 'windows_clipboard', 'windows_wait', 'windows_wait_for',
  'windows_find', 'windows_read', 'windows_window', 'windows_process',
]

const ARTIFACT = join(WT_DIR, 'dsh', 'windows-tools.ts')
const EXPECTED_TOOLS = 14

function artifactSource() {
  return readFileSync(ARTIFACT, 'utf8')
}

function resolveDshToolsEntry(repoDir) {
  const pkgDir = join(repoDir, 'node_modules', '@deepseek-ai', 'dsh-tools')
  const pkgPath = join(pkgDir, 'package.json')
  if (!existsSync(pkgPath)) return null
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  const candidates = []
  const dot = pkg.exports === undefined ? undefined : (pkg.exports['.'] ?? pkg.exports)
  if (typeof dot === 'string') candidates.push(dot)
  if (dot !== undefined && dot !== null && typeof dot === 'object') {
    for (const key of ['import', 'module', 'default', 'require']) {
      const value = dot[key]
      if (typeof value === 'string') candidates.push(value)
      else if (value !== null && typeof value === 'object') {
        for (const nested of ['default', 'import', 'require']) {
          if (typeof value[nested] === 'string') candidates.push(value[nested])
        }
      }
    }
  }
  for (const key of ['module', 'main']) {
    if (typeof pkg[key] === 'string') candidates.push(pkg[key])
  }
  candidates.push('index.js', 'index.mjs')
  for (const candidate of candidates) {
    const path = join(pkgDir, candidate)
    if (existsSync(path)) return path
  }
  return null
}

export default {
  name: 'dsh',
  cases: [
    {
      id: 'dsh/artifact-shape',
      title: 'the generated plugin registers exactly the 17 documented tools',
      async run(ctx) {
        const src = artifactSource()
        const registrations = (src.match(/ctx\.tools\.register\(/g) ?? []).length
        ctx.check.eq(registrations, EXPECTED_TOOLS, 'the artifact contains 17 tool registrations')
        ctx.check.eq((src.match(/export function apply/g) ?? []).length, 1, 'the artifact exports exactly one apply')
        const names = [...src.matchAll(/name:\s*'([a-z_]+)'/g)].map((m) => m[1]).filter((n) => n.startsWith('windows_'))
        for (const name of TOOL_NAMES) {
          ctx.check.ok(names.includes(name), `the artifact registers ${name}`, `found: ${names.join(', ')}`)
        }
      },
    },

    {
      id: 'dsh/load-smoke',
      title: 'the generated plugin loads and registers its tools on a fake host context',
      async run(ctx) {
        const repo = process.env.DSH_REPO
        if (repo === undefined || repo.trim() === '' || !existsSync(repo)) {
          throw new Skip('DSH_REPO is not set (or does not exist): set it to a dsh checkout with node_modules to run the load smoke')
        }
        const entry = resolveDshToolsEntry(repo)
        if (entry === null) {
          throw new Skip(`@deepseek-ai/dsh-tools is not resolvable inside DSH_REPO (${repo}): nothing to load the plugin against`)
        }

        const stage = ensureDir(join(ctx.scratch, 'dsh-stage'))
        writeFileSync(join(stage, 'windows-tools.ts'), artifactSource())
        const stubDir = ensureDir(join(stage, 'node_modules', '@deepseek-ai', 'dsh-tools'))
        writeFileSync(join(stubDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-tools', version: '0.0.0', type: 'module', main: 'index.mjs' }))
        writeFileSync(join(stubDir, 'index.mjs'), `export * from ${JSON.stringify(pathToFileURL(entry).href)}\n`)

        let mod
        try {
          mod = await import(pathToFileURL(join(stage, 'windows-tools.ts')).href)
        } catch (error) {
          throw new Error(`the generated plugin failed to import: ${error.message}`)
        }
        ctx.check.eq(typeof mod.apply, 'function', 'the generated plugin exports apply()')
        const registered = []
        const fakeCtx = {
          tools: { register: (tool) => { registered.push(tool) } },
          effect: () => {},
          get: () => undefined,
        }
        mod.apply(fakeCtx)
        ctx.check.eq(registered.length, EXPECTED_TOOLS, 'apply() registers 17 tools on the fake context')
        const blob = JSON.stringify(registered)
        for (const name of TOOL_NAMES) {
          ctx.check.contains(blob, name, `apply() registers ${name}`)
        }
      },
    },
  ],
}
