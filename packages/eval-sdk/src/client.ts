import {
  AnalysisJobSchema, AnalysisOutputManifestSchema, ArchiveDocumentSummarySchema, ArchivedRunDetailSchema, ArchivedRunSummarySchema,
  ArchiveSummarySchema, ArtifactEntrySchema, CapabilityVectorSchema, CommittedAcknowledgementSchema, ControlPlaneCapabilitiesSchema,
  EvaluationCommandSchema, EvaluationEventSchema, EvaluationQuerySchema, LeaderboardEntrySchema, PlatformMetricsSnapshotSchema,
  ReportManifestSchema, WorkerRegistrationSchema, LeaseHeartbeatSchema, TrialLeaseSchema, TrialProgressUpdateSchema, TrialResultCommitSchema,
  type ArtifactEntry, type CommittedAcknowledgement, type ControlPlaneCapabilities, type EvaluationCommand, type EvaluationQuery,
  type EvaluationEvent, type LeaseHeartbeat, type TrialLease, type TrialProgressUpdate, type TrialResultCommit, type WorkerRegistration,
} from '@agent-kernel/eval-protocol'

import { resolveCredentialProvider, type CredentialProviderLike } from './credentials.js'

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
export type RequestOptions = AbortSignal | { signal?: AbortSignal; deadlineMs?: number }
export type WatchOptions = { signal?: AbortSignal; lastEventId?: string | number }
export type Page<T> = { items: T[]; page: { nextCursor?: string; hasMore: boolean; total?: number } }
export type CommandInput = EvaluationCommand | (Omit<EvaluationCommand, 'schemaVersion' | 'commandId' | 'idempotencyKey' | 'submittedAt'> & Partial<Pick<EvaluationCommand, 'schemaVersion' | 'commandId' | 'idempotencyKey' | 'submittedAt'>>)

export type QueryResponse<Q extends EvaluationQuery> =
  Q['resource'] extends 'capabilities' ? ControlPlaneCapabilities :
  Q['resource'] extends 'platform-metrics' ? ReturnType<typeof PlatformMetricsSnapshotSchema.parse> :
  Q['resource'] extends 'events' ? Page<EvaluationEvent> :
  Q['resource'] extends 'artifacts' ? Page<ArtifactEntry> :
  Q['resource'] extends 'leaderboard' ? Page<ReturnType<typeof LeaderboardEntrySchema.parse>> & { pivot: string; rankingGroups: string[] } :
  Q['resource'] extends 'analysis-jobs' ? Page<ReturnType<typeof AnalysisJobSchema.parse>> :
  Q['resource'] extends 'analysis-job' ? ReturnType<typeof AnalysisJobSchema.parse> | null :
  Q['resource'] extends 'analysis-output' ? ReturnType<typeof AnalysisOutputManifestSchema.parse> | null :
  Q['resource'] extends 'capability-vectors' ? Page<ReturnType<typeof CapabilityVectorSchema.parse>> :
  Q['resource'] extends 'reports' ? Page<ReturnType<typeof ReportManifestSchema.parse>> :
  Q['resource'] extends 'archive-summary' ? ReturnType<typeof ArchiveSummarySchema.parse> :
  Q['resource'] extends 'archived-runs' ? Page<ReturnType<typeof ArchivedRunSummarySchema.parse>> :
  Q['resource'] extends 'archived-run' ? ReturnType<typeof ArchivedRunDetailSchema.parse> | null :
  Q['resource'] extends 'archive-documents' ? Page<ReturnType<typeof ArchiveDocumentSummarySchema.parse>> : unknown

export class ControlPlaneHttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
    this.name = 'ControlPlaneHttpError'
  }
}

export class ControlPlaneDeadlineError extends Error {
  readonly code = 'DEADLINE_EXCEEDED'
  constructor(readonly deadlineMs: number) { super(`Control Plane request exceeded ${deadlineMs}ms deadline`); this.name = 'ControlPlaneDeadlineError' }
}

export class ArtifactIntegrityError extends Error {
  readonly code = 'ARTIFACT_INTEGRITY_ERROR'
  constructor(message: string) { super(message); this.name = 'ArtifactIntegrityError' }
}

export class ControlPlaneClient {
  readonly baseUrl: string
  readonly deadlineMs: number
  private readonly fetchImpl: FetchLike
  private readonly getToken?: () => Promise<string | undefined>

  constructor(options: { baseUrl: string; fetchImpl?: FetchLike; credentialProvider?: CredentialProviderLike; deadlineMs?: number }) {
    this.baseUrl = options.baseUrl.replace(/\/$/u, '')
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis)
    this.getToken = options.credentialProvider ? resolveCredentialProvider(options.credentialProvider) : undefined
    this.deadlineMs = validDeadline(options.deadlineMs ?? 30_000)
  }

  async capabilities(options?: RequestOptions): Promise<ControlPlaneCapabilities> {
    return ControlPlaneCapabilitiesSchema.parse(await this.request('/api/v1/capabilities', { method: 'GET' }, options))
  }

  async command(input: CommandInput, options?: RequestOptions & { idempotencyKey?: string }): Promise<CommittedAcknowledgement> {
    const supplied = input as Record<string, unknown>
    const commandId = typeof supplied.commandId === 'string' ? supplied.commandId : crypto.randomUUID()
    const optionKey = !(options instanceof AbortSignal) ? options?.idempotencyKey : undefined
    const body = EvaluationCommandSchema.parse({ schemaVersion: 1, commandId, idempotencyKey: optionKey ?? supplied.idempotencyKey ?? commandId, submittedAt: supplied.submittedAt ?? new Date().toISOString(), ...supplied })
    return CommittedAcknowledgementSchema.parse(await this.request('/api/v1/commands', { method: 'POST', body: JSON.stringify(body) }, options))
  }

  async query<Q extends EvaluationQuery>(input: Q, options?: RequestOptions): Promise<QueryResponse<Q>> {
    const query = EvaluationQuerySchema.parse(input)
    return parseQueryResponse(query, await this.request('/api/v1/query', { method: 'POST', body: JSON.stringify(query) }, options)) as QueryResponse<Q>
  }

  async *watchEvents(runId: string, options: WatchOptions = {}): AsyncGenerator<EvaluationEvent> {
    const headers = new Headers({ accept: 'text/event-stream' })
    if (options.lastEventId !== undefined) headers.set('last-event-id', String(options.lastEventId))
    await this.authorize(headers)
    const response = await this.fetchImpl(`${this.baseUrl}/api/v1/events?runId=${encodeURIComponent(runId)}`, { method: 'GET', headers, signal: options.signal })
    if (!response.ok) throw await responseError(response)
    if (!response.body) throw new ControlPlaneHttpError(response.status, 'INVALID_SSE_RESPONSE', 'Control Plane returned an empty event stream')
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
    let buffer = ''
    try {
      while (true) {
        const { value, done } = await reader.read(); if (done) break
        buffer += value
        const frames = buffer.split(/\r?\n\r?\n/u); buffer = frames.pop() ?? ''
        for (const frame of frames) {
          let event = 'message'; const data: string[] = []
          for (const line of frame.split(/\r?\n/u)) {
            if (line.startsWith('event:')) event = line.slice(6).trim()
            else if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
          }
          if (!data.length) continue
          const parsed = parseJson(data.join('\n'), response.status)
          if (event === 'error') { const error = asRecord(parsed); throw new ControlPlaneHttpError(404, stringValue(error.code, 'SSE_ERROR'), stringValue(error.message, 'Control Plane event stream failed')) }
          yield EvaluationEventSchema.parse(parsed)
        }
      }
    } finally { reader.releaseLock() }
  }

  archiveDocumentUrl(documentId: string): string { return this.baseUrl + '/api/v1/archive-documents/' + encodeURIComponent(documentId) }

  async downloadArtifact(entry: ArtifactEntry, trialId: string, options?: RequestOptions): Promise<Uint8Array> {
    const artifact = ArtifactEntrySchema.parse(entry)
    const bytes = await this.download(`/api/v1/artifacts/${encodeURIComponent(artifact.artifactId)}?trialId=${encodeURIComponent(trialId)}`, options)
    if (bytes.byteLength !== artifact.bytes) throw new ArtifactIntegrityError(`artifact byte count mismatch: expected ${artifact.bytes}, received ${bytes.byteLength}`)
    const digest = await sha256(bytes)
    if (digest !== artifact.sha256) throw new ArtifactIntegrityError(`artifact SHA-256 mismatch: expected ${artifact.sha256}, received ${digest}`)
    return bytes
  }

  async registerWorker(worker: WorkerRegistration, options?: RequestOptions): Promise<WorkerRegistration> { const body = WorkerRegistrationSchema.parse(worker); return WorkerRegistrationSchema.parse(await this.request('/api/v1/workers/register', { method: 'POST', body: JSON.stringify(body) }, options)) }
  async heartbeatWorker(workerId: string, options?: RequestOptions): Promise<void> { await this.request('/api/v1/workers/heartbeat', { method: 'POST', body: JSON.stringify({ workerId }) }, options) }
  async acquireLease(workerId: string, leaseMs: number, options?: RequestOptions): Promise<TrialLease | null> { const result = await this.request('/api/v1/leases/acquire', { method: 'POST', body: JSON.stringify({ workerId, leaseMs }) }, options); return result === null ? null : TrialLeaseSchema.parse(result) }
  async heartbeatLease(heartbeat: LeaseHeartbeat, executionReceipt: 'none' | 'known' | 'indeterminate', options?: RequestOptions): Promise<LeaseHeartbeat> { const body = LeaseHeartbeatSchema.parse(heartbeat); return LeaseHeartbeatSchema.parse(await this.request('/api/v1/leases/heartbeat', { method: 'POST', body: JSON.stringify({ heartbeat: body, executionReceipt }) }, options)) }
  async progressTrial(update: TrialProgressUpdate, options?: RequestOptions): Promise<EvaluationEvent> { const body = TrialProgressUpdateSchema.parse(update); return EvaluationEventSchema.parse(await this.request('/api/v1/leases/progress', { method: 'POST', body: JSON.stringify(body) }, options)) }
  async commitTrialResult(commit: TrialResultCommit, options?: RequestOptions): Promise<TrialResultCommit> { const body = TrialResultCommitSchema.parse(commit); return TrialResultCommitSchema.parse(await this.request('/api/v1/results/commit', { method: 'POST', body: JSON.stringify(body) }, options)) }
  async expireLeases(options?: RequestOptions): Promise<number> { const result = asRecord(await this.request('/api/v1/leases/expire', { method: 'POST', body: '{}' }, options)); if (typeof result.expired !== 'number') throw new Error('invalid lease expiry response'); return result.expired }
  async stageTrialArtifact(input: { leaseId: string; commitToken: string; path: string; mediaType: string; bytes: number; sha256: string; content: Uint8Array }, options?: RequestOptions): Promise<void> { await this.upload('/api/v1/artifacts/stage/trial', input, { leaseId: input.leaseId, commitToken: input.commitToken }, options) }
  async stageAnalysisArtifact(input: { jobId: string; executorId: string; path: string; mediaType: string; bytes: number; sha256: string; content: Uint8Array }, options?: RequestOptions): Promise<void> { await this.upload('/api/v1/artifacts/stage/analysis', input, { jobId: input.jobId, executorId: input.executorId }, options) }
  async expireAnalysisJobs(options?: RequestOptions): Promise<number> { const result = asRecord(await this.request('/api/v1/analysis/expire', { method: 'POST', body: '{}' }, options)); if (typeof result.expired !== 'number') throw new Error('invalid analysis expiry response'); return result.expired }

  private async upload(path: string, artifact: { path: string; mediaType: string; bytes: number; sha256: string; content: Uint8Array }, authority: Record<string, string>, options?: RequestOptions): Promise<void> {
    const headers = new Headers({ 'content-type': 'application/octet-stream', accept: 'application/json', 'x-agent-eval-artifact-path': artifact.path, 'x-agent-eval-artifact-media-type': artifact.mediaType, 'x-agent-eval-artifact-bytes': String(artifact.bytes), 'x-agent-eval-artifact-sha256': artifact.sha256 })
    for (const [name, value] of Object.entries(authority)) headers.set('x-agent-eval-' + name.replace(/[A-Z]/gu, (letter) => '-' + letter.toLowerCase()), value)
    await this.authorize(headers)
    const deadline = deadlineSignal(options, this.deadlineMs)
    try { const response = await this.fetchImpl(this.baseUrl + path, { method: 'PUT', headers, body: new Uint8Array(artifact.content).buffer, signal: deadline.signal }); if (!response.ok) throw await responseError(response) } catch (error) { throw deadline.map(error) } finally { deadline.dispose() }
  }

  private async download(path: string, options?: RequestOptions): Promise<Uint8Array> {
    const headers = new Headers(); await this.authorize(headers); const deadline = deadlineSignal(options, this.deadlineMs)
    try { const response = await this.fetchImpl(this.baseUrl + path, { headers, signal: deadline.signal }); if (!response.ok) throw await responseError(response); return new Uint8Array(await response.arrayBuffer()) } catch (error) { throw deadline.map(error) } finally { deadline.dispose() }
  }

  private async request(path: string, init: RequestInit, options?: RequestOptions): Promise<unknown> {
    const headers = new Headers(init.headers); if (init.body !== undefined) headers.set('content-type', 'application/json'); headers.set('accept', 'application/json'); await this.authorize(headers)
    const deadline = deadlineSignal(options, this.deadlineMs)
    try { const response = await this.fetchImpl(this.baseUrl + path, { ...init, headers, signal: deadline.signal }); const text = await response.text(); const body = text ? parseJson(text, response.status) : null; if (!response.ok) throw httpError(response.status, body); return body } catch (error) { throw deadline.map(error) } finally { deadline.dispose() }
  }

  private async authorize(headers: Headers): Promise<void> { const token = await this.getToken?.(); if (token) headers.set('authorization', 'Bearer ' + token) }
}

function parseQueryResponse(query: EvaluationQuery, body: unknown): unknown {
  switch (query.resource) {
    case 'capabilities': return ControlPlaneCapabilitiesSchema.parse(body)
    case 'platform-metrics': return PlatformMetricsSnapshotSchema.parse(body)
    case 'events': return parsePage(body, EvaluationEventSchema)
    case 'artifacts': return parsePage(body, ArtifactEntrySchema)
    case 'leaderboard': { const value = asRecord(body); return { ...parsePage(value, LeaderboardEntrySchema), pivot: requiredString(value, 'pivot'), rankingGroups: stringArray(value.rankingGroups) } }
    case 'analysis-jobs': return parsePage(body, AnalysisJobSchema)
    case 'analysis-job': return body === null ? null : AnalysisJobSchema.parse(body)
    case 'analysis-output': return body === null ? null : AnalysisOutputManifestSchema.parse(body)
    case 'capability-vectors': return parsePage(body, CapabilityVectorSchema)
    case 'reports': return parsePage(body, ReportManifestSchema)
    case 'archive-summary': return ArchiveSummarySchema.parse(body)
    case 'archived-runs': return parsePage(body, ArchivedRunSummarySchema)
    case 'archived-run': return body === null ? null : ArchivedRunDetailSchema.parse(body)
    case 'archive-documents': return parsePage(body, ArchiveDocumentSummarySchema)
    default: return validateGenericResponse(query.resource, body)
  }
}

function parsePage<T>(body: unknown, schema: { parse(value: unknown): T }): Page<T> { const value = asRecord(body); const page = asRecord(value.page); if (!Array.isArray(value.items) || typeof page.hasMore !== 'boolean') throw new Error('invalid paginated query response'); return { items: value.items.map((item) => schema.parse(item)), page: { hasMore: page.hasMore, ...(typeof page.nextCursor === 'string' ? { nextCursor: page.nextCursor } : {}), ...(typeof page.total === 'number' ? { total: page.total } : {}) } } }
function validateGenericResponse(resource: string, body: unknown): unknown { if (['run', 'trial', 'task', 'analysis-job', 'analysis-output', 'deletion-impact', 'archived-run', 'archive-document'].includes(resource)) { if (body !== null) asRecord(body); return body } if (['runs', 'trials', 'catalog', 'defects', 'failure-cluster-promotions', 'reproductions', 'regressions', 'regression-decisions', 'insights', 'audit', 'retention', 'workers', 'run-templates'].includes(resource)) return parsePage(body, { parse: asRecord }); return body }
function validDeadline(value: number): number { if (!Number.isFinite(value) || value <= 0) throw new TypeError('deadlineMs must be a positive finite number'); return value }
function deadlineSignal(options: RequestOptions | undefined, fallback: number): { signal: AbortSignal; dispose(): void; map(error: unknown): unknown } { const external = options instanceof AbortSignal ? options : options?.signal; const ms = validDeadline(options instanceof AbortSignal ? fallback : options?.deadlineMs ?? fallback); const controller = new AbortController(); let expired = false; const timer = setTimeout(() => { expired = true; controller.abort() }, ms); const abort = () => controller.abort(external?.reason); external?.addEventListener('abort', abort, { once: true }); return { signal: controller.signal, dispose: () => { clearTimeout(timer); external?.removeEventListener('abort', abort) }, map: (error) => expired ? new ControlPlaneDeadlineError(ms) : error } }
async function responseError(response: Response): Promise<ControlPlaneHttpError> { const text = await response.text(); return httpError(response.status, text ? parseJson(text, response.status) : null) }
function httpError(status: number, body: unknown): ControlPlaneHttpError { const error = body && typeof body === 'object' ? body as Record<string, unknown> : {}; return new ControlPlaneHttpError(status, stringValue(error.code, 'HTTP_ERROR'), stringValue(error.message, 'Control Plane request failed')) }
function parseJson(text: string, status: number): unknown { try { return JSON.parse(text) } catch { throw new ControlPlaneHttpError(status, 'INVALID_JSON_RESPONSE', 'Control Plane returned invalid JSON') } }
function asRecord(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid object response'); return value as Record<string, unknown> }
function requiredString(value: Record<string, unknown>, key: string): string { if (typeof value[key] !== 'string') throw new Error(`invalid ${key} in response`); return value[key] }
function stringValue(value: unknown, fallback: string): string { return typeof value === 'string' ? value : fallback }
function stringArray(value: unknown): string[] { if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new Error('invalid string array response'); return value }
async function sha256(bytes: Uint8Array): Promise<string> { const copy = new Uint8Array(bytes); const digest = await crypto.subtle.digest('SHA-256', copy.buffer); return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('') }
