import { createHash, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

import {
  AnalysisJobSchema, AnalysisOutputManifestSchema, AnalyzerInputSchema, canonicalJson, parseTrialTraceJsonl, serializeTrialTraceJsonl, sha256Hex,
  type AnalysisJob, type AnalysisOutputManifest, type AnalyzerInput, type TrialTrace,
} from '@agent-kernel/eval-protocol'
import { ControlPlaneClient, type ReferencedHashSigner } from '@agent-kernel/eval-sdk'

import { alignTraces, clusterUnknownFailures } from './alignment.js'
import { continueCounterfactual, type CounterfactualContinuationHarness, type CounterfactualOutcomeVerifier } from './counterfactual.js'
import { runControlPlaneLoop } from './control-plane-loop.js'
import { analyzeRequiredDetectors, DETECTOR_VERSIONS, type RequiredDetectorId } from './detectors.js'
import type { DetectorPluginRegistry } from './detector-plugins.js'
import { appendTraceSpans, traceJsonl } from './trace-evidence.js'

type Page<T> = { items: T[]; page: { hasMore: boolean; nextCursor?: string } }
type RunProjection = { accepted: { spec: { analysis: { detectorIds: string[] } } } }
type TrialProjection = { trialId: string; runId: string; evidence?: { analyzerInputRef: string; traceRef?: string; resultHash: string; artifactManifest: { entries: Array<{ artifactId: string; path: string; mediaType: string; bytes: number; sha256: string }> } } }
type AnalyzerEvidence = { trial: TrialProjection; input: AnalyzerInput; trace?: TrialTrace }

export class EvaluationAnalyzer {
  constructor(private readonly options: {
    controlPlane: ControlPlaneClient
    executorId: string
    leaseMs: number
    pollIntervalMs?: number
    now?: () => Date
    detectorPlugins?: DetectorPluginRegistry
    counterfactualHarness?: CounterfactualContinuationHarness
    counterfactualVerifier?: CounterfactualOutcomeVerifier
    reproductionSigningProvider?: ReferencedHashSigner
  }) {}

  async runUntilIdle(options: { idlePolls?: number; signal?: AbortSignal } = {}): Promise<void> {
    let idle = 0; const requiredIdle = options.idlePolls ?? 3
    while (!options.signal?.aborted) {
      await this.options.controlPlane.expireAnalysisJobs(options.signal)
      const job = await this.nextQueued(options.signal)
      if (!job) {
        idle += 1; if (idle >= requiredIdle) return
        await delay(this.options.pollIntervalMs ?? 100, undefined, options.signal ? { signal: options.signal } : undefined).catch(() => undefined); continue
      }
      idle = 0; await this.execute(job, options.signal)
    }
    throw options.signal.reason instanceof Error ? options.signal.reason : new Error('analyzer stopped')
  }

  async start(signal?: AbortSignal): Promise<void> {
    await runControlPlaneLoop({
      signal,
      pollIntervalMs: this.options.pollIntervalMs ?? 500,
      runOnce: async () => this.runUntilIdle({ idlePolls: 1, signal }),
    })
  }

  private async nextQueued(signal?: AbortSignal): Promise<AnalysisJob | null> {
    for (const kind of ['detectors', 'trace-alignment', 'clustering', 'counterfactual'] as const) {
      const response = await this.options.controlPlane.query({ resource: 'analysis-jobs', state: 'queued', kind, page: { limit: 1 } }, signal) as Page<AnalysisJob>
      if (response.items[0]) return AnalysisJobSchema.parse(response.items[0])
    }
    return null
  }

  private async execute(queued: AnalysisJob, signal?: AbortSignal): Promise<void> {
    const start = command('analysis.job.start', { jobId: queued.jobId, executorId: this.options.executorId, leaseMs: this.options.leaseMs })
    try { await this.options.controlPlane.command(start, signal) } catch { return }
    const controller = new AbortController(); const abort = () => controller.abort(signal?.reason ?? new Error('analyzer stopped'))
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort()
    const heartbeat = this.heartbeat(queued.jobId, controller.signal)
    try {
      const current = AnalysisJobSchema.parse(await this.options.controlPlane.query({ resource: 'analysis-job', jobId: queued.jobId }, controller.signal))
      const manifest = await this.process(current, controller.signal)
      await this.options.controlPlane.command(command('analysis.job.complete', { jobId: current.jobId, executorId: this.options.executorId, outputManifest: manifest }), controller.signal)
    } catch (error) {
      if (!controller.signal.aborted) {
        await this.options.controlPlane.command(command('analysis.job.fail', { jobId: queued.jobId, executorId: this.options.executorId, failure: { code: 'ANALYSIS_EXECUTION_FAILED', summary: safeMessage(error) } })).catch(() => undefined)
      }
    } finally {
      controller.abort(new Error('analysis job finished')); signal?.removeEventListener('abort', abort); await heartbeat
    }
  }

  private async heartbeat(jobId: string, signal: AbortSignal): Promise<void> {
    const interval = Math.max(100, Math.floor(this.options.leaseMs / 3))
    while (!signal.aborted) {
      await delay(interval, undefined, { signal }).catch(() => undefined)
      if (!signal.aborted) await this.options.controlPlane.command(command('analysis.job.heartbeat', { jobId, executorId: this.options.executorId, leaseMs: this.options.leaseMs }), signal)
    }
  }

  private async process(job: AnalysisJob, signal: AbortSignal): Promise<AnalysisOutputManifest> {
    const run = await this.options.controlPlane.query({ resource: 'run', runId: job.runId }, signal) as RunProjection
    const page = await this.options.controlPlane.query({ resource: 'trials', runId: job.runId, state: 'completed', page: { limit: 500 } }, signal) as Page<TrialProjection>
    const evidence: AnalyzerEvidence[] = []
    for (const trial of page.items) evidence.push(await this.readEvidence(trial, signal))
    const inputs = evidence.map((item) => item.input)
    const outputs: AnalysisOutputManifest['outputs'] = []
    if (job.kind === 'detectors') {
      const detectorIds = job.detectorIds ?? run.accepted.spec.analysis.detectorIds
      for (const item of evidence) {
        const traceArtifactRefs: string[] = []
        for (const detectorId of detectorIds) {
          let findings
          if (detectorId in DETECTOR_VERSIONS) findings = analyzeRequiredDetectors(item.input, [requiredDetectorId(detectorId)])
          else if (this.options.detectorPlugins?.has(detectorId)) findings = await this.options.detectorPlugins.analyze(detectorId, item.input)
          else throw new Error('unknown detector implementation: ' + detectorId)
          for (const finding of findings) {
            const uploaded = await this.upload(job, 'finding', finding.findingId, finding, signal)
            outputs.push(uploaded); traceArtifactRefs.push(uploaded.artifactRef)
          }
        }
        if (item.trace) {
          const detectedAt = (this.options.now ?? (() => new Date()))().toISOString()
          const derived = appendTraceSpans(traceJsonl(item.trace), [{
            spanId: 'analyzer-' + job.jobId, name: 'analyzer.detect', startedAt: detectedAt, completedAt: detectedAt, status: 'ok',
            artifactRefs: traceArtifactRefs, outcomeCategory: traceArtifactRefs.length > 0 ? 'finding_detected' : 'no_finding',
          }])
          outputs.push(await this.uploadRaw(job, 'trace', 'trace-' + item.input.trialId, Buffer.from(traceJsonl(derived)), 'application/x-ndjson', signal))
        }
      }
    } else if (job.kind === 'trace-alignment') {
      for (let leftIndex = 0; leftIndex < inputs.length; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < inputs.length; rightIndex += 1) {
          const left = inputs[leftIndex]!; const right = inputs[rightIndex]!
          if (left.taskId !== right.taskId) continue
          const alignment = alignTraces(left.trialId, left.events, right.trialId, right.events, { leftOutcome: left.verifierIntegrity.passed ? 'success' : 'failure', rightOutcome: right.verifierIntegrity.passed ? 'success' : 'failure' })
          outputs.push(await this.upload(job, 'trace-alignment', 'alignment-' + left.trialId + '-' + right.trialId, alignment, signal))
        }
      }
      if (outputs.length === 0) throw new Error('trace alignment found no same-task trial pair')
    } else if (job.kind === 'clustering') {
      const defects = await this.options.controlPlane.query({ resource: 'defects', runId: job.runId, page: { limit: 500 } }, signal) as Page<import('@agent-kernel/eval-protocol').DefectFinding>
      const clusters = clusterUnknownFailures(defects.items.map((finding) => {
        const input = inputs.find((candidate) => candidate.trialId === finding.trialId)
        if (!input) throw new Error('cluster finding has no canonical analyzer input: ' + finding.findingId)
        return { finding, actionErrorSequence: errorSequence(input) }
      }))
      if (clusters.length === 0) throw new Error('clustering requires at least one unknown failure finding')
      for (const cluster of clusters) outputs.push(await this.upload(job, 'failure-cluster', cluster.clusterId, cluster, signal))
    } else if (job.kind === 'counterfactual') {
      if (!job.counterfactualRequest) throw new Error('counterfactual job lacks an immutable request')
      if (!this.options.counterfactualHarness) throw new Error('counterfactual continuation harness is not configured')
      if (!this.options.counterfactualVerifier) throw new Error('independent counterfactual verifier is not configured')
      const source = inputs.find((input) => input.trialId === job.counterfactualRequest!.sourceTrialId)
      if (!source) throw new Error('counterfactual source trial has no canonical analyzer input')
      const results = await continueCounterfactual(job.counterfactualRequest, source, this.options.counterfactualHarness, this.options.counterfactualVerifier, signal)
      for (const result of results) outputs.push(await this.upload(job, 'counterfactual', result.counterfactualId, result, signal))
    } else {
      throw new Error('unsupported analysis job kind: ' + job.kind)
    }
    const generatedAt = (this.options.now ?? (() => new Date()))().toISOString()
    const unsigned = { schemaVersion: 1 as const, jobId: job.jobId, runId: job.runId, inputManifestHash: job.inputManifestHash, generatedAt, outputs }
    return AnalysisOutputManifestSchema.parse({ ...unsigned, manifestHash: await sha256Hex(canonicalJson(unsigned)) })
  }

  private async readEvidence(trial: TrialProjection, signal: AbortSignal): Promise<AnalyzerEvidence> {
    const evidence = trial.evidence; if (!evidence) throw new Error('completed trial has no canonical evidence: ' + trial.trialId)
    const entry = evidence.artifactManifest.entries.find((candidate) => candidate.path === evidence.analyzerInputRef)
    if (!entry) throw new Error('canonical analyzer input is absent from trial manifest: ' + trial.trialId)
    const response = await fetch(this.options.controlPlane.baseUrl + '/api/v1/artifacts/' + encodeURIComponent(entry.artifactId) + '?trialId=' + encodeURIComponent(trial.trialId), { signal })
    if (!response.ok) throw new Error('cannot read analyzer input artifact: ' + trial.trialId)
    const input = AnalyzerInputSchema.parse(await response.json())
    if (input.runId !== trial.runId || input.trialId !== trial.trialId) throw new Error('canonical analyzer input authority mismatch: ' + trial.trialId)
    if (await sha256Hex(canonicalJson(input.events)) !== input.projectionHash) throw new Error('canonical analyzer projection hash mismatch: ' + trial.trialId)
    const { inputManifestHash, ...unsigned } = input
    if (await sha256Hex(canonicalJson(unsigned)) !== inputManifestHash) throw new Error('canonical analyzer input hash mismatch: ' + trial.trialId)
    if (!evidence.traceRef) return { trial, input }
    const traceEntry = evidence.artifactManifest.entries.find((candidate) => candidate.path === evidence.traceRef)
    if (!traceEntry) throw new Error('canonical trial trace is absent from trial manifest: ' + trial.trialId)
    const traceResponse = await fetch(this.options.controlPlane.baseUrl + '/api/v1/artifacts/' + encodeURIComponent(traceEntry.artifactId) + '?trialId=' + encodeURIComponent(trial.trialId), { signal })
    if (!traceResponse.ok) throw new Error('cannot read canonical trial trace artifact: ' + trial.trialId)
    const trace = parseTrialTraceJsonl(await traceResponse.text())
    if (trace.runId !== trial.runId || trace.trialId !== trial.trialId) throw new Error('canonical trial trace authority mismatch: ' + trial.trialId)
    if (await sha256Hex(serializeTrialTraceJsonl(trace)) !== input.traceHash) throw new Error('canonical analyzer trace hash mismatch: ' + trial.trialId)
    return { trial, input, trace }
  }

  private async upload(job: AnalysisJob, kind: AnalysisOutputManifest['outputs'][number]['kind'], outputId: string, value: unknown, signal: AbortSignal) {
    return await this.uploadRaw(job, kind, outputId, Buffer.from(canonicalJson(value)), 'application/json', signal)
  }

  private async uploadRaw(job: AnalysisJob, kind: AnalysisOutputManifest['outputs'][number]['kind'], outputId: string, content: Buffer, mediaType: string, signal: AbortSignal) {
    const sha256 = createHash('sha256').update(content).digest('hex')
    const artifactRef = 'analysis/' + job.jobId + '/' + outputId + (mediaType === 'application/x-ndjson' ? '.jsonl' : '.json')
    await this.options.controlPlane.stageAnalysisArtifact({ jobId: job.jobId, executorId: this.options.executorId, path: artifactRef, mediaType, bytes: content.byteLength, sha256, content }, signal)
    return { outputId, kind, artifactRef, mediaType, bytes: content.byteLength, sha256 }
  }
}

function command<T extends string>(type: T, fields: Record<string, unknown>): any { const id = type.replaceAll('.', '-') + '-' + randomUUID(); return { schemaVersion: 1, type, commandId: id, idempotencyKey: id, submittedAt: new Date().toISOString(), ...fields } }
function requiredDetectorId(value: string): RequiredDetectorId { if (!(value in DETECTOR_VERSIONS)) throw new Error('unknown detector implementation: ' + value); return value as RequiredDetectorId }
function errorSequence(input: AnalyzerInput): string[] { return input.events.filter((event) => event.kind === 'error' || event.kind === 'tool_call').map((event) => canonicalJson({ kind: event.kind, data: event.data })) }
function safeMessage(error: unknown): string { return (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/gu, ' ').slice(0, 500) || 'analysis failed' }
