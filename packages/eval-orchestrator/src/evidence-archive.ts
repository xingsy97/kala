import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, resolve } from 'node:path'

import {
  ArchiveConclusionSchema, ArchiveDocumentSummarySchema, ArchivedRunDetailSchema, ArchivedRunSummarySchema,
  type ArchiveConclusion, type ArchiveDocumentSummary, type ArchivedRunDetail, type ArchivedRunSummary,
} from '@agent-kernel/eval-protocol'

type ArchiveDocument = ArchiveDocumentSummary & { content: unknown }
type MutableRun = {
  runId: string
  state: string
  taskPackId?: string
  generatedAt?: string
  startedAt?: string
  completedAt?: string
  durationMs?: number
  agentIds: Set<string>
  taskIds: Set<string>
  cleanupVerified?: boolean
  defectCount?: number
  documents: Map<string, ArchiveDocumentSummary>
  trials: Map<string, ArchivedRunDetail['trials'][number]>
  conclusions: Map<string, ArchiveConclusion>
  workerErrors: unknown[]
}

export class EvidenceArchive {
  readonly documents = new Map<string, ArchiveDocument>()
  readonly runs = new Map<string, ArchivedRunDetail>()
  readonly conclusions: ArchiveConclusion[] = []
  rootAvailable = false

  constructor(readonly root?: string) {}

  async initialize(): Promise<void> {
    if (!this.root) return
    const directory = resolve(this.root)
    let names: string[]
    try { names = (await readdir(directory)).filter((name) => name.endsWith('.json')).sort() }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    this.rootAvailable = true
    const mutableRuns = new Map<string, MutableRun>()
    for (const name of names) {
      const path = resolve(directory, name)
      const body = await readFile(path)
      let content: unknown
      try { content = JSON.parse(body.toString('utf8')) } catch { continue }
      if (!record(content)) continue
      const metadata = await stat(path)
      const documentId = documentIdentifier(name)
      const runIds = collectRunIds(content)
      const document = ArchiveDocumentSummarySchema.parse({
        documentId, fileName: name, title: titleFor(name, content), kind: kindFor(name, content),
        sha256: createHash('sha256').update(body).digest('hex'), bytes: metadata.size,
        ...(date(content.generatedAt) ? { generatedAt: date(content.generatedAt) } : {}),
        ...(text(content.scope) ? { scope: text(content.scope) } : {}), runIds,
      })
      this.documents.set(documentId, { ...document, content })
      ingestDocument(mutableRuns, document, content)
      this.conclusions.push(...documentConclusions(document, content))
    }
    for (const conclusion of this.conclusions) for (const runId of conclusion.runIds) mutableRun(mutableRuns, runId).conclusions.set(conclusion.conclusionId, conclusion)
    for (const run of mutableRuns.values()) {
      const trials = [...run.trials.values()].sort((left, right) => left.trialId.localeCompare(right.trialId))
      const counts = outcomeCounts(trials)
      const summary = ArchivedRunSummarySchema.parse({
        runId: run.runId, state: run.state, ...(run.taskPackId ? { taskPackId: run.taskPackId } : {}),
        ...(run.generatedAt ? { generatedAt: run.generatedAt } : {}), ...(run.startedAt ? { startedAt: run.startedAt } : {}),
        ...(run.completedAt ? { completedAt: run.completedAt } : {}), ...(run.durationMs !== undefined ? { durationMs: run.durationMs } : {}),
        trialCount: trials.length, ...counts, outcome: runOutcome(run.state, counts), agentIds: [...run.agentIds].sort(), taskIds: [...run.taskIds].sort(),
        ...(run.cleanupVerified !== undefined ? { cleanupVerified: run.cleanupVerified } : {}), ...(run.defectCount !== undefined ? { defectCount: run.defectCount } : {}),
        sourceDocumentIds: [...run.documents.keys()].sort(), sourceFiles: [...run.documents.values()].map((item) => item.fileName).sort(),
      })
      this.runs.set(run.runId, ArchivedRunDetailSchema.parse({ ...summary, trials, conclusions: [...run.conclusions.values()], documents: [...run.documents.values()], workerErrors: run.workerErrors }))
    }
  }

  runSummaries(): ArchivedRunSummary[] {
    return [...this.runs.values()].map(({ trials: _trials, conclusions: _conclusions, documents: _documents, workerErrors: _errors, ...summary }) => summary).sort((left, right) => archiveTime(right) - archiveTime(left) || left.runId.localeCompare(right.runId))
  }

  document(documentId: string): ArchiveDocument | undefined { return this.documents.get(documentId) }
}

function ingestDocument(runs: Map<string, MutableRun>, document: ArchiveDocumentSummary, content: Record<string, unknown>): void {
  const directRunId = identifier(content.runId)
  if (directRunId) {
    const run = mutableRun(runs, directRunId)
    run.documents.set(document.documentId, document)
    mergeRun(run, content)
  }
  for (const key of ['baseline', 'candidate'] as const) {
    const value = record(content[key]) ? content[key] as Record<string, unknown> : undefined
    const runId = identifier(value?.runId)
    if (!value || !runId) continue
    const run = mutableRun(runs, runId)
    run.documents.set(document.documentId, document)
    mergeRun(run, value)
  }
  for (const runId of document.runIds) mutableRun(runs, runId).documents.set(document.documentId, document)
}

function mergeRun(run: MutableRun, source: Record<string, unknown>): void {
  run.state = text(source.runState) ?? text(source.state) ?? run.state
  run.taskPackId = identifier(source.taskPackId) ?? run.taskPackId
  run.generatedAt = date(source.generatedAt) ?? run.generatedAt
  run.startedAt = date(source.startedAt) ?? run.startedAt
  run.completedAt = date(source.completedAt) ?? run.completedAt
  run.durationMs = number(source.durationMs) ?? run.durationMs
  if (typeof source.cleanupVerified === 'boolean') run.cleanupVerified = source.cleanupVerified
  const defectCount = typeof source.defects === 'number' ? source.defects : Array.isArray(source.defects) ? source.defects.length : undefined
  if (defectCount !== undefined) run.defectCount = Math.max(run.defectCount ?? 0, defectCount)
  for (const id of identifiers(source.agentIds)) run.agentIds.add(id)
  for (const id of identifiers(source.agents)) run.agentIds.add(id)
  for (const id of identifiers(source.taskIds)) run.taskIds.add(id)
  if (Array.isArray(source.workerErrors)) run.workerErrors.push(...source.workerErrors)
  for (const trial of trialsFrom(source)) {
    run.trials.set(trial.trialId, trial)
    if (trial.agentVariantId) run.agentIds.add(trial.agentVariantId)
    if (trial.taskId) run.taskIds.add(trial.taskId)
  }
}

function trialsFrom(source: Record<string, unknown>): ArchivedRunDetail['trials'] {
  const values = Array.isArray(source.trials) ? source.trials : record(source.sweMarathon) ? [source.sweMarathon] : Array.isArray(source.metamorphicVariants) ? source.metamorphicVariants : []
  return values.flatMap((raw) => {
    if (!record(raw)) return []
    const trialId = identifier(raw.trialId)
    if (!trialId) return []
    const nativeMetrics = metricRecord(raw.nativeMetrics)
    return [{
      trialId, ...(identifier(raw.taskId) ? { taskId: identifier(raw.taskId)! } : {}), ...(identifier(raw.agentVariantId) ? { agentVariantId: identifier(raw.agentVariantId)! } : {}),
      ...(identifier(raw.benchmarkId) ? { benchmarkId: identifier(raw.benchmarkId)! } : {}), ...(text(raw.evidenceLevel) ? { evidenceLevel: text(raw.evidenceLevel)! } : {}),
      outcome: trialOutcome(nativeMetrics, raw), nativeMetrics, ...(integer(raw.normalizedEventCount) !== undefined ? { normalizedEventCount: integer(raw.normalizedEventCount)! } : {}),
      ...(digest(raw.resultHash) ? { resultHash: digest(raw.resultHash)! } : {}), ...(digest(raw.artifactManifestHash) ? { artifactManifestHash: digest(raw.artifactManifestHash)! } : {}),
    }]
  })
}

function documentConclusions(document: ArchiveDocumentSummary, content: Record<string, unknown>): ArchiveConclusion[] {
  const conclusions: ArchiveConclusion[] = []
  const add = (value: Omit<ArchiveConclusion, 'sourceDocumentId'>) => conclusions.push(ArchiveConclusionSchema.parse({ ...value, sourceDocumentId: document.documentId }))
  if (document.kind === 'lifecycle' && identifier(content.runId)) {
    const trials = trialsFrom(content); const counts = outcomeCounts(trials); const runId = identifier(content.runId)!
    add({ conclusionId: uniqueId('run-result', document.documentId), kind: 'run-result', title: (identifier(content.taskPackId) ?? 'Evaluation') + ' · ' + runId, status: runOutcome(text(content.runState) ?? 'unknown', counts), summary: `${counts.passedTrials}/${trials.length} trials passed; ${counts.failedTrials} failed; ${counts.unknownTrials} unknown.`, runIds: [runId], evidenceRefs: [document.fileName], data: { trialCount: trials.length, ...counts, cleanupVerified: content.cleanupVerified } })
  }
  if (record(content.finding)) {
    const finding = content.finding as Record<string, unknown>; const runIds = identifiers([finding.runId])
    add({ conclusionId: uniqueId('finding', identifier(finding.findingId) ?? document.documentId), kind: 'finding', title: 'Defect finding · ' + (identifier(finding.findingId) ?? document.title), status: text(finding.status) ?? 'detected', summary: `${text(finding.category) ?? 'unknown'} / ${text(finding.severity) ?? 'unknown'} at normalized sequence ${String(integer(finding.firstDivergenceSequence) ?? 'unknown')}.`, ...(number(finding.confidence) !== undefined ? { confidence: number(finding.confidence)! } : {}), runIds, evidenceRefs: strings(finding.evidenceRefs).length ? strings(finding.evidenceRefs) : [document.fileName], data: finding })
  }
  const reproduction = record(content.reproduction) ? content.reproduction as Record<string, unknown> : document.kind === 'reproduction' ? content : undefined
  if (reproduction && (record(reproduction.reproduction) || 'reproduced' in reproduction || identifier(reproduction.bundleId))) {
    const result = record(reproduction.reproduction) ? reproduction.reproduction as Record<string, unknown> : reproduction
    const attempts = integer(result.attempts) ?? (Array.isArray(result.attempts) ? result.attempts.length : undefined); const reproduced = integer(result.reproduced) ?? (Array.isArray(result.attempts) ? result.attempts.filter((item) => record(item) && item.reproduced === true).length : undefined)
    add({ conclusionId: uniqueId('reproduction', identifier(reproduction.bundleId) ?? document.documentId), kind: 'reproduction', title: 'Verified reproduction · ' + (identifier(reproduction.bundleId) ?? document.title), status: reproduced && reproduced > 0 ? 'reproduced' : 'unknown', summary: `${reproduced ?? 'unknown'}/${attempts ?? 'unknown'} fresh reproduction attempts matched; minimization ${String(integer(record(reproduction.minimization) ? (reproduction.minimization as Record<string, unknown>).originalUnits : undefined) ?? '?')}→${String(integer(record(reproduction.minimization) ? (reproduction.minimization as Record<string, unknown>).minimizedUnits : undefined) ?? '?')}.`, runIds: collectRunIds(reproduction), evidenceRefs: [document.fileName], data: reproduction })
  }
  if (record(content.gate)) {
    const gate = content.gate as Record<string, unknown>; const statistics = record(gate.statistics) ? gate.statistics as Record<string, unknown> : {}
    add({ conclusionId: uniqueId('regression', identifier(gate.gateId) ?? document.documentId), kind: 'regression', title: 'Regression gate · ' + (identifier(gate.gateId) ?? document.title), status: text(gate.decision) ?? 'unknown', summary: `Decision ${text(gate.decision) ?? 'unknown'}; success delta ${String(number(statistics.successRateDelta) ?? '?')}; McNemar p=${String(number(statistics.mcnemarPValue) ?? '?')}; violations ${Array.isArray(gate.violations) ? gate.violations.length : '?'}.`, runIds: collectRunIds(content), evidenceRefs: strings(gate.evidenceRefs).length ? strings(gate.evidenceRefs) : [document.fileName], data: gate })
  }
  if (record(content.insight)) {
    const insight = content.insight as Record<string, unknown>
    add({ conclusionId: uniqueId('insight', identifier(insight.insightId) ?? document.documentId), kind: 'insight', title: 'Product insight · ' + (identifier(insight.insightId) ?? document.title), status: text(insight.status) ?? 'unknown', summary: text(insight.failureCluster) ?? document.title, ...(number(insight.confidence) !== undefined ? { confidence: number(insight.confidence)! } : {}), ...(text(insight.recommendation) ? { recommendation: text(insight.recommendation)! } : {}), runIds: collectRunIds(content), evidenceRefs: strings(insight.evidenceRefs).length ? strings(insight.evidenceRefs) : [document.fileName], data: insight })
  }
  if (record(content.report)) {
    const report = content.report as Record<string, unknown>
    add({ conclusionId: uniqueId('report', identifier(report.reportId) ?? document.documentId), kind: 'report', title: 'Evidence report · ' + (identifier(report.reportId) ?? document.title), status: report.redactionPassed === true ? 'verified' : 'unknown', summary: `${Array.isArray(report.formats) ? report.formats.length : 0} hash-bound formats; methodology ${text(report.methodologyVersion) ?? 'unknown'}; redaction ${report.redactionPassed === true ? 'passed' : 'unknown'}.`, runIds: identifiers(report.runRefs), evidenceRefs: [document.fileName], data: report })
  }
  if (document.kind === 'closed-loop') add({ conclusionId: uniqueId('closed-loop', document.documentId), kind: 'closed-loop', title: document.title, status: Array.isArray(content.tenSteps) && content.tenSteps.every((step) => record(step) && step.passed === true) ? 'passed' : 'unknown', summary: `${Array.isArray(content.tenSteps) ? content.tenSteps.filter((step) => record(step) && step.passed === true).length : 0}/${Array.isArray(content.tenSteps) ? content.tenSteps.length : 0} closed-loop steps passed.`, runIds: collectRunIds(content), evidenceRefs: [document.fileName], data: { tenSteps: content.tenSteps, immutablePairing: content.immutablePairing, traceDivergence: content.traceDivergence } })
  return conclusions
}

function mutableRun(runs: Map<string, MutableRun>, runId: string): MutableRun {
  const found = runs.get(runId)
  if (found) return found
  const created: MutableRun = { runId, state: 'archived', agentIds: new Set(), taskIds: new Set(), documents: new Map(), trials: new Map(), conclusions: new Map(), workerErrors: [] }
  runs.set(runId, created); return created
}
function collectRunIds(value: unknown): string[] {
  const found = new Set<string>()
  const visit = (current: unknown, key?: string) => {
    if (key && ['runId', 'baselineRunId', 'candidateRunId'].includes(key) && identifier(current)) found.add(identifier(current)!)
    else if (key && ['runIds', 'runRefs'].includes(key)) for (const id of identifiers(current)) found.add(id)
    if (Array.isArray(current)) for (const item of current) visit(item)
    else if (record(current)) for (const [childKey, child] of Object.entries(current)) visit(child, childKey)
  }
  visit(value); return [...found].sort()
}
function trialOutcome(metrics: Record<string, string | number | boolean>, raw: Record<string, unknown>): 'passed' | 'failed' | 'unknown' {
  const positive = ['journey_completed', 'recovered', 'resolved', 'compile_passed', 'tests_passed', 'verifier_protocol_valid', 'passed', 'success_control_passed']
  if (positive.some((key) => metrics[key] === true || typeof metrics[key] === 'number' && metrics[key] > 0)) return 'passed'
  if (integer(metrics.totalSteps) !== undefined && integer(metrics.passedSteps) !== undefined) return integer(metrics.totalSteps) === integer(metrics.passedSteps) ? 'passed' : 'failed'
  if (text(raw.state) && !['completed', 'passed'].includes(text(raw.state)!)) return 'failed'
  return 'unknown'
}
function outcomeCounts(trials: ArchivedRunDetail['trials']) { return { passedTrials: trials.filter((trial) => trial.outcome === 'passed').length, failedTrials: trials.filter((trial) => trial.outcome === 'failed').length, unknownTrials: trials.filter((trial) => trial.outcome === 'unknown').length } }
function runOutcome(state: string, counts: ReturnType<typeof outcomeCounts>): 'passed' | 'failed' | 'unknown' { if (counts.failedTrials > 0 || ['failed', 'cancelled', 'blocked', 'interrupted'].includes(state)) return 'failed'; if (counts.passedTrials > 0 && counts.unknownTrials === 0 && state === 'completed') return 'passed'; return 'unknown' }
function kindFor(name: string, content: Record<string, unknown>): ArchiveDocumentSummary['kind'] { if (name.includes('closed-loop') && (content.gate || content.insight)) return 'closed-loop'; if (name.includes('reproduction') || content.reproduction && !content.trials) return 'reproduction'; if (identifier(content.runId) && (Array.isArray(content.trials) || content.sweMarathon || content.metamorphicVariants)) return 'lifecycle'; if (name.includes('acceptance')) return 'acceptance'; return 'other' }
function titleFor(name: string, content: Record<string, unknown>): string { const runId = identifier(content.runId); if (runId) return (identifier(content.taskPackId) ?? text(content.mode) ?? 'Evaluation') + ' · ' + runId; return basename(name, '.json').split('-').map((part) => part ? part[0]!.toUpperCase() + part.slice(1) : part).join(' ') }
function documentIdentifier(name: string): string { return basename(name, '.json').replace(/[^A-Za-z0-9._:-]/gu, '-').slice(0, 180) }
function uniqueId(prefix: string, value: string): string { return (prefix + '-' + value).replace(/[^A-Za-z0-9._:-]/gu, '-').slice(0, 180) }
function archiveTime(run: ArchivedRunSummary): number { return Date.parse(run.completedAt ?? run.generatedAt ?? run.startedAt ?? '') || 0 }
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
function text(value: unknown): string | undefined { return typeof value === 'string' && value.trim() ? value.trim() : undefined }
function identifier(value: unknown): string | undefined { const valueText = text(value); return valueText && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(valueText) ? valueText : undefined }
function identifiers(value: unknown): string[] { return Array.isArray(value) ? value.flatMap((item) => identifier(item) ? [identifier(item)!] : record(item) && identifier(item.runId) ? [identifier(item.runId)!] : []) : [] }
function strings(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && !!item.trim()) : [] }
function number(value: unknown): number | undefined { return typeof value === 'number' && Number.isFinite(value) ? value : undefined }
function integer(value: unknown): number | undefined { return typeof value === 'number' && Number.isInteger(value) ? value : undefined }
function date(value: unknown): string | undefined { const valueText = text(value); return valueText && Number.isFinite(Date.parse(valueText)) ? new Date(valueText).toISOString() : undefined }
function digest(value: unknown): string | undefined { const valueText = text(value); return valueText && /^[a-f0-9]{64}$/u.test(valueText) ? valueText : undefined }
function metricRecord(value: unknown): Record<string, string | number | boolean> { if (!record(value)) return {}; return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string | number | boolean] => ['string', 'number', 'boolean'].includes(typeof entry[1]))) }
