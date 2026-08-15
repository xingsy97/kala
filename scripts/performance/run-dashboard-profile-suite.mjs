#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { gitRevision, sha256File } from './profiling-utils.mjs'

const root = new URL('../..', import.meta.url).pathname
const args = process.argv.slice(2).filter((arg) => arg !== '--')
const option = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined }
const outputRoot = resolve(option('--output') ?? join('/tmp', `runlab-dashboard-profile-${Date.now()}`))
const turns = option('--turns') ?? '1250'
const historyOnly = args.includes('--history-only')
const streamingOnly = args.includes('--streaming-only')
const keepMaps = args.includes('--keep-profiling-build')
const bundle = join(root, 'release/bundle-dashboard-with-runtime.cjs')
const dashboardDist = join(root, 'packages/dashboard/dist')
const releaseDir = join(root, 'release')
const backupRoot = mkdtempSync(join(tmpdir(), 'runlab-profile-artifact-backup-'))
mkdirSync(outputRoot, { recursive: true })
if (existsSync(dashboardDist)) cpSync(dashboardDist, join(backupRoot, 'dashboard-dist'), { recursive: true })
if (existsSync(releaseDir)) cpSync(releaseDir, join(backupRoot, 'release'), { recursive: true })

let succeeded = false
try {
  run('node', ['scripts/release/build-release-assets.mjs', '--repo', process.env.GITHUB_REPOSITORY ?? 'local/agent-runlab'], {
    ...process.env,
    RUNLAB_PROFILE_SOURCEMAP: '1',
  })
  if (!streamingOnly) {
    run('node', ['scripts/performance/profile-dashboard-production.mjs'], {
      ...process.env,
      PERF_TURNS: turns,
      PERF_EVIDENCE_ROOT: join(outputRoot, 'history'),
      PERF_DASHBOARD_PORT: process.env.PERF_DASHBOARD_PORT ?? '3210',
    })
    const profiles = readdirSync(join(outputRoot, 'history')).filter((name) => name.endsWith('.cpuprofile.json')).map((name) => join(outputRoot, 'history', name))
    run('node', ['scripts/performance/analyze-cpu-profile.mjs', ...profiles, '--output', join(outputRoot, 'history-hotspots.md')], process.env)
  }
  if (!historyOnly) {
    run('node', ['scripts/performance/profile-dashboard-streaming.mjs'], {
      ...process.env,
      PERF_EVIDENCE_ROOT: join(outputRoot, 'streaming'),
      PERF_STREAM_HOST_PORT: process.env.PERF_STREAM_HOST_PORT ?? '3216',
      PERF_STREAM_PROVIDER_PORT: process.env.PERF_STREAM_PROVIDER_PORT ?? '3217',
    })
    run('node', ['scripts/performance/analyze-cpu-profile.mjs', join(outputRoot, 'streaming/streaming.cpuprofile.json'), '--output', join(outputRoot, 'streaming-hotspots.md')], process.env)
  }
  const manifest = {
    generatedAt: new Date().toISOString(),
    gitRevision: gitRevision(root),
    artifactPath: bundle,
    artifactSha256: sha256File(bundle),
    turns: Number(turns),
    scenarios: { history: !streamingOnly, streaming: !historyOnly },
    sourceMaps: readdirSync(join(root, 'packages/dashboard/dist/assets')).filter((name) => name.endsWith('.map')).length,
  }
  writeFileSync(join(outputRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  succeeded = true
  console.log(`Dashboard profiling evidence: ${outputRoot}`)
} finally {
  if (!keepMaps) {
    rmSync(dashboardDist, { recursive: true, force: true })
    rmSync(releaseDir, { recursive: true, force: true })
    if (existsSync(join(backupRoot, 'dashboard-dist'))) cpSync(join(backupRoot, 'dashboard-dist'), dashboardDist, { recursive: true })
    if (existsSync(join(backupRoot, 'release'))) cpSync(join(backupRoot, 'release'), releaseDir, { recursive: true })
    const assets = join(dashboardDist, 'assets')
    const maps = existsSync(assets) ? readdirSync(assets).filter((name) => name.endsWith('.map')) : []
    if (maps.length > 0) throw new Error(`restored ordinary release unexpectedly contains source maps: ${maps.join(', ')}`)
  }
  rmSync(backupRoot, { recursive: true, force: true })
  if (!succeeded) console.error(`Profiling suite failed; partial evidence may remain at ${outputRoot}`)
}

function run(command, commandArgs, env) {
  const result = spawnSync(command, commandArgs, { cwd: root, env, stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`${command} ${commandArgs.join(' ')} failed with ${result.status}`)
}
