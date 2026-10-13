/**
 * Group 6 — narrow builds (v2 §9, task-3 item 6): the builder must be idempotent and
 * the checked-in artifact must be exactly what the current host + builder produce.
 *
 * The build is *never* run inside the repository (that would write dsh/windows-tools.ts,
 * which belongs to another writer's scope): the whole plugin directory is copied into the
 * run scratch dir first, and the repository artifact hash is compared before/after.
 */

import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_DIR, WT_DIR, ensureDir, sha256File } from '../lib/host.mjs'

let copyState = null

function buildInCopy(ctx) {
  if (copyState === null) {
    copyState = (() => {
      const root = ensureDir(join(ctx.scratch, 'build-copy'))
      const copy = join(root, 'windows-tools')
      cpSync(WT_DIR, copy, { recursive: true })
      const script = join(copy, 'build', 'build.mjs')
      const artifact = join(copy, 'dsh', 'windows-tools.ts')
      const repoArtifact = join(WT_DIR, 'dsh', 'windows-tools.ts')
      const runs = []
      // Causal check: the hash is read immediately before and after the builds that this
      // suite runs, so a concurrent writer elsewhere in the repo cannot make it flaky.
      const repoHashBefore = sha256File(repoArtifact)
      for (let i = 0; i < 2; i++) {
        const result = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8' })
        runs.push({
          status: result.status,
          output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim(),
          hash: existsSync(artifact) ? sha256File(artifact) : null,
        })
      }
      return { copy, artifact, runs, repoHashBefore, repoHashAfter: sha256File(repoArtifact) }
    })()
  }
  return copyState
}

export default {
  name: 'build',
  cases: [
    {
      id: 'build/rebuild-is-byte-identical',
      title: 'building the plugin twice in a scratch copy produces identical bytes',
      async run(ctx) {
        const state = buildInCopy(ctx)
        ctx.check.eq(state.runs[0].status, 0, 'the first build exits 0', state.runs[0].output.slice(0, 400))
        ctx.check.eq(state.runs[1].status, 0, 'the second build exits 0', state.runs[1].output.slice(0, 400))
        ctx.check.ok(state.runs[0].hash !== null, 'the first build produced dsh/windows-tools.ts', state.runs[0].output.slice(0, 400))
        ctx.check.eq(state.runs[1].hash, state.runs[0].hash, 'the second build is byte-identical to the first')
        ctx.check.match(state.runs[0].output, /registrations:\s*\d+/, 'the builder reports the registration count', state.runs[0].output.slice(0, 300))
      },
    },

    {
      id: 'build/checked-in-artifact-is-in-sync',
      title: 'the committed dsh artifact equals a fresh build of the committed host',
      async run(ctx) {
        const state = buildInCopy(ctx)
        const fresh = state.runs[1].hash
        const committed = sha256File(join(WT_DIR, 'dsh', 'windows-tools.ts'))
        ctx.check.ok(fresh !== null, 'a fresh build produced an artifact')
        ctx.check.eq(committed, fresh, 'dsh/windows-tools.ts is up to date with host/wt-host.ps1 (rerun node windows-tools/build/build.mjs)')
      },
    },

    {
      id: 'build/suite-does-not-touch-the-repository',
      title: 'running the builds inside the scratch copy leaves the repository artifact alone',
      async run(ctx) {
        const state = buildInCopy(ctx)
        ctx.check.eq(state.repoHashAfter, state.repoHashBefore, 'the repository artifact is byte-identical across the suite\'s own builds')
        ctx.check.ok(state.copy.startsWith(ctx.scratch), 'the builds ran inside the run scratch directory, never in the repository', state.copy)
        ctx.check.ok(readFileSync(join(REPO_DIR, 'windows-tools', 'build', 'build.mjs'), 'utf8').length > 0, 'sanity: the repository builder is readable')
      },
    },
  ],
}
