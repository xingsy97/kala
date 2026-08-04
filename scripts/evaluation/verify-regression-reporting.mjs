#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'

import { ProductInsightSchema, acceptEvaluationRunSpec, canonicalJson, sha256Hex } from '../../packages/eval-protocol/dist/index.js'
import { decideRegressionGate, generateEvaluationReport } from '../../packages/eval-orchestrator/dist/src/index.js'

const runFile = promisify(execFile)
const root = resolve(new URL('../..', import.meta.url).pathname)
const temporary = await mkdtemp(join(tmpdir(), 'agent-eval-regression-reporting-'))
const testReportPath = join(temporary, 'vitest.json')

try {
  await runFile('pnpm', ['--dir', 'packages/eval-orchestrator', 'exec', 'vitest', 'run', 'src/regression-gate.test.ts', 'src/report-generator.test.ts', 'src/control-plane.test.ts', '--reporter=json', '--outputFile=' + testReportPath], { cwd: root, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024 })
  const testReport = JSON.parse(await readFile(testReportPath, 'utf8'))
  const assertions = testReport.testResults.flatMap((file) => file.assertionResults)
  const requiredTests = [
    'blocks a deterministic success regression with paired statistics',
    'classifies flakes and infrastructure failures as indeterminate instead of deterministic Agent regression',
    'passes matched improvements without fabricating unmatched comparisons',
    'deterministically generates all seven formats and all ten report sections',
    'rejects missing configured repeats and modified evidence hashes',
    'rejects private absolute paths before producing public report files',
    'durably controls defect promotion, reproduction, regression, reports, insights, and immutable audit',
  ].map((title) => requiredAssertion(assertions, title))

  const rules = { maxSuccessRateDropPp: 2, maxNewCriticalDefects: 0, maxTestGamingRate: 0, maxP95CostIncreasePct: 15, allowedFlakeRate: 0.5, confidenceLevel: 0.95 }
  const regression = {
    blocked: decideRegressionGate({ gateId: 'release-block', baselineConfigHash: 'a'.repeat(64), candidateConfigHash: 'b'.repeat(64), observations: [pair('one', true, false), pair('two', true, true), pair('three', true, true)], rules }),
    improved: decideRegressionGate({ gateId: 'release-improvement', baselineConfigHash: 'a'.repeat(64), candidateConfigHash: 'c'.repeat(64), observations: [pair('one', false, true), pair('two', true, true), pair('three', true, true)], rules }),
    flakeAware: decideRegressionGate({ gateId: 'release-flake-aware', baselineConfigHash: 'a'.repeat(64), candidateConfigHash: 'd'.repeat(64), observations: [pair('stable', true, true, 0), pair('stable', true, true, 1), pair('flaky', true, true, 0), pair('flaky', false, true, 1)], rules }),
  }
  if (regression.blocked.decision !== 'block' || regression.improved.decision !== 'pass' || regression.flakeAware.decision !== 'pass' || !regression.flakeAware.flakyTasks.includes('flaky')) throw new Error('seeded regression decisions did not cover block, improvement, and non-blocking flake classification')
  for (const decision of Object.values(regression)) {
    const statistics = decision.statistics
    if (!statistics || statistics.confidenceInterval?.method !== 'paired-bootstrap' || statistics.confidenceInterval.samples !== 10_000 || typeof statistics.mcnemarPValue !== 'number' || !statistics.repeatedRunVariance || !statistics.evidenceCompleteness || !statistics.pareto || !Array.isArray(statistics.taskDeltas)) throw new Error('regression decision lacks required statistical methodology evidence')
  }

  const { accepted, trials } = await reportFixtures()
  const input = { reportId: 'release-reporting-acceptance', methodologyVersion: '1.0.0', generatedAt: '2026-08-03T04:00:00.000Z', runs: [{ accepted, trials }], regressionDecisions: Object.values(regression) }
  const first = await generateEvaluationReport(input)
  const second = await generateEvaluationReport({ ...input, runs: [{ accepted, trials: [...trials].reverse() }], regressionDecisions: [...Object.values(regression)].reverse() })
  if (canonicalJson(first.manifest) !== canonicalJson(second.manifest)) throw new Error('report manifest changed when immutable inputs were reordered')
  for (const firstFile of first.files) {
    const secondFile = second.files.find((candidate) => candidate.format === firstFile.format)
    if (!secondFile || !Buffer.from(firstFile.content).equals(Buffer.from(secondFile.content))) throw new Error('report format is not deterministic: ' + firstFile.format)
  }
  const formats = Object.fromEntries(first.files.map((file) => [file.format, new TextDecoder().decode(file.content)]))
  const jsonReport = JSON.parse(formats.json)
  const formatChecks = {
    json: jsonReport.inputEvidenceHash === first.manifest.inputEvidenceHash,
    csv: formats.csv.startsWith('runId,trialId,taskId,repeatIndex') && formats.csv.trimEnd().split('\n').length === trials.length + 1,
    html: count(formats.html, '<h2>') === 10 && formats.html.includes('@media print'),
    pdf: formats.pdf.startsWith('%PDF-1.4') && formats.pdf.endsWith('%%EOF\n'),
    junit: formats.junit.includes('<testsuites tests="6" failures="0">') && count(formats.junit, '<testcase ') === trials.length,
    sarif: JSON.parse(formats.sarif).version === '2.1.0',
    markdown: Array.from({ length: 10 }, (_, index) => '## ' + String(index + 1) + '.').every((heading) => formats.markdown.includes(heading)),
  }
  if (Object.values(formatChecks).some((passed) => !passed)) throw new Error('one or more report format validations failed: ' + JSON.stringify(formatChecks))
  if (!Array.isArray(jsonReport.capabilityVectors) || jsonReport.capabilityVectors.length === 0 || Object.keys(jsonReport.capabilityVectors[0].components ?? {}).length !== 11) throw new Error('report JSON lacks the eleven-component capability vector')
  if (!formats.html.includes('Capability Breakdown') || !formats.markdown.includes('Capability Breakdown') || !formats.pdf.includes('Capability Breakdown')) throw new Error('human-readable reports lack capability breakdown content')
  const insight = ProductInsightSchema.parse({ schemaVersion: 1, insightId: 'release-insight', evidenceRefs: ['finding-tool-recovery', regression.improved.gateId], failureCluster: 'tool recovery after ambiguous action', affectedTaskRate: 1 / 3, severity: 'high', suspectedLayer: 'runtime', confidence: 0.95, recommendation: 'require an observed-state check before replay', expectedMetric: 'paired success-rate delta', regressionPackId: 'release-regression-pack', owner: 'agent-platform', status: 'validated', postFixValidationRefs: [regression.improved.gateId], postFixCandidateRunId: 'canonical-eval-run', postFixGateId: regression.improved.gateId })

  const evidence = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    scope: 'fresh standalone seeded baseline/candidate decisions and deterministic immutable report generation; no Host sessions or historical evaluation artifacts',
    regression,
    methodology: { pairedBootstrapSamples: 10_000, mcnemar: true, repeatedRunVariance: true, evidenceCompleteness: true, taskDeltas: true, pareto: true },
    capabilityVector: { components: Object.keys(jsonReport.capabilityVectors[0].components), evidenceLinked: Object.values(jsonReport.capabilityVectors[0].components).every((component) => component.methodologyRef && component.evidenceRefs?.length > 0) },
    report: { manifest: first.manifest, formatChecks, deterministicAcrossInputOrder: true, formatBytes: Object.fromEntries(first.files.map((file) => [file.format, file.content.byteLength])) },
    durableClosedLoop: { promotionReportInsightAuditTest: requiredTests.at(-1), insight },
    tests: requiredTests,
    sourceHashes: await sourceHashes([
      'packages/eval-orchestrator/src/regression-gate.ts', 'packages/eval-orchestrator/src/regression-gate.test.ts',
      'packages/eval-orchestrator/src/report-generator.ts', 'packages/eval-orchestrator/src/report-generator.test.ts',
      'packages/eval-orchestrator/src/capability-vector.ts', 'packages/eval-orchestrator/src/capability-vector.test.ts',
      'packages/eval-orchestrator/src/control-plane.ts', 'packages/eval-orchestrator/src/control-plane.test.ts',
      'scripts/evaluation/verify-regression-reporting.mjs',
    ]),
  }
  const output = option('--output')
  if (output) {
    const path = resolve(output)
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeFile(path, JSON.stringify(evidence, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  }
  process.stdout.write(JSON.stringify({ ok: true, decisions: Object.fromEntries(Object.entries(regression).map(([name, decision]) => [name, decision.decision])), formats: Object.keys(formatChecks), tests: requiredTests.length, output: output ? resolve(output) : undefined }) + '\n')
} finally {
  await rm(temporary, { recursive: true, force: true })
}

function pair(taskId, baseline, candidate, repeatIndex = 0) {
  return { taskId, repeatIndex, baseline: { passed: baseline, costUsd: 1, evidenceRef: 'baseline:' + taskId + ':' + String(repeatIndex) }, candidate: { passed: candidate, costUsd: 1, evidenceRef: 'candidate:' + taskId + ':' + String(repeatIndex) } }
}

async function reportFixtures() {
  const spec = JSON.parse(await readFile(join(root, 'packages/eval-protocol/fixtures/canonical-run-spec-v1.json'), 'utf8'))
  const template = JSON.parse(await readFile(join(root, 'packages/eval-protocol/fixtures/canonical-trial-result-v1.json'), 'utf8'))
  const accepted = await acceptEvaluationRunSpec(spec, '2026-08-03T00:00:01.000Z')
  const trials = []
  for (const taskId of ['task-one', 'task-two']) for (let repeatIndex = 0; repeatIndex < 3; repeatIndex += 1) trials.push(await trialEvidence(template, taskId, repeatIndex))
  return { accepted, trials }
}

async function trialEvidence(template, taskId, repeatIndex) {
  const output = structuredClone(template)
  const oldTrialId = output.trialId
  output.trialId = output.runId + ':' + taskId + ':' + output.agentVariantId + ':' + String(repeatIndex)
  output.taskId = taskId
  output.repeatIndex = repeatIndex
  output.artifactManifest.trialId = output.trialId
  output.artifactManifest.leaseId = 'release-lease-' + taskId + '-' + String(repeatIndex)
  for (const entry of output.artifactManifest.entries) entry.path = entry.path.replace(oldTrialId, output.trialId)
  for (const key of ['nativeEventsRef', 'normalizedEventsRef', 'analyzerInputRef', 'finalDiffRef', 'stdoutRef', 'stderrRef']) output[key] = output[key].replace(oldTrialId, output.trialId)
  output.benchmarkResult.rawResultRef = output.benchmarkResult.rawResultRef.replace(oldTrialId, output.trialId)
  const { manifestHash: _oldManifestHash, signature: _signature, ...manifest } = output.artifactManifest
  output.artifactManifest.manifestHash = await sha256Hex(canonicalJson(manifest))
  const { resultHash: _oldResultHash, ...result } = output
  output.resultHash = await sha256Hex(canonicalJson(result))
  return output
}

function requiredAssertion(assertions, title) {
  const matches = assertions.filter((assertion) => assertion.title === title)
  if (matches.length !== 1 || matches[0].status !== 'passed') throw new Error('required test did not pass exactly once: ' + title)
  return { test: matches[0].fullName, status: matches[0].status, durationMs: matches[0].duration }
}
function count(value, needle) { return value.split(needle).length - 1 }
async function sourceHashes(paths) { return await Promise.all(paths.map(async (path) => ({ path, sha256: createHash('sha256').update(await readFile(resolve(root, path))).digest('hex') }))) }
function option(name) { for (let index = 2; index < process.argv.length; index += 1) if (process.argv[index] === name) return process.argv[index + 1]; else if (process.argv[index]?.startsWith(name + '=')) return process.argv[index].slice(name.length + 1) }
