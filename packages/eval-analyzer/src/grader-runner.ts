import { createHash, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

import {
  AnalysisJobSchema, AnalysisOutputManifestSchema, GradingResultSchema, TrialEvidenceSchema, canonicalJson, sha256Hex,
  type AnalysisJob, type AnalysisOutputManifest, type GradingResult, type TrialEvidence,
} from '@agent-kernel/eval-protocol'
import { ControlPlaneClient } from '@agent-kernel/eval-sdk'

import { runControlPlaneLoop } from './control-plane-loop.js'

type Page<T> = { items: T[]; page: { hasMore: boolean; nextCursor?: string } }
type RunProjection = { accepted: { spec: { verification: { verifierId: string; verifierVersion: string; officialRequired: boolean } } } }
type TrialProjection = { trialId: string; taskId: string; agentVariantId: string; evidence?: TrialEvidence }

export class EvaluationGrader {
  constructor(private readonly options: {
    controlPlane: ControlPlaneClient
    executorId: string
    leaseMs: number
    pollIntervalMs?: number
    now?: () => Date
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
    throw options.signal.reason instanceof Error ? options.signal.reason : new Error('grader stopped')
  }

  async start(signal?: AbortSignal): Promise<void> {
    await runControlPlaneLoop({
      signal,
      pollIntervalMs: this.options.pollIntervalMs ?? 500,
      runOnce: async () => this.runUntilIdle({ idlePolls: 1, signal }),
    })
  }

  private async nextQueued(signal?: AbortSignal): Promise<AnalysisJob | null> {
    const response = await this.options.controlPlane.query({ resource: 'analysis-jobs', state: 'queued', kind: 'grading', page: { limit: 1 } }, signal) as Page<AnalysisJob>
    return response.items[0] ? AnalysisJobSchema.parse(response.items[0]) : null
  }

  private async execute(queued: AnalysisJob, signal?: AbortSignal): Promise<void> {
    try { await this.options.controlPlane.command(command('analysis.job.start', { jobId: queued.jobId, executorId: this.options.executorId, leaseMs: this.options.leaseMs }), signal) } catch { return }
    const controller = new AbortController(); const abort = () => controller.abort(signal?.reason ?? new Error('grader stopped'))
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort()
    let current: AnalysisJob | undefined
    let heartbeat = Promise.resolve()
    try {
      current = AnalysisJobSchema.parse(await this.options.controlPlane.query({ resource: 'analysis-job', jobId: queued.jobId }, controller.signal))
      heartbeat = this.heartbeat(current, controller.signal)
      const manifest = await this.process(current, controller.signal)
      await this.options.controlPlane.command(command('analysis.job.complete', { ...leaseAuthority(current), jobId: current.jobId, executorId: this.options.executorId, outputManifest: manifest }), controller.signal)
    } catch (error) {
      if (!controller.signal.aborted && current) await this.options.controlPlane.command(command('analysis.job.fail', { ...leaseAuthority(current), jobId: queued.jobId, executorId: this.options.executorId, failure: { code: 'GRADING_EXECUTION_FAILED', summary: safeMessage(error) } })).catch(() => undefined)
    } finally {
      controller.abort(new Error('grading job finished')); signal?.removeEventListener('abort', abort); await heartbeat
    }
  }

  private async heartbeat(job: AnalysisJob, signal: AbortSignal): Promise<void> {
    const interval = Math.max(100, Math.floor(this.options.leaseMs / 3))
    while (!signal.aborted) {
      await delay(interval, undefined, { signal }).catch(() => undefined)
      if (!signal.aborted) await this.options.controlPlane.command(command('analysis.job.heartbeat', { ...leaseAuthority(job), jobId: job.jobId, executorId: this.options.executorId, leaseMs: this.options.leaseMs }), signal)
    }
  }

  private async process(job: AnalysisJob, signal: AbortSignal): Promise<AnalysisOutputManifest> {
    if (job.kind !== 'grading') throw new Error('unsupported grading job kind: ' + job.kind)
    const run = await this.options.controlPlane.query({ resource: 'run', runId: job.runId }, signal) as RunProjection
    const page = await this.options.controlPlane.query({ resource: 'trials', runId: job.runId, state: 'completed', page: { limit: 500 } }, signal) as Page<TrialProjection>
    if (page.page.hasMore) throw new Error('grading run exceeds one canonical result page')
    const outputs: AnalysisOutputManifest['outputs'] = []
    for (const trial of page.items) {
      const result = await this.verifyTrial(job, run, trial, signal)
      outputs.push(await this.upload(job, result, signal))
    }
    const generatedAt = (this.options.now ?? (() => new Date()))().toISOString()
    const unsigned = { schemaVersion: 1 as const, jobId: job.jobId, runId: job.runId, inputManifestHash: job.inputManifestHash, generatedAt, outputs }
    return AnalysisOutputManifestSchema.parse({ ...unsigned, manifestHash: await sha256Hex(canonicalJson(unsigned)) })
  }

  private async verifyTrial(job: AnalysisJob, run: RunProjection, trial: TrialProjection, signal: AbortSignal): Promise<GradingResult> {
    const evidence = TrialEvidenceSchema.parse(trial.evidence)
    const policy = run.accepted.spec.verification
    if (evidence.runId !== job.runId || evidence.trialId !== trial.trialId || evidence.taskId !== trial.taskId || evidence.agentVariantId !== trial.agentVariantId) throw new Error('grading trial evidence authority mismatch')
    if (!job.inputRefs.includes('trial-result:' + evidence.resultHash)) throw new Error('grading job does not authorize trial result: ' + trial.trialId)
    if (evidence.benchmarkResult.verifierId !== policy.verifierId || evidence.benchmarkResult.verifierVersion !== policy.verifierVersion) throw new Error('grading verifier identity does not match immutable run spec')
    const raw = evidence.artifactManifest.entries.find((entry) => entry.path === evidence.benchmarkResult.rawResultRef)
    if (!raw) throw new Error('grading raw result is absent from canonical artifact manifest')
    const response = await fetch(this.options.controlPlane.baseUrl + '/api/v1/artifacts/' + encodeURIComponent(raw.artifactId) + '?trialId=' + encodeURIComponent(trial.trialId), { signal })
    if (!response.ok) throw new Error('cannot read canonical grader artifact: ' + trial.trialId)
    const content = new Uint8Array(await response.arrayBuffer())
    const rawHash = await sha256Hex(content)
    if (content.byteLength !== raw.bytes || rawHash !== raw.sha256) throw new Error('canonical grader artifact integrity mismatch: ' + trial.trialId)
    const official = evidence.evidenceLevel === 'official' && evidence.benchmarkResult.officialEvidence
    return GradingResultSchema.parse({
      schemaVersion: 1, jobId: job.jobId, runId: job.runId, trialId: trial.trialId, taskId: trial.taskId, agentVariantId: trial.agentVariantId,
      sourceResultHash: evidence.resultHash, sourceArtifactManifestHash: evidence.artifactManifest.manifestHash, rawArtifactSha256: rawHash,
      evidenceLevel: evidence.evidenceLevel, officialRequired: policy.officialRequired, eligible: !policy.officialRequired || official, benchmarkResult: evidence.benchmarkResult,
      verifiedAt: (this.options.now ?? (() => new Date()))().toISOString(),
    })
  }

  private async upload(job: AnalysisJob, result: GradingResult, signal: AbortSignal) {
    const content = Buffer.from(canonicalJson(result)); const sha256 = createHash('sha256').update(content).digest('hex')
    const outputId = 'grading-' + result.sourceResultHash.slice(0, 24)
    const artifactRef = 'analysis/' + job.jobId + '/' + outputId + '.json'
    await this.options.controlPlane.stageAnalysisArtifact({ ...leaseAuthority(job), jobId: job.jobId, executorId: this.options.executorId, path: artifactRef, mediaType: 'application/json', bytes: content.byteLength, sha256, content }, signal)
    return { outputId, kind: 'grading-result' as const, artifactRef, mediaType: 'application/json', bytes: content.byteLength, sha256 }
  }
}

function command<T extends string>(type: T, fields: Record<string, unknown>): any { const id = type.replaceAll('.', '-') + '-' + randomUUID(); return { schemaVersion: 1, type, commandId: id, idempotencyKey: id, submittedAt: new Date().toISOString(), ...fields } }
function leaseAuthority(job: AnalysisJob): { leaseToken: string; generation: number } { if (!job.leaseToken || !job.generation) throw new Error('analysis job lacks fenced lease authority'); return { leaseToken: job.leaseToken, generation: job.generation } }
function safeMessage(error: unknown): string { return (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/gu, ' ').slice(0, 500) || 'grading failed' }
