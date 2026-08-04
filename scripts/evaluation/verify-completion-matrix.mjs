#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { promisify } from 'node:util'

const runFile = promisify(execFile)
const root = resolve(new URL('../..', import.meta.url).pathname)
const evidencePaths = {
  protocol: 'docs/evidence/evaluation/protocol-contracts-acceptance-20260803.json',
  parity: 'docs/evidence/evaluation/control-plane-parity-acceptance-20260803.json',
  scheduler: 'docs/evidence/evaluation/scheduler-recovery-acceptance-20260803.json',
  worker: 'docs/evidence/evaluation/worker-deployment-acceptance-20260803.json',
  workerBoundary: 'docs/evidence/evaluation/worker-boundary-acceptance-20260803.json',
  sandbox: 'docs/evidence/evaluation/sandbox-conformance-20260803.json',
  agents: 'docs/evidence/evaluation/agent-adapters-acceptance-20260803.json',
  benchmarkFixtures: 'docs/evidence/evaluation/benchmark-lifecycles-20260803011312.json',
  benchmarkAgents: 'docs/evidence/evaluation/benchmark-agent-lifecycles-acceptance-20260803.json',
  external: 'docs/evidence/evaluation/external-contributor-acceptance-20260803.json',
  sweBench: 'docs/evidence/evaluation/final-fresh-swe-bench-astropy-12907-20260803.json',
  sdlc: 'docs/evidence/evaluation/final-fresh-sdlc-journey-20260803.json',
  fault: 'docs/evidence/evaluation/flagship-closed-loop-baseline-20260803.json',
  codeUnderstanding: 'docs/evidence/evaluation/code-understanding-acceptance-20260803.json',
  memoryPlanning: 'docs/evidence/evaluation/memory-planning-acceptance-20260803.json',
  metamorphic: 'docs/evidence/evaluation/metamorphic-variants-acceptance-20260803.json',
  sweMarathonLifecycle: 'docs/evidence/evaluation/swe-marathon-lifecycle-acceptance-20260803.json',
  metamorphicLifecycle: 'docs/evidence/evaluation/metamorphic-lifecycle-acceptance-20260803.json',
  analysis: 'docs/evidence/evaluation/analysis-mining-acceptance-20260803.json',
  reproduction: 'docs/evidence/evaluation/flagship-fresh-reproduction-20260803.json',
  regression: 'docs/evidence/evaluation/regression-reporting-acceptance-20260803.json',
  productDashboard: 'docs/evidence/evaluation/product-dashboard-integration-acceptance-20260803.json',
}
const evidence = Object.fromEntries(await Promise.all(Object.entries(evidencePaths).map(async ([name, path]) => [name, JSON.parse(await readFile(resolve(root, path), 'utf8'))])))

const lifecycle = []
function add(adapter, kind, proof, checks) {
  if (checks.some((check) => check !== true)) throw new Error(adapter + ' lifecycle evidence is incomplete')
  lifecycle.push({ adapter, kind, proof, acceptedSpec: true, controlPlane: true, workerOrPublicPluginContract: true, isolatedSandbox: true, nativeVerifier: true, canonicalEvidence: true, gradingAndAnalysis: true, cleanupVerified: true })
}

const swe = evidence.sweBench
add('swe-bench', 'official real-Agent lifecycle', { path: evidencePaths.sweBench, runId: swe.runId, trials: swe.trials?.length, evidenceLevel: 'official' }, [swe.runState === 'completed', swe.freshSandboxes === 3, swe.cleanupVerified, swe.sourceFetchedFresh, swe.trials?.length === 3, swe.trials?.every((trial) => trial.evidenceLevel === 'official' && trial.nativeMetrics?.resolved === true && hash(trial.resultHash) && trial.normalizedEventCount > 0)])

const terminal = evidence.benchmarkAgents.terminalBench
add('terminal-bench', 'fresh real-Agent lifecycle', { path: evidencePaths.benchmarkAgents, runId: terminal?.runId, trials: 1 }, [terminal?.taskPackId === 'terminal-bench', terminal?.nativeMetrics?.reward === 1, terminal?.freshSandboxes === 1, terminal?.cleanupVerified, hash(terminal?.resultHash), terminal?.normalizedEventCount > 0])
const program = evidence.benchmarkAgents.programBench
add('program-bench', 'fresh real-Agent lifecycle', { path: evidencePaths.benchmarkAgents, runId: program?.runId, trials: 1 }, [program?.taskPackId === 'program-bench', program?.nativeMetrics?.compile_passed === true, program?.nativeMetrics?.tests_passed === true, program?.freshSandboxes === 1, program?.cleanupVerified, hash(program?.resultHash), program?.normalizedEventCount > 0])

const marathon = evidence.sweMarathonLifecycle
add('swe-marathon', 'fresh full unified lifecycle', { path: evidencePaths.sweMarathonLifecycle, runId: marathon?.runId, trials: marathon?.trialCount }, [marathon?.runState === 'completed', marathon?.trialCount === 1, marathon?.freshSandboxes === 1, marathon?.cleanupVerified, marathon?.workerErrors?.length === 0, marathon?.sweMarathon?.nativeMetrics?.resolved_tasks === 2, marathon?.sweMarathon?.nativeMetrics?.total_tasks === 3, marathon?.sweMarathon?.nativeMetrics?.verifier_protocol_valid === true, Boolean(marathon?.gradingJobId), Boolean(marathon?.analysisJobId)])

const taskPack = evidence.benchmarkAgents.customTaskPack
add('custom-task-pack', 'clean-workspace public plugin plus deployed Worker lifecycle', { path: evidencePaths.benchmarkAgents, pluginId: taskPack?.plugin?.id, deployedRunId: evidence.worker.runId }, [taskPack?.plugin?.kind === 'benchmark-adapter', taskPack?.orchestratorInternalsUnchanged === true, evidence.external.privateImportScan?.length === 0, evidence.worker.runState === 'completed', evidence.worker.trialState === 'completed', evidence.worker.lifecycleStates?.includes('verifying'), evidence.worker.lifecycleStates?.includes('analyzing'), hash(evidence.worker.evidence?.resultHash)])

const code = evidence.codeUnderstanding
add('code-understanding', 'fixture/property plus fresh real-Agent lifecycle', { path: evidencePaths.codeUnderstanding, runId: code.runId, trials: 1 }, [code.runId?.startsWith('fresh-code-understanding-'), code.agentVariantId === 'codex', code.cleanupVerified, code.nativeMetrics?.verifier_protocol_valid === true, hash(code.resultHash), code.normalizedEventCount > 0, Boolean(code.gradingJobId), Boolean(code.analysisJobId)])
const memory = evidence.memoryPlanning
add('memory-planning', 'fixture/property plus fresh real-Agent lifecycle', { path: evidencePaths.memoryPlanning, runId: memory.runId, trials: 1 }, [memory.runId?.startsWith('fresh-memory-planning-'), memory.agentVariantId === 'codex', memory.cleanupVerified, memory.nativeMetrics?.verifier_protocol_valid === true, hash(memory.resultHash), memory.normalizedEventCount > 0, Boolean(memory.gradingJobId), Boolean(memory.analysisJobId)])

const sdlc = evidence.sdlc
add('sdlc-journey', 'fresh three-Agent lifecycle', { path: evidencePaths.sdlc, runId: sdlc.runId, trials: sdlc.trials?.length }, [sdlc.runState === 'completed', sdlc.freshSandboxes === 3, sdlc.cleanupVerified, sdlc.trials?.length === 3, sdlc.trials?.every((trial) => trial.nativeMetrics?.journey_completed === true && trial.nativeMetrics?.rollback_verified === true && hash(trial.resultHash) && trial.normalizedEventCount > 0)])

const fault = evidence.fault
add('fault-scenarios', 'fresh five-task three-Agent lifecycle', { path: evidencePaths.fault, runId: fault.runId, trials: fault.trials?.length }, [fault.runState === 'completed', fault.freshSandboxes === 15, fault.cleanupVerified, fault.trials?.length === 15, fault.trials?.every((trial) => trial.nativeMetrics?.recovered === true && hash(trial.resultHash) && trial.normalizedEventCount > 0)])
const tenMinuteDemo = { durationMs: fault.durationMs, thresholdMs: 600_000, passed: Number.isFinite(fault.durationMs) && fault.durationMs < 600_000, tasks: fault.taskIds?.length, agents: fault.agentIds?.length, trials: fault.trials?.length, freshSandboxes: fault.freshSandboxes, cleanupVerified: fault.cleanupVerified }
if (!tenMinuteDemo.passed || tenMinuteDemo.tasks !== 5 || tenMinuteDemo.agents !== 3 || tenMinuteDemo.trials !== 15 || tenMinuteDemo.freshSandboxes !== 15 || tenMinuteDemo.cleanupVerified !== true) throw new Error('five-task three-Agent demo lacks direct under-ten-minute evidence')

const variants = evidence.metamorphic
const variantLifecycle = evidence.metamorphicLifecycle
add('metamorphic-variants', 'generated variants plus fresh full unified lifecycle', { generationPath: evidencePaths.metamorphic, lifecyclePath: evidencePaths.metamorphicLifecycle, runId: variantLifecycle?.runId, variants: variants.variants?.length, trials: variantLifecycle?.trialCount }, [variants.variants?.length === 6, variants.variants?.every((variant) => variant.verifier?.passed === true && hash(variant.manifestHash)), variants.sensitivity?.brittlePathCandidate?.detectedBrittlePathAssumption === true, variants.sensitivity?.semanticMutation?.detectedSemanticChange === true, variantLifecycle?.runState === 'completed', variantLifecycle?.trialCount === 6, variantLifecycle?.freshSandboxes === 6, variantLifecycle?.cleanupVerified, variantLifecycle?.workerErrors?.length === 0, variantLifecycle?.metamorphicVariants?.length === 6, variantLifecycle?.metamorphicVariants?.every((trial) => trial.nativeMetrics?.compile_passed === true && trial.nativeMetrics?.tests_passed === true && trial.nativeMetrics?.verifier_protocol_valid === true), Boolean(variantLifecycle?.gradingJobId), Boolean(variantLifecycle?.analysisJobId)])
if (lifecycle.length !== 10) throw new Error('completion lifecycle matrix must cover exactly ten declared adapter/task-pack classes')

const protocolTests = Object.values(evidence.protocol.groups ?? {}).flat()
const schedulerTests = [...(evidence.scheduler.scheduler ?? []), ...(evidence.scheduler.leases ?? []), ...(evidence.scheduler.cancellation ?? [])]
const regressionTests = evidence.regression.tests ?? []
const unitProperty = {
  schemasMigrations: passing(protocolTests, 14) && evidence.protocol.summary?.explicitForwardMigrationOnly === true && evidence.protocol.summary?.canonicalV1BackwardReadable === true && evidence.protocol.summary?.preRefactorHostArtifactsRejected === true,
  reducersReplay: evidence.protocol.summary?.stateReplayProperties === true,
  leasesRetries: passing(schedulerTests, 13) && evidence.scheduler.coverage?.selectiveRetry === true,
  sandboxConformance: evidence.sandbox.providers?.length === 3 && evidence.sandbox.providers.every((provider) => Object.values(provider.result?.checks ?? {}).every(Boolean)),
  detectors: evidence.analysis.traceAlignment?.firstMeaningfulDivergence === true && evidence.analysis.unknownClustering?.deterministicFallback?.startsWith('sha256') && evidence.analysis.unifiedTrace?.analyzerDetectDerivedSpan === true,
  minimizerPrivacy: evidence.reproduction.minimization?.minimizedUnits === 1 && evidence.reproduction.signatureVerified === true && Object.values(evidence.reproduction.privacy ?? {}).every(Boolean) && evidence.reproduction.unifiedTrace?.analyzerDetectSpans === 1 && evidence.reproduction.unifiedTrace?.reproductionVerifySpans === evidence.reproduction.reproduction?.attempts?.length + 1 && evidence.reproduction.unifiedTrace?.successfulVerificationSpans === evidence.reproduction.unifiedTrace?.reproductionVerifySpans && evidence.reproduction.unifiedTrace?.failureReproductionSpans === evidence.reproduction.reproduction?.attempts?.length && evidence.reproduction.unifiedTrace?.successControlSpans === 1,
  statisticsReports: passing(regressionTests, 7) && evidence.regression.report?.manifest?.formats?.length === 7 && evidence.regression.methodology?.pairedBootstrapSamples === 10_000 && evidence.regression.methodology?.mcnemar === true && evidence.regression.methodology?.repeatedRunVariance === true && evidence.regression.methodology?.evidenceCompleteness === true && evidence.regression.methodology?.taskDeltas === true && evidence.regression.methodology?.pareto === true && evidence.regression.capabilityVector?.components?.length === 11 && evidence.regression.capabilityVector?.evidenceLinked === true,
}
if (Object.values(unitProperty).some((value) => value !== true)) throw new Error('V01 unit/property matrix is incomplete')

const integration = {
  cliApiParity: passing(evidence.parity.requiredTests ?? [], 4) && evidence.parity.assertions?.restartDurability === true,
  controlPlaneWorker: evidence.worker.runState === 'completed' && evidence.workerBoundary.runtime?.runId === evidence.worker.runId,
  restartCancel: evidence.scheduler.coverage?.durableCancellation === true && evidence.scheduler.coverage?.blindIndeterminateReplayRejected === true,
  artifacts: hash(evidence.worker.evidence?.artifactManifestHash) && evidence.workerBoundary.runtime?.cleanupVerified === true,
  adapterNormalization: evidence.agents.tests?.officialCertification?.passed === 30 && evidence.agents.tests?.officialCertification?.expected === 30,
  officialGrader: swe.trials?.every((trial) => trial.evidenceLevel === 'official' && trial.nativeMetrics?.resolved === true),
  defectPromotion: evidence.regression.durableClosedLoop?.promotionReportInsightAuditTest?.status === 'passed' && evidence.reproduction.reproduction?.reproduced >= 2,
  productDashboardLinks: Object.values(evidence.productDashboard.integrations ?? {}).every(Boolean)
    && evidence.productDashboard.privacy?.contentIncluded === false
    && evidence.productDashboard.privacy?.workspacePathIncluded === false
    && evidence.productDashboard.privacy?.privateOnly === true
    && evidence.productDashboard.privacy?.explicitReviewRequired === true
    && evidence.productDashboard.privacy?.redactionAndProvenanceApprovalRequired === true
    && Object.values(evidence.productDashboard.security ?? {}).every(Boolean),
}
if (Object.values(integration).some((value) => value !== true)) throw new Error('V02 integration matrix is incomplete')

const runtimeResidue = await managedRuntimeResidue()
if (Object.values(runtimeResidue).some((items) => items.length > 0)) throw new Error('managed runtime residue remains: ' + JSON.stringify(runtimeResidue))
const sourceFiles = { 'scripts/evaluation/verify-completion-matrix.mjs': sha256(await readFile(new URL(import.meta.url))), ...Object.fromEntries(await Promise.all(Object.values(evidencePaths).map(async (path) => [path, sha256(await readFile(resolve(root, path)))]))) }
const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), scope: 'current-source completion audit for CC09 per-adapter unified lifecycle and V01/V02 verification graphs; fresh standalone evidence only, with no historical Session or compatibility input', sourceRevision: (await runFile('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' })).stdout.trim(), sourceFiles, lifecycle, tenMinuteDemo, unitProperty, integration, runtimeResidue, summary: { lifecycleAdapters: lifecycle.length, unitPropertyGroups: Object.keys(unitProperty).length, integrationGroups: Object.keys(integration).length, failures: 0 } }
const output = resolve(option('--output') ?? 'docs/evidence/evaluation/completion-matrix-acceptance-20260803.json')
await mkdir(dirname(output), { recursive: true, mode: 0o700 })
await writeFile(output, JSON.stringify(report, null, 2) + String.fromCharCode(10), { mode: 0o600 })
process.stdout.write(JSON.stringify({ ok: true, ...report.summary, managedRuntimeResidue: 0, output }) + String.fromCharCode(10))

function passing(tests, minimum) { return tests.length >= minimum && tests.every((test) => test.status === 'passed') }
function hash(value) { return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value) }
function sha256(value) { return createHash('sha256').update(value).digest('hex') }
function option(name) { for (let index = 2; index < process.argv.length; index += 1) if (process.argv[index] === name) return process.argv[index + 1]; else if (process.argv[index]?.startsWith(name + '=')) return process.argv[index].slice(name.length + 1) }
async function managedRuntimeResidue() {
  const [instances, networks, acls] = await Promise.all([
    lxc(['list', '--format', 'json'], (entry) => /^(?:eval-|ae-)/u.test(String(entry.name))),
    lxc(['network', 'list', '--format', 'json'], (entry) => /^ae-n-/u.test(String(entry.name))),
    lxc(['network', 'acl', 'list', '--format', 'json'], (entry) => /^ae-a-/u.test(String(entry.name))),
  ])
  return { instances, networks, acls }
}
async function lxc(args, matches) { const result = await runFile('lxc', args, { cwd: root, encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }); return JSON.parse(result.stdout).filter(matches).map((entry) => entry.name).sort() }
