/**
 * Build the DeepSeek Harness (dsh) variant of the windows-tools plugin.
 *
 * The single source of truth is host/wt-host.ps1; this script embeds it into
 * build/plugin.template.ts and writes the ready-to-load dsh plugin to
 * dsh/windows-tools.ts. Run from anywhere:
 *
 *   node windows-tools/build/build.mjs
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const template = readFileSync(join(root, 'build', 'plugin.template.ts'), 'utf8')
const host = readFileSync(join(root, 'host', 'wt-host.ps1'), 'utf8').replace(/\r?\n/g, '\r\n')

if (!template.includes('__PS_HOST__')) throw new Error('template misses the __PS_HOST__ placeholder')
if (host.includes('`')) throw new Error('host script contains a backtick and cannot be embedded')

// split/join performs no replacement-pattern interpretation ($&, $', ...)
const out = template.split('__PS_HOST__').join(host)
if (out.includes('__PS_')) throw new Error('unreplaced placeholder remains')

const registrations = (out.match(/ctx\.tools\.register/g) ?? []).length
if (registrations !== 13) throw new Error(`expected 13 tool registrations, found ${String(registrations)}`)
const applyExports = (out.match(/export function apply/g) ?? []).length
if (applyExports !== 1) throw new Error(`expected 1 apply export, found ${String(applyExports)}`)

mkdirSync(join(root, 'dsh'), { recursive: true })
writeFileSync(join(root, 'dsh', 'windows-tools.ts'), out)
console.log('written dsh/windows-tools.ts:', out.length, 'chars; registrations:', registrations)
