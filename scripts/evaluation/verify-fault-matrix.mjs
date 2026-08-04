import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { promisify } from 'node:util'

const runFile = promisify(execFile)
const root = resolve(new URL('../..', import.meta.url).pathname)
const temporary = await mkdtemp(resolve(tmpdir(), 'agent-eval-fault-matrix-'))
const reports = {
  worker: resolve(temporary, 'worker.json'),
  orchestrator: resolve(temporary, 'orchestrator.json'),
  lifecycle: resolve(temporary, 'lifecycle.json'),
}

try {
  await Promise.all([
    vitest('packages/eval-worker', ['src/worker.integration.test.ts'], reports.worker),
    vitest('packages/eval-orchestrator', ['src/control-plane.test.ts', 'src/http-server.test.ts'], reports.orchestrator),
  ])
  await command(process.execPath, [
    'scripts/evaluation/verify-benchmark-lifecycles.mjs',
    '--fixture', 'sdlc-journey', '--fixture', 'fault-scenarios', '--output', reports.lifecycle,
  ], root)

  const testReports = {
    worker: JSON.parse(await readFile(reports.worker, 'utf8')),
    orchestrator: JSON.parse(await readFile(reports.orchestrator, 'utf8')),
  }
  const lifecycle = JSON.parse(await readFile(reports.lifecycle, 'utf8'))
  const definitions = [
    scenario('worker-death', 'worker', 'classifies an in-flight trial indeterminate after hard Worker loss stops lease heartbeats'),
    scenario('control-plane-restart', 'orchestrator', 'recovers the same authoritative HTTP query after a Control Plane restart'),
    scenario('provider-429', 'worker', 'classifies rate limit as retryable provider responsibility', responsibility('provider_failure', 'provider', true, true)),
    scenario('provider-timeout', 'worker', 'classifies provider timeout as retryable provider responsibility', responsibility('provider_failure', 'provider', true, true)),
    scenario('lost-result-ack', 'worker', 'retries a lost result acknowledgement against the idempotent committed result'),
    scenario('environment-setup-failure', 'worker', 'classifies setup failure as environment responsibility', responsibility('environment_failure', 'environment', true, true)),
    scenario('interrupted-artifact-upload', 'orchestrator', 'discards an interrupted HTTP artifact body and accepts one verified retry'),
    scenario('verifier-timeout', 'worker', 'bounds a verifier that ignores cancellation and attributes the timeout to the verifier', responsibility('timeout', 'verifier', true, true)),
    scenario('duplicate-completion', 'orchestrator', 'leases only compatible trials and makes result completion idempotent by hash'),
    scenario('lease-expiry', 'orchestrator', 'requeues expired work only before any execution receipt and classifies ambiguous work indeterminate', responsibility('indeterminate_side_effect', 'indeterminate', false, false)),
    scenario('resource-exhaustion', 'worker', 'classifies disk exhaustion as environment responsibility', responsibility('environment_failure', 'environment', true, true)),
    scenario('observable-agent-failure', 'worker', 'attributes an observable Agent failure to the Agent and records sufficient recovery state', responsibility('agent_failure', 'agent', true, false)),
    scenario('durable-cancellation', 'worker', 'propagates durable run cancellation through a rejected lease heartbeat to the live Agent'),
  ]
  const scenarios = definitions.map((definition) => resolveTest(definition, testReports))
  scenarios.push(resolveLifecycle('rollback', lifecycle, 'sdlc-journey', 'rollback_verified'))
  scenarios.push(resolveLifecycle('fault-recovery-control', lifecycle, 'fault-scenarios', 'recovered'))
  const failed = scenarios.filter((entry) => entry.status !== 'passed')
  if (failed.length > 0) throw new Error('fault matrix failed: ' + failed.map((entry) => entry.id + '=' + entry.status).join(', '))
  const runtimeResidue = await managedRuntimeResidue()
  if (Object.values(runtimeResidue).some((entries) => entries.length > 0)) throw new Error('managed runtime residue remains: ' + JSON.stringify(runtimeResidue))

  const evidence = {
    schemaVersion: 1, generatedAt: new Date().toISOString(),
    scope: 'fresh standalone evaluation fault injection; no Host sessions or historical evaluation artifacts',
    scenarios, runtimeResidue,
    sourceHashes: await sourceHashes([
      'packages/eval-protocol/src/failure.ts', 'packages/eval-protocol/src/protocol.test.ts',
      'packages/eval-worker/src/trial-runner.ts', 'packages/eval-worker/src/worker.integration.test.ts',
      'packages/eval-orchestrator/src/control-plane.ts', 'packages/eval-orchestrator/src/http-server.ts',
      'packages/eval-orchestrator/src/control-plane.test.ts', 'packages/eval-orchestrator/src/http-server.test.ts',
      'scripts/evaluation/verify-benchmark-lifecycles.mjs', 'scripts/evaluation/verify-fault-matrix.mjs',
      'adapters/benchmarks/fault-scenarios/src/index.ts',
      'task-packs/fault-scenarios-v1/config-schema-recovery/INCIDENT.md',
      'task-packs/fault-scenarios-v1/config-schema-recovery/scripts/check.mjs',
      'task-packs/fault-scenarios-v1/config-schema-recovery/src/config.mjs',
      'task-packs/fault-scenarios-v1/config-schema-recovery/tests/config.test.mjs',
    ]),
  }
  const output = option('--output')
  if (output) {
    const path = resolve(output)
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeFile(path, JSON.stringify(evidence, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  }
  process.stdout.write(JSON.stringify({ ok: true, passed: scenarios.length, scenarios: scenarios.map((entry) => entry.id), output: output ? resolve(output) : undefined }) + '\n')
} finally {
  await rm(temporary, { recursive: true, force: true })
}

function scenario(id, report, title, expectedResponsibility) { return { id, report, title, expectedResponsibility } }
function resolveTest(definition, reportsByName) {
  const assertions = reportsByName[definition.report].testResults.flatMap((result) => result.assertionResults)
  const matches = assertions.filter((assertion) => assertion.title === definition.title)
  if (matches.length !== 1) throw new Error('expected one fault assertion for ' + definition.id + ', found ' + String(matches.length))
  const assertion = matches[0]
  return { id: definition.id, status: assertion.status, kind: 'fault-injection-test', test: assertion.fullName, durationMs: assertion.duration, ...(definition.expectedResponsibility ? { responsibility: definition.expectedResponsibility } : {}) }
}
function resolveLifecycle(id, lifecycle, benchmarkId, metric) {
  const matches = lifecycle.results.filter((result) => result.benchmarkId === benchmarkId)
  if (matches.length !== 1) throw new Error('expected one fresh lifecycle result for ' + benchmarkId)
  const result = matches[0]
  return { id, status: result.result.nativeMetrics[metric] === true ? 'passed' : 'failed', kind: 'fresh-sandbox-lifecycle', benchmarkId, sandboxId: result.sandboxId, provider: result.provider, metric, environmentLock: result.environmentLock }
}
async function vitest(directory, files, output) { await command('pnpm', ['--dir', directory, 'exec', 'vitest', 'run', ...files, '--reporter=json', '--outputFile=' + output], root) }
async function command(binary, args, cwd) { return await runFile(binary, args, { cwd, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024 }) }
async function sourceHashes(paths) {
  return await Promise.all(paths.map(async (path) => ({ path, sha256: createHash('sha256').update(await readFile(resolve(root, path))).digest('hex') })))
}
function option(name) { for (let index = 2; index < process.argv.length; index += 1) if (process.argv[index] === name) return process.argv[index + 1]; else if (process.argv[index]?.startsWith(name + '=')) return process.argv[index].slice(name.length + 1) }
function responsibility(category, owner, observedStateSufficientForRecovery, retryable) { return { category, responsibility: owner, observedStateSufficientForRecovery, retryable } }
async function managedRuntimeResidue() {
  const [instances, networks, acls] = await Promise.all([
    lxc(['list', '--format', 'json'], (entry) => /^(?:eval-|ae-)/u.test(String(entry.name))),
    lxc(['network', 'list', '--format', 'json'], (entry) => /^ae-n-/u.test(String(entry.name))),
    lxc(['network', 'acl', 'list', '--format', 'json'], (entry) => /^ae-a-/u.test(String(entry.name))),
  ])
  return { instances, networks, acls }
}
async function lxc(args, matches) { const result = await runFile('lxc', args, { cwd: root, encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }); return JSON.parse(result.stdout).filter(matches).map((entry) => entry.name).sort() }
