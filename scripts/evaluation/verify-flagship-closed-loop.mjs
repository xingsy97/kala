#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'

import { canonicalJson, sha256Hex, verifyReproductionBundleSignature } from '../../packages/eval-protocol/dist/index.js'
import { DurableJournal, EvaluationControlPlane, JournalTransactionSchema, RegisteredTaskCatalog } from '../../packages/eval-orchestrator/dist/src/index.js'

const workspaceRoot = resolve(dirname(new URL(import.meta.url).pathname), '../..')
const baselineRoot = requiredPath('--baseline-root')
const candidateRoot = requiredPath('--candidate-root')
const reproductionManifest = requiredPath('--reproduction-manifest')
const outputPath = option('--output') ? resolve(option('--output')) : undefined
const closedLoopRoot = option('--data-root') ? resolve(option('--data-root')) : await mkdtemp(join(tmpdir(), 'agent-eval-flagship-closed-loop-'))
const artifactRoot = join(closedLoopRoot, 'artifacts')
const journalPath = join(closedLoopRoot, 'control-plane.jsonl')

const baselineJournal = new DurableJournal(join(baselineRoot, 'control-plane.jsonl'))
const candidateJournal = new DurableJournal(join(candidateRoot, 'control-plane.jsonl'))
const [baselineTransactions, candidateTransactions] = await Promise.all([baselineJournal.readAll(), candidateJournal.readAll()])
const mergedTransactions = await rewriteJournal([...baselineTransactions, ...candidateTransactions])
await mkdir(closedLoopRoot, { recursive: true, mode: 0o700 })
await writeFile(journalPath, mergedTransactions.map((transaction) => JSON.stringify(transaction)).join('\n') + '\n', { mode: 0o600 })

await mkdir(artifactRoot, { recursive: true, mode: 0o700 })
const mergeResults = await Promise.all([
  mergeArtifactTree(join(baselineRoot, 'artifacts'), artifactRoot),
  mergeArtifactTree(join(candidateRoot, 'artifacts'), artifactRoot),
])
const reproduction = await verifyReproductionBundleSignature(JSON.parse(await readFile(reproductionManifest, 'utf8')))
const reproductionRoot = dirname(reproductionManifest)
for (const file of reproduction.files) {
  const content = await readFile(join(reproductionRoot, basename(file.path)))
  if (content.byteLength !== file.bytes || createHash('sha256').update(content).digest('hex') !== file.sha256) throw new Error('reproduction source file integrity mismatch: ' + file.path)
  await writeArtifactIdempotent(join(artifactRoot, file.path), content)
}

const catalog = new RegisteredTaskCatalog()
let controlPlane = new EvaluationControlPlane({ journalPath, reportRoot: artifactRoot, taskCatalog: catalog })
await controlPlane.initialize()
const baselineRun = onlyRun(controlPlane, baselineTransactions)
const candidateRun = onlyRun(controlPlane, candidateTransactions)
const baselineAgent = requiredAgent(baselineRun, 'agent-runlab')
const candidateAgent = requiredAgent(candidateRun, 'agent-runlab')
assertComparableRuns(baselineRun, candidateRun)

const baselineTrials = trialsFor(controlPlane, baselineRun.accepted.spec.runId)
const candidateTrials = trialsFor(controlPlane, candidateRun.accepted.spec.runId)
const sourceTrial = requiredTrial(baselineTrials, 'config-schema-recovery-1', 'agent-runlab')
const traceDivergence = await mineTraceDivergence(baselineTrials, artifactRoot, 'config-schema-recovery-1')
const environmentLockHash = await sha256Hex(canonicalJson(sourceTrial.evidence.environmentLock))
if (environmentLockHash !== reproduction.environmentLockHash) throw new Error('signed reproduction does not use the flagship source trial environment lock')

const finding = {
  schemaVersion: 1, findingId: reproduction.findingId, detectorId: 'first-divergence-miner', detectorVersion: '1.0.0',
  runId: baselineRun.accepted.spec.runId, trialId: sourceTrial.trialId, category: 'tool_recovery', severity: 'medium', confidence: 1,
  firstDivergenceSequence: traceDivergence['agent-runlab'].firstObservationSequence,
  evidenceRefs: Object.values(traceDivergence).map((item) => item.normalizedEventsRef), status: 'human_validated',
}
const pack = {
  schemaVersion: 1, packId: 'flagship-config-schema-regression', version: '1.0.0', taskPackRef: baselineRun.accepted.spec.taskPack.id + '@' + baselineRun.accepted.spec.taskPack.version,
  environmentLockHashes: [environmentLockHash], verifierSemanticsHash: baselineRun.accepted.spec.verification.configHash, faultScenarioIds: ['invalid-port-type-v1'],
  severity: 'medium', owner: 'agent-platform', allowedFlakeRate: 0,
  baselineEvidenceRefs: baselineTrials.filter((trial) => trial.agentVariantId === 'agent-runlab').map((trial) => trial.evidence.resultHash).sort(),
  promotionSourceFindingId: finding.findingId,
}
const gateId = 'flagship-observe-before-act-gate'
const reportId = 'flagship-closed-loop-report'
const insight = {
  schemaVersion: 1, insightId: 'flagship-observe-before-act-insight', evidenceRefs: [finding.findingId, gateId],
  failureCluster: 'configuration recovery requires observing the concrete schema failure before editing', affectedTaskRate: 1, severity: 'medium', suspectedLayer: 'runtime', confidence: 1,
  recommendation: 'observe the failing command and current configuration before applying a recovery edit', expectedMetric: 'paired native recovery success rate',
  regressionPackId: pack.packId, owner: 'agent-platform', status: 'validated', postFixValidationRefs: [gateId],
}

const acknowledgements = []
acknowledgements.push(await command(controlPlane, 'defect.record', 'flagship-record-defect', { finding }))
acknowledgements.push(await command(controlPlane, 'defect.promote', 'flagship-promote-defect', { findingId: finding.findingId, pack, reproduction }))
acknowledgements.push(await command(controlPlane, 'regression.evaluate', 'flagship-evaluate-regression', {
  gateId, baseline: { runId: baselineRun.accepted.spec.runId, agentVariantId: baselineAgent.variantId },
  candidate: { runId: candidateRun.accepted.spec.runId, agentVariantId: candidateAgent.variantId },
  rules: { maxSuccessRateDropPp: 0, maxNewCriticalDefects: 0, maxTestGamingRate: 0, maxP95CostIncreasePct: 15, allowedFlakeRate: 0, confidenceLevel: 0.95 },
}))
const gate = controlPlane.projection.regressionDecisions.get(gateId)
if (!gate || gate.decision !== 'pass' || gate.pairedTasks !== 5 || gate.statistics?.pairedTies !== 5) throw new Error('flagship candidate did not produce the expected five-coordinate passing gate')
acknowledgements.push(await command(controlPlane, 'insight.record', 'flagship-record-insight', { insight }))
acknowledgements.push(await command(controlPlane, 'report.generate', 'flagship-generate-report', { reportId, runIds: [baselineRun.accepted.spec.runId, candidateRun.accepted.spec.runId], methodologyVersion: 'flagship-closed-loop-v1' }))

const beforeRestart = snapshot(controlPlane, finding.findingId, reproduction.bundleId, pack.packId, gateId, insight.insightId, reportId)
controlPlane = new EvaluationControlPlane({ journalPath, reportRoot: artifactRoot, taskCatalog: new RegisteredTaskCatalog() })
await controlPlane.initialize()
const afterRestart = snapshot(controlPlane, finding.findingId, reproduction.bundleId, pack.packId, gateId, insight.insightId, reportId)
if (canonicalJson(beforeRestart) !== canonicalJson(afterRestart) || Object.values(afterRestart).some((value) => value === false)) throw new Error('closed-loop resources did not survive Control Plane journal replay')
const replayedTransactions = await controlPlane.journal.readAll()
const audits = controlPlane.projection.auditRecords
if (audits.some((record, index) => record.sequence !== index || record.committedSequence !== index)) throw new Error('rewritten audit sequence is not contiguous and transaction-aligned')
for (const acknowledgement of acknowledgements) if (acknowledgement.projectionVersion !== acknowledgement.committedSequence + 1) throw new Error('closed-loop acknowledgement projection version mismatch')

const report = controlPlane.projection.reports.get(reportId)
if (!report || report.formats.length !== 7) throw new Error('flagship report does not contain all seven required formats')
for (const format of report.formats) await controlPlane.artifactStore.readReport(report, format.format)
const artifactSummary = await summarizeTree(artifactRoot)
const tenSteps = [
  { step: 1, name: 'three Agents selected', passed: baselineRun.accepted.spec.agents.map((agent) => agent.variantId).sort().join(',') === 'agent-runlab,claude-code,codex' },
  { step: 2, name: 'five-task public fault pack selected', passed: baselineRun.accepted.spec.taskPack.evaluatedSlice.selectedItems === 5 },
  { step: 3, name: 'isolated trials executed with concurrency', passed: baselineTrials.length === 15 && new Set(baselineTrials.map((trial) => trial.trialId)).size === 15 && baselineRun.accepted.spec.execution.maxConcurrency === 3 },
  { step: 4, name: 'native and normalized traces retained', passed: baselineTrials.every((trial) => trial.evidence.nativeEventsRef && trial.evidence.normalizedEventsRef) },
  { step: 5, name: 'native verifier passed all trials', passed: baselineTrials.every((trial) => trial.evidence.benchmarkResult.nativeMetrics.recovered === true) },
  { step: 6, name: 'recovery defect mined and recorded', passed: Boolean(controlPlane.projection.defects.get(finding.findingId)) },
  { step: 7, name: 'first divergence compared across three Agents', passed: Object.keys(traceDivergence).length === 3 && Object.values(traceDivergence).every((item) => Number.isInteger(item.firstObservationSequence)) },
  { step: 8, name: 'signed minimal reproduction verified', passed: reproduction.reproduction.reproduced >= 2 && reproduction.reproduction.minimization.minimizedUnits === 1 },
  { step: 9, name: 'defect promoted to regression pack', passed: Boolean(controlPlane.projection.regressionPacks.get(pack.packId)) },
  { step: 10, name: 'candidate rerun gated and insight validated', passed: gate.decision === 'pass' && controlPlane.projection.insights.get(insight.insightId)?.status === 'validated' },
]
for (const trial of baselineTrials) for (const path of [trial.evidence.nativeEventsRef, trial.evidence.normalizedEventsRef, trial.evidence.benchmarkResult.rawResultRef, trial.evidence.finalDiffRef]) await assertArtifactRef(trial, path, artifactRoot)
if (tenSteps.some((step) => !step.passed)) throw new Error('one or more flagship demo steps failed')

const evidence = {
  schemaVersion: 1, generatedAt: new Date().toISOString(),
  scope: 'fresh standalone LXD flagship runs merged into a new canonical Control Plane; no Host session, legacy artifact, compatibility shim, forwarding, or dual write',
  baseline: runEvidence(baselineRun, baselineTrials), candidate: runEvidence(candidateRun, candidateTrials),
  immutablePairing: { sliceManifestHash: baselineRun.accepted.spec.taskPack.evaluatedSlice.sliceManifestHash, taskIdsHash: baselineRun.accepted.spec.taskPack.evaluatedSlice.selectionSpec.taskIdsHash, repeats: 1, pairedCoordinates: gate.pairedTasks },
  journal: { importedTransactions: baselineTransactions.length + candidateTransactions.length, finalTransactions: replayedTransactions.length, auditRecords: audits.length, hashChainVerifiedAfterRestart: true, sha256: createHash('sha256').update(await readFile(journalPath)).digest('hex') },
  artifacts: { ...artifactSummary, importedFiles: mergeResults.reduce((total, result) => total + result.files, 0), reproductionFiles: reproduction.files.length, allReportFormatsVerified: true },
  finding, traceDivergence, reproduction: { bundleId: reproduction.bundleId, signedPayloadHash: reproduction.signedPayloadHash, signatureVerified: true, environmentLockHash, attempts: reproduction.reproduction.attempts.length, reproduced: reproduction.reproduction.reproduced, successControl: reproduction.reproduction.expectedSuccessControl.passed, minimization: reproduction.reproduction.minimization, privacy: reproduction.privacy },
  promotion: { packId: pack.packId, faultScenarioIds: pack.faultScenarioIds, baselineEvidenceRefs: pack.baselineEvidenceRefs },
  gate, insight, report, tenSteps, restartReplay: { ...afterRestart, verified: true }, acknowledgements,
  sourceHashes: await sourceHashes(['scripts/evaluation/run-real-task-pack.mjs', 'scripts/evaluation/verify-flagship-closed-loop.mjs', 'packages/eval-orchestrator/src/control-plane.ts', 'packages/eval-orchestrator/src/journal.ts']),
}
if (outputPath) { await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 }); await writeFile(outputPath, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 }) }
process.stdout.write(JSON.stringify({ ok: true, baselineRunId: baselineRun.accepted.spec.runId, candidateRunId: candidateRun.accepted.spec.runId, pairedTasks: gate.pairedTasks, ties: gate.statistics?.pairedTies, decision: gate.decision, transactions: replayedTransactions.length, tenSteps: tenSteps.length, output: outputPath }) + '\n')

async function rewriteJournal(transactions) {
  let previousHash = null
  let auditSequence = 0
  const output = []
  for (const [transactionSequence, source] of transactions.entries()) {
  const records = structuredClone(source.records).map((record) => {
      if (record.kind === 'audit.recorded') record.record = { ...record.record, sequence: auditSequence++, committedSequence: transactionSequence }
      if (record.kind === 'command.acknowledged') record.acknowledgement = { ...record.acknowledgement, committedSequence: transactionSequence, projectionVersion: transactionSequence + 1 }
      return record
    })
    const sourceLabel = transactionSequence < baselineTransactions.length ? 'baseline' : 'candidate'
    const unsigned = { schemaVersion: 1, transactionSequence, transactionId: sourceLabel + '-' + source.transactionId, committedAt: source.committedAt, previousHash, records }
    const transaction = JournalTransactionSchema.parse({ ...unsigned, transactionHash: await sha256Hex(canonicalJson(unsigned)) })
    output.push(transaction); previousHash = transaction.transactionHash
  }
  return output
}

async function mergeArtifactTree(sourceRoot, destinationRoot) {
  let files = 0; let bytes = 0
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const source = join(directory, entry.name)
      if (entry.isSymbolicLink()) throw new Error('artifact merge rejects symbolic links')
      if (entry.isDirectory()) await visit(source)
      else if (entry.isFile()) { const content = await readFile(source); await writeArtifactIdempotent(join(destinationRoot, relative(sourceRoot, source)), content); files += 1; bytes += content.byteLength }
      else throw new Error('artifact merge accepts regular files and directories only')
    }
  }
  await visit(sourceRoot)
  return { files, bytes }
}
async function writeArtifactIdempotent(path, content) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  try { await writeFile(path, content, { flag: 'wx', mode: 0o600 }) }
  catch (error) {
    if (error.code !== 'EEXIST') throw error
    const existing = await readFile(path)
    if (!existing.equals(Buffer.from(content))) throw new Error('artifact merge conflict: ' + path)
  }
}
function onlyRun(controlPlane, transactions) {
  const ids = transactions.flatMap((transaction) => transaction.records.filter((record) => record.kind === 'run.accepted').map((record) => record.accepted.spec.runId))
  if (ids.length !== 1) throw new Error('each flagship journal must contain exactly one run')
  const run = controlPlane.projection.runs.get(ids[0]); if (!run) throw new Error('merged flagship run is missing'); return run
}
function requiredAgent(run, variantId) { const agent = run.accepted.spec.agents.find((candidate) => candidate.variantId === variantId); if (!agent) throw new Error('run lacks Agent variant ' + variantId); return agent }
function trialsFor(controlPlane, runId) { return [...controlPlane.projection.trials.values()].filter((trial) => trial.runId === runId).sort((left, right) => left.trialId.localeCompare(right.trialId)) }
function requiredTrial(trials, taskId, agentVariantId) { const trial = trials.find((candidate) => candidate.taskId === taskId && candidate.agentVariantId === agentVariantId); if (!trial?.evidence) throw new Error('missing canonical source trial'); return trial }
function assertComparableRuns(baseline, candidate) {
  const left = baseline.accepted.spec; const right = candidate.accepted.spec
  if (left.taskPack.evaluatedSlice.sliceManifestHash !== right.taskPack.evaluatedSlice.sliceManifestHash || left.taskPack.evaluatedSlice.selectionSpec.taskIdsHash !== right.taskPack.evaluatedSlice.selectionSpec.taskIdsHash) throw new Error('baseline/candidate immutable evaluated slices differ')
  if (left.execution.repeats !== right.execution.repeats || left.verification.configHash !== right.verification.configHash) throw new Error('baseline/candidate repeat or verifier semantics differ')
}
async function mineTraceDivergence(trials, root, taskId) {
  const output = {}
  for (const agentVariantId of ['agent-runlab', 'claude-code', 'codex']) {
    const trial = requiredTrial(trials, taskId, agentVariantId)
    const lines = (await readFile(join(root, trial.evidence.normalizedEventsRef), 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    const observed = lines.find((event) => JSON.stringify(event.data).includes('CONFIG_SCHEMA_INVALID'))
    const recovered = lines.find((event) => {
      const value = JSON.stringify(event.data)
      return event.sequence > observed.sequence && (
        value.includes('\"name\":\"replace_in_file\"') || value.includes('\"name\":\"apply_file_patch\"') ||
        value.includes('\"name\":\"Edit\"') || value.includes('\"type\":\"fileChange\"') && value.includes('config/service.json')
      )
    })
    if (!observed || !recovered) throw new Error('could not mine observation/recovery divergence for ' + agentVariantId)
    output[agentVariantId] = { trialId: trial.trialId, firstObservationSequence: observed.sequence, firstRecoveryActionSequence: recovered.sequence, normalizedEventsRef: trial.evidence.normalizedEventsRef, nativeEventsRef: trial.evidence.nativeEventsRef, resultHash: trial.evidence.resultHash }
  }
  return output
}
async function command(controlPlane, type, id, body) { return await controlPlane.executeCommand({ schemaVersion: 1, type, commandId: id, idempotencyKey: id, submittedAt: new Date().toISOString(), ...body }) }
function snapshot(controlPlane, findingId, bundleId, packId, gateId, insightId, reportId) { return { finding: controlPlane.projection.defects.get(findingId)?.status === 'promoted', bundle: controlPlane.projection.reproductions.has(bundleId), pack: controlPlane.projection.regressionPacks.has(packId), gate: controlPlane.projection.regressionDecisions.has(gateId), insight: controlPlane.projection.insights.get(insightId)?.status === 'validated', report: controlPlane.projection.reports.has(reportId) } }
function runEvidence(run, trials) { return { runId: run.accepted.spec.runId, specHash: run.accepted.specHash, agents: run.accepted.spec.agents.map((agent) => agent.variantId), taskCount: run.accepted.spec.taskPack.evaluatedSlice.selectedItems, trialCount: trials.length, recovered: trials.filter((trial) => trial.evidence?.benchmarkResult.nativeMetrics.recovered === true).length, freshEnvironmentLocks: [...new Set(trials.map((trial) => canonicalJson(trial.evidence?.environmentLock)))].length, configHashes: Object.fromEntries(run.accepted.spec.agents.map((agent) => [agent.variantId, agent.configHash])) } }
async function summarizeTree(root) { let files = 0; let bytes = 0; async function visit(directory) { for (const entry of await readdir(directory, { withFileTypes: true })) { const path = join(directory, entry.name); if (entry.isDirectory()) await visit(path); else { const metadata = await stat(path); files += 1; bytes += metadata.size } } } await visit(root); return { files, bytes } }
async function assertArtifactRef(trial, path, root) { const entry = trial.evidence.artifactManifest.entries.find((candidate) => candidate.path === path); if (!entry) throw new Error('canonical artifact manifest lacks evidence ref: ' + path); const content = await readFile(join(root, path)); if (content.byteLength !== entry.bytes || createHash('sha256').update(content).digest('hex') !== entry.sha256) throw new Error('canonical evidence ref failed integrity check: ' + path) }
async function sourceHashes(paths) { return await Promise.all(paths.map(async (path) => ({ path, sha256: createHash('sha256').update(await readFile(resolve(workspaceRoot, path))).digest('hex') }))) }
function requiredPath(name) { const value = option(name); if (!value) throw new Error(name + ' is required'); return resolve(value) }
function option(name) { for (let index = 2; index < process.argv.length; index += 1) if (process.argv[index] === name) return process.argv[index + 1]; else if (process.argv[index]?.startsWith(name + '=')) return process.argv[index].slice(name.length + 1) }
