import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { promisify } from 'node:util'

import { DockerSandboxProvider } from '../../adapters/environments/docker/dist/index.js'
import { createLxdContainerProvider } from '../../adapters/environments/lxd-container/dist/index.js'
import { createTerminalBenchAdapter } from '../../adapters/benchmarks/terminal-bench/dist/index.js'
import { createProgramBenchAdapter } from '../../adapters/benchmarks/program-bench/dist/index.js'
import { createSweMarathonAdapter } from '../../adapters/benchmarks/swe-marathon/dist/index.js'
import { createSdlcJourneyAdapter } from '../../adapters/benchmarks/sdlc-journey/dist/index.js'
import { createFaultScenarioAdapter } from '../../adapters/benchmarks/fault-scenarios/dist/index.js'

const runFile = promisify(execFile)
const HASH = 'a'.repeat(64)
const dockerPolicy = { provider: 'docker', imageDigest: option('--docker-image') ?? 'mcr.microsoft.com/devcontainers/typescript-node@sha256:3ff0e3ff2f98928cb4cd1faab2b3338161b13007c04e9b0f1d2d89a69c75e676', readOnlyBase: true, ephemeralOverlay: true, resources: { cpu: 1, memoryMb: 256, diskMb: 1024, pids: 128 }, network: { mode: 'denied', allowedDestinations: [] }, artifactAllowlist: [] }
const lxdPolicy = { provider: 'lxd-container', imageDigest: option('--lxd-image') ?? '9c68ebff3356', readOnlyBase: true, ephemeralOverlay: true, resources: { cpu: 1, memoryMb: 512, diskMb: 2048, pids: 128 }, network: { mode: 'denied', allowedDestinations: [] }, artifactAllowlist: [] }
const allFixtures = [
  { id: 'terminal-bench', adapter: createTerminalBenchAdapter(), provider: () => new DockerSandboxProvider(), policy: dockerPolicy, setup: setupTerminal, verification: [{ stepId: 'native-reward', nativeMetric: 'reward', argv: ['sh', '-ceu', 'test "$(cat answer.txt)" = 42; printf \'%s\\n\' \'{"metrics":{"reward":1}}\''], cwd: '.', timeoutMs: 10_000, requiredExitCode: 0 }], expected: { reward: 1, resolved: true, verifier_protocol_valid: true } },
  { id: 'program-bench', adapter: createProgramBenchAdapter(), provider: () => new DockerSandboxProvider(), policy: dockerPolicy, setup: setupProgram, verification: [
    { stepId: 'submission-contract', nativeMetric: 'submission_contract', argv: ['sh', '-ceu', 'test -x compile.sh; test -s program.sh; printf \'%s\\n\' \'{"metrics":{"contract_ok":true,"implementation_file_count":1}}\''], cwd: '.', timeoutMs: 10_000, requiredExitCode: 0 },
    { stepId: 'compile', nativeMetric: 'compile_passed', argv: ['sh', '-ceu', './compile.sh; test -x executable; printf \'%s\\n\' \'{"metrics":{"compile_passed":true}}\''], cwd: '.', timeoutMs: 10_000, requiredExitCode: 0 },
    { stepId: 'tests', nativeMetric: 'tests_passed', argv: ['sh', '-ceu', 'test "$(./executable fixture)" = "hello fixture"; printf \'%s\\n\' \'{"metrics":{"tests_passed":true}}\''], cwd: '.', timeoutMs: 10_000, requiredExitCode: 0 },
  ], expected: { submission_contract: true, compile_passed: true, tests_passed: true, verifier_protocol_valid: true } },
  { id: 'swe-marathon', adapter: createSweMarathonAdapter(), provider: () => new DockerSandboxProvider(), policy: dockerPolicy, setup: setupMarathon, verification: [{ stepId: 'native-resolution', nativeMetric: 'resolved_tasks', argv: ['sh', '-ceu', 'total=$(find outcomes -type f | wc -l | tr -d " "); resolved=$(grep -l \'^1$\' outcomes/* | wc -l | tr -d " "); test "$total" -eq 3; test "$resolved" -eq 2; printf \'{"metrics":{"resolved_tasks":%s,"total_tasks":%s}}\\n\' "$resolved" "$total"'], cwd: '.', timeoutMs: 10_000, requiredExitCode: 0 }], expected: { resolved_tasks: 2, total_tasks: 3, completion_rate: 2 / 3, verifier_protocol_valid: true } },
  { id: 'sdlc-journey', adapter: createSdlcJourneyAdapter(), provider: createLxdContainerProvider, policy: lxdPolicy, setup: setupSdlc, verification: sdlcSteps(), expected: { journey_completed: true, completed_stages: 8, total_stages: 8 } },
  { id: 'fault-scenarios', adapter: createFaultScenarioAdapter(), provider: createLxdContainerProvider, policy: lxdPolicy, setup: setupFault, verification: faultSteps(), expected: { recovered: true, recovery_stages: 5, total_recovery_stages: 5 } },
]
const requestedFixtures = values('--fixture')
const fixtureIds = new Set(allFixtures.map((fixture) => fixture.id))
for (const id of requestedFixtures) if (!fixtureIds.has(id)) throw new Error('unknown lifecycle fixture: ' + id)
const fixtures = requestedFixtures.length > 0 ? allFixtures.filter((fixture) => requestedFixtures.includes(fixture.id)) : allFixtures

const results = []
for (const fixture of fixtures) {
  const provider = fixture.provider()
  const preflight = await provider.preflight(fixture.policy)
  if (!preflight.ok) throw new Error(fixture.id + ' provider preflight failed')
  const workerDataDir = resolve('/tmp', 'agent-eval-lifecycle-' + fixture.id + '-' + process.pid)
  await mkdir(workerDataDir, { recursive: true, mode: 0o700 })
  const repository = await fixtureRepository(workerDataDir, fixture.id)
  const task = { schemaVersion: 1, taskId: fixture.id + '-fixture', taskPackId: fixture.id, taskPackVersion: '1', title: fixture.id + ' lifecycle fixture', prompt: 'Deterministic verifier lifecycle fixture.', repository, fixtureManifestHash: repository.archiveSha256, faultScenarioIds: fixture.id === 'fault-scenarios' ? ['deterministic-config-fault-v1'] : [], verification: fixture.verification, analysis: { constraints: [], protectedPaths: [], hiddenVerifierPaths: [] }, lxdInitMode: 'keepalive', policy: { license: { status: 'granted', basis: 'MIT' }, permissions: { evaluation: { status: 'granted', basis: 'local evaluation conformance' }, training: { status: 'unreviewed' } }, sourceProvenance: { status: 'granted', sourceRefs: ['fixture:benchmark-lifecycle'] }, publication: { artifact: { status: 'granted', basis: 'local evaluation conformance' }, report: { status: 'granted', basis: 'local evaluation conformance' }, leaderboard: { status: 'granted', basis: 'local evaluation conformance' }, redistribution: { status: 'granted', basis: 'MIT' } } } }
  let target
  try {
    target = await provider.create({ workerId: 'benchmark-lifecycle', trialId: fixture.id + '-' + process.pid, task, policy: fixture.policy, workerDataDir })
    await fixture.adapter.prepareTask(task, target)
    await fixture.setup(target)
    const verification = await fixture.adapter.verify({ runId: 'lifecycle-' + fixture.id, trialId: 'trial-' + fixture.id, task, sandbox: target, agentArtifacts: agentArtifacts(), agentVariant: agentVariant(), signal: new AbortController().signal })
    for (const [name, value] of Object.entries(fixture.expected)) if (verification.result.nativeMetrics[name] !== value) throw new Error(fixture.id + ' metric mismatch for ' + name + ': metrics=' + JSON.stringify(verification.result.nativeMetrics) + '; stdout=' + JSON.stringify(verification.stdout) + '; stderr=' + JSON.stringify(verification.stderr))
    if (verification.result.officialEvidence) throw new Error(fixture.id + ' fixture cannot claim official evidence')
    const collected = await provider.collect(target)
    results.push({ benchmarkId: fixture.id, provider: provider.descriptor.kind, sandboxId: target.sandboxId, environmentLock: collected.environmentLock, result: verification.result, artifactPaths: verification.artifactPaths })
  } finally {
    if (target) { await provider.destroy(target).catch(() => undefined); if (!await provider.verifyDestroyed(target)) throw new Error(fixture.id + ' sandbox cleanup verification failed') }
  }
}
const evidence = { schemaVersion: 1, generatedAt: new Date().toISOString(), scope: 'adapter-sandbox-verifier-lifecycle; not Agent performance evidence', results }
const output = option('--output')
if (output) { const path = resolve(output); await mkdir(dirname(path), { recursive: true, mode: 0o700 }); await writeFile(path, JSON.stringify(evidence, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 }) }
process.stdout.write(JSON.stringify({ ok: true, benchmarks: results.map((result) => ({ benchmarkId: result.benchmarkId, provider: result.provider, nativeMetrics: result.result.nativeMetrics, officialEvidence: result.result.officialEvidence })), output: output ? resolve(output) : undefined }) + '\n')

async function setupTerminal(target) { await put(target, 'answer.txt', '42\n') }
async function setupProgram(target) { await put(target, 'program.sh', '#!/bin/sh\nprintf "hello %s\\n" "$1"\n', true); await put(target, 'compile.sh', '#!/bin/sh\nset -eu\ncp program.sh executable\nchmod +x executable\n', true) }
async function setupMarathon(target) { await target.execute({ argv: ['sh', '-ceu', 'mkdir -p outcomes; printf 1 > outcomes/task-a; printf 0 > outcomes/task-b; printf 1 > outcomes/task-c'], cwd: '/workspace', timeoutMs: 10_000 }) }
async function setupSdlc(target) {
  const loopback = await target.execute({ argv: ['sh', '-ceu', 'ip link set lo up'], timeoutMs: 10_000 })
  if (loopback.exitCode !== 0) throw new Error('SDLC fixture could not enable isolated loopback: ' + loopback.stderr)
  await put(target, 'issue-analysis.txt', 'root cause: version marker is stale\n')
  await put(target, 'app.txt', 'version=2\n')
  await put(target, 'test.sh', '#!/bin/sh\nset -eu\ngrep -q "version=2" app.txt\n', true)
  await put(target, 'build.sh', '#!/bin/sh\nset -eu\nmkdir -p package\ncp app.txt package/app.pkg\n', true)
}
async function setupFault(target) { await put(target, 'app.sh', '#!/bin/sh\nset -eu\ntest "$(cat config)" = good || { echo CONFIG_INVALID >&2; exit 23; }\nprintf ok\n', true); await put(target, 'config', 'good\n') }
async function put(target, path, body, executable = false) { const result = await target.execute({ argv: ['sh', '-ceu', 'cat > "$1"; ' + (executable ? 'chmod +x "$1"' : ':'), 'write', '/workspace/' + path], stdin: body, timeoutMs: 10_000 }); if (result.exitCode !== 0) throw new Error('fixture write failed: ' + path) }
function metricStep(name, script) { return { stepId: name, nativeMetric: name, argv: ['sh', '-ceu', script + '; printf \'%s\\n\' \'{"metrics":{"' + name + '":true}}\''], cwd: '.', timeoutMs: 20_000, requiredExitCode: 0 } }
function sdlcSteps() { return [
  metricStep('investigation_passed', 'grep -q "root cause" issue-analysis.txt'), metricStep('implementation_verified', 'grep -q "version=2" app.txt'), metricStep('tests_passed', './test.sh'),
  metricStep('build_passed', './build.sh; test -s package/app.pkg'), metricStep('package_created', 'test -s package/app.pkg'),
  metricStep('deploy_succeeded', 'rm -rf deploy; mkdir deploy; cp package/app.pkg deploy/app.txt; python3 -m http.server 18080 --bind 127.0.0.1 --directory deploy >/tmp/sdlc-http.log 2>&1 & echo $! > deploy.pid; sleep 1; kill -0 "$(cat deploy.pid)"'),
  metricStep('health_verified', 'python3 -c \'import urllib.request; assert b"version=2" in urllib.request.urlopen("http://127.0.0.1:18080/app.txt", timeout=3).read()\''),
  metricStep('rollback_verified', 'kill "$(cat deploy.pid)"; wait "$(cat deploy.pid)" 2>/dev/null || true; printf "version=1\\n" > deploy/app.txt; python3 -m http.server 18081 --bind 127.0.0.1 --directory deploy >/tmp/sdlc-rollback.log 2>&1 & pid=$!; sleep 1; python3 -c \'import urllib.request; assert b"version=1" in urllib.request.urlopen("http://127.0.0.1:18081/app.txt", timeout=3).read()\'; kill "$pid"; wait "$pid" 2>/dev/null || true'),
] }
function faultSteps() { return [
  metricStep('fault_injected', 'printf bad > config'), metricStep('fault_observed', 'if ./app.sh >out 2>error; then exit 1; else grep -q CONFIG_INVALID error; fi'),
  metricStep('recovery_action_grounded', 'grep -q CONFIG_INVALID error; printf "restore known-good config after CONFIG_INVALID\\n" > recovery.log; printf good > config'),
  metricStep('service_recovered', 'test "$(./app.sh)" = ok'), metricStep('success_control_passed', 'printf good > config; test "$(./app.sh)" = ok'),
] }
function agentArtifacts() { return { completedAt: new Date().toISOString(), finalResponse: 'fixture', finalDiff: '', nativeEvents: [], normalizedEvents: [], stdout: '', stderr: '', usage: { availability: 'unavailable', reason: 'lifecycle verifier fixture' }, version: 'fixture', configHash: HASH, extraArtifactPaths: [] } }
function agentVariant() { return { variantId: 'fixture-agent', backendId: 'custom-command', agentVersion: 'fixture', model: { modelId: 'fixture' }, configHash: HASH, config: {}, credentialRefs: [] } }
function values(name) { const output = []; for (let index = 2; index < process.argv.length; index += 1) if (process.argv[index] === name && process.argv[index + 1]) output.push(process.argv[++index]); else if (process.argv[index]?.startsWith(name + '=')) output.push(process.argv[index].slice(name.length + 1)); return output }
function option(name) { return values(name).at(-1) }

async function fixtureRepository(workerDataDir, fixtureId) {
  const source = resolve(workerDataDir, 'source')
  const archiveRef = 'fixtures/repository.tar'
  const archive = resolve(workerDataDir, archiveRef)
  await mkdir(source, { recursive: true, mode: 0o700 })
  await mkdir(dirname(archive), { recursive: true, mode: 0o700 })
  await writeFile(resolve(source, 'README.md'), '# ' + fixtureId + ' lifecycle fixture\n', { mode: 0o600 })
  await command('git', ['init', '-q', '-b', 'main'], source)
  await command('git', ['config', 'user.name', 'Agent Evaluation Fixture'], source)
  await command('git', ['config', 'user.email', 'evaluation@localhost'], source)
  await command('git', ['add', '.'], source)
  await command('git', ['commit', '-qm', 'fixture'], source, { GIT_AUTHOR_DATE: '2026-08-03T00:00:00Z', GIT_COMMITTER_DATE: '2026-08-03T00:00:00Z' })
  const revision = (await command('git', ['rev-parse', 'HEAD'], source)).stdout.trim()
  await command('tar', ['--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '-cf', archive, '-C', source, '.'])
  return { kind: 'artifact', archiveRef, archiveSha256: createHash('sha256').update(await readFile(archive)).digest('hex'), revision }
}
async function command(binary, args, cwd, environment = {}) { return await runFile(binary, args, { cwd, env: { ...process.env, ...environment }, encoding: 'utf8', timeout: 30_000 }) }
