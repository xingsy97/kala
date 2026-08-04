import { createHash, generateKeyPairSync } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { DefectFindingSchema, ResolvedTaskSchema, SandboxPolicySchema, canonicalJson, parseTrialTraceJsonl, serializeTrialTraceJsonl } from '../../packages/eval-protocol/dist/index.js'
import { buildVerifiedReproductionBundle, verifyReproductionBundleSignature } from '../../packages/eval-analyzer/dist/src/index.js'
import { DockerSandboxProvider } from '../../adapters/environments/docker/dist/index.js'
import { createLxdContainerProvider } from '../../adapters/environments/lxd-container/dist/index.js'

const providerKind = option('--provider') ?? 'docker'
if (providerKind !== 'docker' && providerKind !== 'lxd-container') throw new Error('--provider must be docker or lxd-container')
const imageDigest = option('--image') ?? (providerKind === 'docker' ? 'alpine@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b' : undefined)
if (!imageDigest) throw new Error('--image is required for LXD reproduction')
const repositoryRevision = option('--repository-revision') ?? 'synthetic-config-schema-v1'
const networkDestinations = values('--network-destination')
const output = resolve(option('--output') ?? join(tmpdir(), 'agent-eval-real-reproduction-' + process.pid + '.json'))
const bundleRoot = resolve(option('--bundle-root') ?? join(dirname(output), 'agent-eval-real-reproduction-bundle-' + process.pid))
const workerDataDir = resolve(option('--worker-data-dir') ?? join(tmpdir(), 'agent-eval-real-reproduction-worker-' + process.pid))
const runId = safeId('fresh-reproduction-' + new Date().toISOString().replace(/[-:.TZ]/gu, '').slice(0, 14) + '-' + process.pid)
const bundleId = runId + '-config-schema'
const findingId = option('--finding-id') ?? runId + '-finding'
const findingRunId = option('--finding-run-id') ?? runId
const findingTrialId = option('--finding-trial-id') ?? runId + '-source'
const firstDivergenceSequence = option('--first-divergence-sequence') ? positiveInteger(option('--first-divergence-sequence'), '--first-divergence-sequence') : undefined
const failureFingerprint = sha256('CONFIG_SCHEMA_INVALID')
const units = [
  { id: 'noise-readme', path: 'README.md', content: 'Synthetic config-schema reproduction.\n' },
  { id: 'trigger-config', path: 'config.json', content: '{"port":"18110","greeting":"hello"}\n' },
  { id: 'noise-notes', path: 'notes.txt', content: 'This file is irrelevant to the failure.\n' },
]
const policy = SandboxPolicySchema.parse({
  provider: providerKind, imageDigest, readOnlyBase: true, ephemeralOverlay: true,
  resources: providerKind === 'docker' ? { cpu: 1, memoryMb: 256, diskMb: 256, pids: 64 } : { cpu: 2, memoryMb: 4096, diskMb: 8192, pids: 512 },
  network: networkDestinations.length === 0 ? { mode: 'denied', allowedDestinations: [] } : { mode: 'allowlist', allowedDestinations: networkDestinations }, artifactAllowlist: [],
})
const task = ResolvedTaskSchema.parse({
  schemaVersion: 1, taskId: 'config-schema-reproduction', taskPackId: 'fault-scenarios', taskPackVersion: '1.0.0', title: 'Strict configuration schema reproduction', prompt: 'Reproduce CONFIG_SCHEMA_INVALID.',
  repository: { kind: 'artifact', archiveRef: 'fixtures/config-schema.tar', archiveSha256: sha256('synthetic-reproduction-fixture'), revision: repositoryRevision },
  fixtureManifestHash: sha256(canonicalJson(units)), faultScenarioIds: ['invalid-port-type-v1'], verification: [{ stepId: 'schema-check', argv: ['sh', '-ceu', checker()], cwd: '.', timeoutMs: 10_000, requiredExitCode: 23, nativeMetric: 'failure_reproduced' }],
  analysis: { constraints: [{ id: 'failure-reproduced', kind: 'evidence', sourceRef: 'task#schema-check', verifierId: 'reproduction-harness', verifierVersion: '1', verifierMetric: 'failure_reproduced' }], protectedPaths: [], hiddenVerifierPaths: [] },
  ...(providerKind === 'lxd-container' ? { lxdInitMode: 'keepalive' } : {}), policy: { license: { status: 'granted', basis: 'MIT' }, permissions: { evaluation: { status: 'granted', basis: 'public synthetic evaluation' }, training: { status: 'unreviewed' } }, sourceProvenance: { status: 'granted', sourceRefs: ['fixture:real-reproduction'] }, publication: { artifact: { status: 'granted', basis: 'public synthetic evaluation' }, report: { status: 'granted', basis: 'public synthetic evaluation' }, leaderboard: { status: 'granted', basis: 'public synthetic evaluation' }, redistribution: { status: 'granted', basis: 'MIT' } } },
})
await Promise.all([mkdir(workerDataDir, { recursive: true, mode: 0o700 }), mkdir(bundleRoot, { recursive: true, mode: 0o700 })])
const provider = providerKind === 'docker' ? new DockerSandboxProvider() : createLxdContainerProvider()
const preflight = await provider.preflight(policy)
if (!preflight.ok) throw new Error(providerKind + ' reproduction preflight failed: ' + preflight.errors.map((error) => error.code).join(','))

const executions = []
const original = await executeCandidate(units, 'original')
if (original.failureFingerprint !== failureFingerprint) throw new Error('original fresh sandbox did not reproduce the canonical failure')
const environmentLock = original.environmentLock
const expectedEnvironmentLockHash = option('--expected-environment-lock-hash')
if (expectedEnvironmentLockHash && sha256(canonicalJson(environmentLock)) !== expectedEnvironmentLockHash) throw new Error('fresh reproduction environment lock does not match the declared source trial')
const finding = DefectFindingSchema.parse({ schemaVersion: 1, findingId, detectorId: 'tool-recovery', detectorVersion: '1.0.0', runId: findingRunId, trialId: findingTrialId, category: 'tool_recovery', severity: 'high', confidence: 1, ...(firstDivergenceSequence === undefined ? {} : { firstDivergenceSequence }), evidenceRefs: ['normalized-events.jsonl#CONFIG_SCHEMA_INVALID'], status: 'human_validated' })
const { privateKey } = generateKeyPairSync('ed25519')
const built = await buildVerifiedReproductionBundle({
  bundleId, finding, failureFingerprint, environmentLock,
  task: { schemaVersion: 1, taskId: task.taskId, faultScenarioId: 'invalid-port-type-v1', reproduction: { argv: ['sh', '-ceu', checker()], expectedExitCode: 23, stderrIncludes: 'CONFIG_SCHEMA_INVALID', failureFingerprintSource: 'CONFIG_SCHEMA_INVALID' } }, agentConfig: { kind: 'deterministic-reproduction-harness', version: '1.0.0' }, toolRegistry: { tools: ['sandbox.execute'], version: '1.0.0' },
  traceJsonl: analyzedTraceJsonl(), finalDiff: '', verifierResult: { passed: false, code: 'CONFIG_SCHEMA_INVALID', exitCode: 23 }, analysis: { category: 'tool_recovery', responsibility: 'agent', observedStateSufficientForRecovery: true },
  units, attempts: 2,
  harness: {
    preservesFailure: async (candidate) => (await executeCandidate(candidate, 'ddmin')).failureFingerprint === failureFingerprint,
    reproduce: async (candidate, index) => await executeCandidate(candidate, 'attempt-' + String(index + 1)),
    expectedSuccessControl: async () => {
      const result = await executeCandidate([{ id: 'valid-config-control', path: 'config.json', content: '{"port":18110,"greeting":"control"}\n' }], 'success-control')
      return { freshEnvironmentId: result.freshEnvironmentId, environmentLock: result.environmentLock, passed: result.exitCode === 0 && result.stdout.trim() === 'OK', evidenceRefs: result.evidenceRefs }
    },
  },
  signingKey: { keyReference: 'ephemeral-release-acceptance-key', privateKey },
})
if (!verifyReproductionBundleSignature(built.bundle)) throw new Error('generated reproduction signature did not verify')
const tracePath = built.bundle.files.find((file) => file.path.endsWith('/trace.jsonl'))?.path
const traceContent = tracePath ? built.files.get(tracePath) : undefined
if (!traceContent) throw new Error('generated reproduction bundle lacks its unified trace')
const reproductionTrace = parseTrialTraceJsonl(new TextDecoder().decode(traceContent))
const analyzerSpans = reproductionTrace.spans.filter((span) => span.name === 'analyzer.detect')
const verificationSpans = reproductionTrace.spans.filter((span) => span.name === 'reproduction.verify')
if (analyzerSpans.length !== 1) throw new Error('generated reproduction trace must retain exactly one analyzer.detect span')
if (verificationSpans.length !== built.bundle.reproduction.attempts.length + 1) throw new Error('generated reproduction trace must append one verification span per attempt plus the success control')
if (verificationSpans.some((span) => span.status !== 'ok' || span.artifactRefs.length === 0)) throw new Error('generated reproduction trace contains an unsuccessful or ungrounded verification span')
if (verificationSpans.filter((span) => span.outcomeCategory === 'failure_reproduced').length !== built.bundle.reproduction.attempts.length || verificationSpans.filter((span) => span.outcomeCategory === 'expected_success_control_passed').length !== 1) throw new Error('generated reproduction trace outcomes do not match the signed reproduction result')
for (const [path, content] of built.files) {
  const destination = join(bundleRoot, path)
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
  await writeFile(destination, content, { mode: path.endsWith('/reproduce.sh') ? 0o700 : 0o600 })
}
const manifestPath = join(bundleRoot, 'bundles', bundleId, 'bundle.json')
await mkdir(dirname(manifestPath), { recursive: true, mode: 0o700 })
await writeFile(manifestPath, JSON.stringify(built.bundle, null, 2) + '\n', { mode: 0o600 })
for (const file of built.bundle.files) {
  const content = built.files.get(file.path)
  if (!content || content.byteLength !== file.bytes || sha256(content) !== file.sha256) throw new Error('bundle file integrity mismatch: ' + file.path)
}
if (executions.some((execution) => !execution.cleanupVerified)) throw new Error('one or more reproduction sandboxes were not destroyed')
if (new Set(executions.map((execution) => execution.freshEnvironmentId)).size !== executions.length) throw new Error('reproduction harness reused a sandbox')
const evidence = {
  schemaVersion: 1, generatedAt: new Date().toISOString(), runId, bundleId, findingId: finding.findingId, faultScenarioId: 'invalid-port-type-v1', failureFingerprint, environmentLockHash: built.bundle.environmentLockHash,
  freshSandboxExecutions: executions.length, cleanupVerified: true, uniqueFreshEnvironments: true,
  minimization: built.bundle.reproduction.minimization, reproduction: built.bundle.reproduction,
  successControl: { passed: built.bundle.reproduction.expectedSuccessControl.passed, freshEnvironment: true },
  privacy: built.bundle.privacy, signatureVerified: true, signedPayloadHash: built.bundle.signedPayloadHash,
  unifiedTrace: { totalSpans: reproductionTrace.spans.length, analyzerDetectSpans: analyzerSpans.length, reproductionVerifySpans: verificationSpans.length, successfulVerificationSpans: verificationSpans.filter((span) => span.status === 'ok').length, failureReproductionSpans: verificationSpans.filter((span) => span.outcomeCategory === 'failure_reproduced').length, successControlSpans: verificationSpans.filter((span) => span.outcomeCategory === 'expected_success_control_passed').length },
  bundleManifestPath: manifestPath, bundleFiles: built.bundle.files,
}
await mkdir(dirname(output), { recursive: true, mode: 0o700 })
await writeFile(output, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 })
process.stdout.write(JSON.stringify({ ok: true, runId, bundleId, freshSandboxExecutions: executions.length, minimizedUnits: built.bundle.reproduction.minimization.minimizedUnits, reproduced: built.bundle.reproduction.reproduced, successControl: built.bundle.reproduction.expectedSuccessControl.passed, signedPayloadHash: built.bundle.signedPayloadHash, output, bundleRoot }) + '\n')

async function executeCandidate(candidate, phase) {
  const trialId = safeId(runId + '-' + phase + '-' + String(executions.length + 1))
  let target
  try {
    target = await provider.create({ workerId: runId, trialId, task, policy, workerDataDir })
    for (const unit of candidate) {
      if (!safeRelativePath(unit.path)) throw new Error('candidate path is not relative and contained')
      const written = await target.execute({ argv: ['sh', '-ceu', 'mkdir -p "$(dirname "$1")"; cat > "$1"', 'write-unit', target.workspacePath + '/' + unit.path], stdin: unit.content, timeoutMs: 10_000 })
      if (written.exitCode !== 0) throw new Error('candidate unit could not be written: ' + unit.path)
    }
    const checked = await target.execute({ argv: ['sh', '-ceu', checker()], cwd: target.workspacePath, timeoutMs: 10_000 })
    const collected = await provider.collect(target)
    const observed = checked.exitCode === 23 && checked.stderr.includes('CONFIG_SCHEMA_INVALID') ? failureFingerprint : sha256('exit=' + String(checked.exitCode) + '\nstdout=' + checked.stdout + '\nstderr=' + checked.stderr)
    await provider.destroy(target)
    const cleanupVerified = await provider.verifyDestroyed(target)
    const execution = { phase, freshEnvironmentId: target.sandboxId, environmentLock: collected.environmentLock, failureFingerprint: observed, evidenceRefs: ['sandbox:' + target.sandboxId, 'stderr-sha256:' + sha256(checked.stderr)], exitCode: checked.exitCode, stdout: checked.stdout, stderr: checked.stderr, cleanupVerified }
    executions.push(execution)
    return execution
  } catch (error) {
    if (target) { await provider.destroy(target).catch(() => undefined); await provider.verifyDestroyed(target).catch(() => false) }
    throw error
  }
}

function checker() { return `if ! test -f config.json; then echo CONFIG_MISSING >&2; exit 20; fi; if grep -Eq '"port"[[:space:]]*:[[:space:]]*[0-9]+' config.json; then echo OK; exit 0; fi; echo CONFIG_SCHEMA_INVALID >&2; exit 23` }
function analyzedTraceJsonl() {
  const at = new Date().toISOString()
  const traceId = safeId('trace-' + findingRunId + '-' + findingTrialId)
  const refs = { runId: findingRunId, trialId: findingTrialId, backendId: 'reproduction-harness', taskId: task.taskId }
  const span = (spanId, parentSpanId, name) => ({ schemaVersion: 1, traceId, spanId, ...(parentSpanId ? { parentSpanId } : {}), name, startedAt: at, completedAt: at, status: 'ok', refs, artifactRefs: [] })
  return serializeTrialTraceJsonl({ schemaVersion: 1, traceId, runId: findingRunId, trialId: findingTrialId, spans: [
    span('run', undefined, 'evaluation.run'), span('trial', 'run', 'evaluation.trial'), span('environment', 'trial', 'environment.prepare'),
    span('agent', 'trial', 'agent.execute'), span('workspace', 'trial', 'workspace.snapshot'), span('verifier', 'trial', 'verifier.execute'),
    { ...span('analyzer', 'trial', 'analyzer.detect'), outcomeCategory: 'finding_detected' },
  ] })
}
function sha256(value) { return createHash('sha256').update(value).digest('hex') }
function safeRelativePath(value) { return typeof value === 'string' && value.length > 0 && !value.startsWith('/') && value !== '..' && !value.startsWith('../') && !value.includes('/../') }
function safeId(value) { return value.toLowerCase().replace(/[^a-z0-9._:-]/gu, '-').replace(/-+/gu, '-').slice(0, 120) }
function positiveInteger(value, name) { const parsed = Number(value); if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(name + ' must be a positive integer'); return parsed }
function option(name) { for (let index = 2; index < process.argv.length; index += 1) if (process.argv[index] === name) return process.argv[index + 1]; else if (process.argv[index]?.startsWith(name + '=')) return process.argv[index].slice(name.length + 1) }
function values(name) { const output = []; for (let index = 2; index < process.argv.length; index += 1) if (process.argv[index] === name && process.argv[index + 1]) output.push(process.argv[++index]); else if (process.argv[index]?.startsWith(name + '=')) output.push(process.argv[index].slice(name.length + 1)); return output }
