#!/usr/bin/env node
/**
 * Copy the generated dsh plugin into the dsh source checkout's scratch-plugin
 * directory, which is where the profile patch (`cordis.patch.yml`) loads it from.
 *
 * The generated file must live inside the dsh repo because it imports
 * `@deepseek-ai/dsh-tools`, resolved by walking up from the file location;
 * pointing the patch at this repo's clone fails with "Cannot find module".
 *
 * A previous copy is preserved under `scratch-plugin/src/.backups/` before it is
 * replaced. The copy is verified by hash; a mismatch aborts.
 *
 * Usage: node build/deploy.mjs [dshRepoPath]
 *   dshRepoPath defaults to the DSH source checkout used by this machine.
 * Effect: takes hold only after the dsh host restarts (host plugins are loaded
 * once at boot); this script never restarts the host itself.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const dshRepo = path.resolve(process.argv[2] || 'C:/Users/长离/Documents/deepseek-harness/deepseek-harness')
const src = path.join(root, 'dsh', 'archivist.ts')
const dstDir = path.join(dshRepo, 'scratch-plugin', 'src')
const dst = path.join(dstDir, 'archivist.ts')

const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')
const stamp = () => new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15)

if (!existsSync(src)) throw new Error(`missing generated plugin: ${src} — run build/build.mjs first`)
if (!existsSync(path.join(dshRepo, 'scratch-plugin'))) {
  throw new Error(`not a dsh source checkout (no scratch-plugin/): ${dshRepo} — pass the checkout path as argv[2]`)
}

let previous = null
if (existsSync(dst)) {
  previous = sha(dst)
  if (previous === sha(src)) {
    console.log(`unchanged: ${dst}\nsha256=${previous} (${statSync(dst).size} bytes) — host still needs a restart only if you changed it before`)
    process.exit(0)
  }
  const backupDir = path.join(dstDir, '.backups')
  mkdirSync(backupDir, { recursive: true })
  const backup = path.join(backupDir, `archivist-${stamp()}-${previous.slice(0, 8)}.ts`)
  copyFileSync(dst, backup)
  console.log(`backed up previous: ${backup}`)
}

mkdirSync(dstDir, { recursive: true })
copyFileSync(src, dst)
const copied = sha(dst)
if (copied !== sha(src)) throw new Error('copy verification failed: hashes differ')

console.log(`deployed: ${dst}`)
console.log(`  previous sha256=${previous ?? '(none)'}`)
console.log(`  deployed sha256=${copied} (${statSync(dst).size} bytes)`)
console.log('host plugins load once at boot — restart the dsh app for this to take effect.')
