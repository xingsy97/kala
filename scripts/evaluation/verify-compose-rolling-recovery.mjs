#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { promisify } from 'node:util'

const runFile = promisify(execFile)
const root = resolve(new URL('../..', import.meta.url).pathname)
const project = option('--project') ?? 'agent-eval-rolling-current-20260803'
const port = option('--port') ?? '23300'
const dashboardPort = option('--dashboard-port') ?? '23380'
const output = resolve(option('--output') ?? 'docs/evidence/evaluation/compose-rolling-recovery-20260803.json')
const deploymentOutput = resolve(option('--deployment-output') ?? 'docs/evidence/evaluation/compose-rolling-deployment-acceptance-20260803.json')
const composeFiles = ['deploy/evaluation/compose.yaml', 'deploy/evaluation/acceptance/compose.acceptance.yaml']
const composeArgs = ['compose', '--ansi', 'never', '-p', project, ...composeFiles.flatMap((path) => ['-f', path])]
const environment = { ...process.env, AGENT_EVAL_PORT: port, AGENT_EVAL_DASHBOARD_PORT: dashboardPort }
const sourcePaths = [
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.base.json',
  'packages/eval-analyzer/src/control-plane-loop.ts',
  'packages/eval-analyzer/src/control-plane-loop.test.ts',
  'packages/eval-analyzer/src/runner.ts',
  'packages/eval-analyzer/src/grader-runner.ts',
  'deploy/evaluation/compose.yaml',
  'deploy/evaluation/acceptance/compose.acceptance.yaml',
  'deploy/evaluation/images/Dockerfile.orchestrator',
  'deploy/evaluation/images/Dockerfile.analyzer',
  'deploy/evaluation/images/Dockerfile.dashboard',
  'scripts/evaluation/verify-compose-deployment.mjs',
  'scripts/evaluation/verify-compose-rolling-recovery.mjs',
]

let started = false
try {
  await docker([...composeArgs, 'up', '-d', '--build', '--wait'])
  started = true
  const before = await serviceState()
  assertHealthy(before, 'before recovery')

  await docker([...composeArgs, 'stop', 'orchestrator'])
  const stoppedAt = new Date().toISOString()
  await delay(8_000)
  const during = await serviceState()
  if (during.analyzer.containerId !== before.analyzer.containerId || during.analyzer.restartCount !== before.analyzer.restartCount || during.analyzer.health !== 'healthy') {
    throw new Error('analyzer did not remain healthy and stable while the Control Plane was stopped')
  }

  await docker([...composeArgs, 'start', 'orchestrator'])
  await waitForHealthy('orchestrator')
  const healthyAt = new Date().toISOString()
  await runFile(process.execPath, [
    'scripts/evaluation/verify-compose-deployment.mjs',
    '--url', 'http://127.0.0.1:' + port,
    '--output', deploymentOutput,
  ], commandOptions(120_000))
  const after = await serviceState()
  assertHealthy(after, 'after recovery')
  if (after.analyzer.containerId !== before.analyzer.containerId || after.analyzer.restartCount !== before.analyzer.restartCount) {
    throw new Error('analyzer container identity or restart count changed across Control Plane recovery')
  }
  const deployment = JSON.parse(await readFile(deploymentOutput, 'utf8'))
  if (deployment.run?.state !== 'completed' || deployment.jobs?.length !== 2 || deployment.jobs.some((job) => job.state !== 'completed')) {
    throw new Error('post-recovery grader/analyzer acceptance did not complete')
  }

  const sourceFiles = Object.fromEntries(await Promise.all(sourcePaths.map(async (path) => [path, sha256(await readFile(resolve(root, path)))])))
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    scope: 'current-source standalone Compose image build and Control Plane rolling recovery in an isolated non-production project; post-recovery durable grader and analyzer acceptance',
    sourceRevision: (await runFile('git', ['rev-parse', 'HEAD'], commandOptions(30_000))).stdout.trim(),
    sourceFiles,
    sourceBundleSha256: sha256(Buffer.from(Object.entries(sourceFiles).map(([path, hash]) => path + ':' + hash).join('\n') + '\n')),
    environment: { project, production: false, controlPlaneUrl: 'http://127.0.0.1:' + port, dashboardUrl: 'http://127.0.0.1:' + dashboardPort },
    images: Object.entries(after).map(([service, state]) => ({ service, imageId: state.imageId })),
    rollingRecovery: {
      status: 'passed',
      operation: 'stop and start the isolated Compose orchestrator while leaving analyzer and dashboard running',
      stoppedAt,
      healthyAt,
      analyzer: {
        containerIdBefore: before.analyzer.containerId,
        containerIdDuringDisconnect: during.analyzer.containerId,
        containerIdAfterRecovery: after.analyzer.containerId,
        restartCountBefore: before.analyzer.restartCount,
        restartCountDuringDisconnect: during.analyzer.restartCount,
        restartCountAfterRecovery: after.analyzer.restartCount,
        healthDuringDisconnect: during.analyzer.health,
        healthAfterRecovery: after.analyzer.health,
      },
      orchestrator: { containerId: after.orchestrator.containerId, healthAfterRecovery: after.orchestrator.health, restartCountAfterRecovery: after.orchestrator.restartCount },
      dashboard: { containerId: after.dashboard.containerId, healthAfterRecovery: after.dashboard.health, restartCountAfterRecovery: after.dashboard.restartCount },
    },
    postRecoveryAcceptance: {
      path: deploymentOutput.slice(root.length + 1),
      sha256: sha256(await readFile(deploymentOutput)),
      runId: deployment.runId,
      runState: deployment.run.state,
      jobs: deployment.jobs.map((job) => ({ jobId: job.jobId, kind: job.kind, state: job.state, outputManifestHash: job.outputManifestHash })),
    },
  }
  await mkdir(dirname(output), { recursive: true, mode: 0o700 })
  await writeFile(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
  process.stdout.write(JSON.stringify({ ok: true, project, runId: deployment.runId, output, deploymentOutput }) + '\n')
} finally {
  if (started) await docker([...composeArgs, 'down', '-v', '--remove-orphans'], 300_000).catch(() => undefined)
}

async function serviceState() {
  return Object.fromEntries(await Promise.all(['orchestrator', 'analyzer', 'dashboard'].map(async (service) => {
    const containerId = (await docker([...composeArgs, 'ps', '--all', '-q', service])).stdout.trim()
    if (!containerId) throw new Error('Compose service is missing: ' + service)
    const inspected = JSON.parse((await docker(['inspect', containerId])).stdout)[0]
    return [service, { containerId, imageId: inspected.Image, restartCount: inspected.RestartCount, health: inspected.State.Health?.Status ?? inspected.State.Status }]
  })))
}
async function waitForHealthy(service) {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    const state = await serviceState()
    if (state[service]?.health === 'healthy') return
    await delay(500)
  }
  throw new Error('Compose service did not become healthy: ' + service)
}
function assertHealthy(states, phase) { for (const [service, state] of Object.entries(states)) if (state.health !== 'healthy') throw new Error(service + ' is not healthy ' + phase + ': ' + state.health) }
async function docker(args, timeout = 1_200_000) { return await runFile('docker', args, commandOptions(timeout)) }
function commandOptions(timeout) { return { cwd: root, env: environment, encoding: 'utf8', timeout, maxBuffer: 32 * 1024 * 1024 } }
function delay(ms) { return new Promise((resolveDelay) => setTimeout(resolveDelay, ms)) }
function sha256(value) { return createHash('sha256').update(value).digest('hex') }
function option(name) { for (let index = 2; index < process.argv.length; index += 1) if (process.argv[index] === name) return process.argv[index + 1]; else if (process.argv[index]?.startsWith(name + '=')) return process.argv[index].slice(name.length + 1) }
