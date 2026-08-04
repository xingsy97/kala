import {
  CanonicalReportModelSchema, ReportManifestSchema, canonicalJson, findPlaintextCredentialPaths, reportSemanticHash, sha256Hex,
  verifyAcceptedEvaluationRunSpec, verifyTrialEvidence,
  type AcceptedEvaluationRunSpec, type CapabilityVector, type DefectFinding, type ProductInsight,
  type CanonicalReportModel, type CanonicalReportRun, type CanonicalReportTrial, type RegressionGateDecision, type ReportFormat, type ReportManifest,
  type ReproductionBundle, type TrialEvidence,
} from '@agent-kernel/eval-protocol'
import { deriveCapabilityVector } from './capability-vector.js'

export type ImmutableReportRun = {
  accepted: AcceptedEvaluationRunSpec
  trials: readonly TrialEvidence[]
}

export type ReportGenerationInput = {
  reportId: string
  methodologyVersion: string
  generatedAt: string
  runs: readonly ImmutableReportRun[]
  defects?: readonly DefectFinding[]
  reproductions?: readonly ReproductionBundle[]
  regressionDecisions?: readonly RegressionGateDecision[]
  insights?: readonly ProductInsight[]
}

export type GeneratedReportFile = {
  format: ReportFormat
  path: string
  mediaType: string
  content: Uint8Array
}

export type GeneratedReport = { manifest: ReportManifest; files: readonly GeneratedReportFile[] }

type TrialRow = CanonicalReportTrial
type ReportModel = CanonicalReportModel
type RunSummary = CanonicalReportRun

const SECTIONS = [
  'Executive Summary', 'Run and Environment Identity', 'Native Benchmark Results', 'Capability Breakdown',
  'Paired Agent Comparison', 'Cost, Latency, and Reliability', 'Failure Taxonomy',
  'Top Regressions and Improvements', 'Defect/Reproduction Index', 'Methodology, Confidence, and Limitations',
] as const

const encoder = new TextEncoder()

export async function generateEvaluationReport(input: ReportGenerationInput): Promise<GeneratedReport> {
  if (input.runs.length === 0) throw new Error('report requires at least one immutable run')
  const verifiedRuns: ImmutableReportRun[] = []
  for (const source of input.runs) {
    const accepted = await verifyAcceptedEvaluationRunSpec(source.accepted)
    const trials: TrialEvidence[] = []
    for (const evidence of source.trials) trials.push(await verifyTrialEvidence(evidence))
    assertCompleteRun(accepted, trials)
    trials.sort(compareEvidence)
    verifiedRuns.push({ accepted, trials })
  }
  verifiedRuns.sort((left, right) => left.accepted.spec.runId.localeCompare(right.accepted.spec.runId))
  const immutableInput = {
    runs: verifiedRuns, defects: sorted(input.defects ?? [], 'findingId'), reproductions: sorted(input.reproductions ?? [], 'bundleId'),
    regressionDecisions: sorted(input.regressionDecisions ?? [], 'gateId'), insights: sorted(input.insights ?? [], 'insightId'),
    methodologyVersion: input.methodologyVersion,
  }
  if (findPlaintextCredentialPaths(immutableInput).length > 0) throw new Error('report input contains a plaintext credential-like field')
  assertNoPrivateMaterial(immutableInput)
  const inputEvidenceHash = await sha256Hex(canonicalJson(immutableInput))
  const draft = buildModel(input, verifiedRuns, immutableInput, inputEvidenceHash)
  const model = CanonicalReportModelSchema.parse({ ...draft, semanticHash: await reportSemanticHash(draft) })
  const base = 'reports/' + safeId(input.reportId) + '/report'
  const files: GeneratedReportFile[] = [
    textFile('json', base + '.json', 'application/json', JSON.stringify(model, null, 2) + '\n'),
    textFile('csv', base + '.csv', 'text/csv; charset=utf-8', renderCsv(model)),
    textFile('html', base + '.html', 'text/html; charset=utf-8', renderHtml(model)),
    { format: 'pdf', path: base + '.pdf', mediaType: 'application/pdf', content: renderPdf(model) },
    textFile('junit', base + '.junit.xml', 'application/junit+xml', renderJunit(model)),
    textFile('sarif', base + '.sarif.json', 'application/sarif+json', renderSarif(model)),
    textFile('markdown', base + '.md', 'text/markdown; charset=utf-8', renderMarkdown(model)),
  ]
  assertPublicOutput(files)
  const formats = await Promise.all(files.map(async (file) => ({ format: file.format, path: file.path, sha256: await sha256Hex(file.content) })))
  const manifest = ReportManifestSchema.parse({
    schemaVersion: 1, reportId: input.reportId, inputEvidenceHash, semanticHash: model.semanticHash, runRefs: model.runRefs, formats,
    methodologyVersion: input.methodologyVersion, includesAllConfiguredRepeats: true, redactionPassed: true, generatedAt: input.generatedAt,
  })
  return { manifest, files }
}

function assertCompleteRun(accepted: AcceptedEvaluationRunSpec, trials: readonly TrialEvidence[]): void {
  const spec = accepted.spec
  const taskIds = [...new Set(trials.map((trial) => trial.taskId))].sort()
  if (taskIds.length !== spec.taskPack.evaluatedSlice.selectedItems) throw new Error('report evidence task coverage does not match immutable evaluated slice for ' + spec.runId)
  const expected = spec.taskPack.evaluatedSlice.selectedItems * spec.agents.length * spec.execution.repeats
  if (trials.length !== expected) throw new Error('report evidence does not include every configured trial for ' + spec.runId)
  const observed = new Set<string>()
  for (const trial of trials) {
    if (trial.runId !== spec.runId) throw new Error('report trial references the wrong run: ' + trial.trialId)
    const agent = spec.agents.find((candidate) => candidate.variantId === trial.agentVariantId)
    if (!agent) throw new Error('report trial references an undeclared Agent variant: ' + trial.agentVariantId)
    if (trial.repeatIndex >= spec.execution.repeats) throw new Error('report trial repeat exceeds configured repeats: ' + trial.trialId)
    if (trial.environmentLock.provider !== spec.sandbox.provider || trial.environmentLock.imageDigest !== spec.sandbox.imageDigest) throw new Error('report trial environment differs from immutable run spec: ' + trial.trialId)
    if (trial.benchmarkResult.verifierId !== spec.verification.verifierId || trial.benchmarkResult.verifierVersion !== spec.verification.verifierVersion) throw new Error('report trial verifier differs from immutable run spec: ' + trial.trialId)
    const key = [trial.taskId, trial.agentVariantId, trial.repeatIndex].join('|')
    if (observed.has(key)) throw new Error('duplicate report trial coordinate: ' + key)
    observed.add(key)
  }
  for (const taskId of taskIds) for (const agent of spec.agents) for (let repeat = 0; repeat < spec.execution.repeats; repeat += 1) {
    const key = [taskId, agent.variantId, repeat].join('|')
    if (!observed.has(key)) throw new Error('missing configured report trial coordinate: ' + key)
  }
}

function buildModel(input: ReportGenerationInput, runs: readonly ImmutableReportRun[], immutable: { defects: readonly DefectFinding[]; reproductions: readonly ReproductionBundle[]; regressionDecisions: readonly RegressionGateDecision[]; insights: readonly ProductInsight[] }, inputEvidenceHash: string): ReportModel {
  const trials = runs.flatMap(({ accepted, trials: evidence }) => evidence.map((trial) => trialRow(accepted, trial))).sort(compareRows)
  const capabilityVectors = runs.flatMap(({ accepted, trials: evidence }) => accepted.spec.agents.map((agent) => deriveCapabilityVector({
    runId: accepted.spec.runId, agentVariantId: agent.variantId, methodologyVersion: input.methodologyVersion,
    trials: evidence.filter((trial) => trial.agentVariantId === agent.variantId), findings: immutable.defects.filter((finding) => finding.runId === accepted.spec.runId),
  }))).sort((left, right) => left.runId.localeCompare(right.runId) || left.agentVariantId.localeCompare(right.agentVariantId))
  const summaries = runs.map(({ accepted, trials: evidence }): RunSummary => ({
    runId: accepted.spec.runId, specHash: accepted.specHash, dataset: accepted.spec.taskPack.evaluatedSlice.dataset.displayName,
    datasetVersion: accepted.spec.taskPack.evaluatedSlice.dataset.version, sliceId: accepted.spec.taskPack.evaluatedSlice.sliceId,
    sliceManifestHash: accepted.spec.taskPack.evaluatedSlice.sliceManifestHash, selectedItems: accepted.spec.taskPack.evaluatedSlice.selectedItems,
    repeats: accepted.spec.execution.repeats, expectedTrials: accepted.spec.taskPack.evaluatedSlice.selectedItems * accepted.spec.agents.length * accepted.spec.execution.repeats,
    completedTrials: evidence.length, agents: accepted.spec.agents.map((agent) => agent.variantId).sort(), sandboxProvider: accepted.spec.sandbox.provider,
    imageDigest: accepted.spec.sandbox.imageDigest, verifier: accepted.spec.verification.verifierId + '@' + accepted.spec.verification.verifierVersion,
  }))
  return {
    schemaVersion: 1, reportId: input.reportId, generatedAt: input.generatedAt, methodologyVersion: input.methodologyVersion, inputEvidenceHash, semanticHash: '0'.repeat(64),
    runRefs: summaries.map((run) => run.runId), sections: [...SECTIONS], runs: summaries, trials, capabilityVectors, defects: [...immutable.defects],
    reproductions: [...immutable.reproductions], regressionDecisions: [...immutable.regressionDecisions], insights: [...immutable.insights],
    limitations: ['Metrics retain benchmark-native semantics and are not combined into a universal score.', 'Confidence depends on configured task coverage and repeat count.', 'This report contains redacted metadata and immutable evidence references, not raw private workspace content.'],
  }
}

function trialRow(accepted: AcceptedEvaluationRunSpec, trial: TrialEvidence): TrialRow {
  const agent = accepted.spec.agents.find((candidate) => candidate.variantId === trial.agentVariantId)!
  const metric = primaryMetric(trial.benchmarkResult.nativeMetrics)
  return {
    runId: trial.runId, trialId: trial.trialId, taskId: trial.taskId, repeatIndex: trial.repeatIndex, agentVariantId: trial.agentVariantId,
    backendId: agent.backendId, model: agent.model.modelId, benchmarkId: trial.benchmarkResult.benchmarkId,
    verifier: trial.benchmarkResult.verifierId + '@' + trial.benchmarkResult.verifierVersion, evidenceLevel: trial.evidenceLevel,
    primaryMetric: metric.name, primaryValue: metric.value, passed: metricPassed(metric.value),
    inputTokens: trial.usage.availability === 'available' ? trial.usage.inputTokens : null,
    outputTokens: trial.usage.availability === 'available' ? trial.usage.outputTokens : null,
    costUsd: trial.usage.availability === 'available' ? trial.usage.costUsd ?? null : null, resultHash: trial.resultHash,
    artifactManifestHash: trial.artifactManifest.manifestHash,
  }
}

function primaryMetric(metrics: Readonly<Record<string, number | string | boolean>>): { name: string; value: number | string | boolean } {
  const names = Object.keys(metrics).sort()
  const name = ['resolved', 'passed', 'reward', 'compile_passed', 'journey_completed', ...names].find((candidate) => candidate in metrics)
  if (!name) throw new Error('trial contains no native benchmark metric')
  return { name, value: metrics[name]! }
}

function metricPassed(value: number | string | boolean): boolean { return value === true || typeof value === 'number' && value > 0 || typeof value === 'string' && /^(?:pass|passed|success|resolved)$/iu.test(value) }
function compareRows(left: TrialRow, right: TrialRow): number { return left.runId.localeCompare(right.runId) || left.taskId.localeCompare(right.taskId) || left.agentVariantId.localeCompare(right.agentVariantId) || left.repeatIndex - right.repeatIndex || left.trialId.localeCompare(right.trialId) }
function compareEvidence(left: TrialEvidence, right: TrialEvidence): number { return left.taskId.localeCompare(right.taskId) || left.agentVariantId.localeCompare(right.agentVariantId) || left.repeatIndex - right.repeatIndex || left.trialId.localeCompare(right.trialId) }
function sorted<T extends object, K extends keyof T>(values: readonly T[], key: K): T[] { return [...values].sort((left, right) => String(left[key]).localeCompare(String(right[key]))) }
function safeId(value: string): string { return value.replace(/[^A-Za-z0-9._:-]/gu, '-').slice(0, 120) }
function textFile(format: ReportFormat, path: string, mediaType: string, content: string): GeneratedReportFile { return { format, path, mediaType, content: encoder.encode(content) } }

function renderCsv(model: ReportModel): string {
  const columns: (keyof TrialRow)[] = ['runId', 'trialId', 'taskId', 'repeatIndex', 'agentVariantId', 'backendId', 'model', 'benchmarkId', 'verifier', 'evidenceLevel', 'primaryMetric', 'primaryValue', 'passed', 'inputTokens', 'outputTokens', 'costUsd', 'resultHash', 'artifactManifestHash']
  return [columns.join(','), ...model.trials.map((row) => columns.map((column) => csv(row[column])).join(','))].join('\n') + '\n'
}

function renderHtml(model: ReportModel): string {
  const rows = model.trials.map((trial) => '<tr><td>' + html(trial.runId) + '</td><td>' + html(trial.taskId) + '</td><td>' + html(trial.agentVariantId) + '</td><td>' + String(trial.repeatIndex) + '</td><td>' + html(trial.primaryMetric) + '</td><td>' + html(String(trial.primaryValue)) + '</td><td>' + (trial.passed ? 'pass' : 'fail') + '</td></tr>').join('')
  const runRows = model.runs.map((run) => '<tr><td>' + html(run.runId) + '</td><td>' + html(run.dataset + '@' + run.datasetVersion) + '</td><td>' + html(run.sliceId) + '</td><td>' + String(run.completedTrials) + '/' + String(run.expectedTrials) + '</td><td>' + html(run.sandboxProvider) + '</td><td>' + html(run.verifier) + '</td></tr>').join('')
  const outcomes = model.trials.filter((trial) => trial.passed).length
  const capabilityRows = model.capabilityVectors.flatMap((vector) => Object.entries(vector.components).map(([name, component]) => '<tr><td>' + html(vector.runId) + '</td><td>' + html(vector.agentVariantId) + '</td><td>' + html(name) + '</td><td>' + component.score.toFixed(4) + '</td><td><a href="' + html(component.methodologyRef) + '">methodology</a></td><td>' + html([...component.detectorIds, ...component.verifierIds].join(', ')) + '</td><td>' + String(component.evidenceRefs.length) + '</td></tr>')).join('')
  const comparison = comparisonSummary(model.regressionDecisions)
  const sections = [
    '<section><h2>1. Executive Summary</h2><p>' + String(outcomes) + ' of ' + String(model.trials.length) + ' trial outcomes passed their native primary metric.</p></section>',
    '<section><h2>2. Run and Environment Identity</h2><table><thead><tr><th>Run</th><th>Dataset</th><th>Slice</th><th>Coverage</th><th>Sandbox</th><th>Verifier</th></tr></thead><tbody>' + runRows + '</tbody></table></section>',
    '<section><h2>3. Native Benchmark Results</h2><table><thead><tr><th>Run</th><th>Task</th><th>Agent</th><th>Repeat</th><th>Metric</th><th>Value</th><th>Outcome</th></tr></thead><tbody>' + rows + '</tbody></table></section>',
    '<section><h2>4. Capability Breakdown</h2><table><thead><tr><th>Run</th><th>Agent</th><th>Component</th><th>Score</th><th>Methodology</th><th>Detector / verifier</th><th>Evidence refs</th></tr></thead><tbody>' + capabilityRows + '</tbody></table></section>',
    '<section><h2>5. Paired Agent Comparison</h2><p>' + html(comparison.paired) + '</p></section>',
    '<section><h2>6. Cost, Latency, and Reliability</h2><p>' + html(usageSummary(model.trials) + ' ' + comparison.costLatency) + '</p></section>',
    '<section><h2>7. Failure Taxonomy</h2><p>' + String(model.defects.length) + ' defect findings are linked to immutable trial evidence.</p></section>',
    '<section><h2>8. Top Regressions and Improvements</h2><p>' + String(model.regressionDecisions.length) + ' regression decisions are included.</p></section>',
    '<section><h2>9. Defect/Reproduction Index</h2><p>' + String(model.reproductions.length) + ' verified reproduction bundles are included.</p></section>',
    '<section><h2>10. Methodology, Confidence, and Limitations</h2><p>Methodology ' + html(model.methodologyVersion) + '.</p><ul>' + model.limitations.map((value) => '<li>' + html(value) + '</li>').join('') + '</ul></section>',
  ].join('')
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Evaluation report ' + html(model.reportId) + '</title><style>body{font:15px/1.5 system-ui,sans-serif;color:#17202a;max-width:1120px;margin:auto;padding:2rem}h1,h2{color:#123b5d}table{border-collapse:collapse;width:100%;font-size:.88rem}th,td{border:1px solid #bbc8d2;padding:.4rem;text-align:left;overflow-wrap:anywhere}th{background:#e9f0f5}@media print{body{max-width:none;padding:0}thead{display:table-header-group}tr{break-inside:avoid}h2{break-after:avoid}a{color:inherit}}</style></head><body><header><h1>Agent Evaluation Report</h1><p>Report ' + html(model.reportId) + ' · generated ' + html(model.generatedAt) + ' · evidence ' + html(model.inputEvidenceHash) + ' · semantic ' + html(model.semanticHash) + '</p></header>' + sections + '</body></html>\n'
}

function renderMarkdown(model: ReportModel): string {
  const passes = model.trials.filter((trial) => trial.passed).length
  const runs = model.runs.map((run) => '| ' + md(run.runId) + ' | ' + md(run.dataset + '@' + run.datasetVersion) + ' | ' + md(run.sliceId) + ' | ' + String(run.completedTrials) + '/' + String(run.expectedTrials) + ' | ' + md(run.verifier) + ' |').join('\n')
  const trials = model.trials.map((trial) => '| ' + md(trial.runId) + ' | ' + md(trial.taskId) + ' | ' + md(trial.agentVariantId) + ' | ' + String(trial.repeatIndex) + ' | ' + md(trial.primaryMetric) + ' | ' + md(String(trial.primaryValue)) + ' | ' + (trial.passed ? 'pass' : 'fail') + ' |').join('\n')
  const capabilities = model.capabilityVectors.flatMap((vector) => Object.entries(vector.components).map(([name, component]) => '| ' + md(vector.runId) + ' | ' + md(vector.agentVariantId) + ' | ' + md(name) + ' | ' + component.score.toFixed(4) + ' | ' + md(component.methodologyRef) + ' | ' + md([...component.detectorIds, ...component.verifierIds].join(', ')) + ' | ' + String(component.evidenceRefs.length) + ' |')).join('\n')
  const comparison = comparisonSummary(model.regressionDecisions)
  return '# Agent Evaluation Report\n\nReport ' + code(model.reportId) + ' · generated ' + model.generatedAt + ' · evidence ' + code(model.inputEvidenceHash) + '\n\n' +
    '## 1. Executive Summary\n\n' + String(passes) + ' of ' + String(model.trials.length) + ' trial outcomes passed their native primary metric.\n\n' +
    '## 2. Run and Environment Identity\n\n| Run | Dataset | Slice | Coverage | Verifier |\n|---|---|---|---:|---|\n' + runs + '\n\n' +
    '## 3. Native Benchmark Results\n\n| Run | Task | Agent | Repeat | Metric | Value | Outcome |\n|---|---|---|---:|---|---:|---|\n' + trials + '\n\n' +
    '## 4. Capability Breakdown\n\n| Run | Agent | Component | Score | Methodology | Detector / verifier | Evidence refs |\n|---|---|---|---:|---|---|---:|\n' + capabilities + '\n\n' +
    '## 5. Paired Agent Comparison\n\n' + comparison.paired + '\n\n' +
    '## 6. Cost, Latency, and Reliability\n\n' + usageSummary(model.trials) + ' ' + comparison.costLatency + '\n\n' +
    '## 7. Failure Taxonomy\n\n' + String(model.defects.length) + ' evidence-backed defect findings.\n\n' +
    '## 8. Top Regressions and Improvements\n\n' + String(model.regressionDecisions.length) + ' regression decisions.\n\n' +
    '## 9. Defect/Reproduction Index\n\n' + String(model.reproductions.length) + ' verified reproduction bundles.\n\n' +
    '## 10. Methodology, Confidence, and Limitations\n\nMethodology ' + code(model.methodologyVersion) + '.\n\n' + model.limitations.map((value) => '- ' + value).join('\n') + '\n'
}

function renderJunit(model: ReportModel): string {
  const failures = model.trials.filter((trial) => !trial.passed).length
  const cases = model.trials.map((trial) => {
    const name = trial.taskId + ' repeat ' + String(trial.repeatIndex)
    const failure = trial.passed ? '' : '<failure type="native-verifier-failure" message="Native primary metric did not pass">' + xml(trial.primaryMetric + '=' + String(trial.primaryValue) + '; evidence=' + trial.resultHash) + '</failure>'
    return '<testcase classname="' + xml(trial.runId + '.' + trial.agentVariantId) + '" name="' + xml(name) + '">' + failure + '<system-out>' + xml('resultHash=' + trial.resultHash + '; artifactManifestHash=' + trial.artifactManifestHash) + '</system-out></testcase>'
  }).join('')
  return '<?xml version="1.0" encoding="UTF-8"?>\n<testsuites tests="' + String(model.trials.length) + '" failures="' + String(failures) + '"><testsuite name="agent-evaluation" tests="' + String(model.trials.length) + '" failures="' + String(failures) + '">' + cases + '</testsuite></testsuites>\n'
}

function renderSarif(model: ReportModel): string {
  const rules = [...new Map(model.defects.map((finding) => [finding.detectorId, { id: finding.detectorId, name: finding.category, shortDescription: { text: finding.category.replaceAll('_', ' ') }, properties: { detectorVersion: finding.detectorVersion } }])).values()]
  const results = model.defects.map((finding) => ({ ruleId: finding.detectorId, level: sarifLevel(finding.severity), message: { text: finding.category + ' finding ' + finding.findingId }, properties: { runId: finding.runId, trialId: finding.trialId, confidence: finding.confidence, evidenceRefs: finding.evidenceRefs } }))
  return JSON.stringify({ version: '2.1.0', $schema: 'https://json.schemastore.org/sarif-2.1.0.json', runs: [{ tool: { driver: { name: 'Agent Evaluation Platform', semanticVersion: model.methodologyVersion, rules } }, results, properties: { reportId: model.reportId, inputEvidenceHash: model.inputEvidenceHash } }] }, null, 2) + '\n'
}

function renderPdf(model: ReportModel): Uint8Array {
  const passCount = model.trials.filter((trial) => trial.passed).length
  const lines = ['Agent Evaluation Report', 'Report: ' + model.reportId, 'Generated: ' + model.generatedAt, 'Evidence: ' + model.inputEvidenceHash, '',
    '1. Executive Summary', String(passCount) + ' of ' + String(model.trials.length) + ' trials passed.',
    '2. Run and Environment Identity', ...model.runs.flatMap((run) => [run.runId + ' ' + run.dataset + '@' + run.datasetVersion, run.sandboxProvider + ' ' + run.verifier]),
    '3. Native Benchmark Results', ...model.trials.map((trial) => trial.trialId + ' ' + trial.taskId + ' ' + trial.agentVariantId + ' r' + String(trial.repeatIndex) + ' ' + trial.primaryMetric + '=' + String(trial.primaryValue)),
    '4. Capability Breakdown', ...model.capabilityVectors.flatMap((vector) => Object.entries(vector.components).map(([name, component]) => vector.agentVariantId + ' ' + name + '=' + component.score.toFixed(3))), '5. Paired Agent Comparison', comparisonSummary(model.regressionDecisions).paired,
    '6. Cost, Latency, and Reliability', usageSummary(model.trials) + ' ' + comparisonSummary(model.regressionDecisions).costLatency, '7. Failure Taxonomy', String(model.defects.length) + ' findings.',
    '8. Top Regressions and Improvements', String(model.regressionDecisions.length) + ' decisions.', '9. Defect/Reproduction Index', String(model.reproductions.length) + ' bundles.',
    '10. Methodology, Confidence, and Limitations', 'Methodology ' + model.methodologyVersion, ...model.limitations]
  const wrapped = lines.flatMap((line) => wrapPdfLine(line, 96))
  const pages: string[][] = []
  for (let index = 0; index < wrapped.length; index += 52) pages.push(wrapped.slice(index, index + 52))
  const kids = pages.map((_, index) => String(4 + index * 2) + ' 0 R').join(' ')
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [' + kids + '] /Count ' + String(pages.length) + ' >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
  for (let index = 0; index < pages.length; index += 1) {
    const pageNumber = 4 + index * 2
    const contentNumber = pageNumber + 1
    const content = ['BT', '/F1 10 Tf', '50 790 Td', '13 TL', ...pages[index]!.flatMap((line, lineIndex) => [index === 0 && lineIndex === 0 ? '/F1 16 Tf' : index === 0 && lineIndex === 1 ? '/F1 10 Tf' : '', '(' + pdfText(line) + ') Tj', 'T*']).filter(Boolean), 'ET'].join('\n')
    objects.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ' + String(contentNumber) + ' 0 R >>')
    objects.push('<< /Length ' + String(encoder.encode(content).length) + ' >>\nstream\n' + content + '\nendstream')
  }
  let pdf = '%PDF-1.4\n%agent-evaluation\n'; const offsets = [0]
  for (let index = 0; index < objects.length; index += 1) { offsets.push(encoder.encode(pdf).length); pdf += String(index + 1) + ' 0 obj\n' + objects[index] + '\nendobj\n' }
  const xref = encoder.encode(pdf).length
  pdf += 'xref\n0 ' + String(objects.length + 1) + '\n0000000000 65535 f \n' + offsets.slice(1).map((offset) => String(offset).padStart(10, '0') + ' 00000 n ').join('\n') + '\ntrailer\n<< /Size ' + String(objects.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + String(xref) + '\n%%EOF\n'
  return encoder.encode(pdf)
}

function wrapPdfLine(value: string, width: number): string[] {
  const text = value || ' '
  const output: string[] = []
  for (let index = 0; index < text.length; index += width) output.push(text.slice(index, index + width))
  return output
}

function assertNoPrivateMaterial(value: unknown): void {
  visitStrings(value, (candidate) => {
    if (/(?:^|[\s'"])(?:\/home\/[^/\s]+|\/Users\/[^/\s]+|\/root)(?:\/|$)/u.test(candidate) || /[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/]/u.test(candidate)) throw new Error('report input contains a private absolute path')
    if (/(?:^|[^A-Za-z0-9])(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|Bearer\s+[A-Za-z0-9._~-]{16,})/u.test(candidate)) throw new Error('report input contains a likely secret')
  })
}
function assertPublicOutput(files: readonly GeneratedReportFile[]): void { for (const file of files) assertNoPrivateMaterial(new TextDecoder().decode(file.content)) }
function visitStrings(value: unknown, consume: (value: string) => void): void { if (typeof value === 'string') consume(value); else if (Array.isArray(value)) for (const item of value) visitStrings(item, consume); else if (value && typeof value === 'object') for (const item of Object.values(value as Record<string, unknown>)) visitStrings(item, consume) }
function usageSummary(trials: readonly TrialRow[]): string { const available = trials.filter((trial) => trial.inputTokens !== null); const cost = available.reduce((sum, trial) => sum + (trial.costUsd ?? 0), 0); return String(available.length) + '/' + String(trials.length) + ' trials expose usage; recorded cost USD ' + cost.toFixed(4) + '.' }
function comparisonSummary(decisions: readonly RegressionGateDecision[]): { paired: string; costLatency: string } {
  if (decisions.length === 0) return { paired: 'No matched baseline/candidate gate is included in this report.', costLatency: 'No matched cost/latency Pareto decision is included.' }
  const paired = decisions.map((decision) => {
    const statistics = decision.statistics
    if (!statistics) return decision.gateId + ': canonical v1 decision predates detailed statistical fields.'
    const interval = statistics.confidenceInterval
    const completeness = statistics.evidenceCompleteness
    const variance = statistics.repeatedRunVariance
    return decision.gateId + ': ' + String(statistics.pairedWins) + ' wins, ' + String(statistics.pairedLosses) + ' losses, ' + String(statistics.pairedTies) + ' ties; delta ' + statistics.successRateDelta.toFixed(4) + '; paired bootstrap ' + (interval ? '[' + interval.lower.toFixed(4) + ', ' + interval.upper.toFixed(4) + '] at ' + String(interval.level) + ' (' + String(interval.samples) + ' samples)' : 'unavailable') + '; McNemar p=' + statistics.mcnemarPValue.toFixed(4) + '; repeated-run variance ' + (variance ? 'baseline=' + variance.baseline.toFixed(4) + ', candidate=' + variance.candidate.toFixed(4) : 'unavailable') + '; evidence completeness ' + (completeness ? String(completeness.completePairs) + '/' + String(completeness.totalPairs) : 'unavailable') + '; task deltas=' + String(statistics.taskDeltas?.length ?? 0) + '.'
  }).join(' ')
  const costLatency = decisions.map((decision) => { const pareto = decision.statistics?.pareto; return decision.gateId + ' Pareto: ' + (pareto ? pareto.relation + ', baseline cost=' + String(pareto.baseline.costUsd) + ', latency=' + String(pareto.baseline.latencyMs) + ', quality=' + pareto.baseline.quality.toFixed(4) + '; candidate cost=' + String(pareto.candidate.costUsd) + ', latency=' + String(pareto.candidate.latencyMs) + ', quality=' + pareto.candidate.quality.toFixed(4) : 'unavailable') + '.' }).join(' ')
  return { paired, costLatency }
}
function csv(value: unknown): string { const output = value === null || value === undefined ? '' : String(value); return /[",\n\r]/u.test(output) ? '"' + output.replaceAll('"', '""') + '"' : output }
function html(value: string): string { return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;') }
function xml(value: string): string { return html(value) }
function md(value: string): string { return value.replaceAll('|', '\\|').replaceAll('\n', ' ') }
function code(value: string): string { return String.fromCharCode(96) + value.replaceAll(String.fromCharCode(96), '') + String.fromCharCode(96) }
function pdfText(value: string): string { return value.replace(/[^\x20-\x7E]/gu, '?').replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)') }
function sarifLevel(severity: DefectFinding['severity']): 'note' | 'warning' | 'error' { return severity === 'low' ? 'note' : severity === 'medium' ? 'warning' : 'error' }
