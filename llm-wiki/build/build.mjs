#!/usr/bin/env node
/**
 * Build the two host adapters (OpenCode v2 / dsh) from the single core source
 * (core/llm-wiki.mjs). Uses split/join for the placeholder so `$` characters
 * in the core are never treated as replacement patterns.
 *
 * Outputs:
 *   dist/opencode/index.ts   — self-contained OpenCode plugin
 *   dist/dsh/llm-wiki.ts     — self-contained dsh plugin
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const core = readFileSync(path.join(root, 'core', 'llm-wiki.mjs'), 'utf8')

if (core.includes('__CORE__')) throw new Error('core contains the __CORE__ placeholder — refusing to build')
const toolCount = (core.match(/name: 'wiki_/g) ?? []).length
if (toolCount !== 12) throw new Error(`expected 12 tools in the core, found ${toolCount}`)

const jobs = [
  { template: 'opencode.template.ts', out: 'opencode/index.ts', marker: 'export default Plugin.define', registrations: 'for (const tool of TOOLS)' },
  { template: 'dsh.template.ts', out: 'dsh/llm-wiki.ts', marker: 'export function apply', registrations: 'ctx.tools.register(defineTool' },
]

for (const job of jobs) {
  const template = readFileSync(path.join(root, 'build', job.template), 'utf8')
  if (!template.includes('__CORE__')) throw new Error(`template missing __CORE__: ${job.template}`)
  if (template.split('__CORE__').length !== 2) throw new Error(`template must contain exactly one __CORE__: ${job.template}`)
  const generated = template.split('__CORE__').join(core)
  if (!generated.includes(job.marker)) throw new Error(`generated file missing marker "${job.marker}": ${job.out}`)
  if (!generated.includes(job.registrations)) throw new Error(`generated file missing registration loop: ${job.out}`)
  if (generated.includes('__CORE__')) throw new Error(`placeholder left in ${job.out}`)
  const abs = path.join(root, job.out)
  mkdirSync(path.dirname(abs), { recursive: true })
  writeFileSync(abs, generated)
  console.log(`written ${job.out}: ${generated.length} chars`)
}
console.log(`tools: ${toolCount} | core: ${core.length} chars`)
