import { ControlPlaneClient, ControlPlaneHttpError, resolveCredentialProvider, type CredentialProviderLike } from '@agent-kernel/eval-sdk'
import { EvaluationEventSchema, type ControlPlaneCapabilities, type EvaluationCommand, type EvaluationEvent, type EvaluationQuery } from '@agent-kernel/eval-protocol'

export const SUPPORTED_PROTOCOLS = [1] as const

export type Page<T = unknown> = { items: T[]; page: { nextCursor?: string; hasMore: boolean; total?: number } }
type EventSourceLike = { addEventListener(type: string, listener: (event: Event) => void): void; close(): void }
type EventSourceFactory = (url: string) => EventSourceLike

export type DashboardRuntimeConfig = {
  controlPlaneUrl?: string
  controlPlaneAllowedOrigins?: string[]
  credentialProvider?: CredentialProviderLike
}

declare global {
  var __AGENT_EVAL_DASHBOARD__: DashboardRuntimeConfig | undefined
}

export type RunEventSubscription = {
  runId: string
  afterSequence: number
  retryMs?: number
  onEvent(event: EvaluationEvent): void
  onStateChange?(state: 'connected' | 'reconnecting'): void
}

export class DashboardControlPlane {
  readonly client: ControlPlaneClient
  private readonly eventSourceFactory: EventSourceFactory
  private readonly getToken?: () => Promise<string | undefined>
  private readonly sameOrigin: boolean

  constructor(baseUrl = dashboardControlPlaneUrl(), eventSourceFactory: EventSourceFactory = (url) => {
    const source = new EventSource(url)
    return { addEventListener: (type, listener) => source.addEventListener(type, listener), close: () => source.close() }
  }, credentialProvider = dashboardRuntimeConfig().credentialProvider, allowedOrigins = dashboardRuntimeConfig().controlPlaneAllowedOrigins) {
    const safeBaseUrl = allowedControlPlaneUrl(baseUrl, allowedOrigins)
    this.client = new ControlPlaneClient({ baseUrl: safeBaseUrl, credentialProvider })
    this.eventSourceFactory = eventSourceFactory
    this.getToken = credentialProvider ? resolveCredentialProvider(credentialProvider) : undefined
    this.sameOrigin = new URL(safeBaseUrl).origin === globalThis.location?.origin
  }

  async connect(signal?: AbortSignal): Promise<ControlPlaneCapabilities> {
    const capabilities = await this.client.capabilities(signal)
    if (!capabilities.protocolVersions.some((version) => SUPPORTED_PROTOCOLS.includes(version as 1))) {
      throw new Error('Unsupported Control Plane protocol. Dashboard supports v1.')
    }
    return capabilities
  }

  async query<T>(query: EvaluationQuery, signal?: AbortSignal): Promise<T> { return await this.client.query(query, signal) as T }
  async command(command: EvaluationCommand, signal?: AbortSignal) { return await this.client.command(command, signal) }
  async administrationStatus<T>(signal?: AbortSignal): Promise<T> { return await this.administrationRequest<T>('/api/v1/administration/status', { method: 'GET', signal }) }
  async reloadSecurity<T>(confirmation: string, signal?: AbortSignal): Promise<T> { return await this.administrationRequest<T>('/api/v1/administration/security/reload', { method: 'POST', signal, body: JSON.stringify({ confirmation }) }) }
  artifactUrl(artifactId: string, trialId: string): string {
    const url = new URL(this.client.baseUrl + '/api/v1/artifacts/' + encodeURIComponent(artifactId))
    url.searchParams.set('trialId', trialId)
    return url.toString()
  }
  reportUrl(reportId: string, format: string): string {
    return this.client.baseUrl + '/api/v1/reports/' + encodeURIComponent(reportId) + '/' + encodeURIComponent(format)
  }
  archiveDocumentUrl(documentId: string): string {
    return this.client.archiveDocumentUrl(documentId)
  }
  async artifactText(artifactId: string, trialId: string, signal?: AbortSignal): Promise<string> {
    const response = await this.authenticatedFetch(this.artifactUrl(artifactId, trialId), { signal, headers: { accept: 'application/x-ndjson, application/json, text/plain' } })
    if (!response.ok) throw new ControlPlaneHttpError(response.status, 'HTTP_ERROR', 'Artifact request failed')
    return await response.text()
  }
  async artifactBlob(artifactId: string, trialId: string, signal?: AbortSignal): Promise<Blob> {
    const response = await this.authenticatedFetch(this.artifactUrl(artifactId, trialId), { signal })
    if (!response.ok) throw new ControlPlaneHttpError(response.status, 'HTTP_ERROR', 'Artifact request failed')
    return await response.blob()
  }
  async reportBlob(reportId: string, format: string, signal?: AbortSignal): Promise<Blob> {
    const response = await this.authenticatedFetch(this.reportUrl(reportId, format), { signal })
    if (!response.ok) throw new ControlPlaneHttpError(response.status, 'HTTP_ERROR', 'Report request failed')
    return await response.blob()
  }
  async archiveDocumentBlob(documentId: string, signal?: AbortSignal): Promise<Blob> {
    const response = await this.authenticatedFetch(this.archiveDocumentUrl(documentId), { signal })
    if (!response.ok) throw new ControlPlaneHttpError(response.status, 'HTTP_ERROR', 'Archive document request failed')
    return await response.blob()
  }

  private async authenticatedFetch(url: string, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers)
    const token = await this.getToken?.()
    if (token) headers.set('authorization', 'Bearer ' + token)
    return await fetch(url, { ...init, headers, credentials: 'same-origin' })
  }

  private async administrationRequest<T>(path: string, init: RequestInit): Promise<T> {
    const headers = new Headers(init.headers); headers.set('accept', 'application/json'); if (init.body) headers.set('content-type', 'application/json')
    const token = await this.getToken?.(); if (token) headers.set('authorization', 'Bearer ' + token)
    const response = await fetch(this.client.baseUrl + path, { ...init, headers })
    const body = await response.json() as { code?: string; message?: string }
    if (!response.ok) throw new ControlPlaneHttpError(response.status, body.code ?? 'HTTP_ERROR', body.message ?? 'Administration request failed')
    return body as T
  }

  subscribeRunEvents(subscription: RunEventSubscription): () => void {
    if (!this.sameOrigin) {
      throw new Error('Cross-origin live events are disabled because EventSource cannot attach dashboard credentials.')
    }
    let stopped = false
    let source: EventSourceLike | undefined
    let retry: ReturnType<typeof setTimeout> | undefined
    let afterSequence = subscription.afterSequence
    const reconnect = () => {
      if (stopped || retry) return
      subscription.onStateChange?.('reconnecting')
      retry = setTimeout(() => { retry = undefined; connect() }, subscription.retryMs ?? 500)
    }
    const connect = () => {
      if (stopped) return
      const url = new URL(this.client.baseUrl + '/api/v1/events')
      url.searchParams.set('runId', subscription.runId)
      url.searchParams.set('after', String(afterSequence))
      const current = this.eventSourceFactory(url.toString())
      source = current
      current.addEventListener('open', () => { if (source === current && !stopped) subscription.onStateChange?.('connected') })
      current.addEventListener('durable-event', (message) => {
        if (source !== current || stopped || !(message instanceof MessageEvent)) return
        try {
          const event = EvaluationEventSchema.parse(JSON.parse(String(message.data)))
          if (event.runId !== subscription.runId || event.sequence <= afterSequence) return
          if (event.sequence !== afterSequence + 1) { current.close(); reconnect(); return }
          afterSequence = event.sequence
          subscription.onEvent(event)
        } catch {
          current.close()
          reconnect()
        }
      })
      current.addEventListener('error', () => {
        if (source !== current || stopped) return
        current.close()
        reconnect()
      })
    }
    connect()
    return () => {
      stopped = true
      if (retry) clearTimeout(retry)
      source?.close()
    }
  }
}

export function dashboardControlPlaneUrl(): string {
  const runtime = dashboardRuntimeConfig()
  const configured = new URLSearchParams(globalThis.location?.search ?? '').get('controlPlane') ?? runtime.controlPlaneUrl
  return allowedControlPlaneUrl(configured ?? globalThis.location?.origin ?? 'http://127.0.0.1:13100', runtime.controlPlaneAllowedOrigins)
}

export function allowedControlPlaneUrl(value: string, allowedOrigins: readonly string[] = []): string {
  let url: URL
  try { url = new URL(value, globalThis.location?.origin) } catch { throw new Error('Control Plane configuration is invalid.') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Control Plane configuration is not allowed.')
  const sameOrigin = Boolean(globalThis.location?.origin) && url.origin === globalThis.location.origin
  const allowlist = allowedOrigins.map((origin) => {
    try { return new URL(origin).origin } catch { return '' }
  })
  if (!sameOrigin && !allowlist.includes(url.origin)) throw new Error('Control Plane configuration is not allowed.')
  return url.toString().replace(/\/$/u, '')
}

export function errorMessage(error: unknown): string {
  if (error instanceof ControlPlaneHttpError && error.status === 401) return 'Sign in to continue.'
  if (error instanceof ControlPlaneHttpError && error.status === 403) return 'You do not have permission to perform this action.'
  if (error instanceof ControlPlaneHttpError && error.status === 409) return 'This item changed while the action was in progress. Refresh the page and try again.'
  if (error instanceof ControlPlaneHttpError && error.status >= 500) return 'The evaluation service could not complete the request. Try again in a moment.'
  if (error instanceof ControlPlaneHttpError) return 'The requested action could not be completed.'
  const raw = error instanceof Error ? error.message : String(error)
  if (/unsupported(?:\s+control\s+plane)?\s+protocol/i.test(raw))
    return 'This dashboard is not compatible with the connected evaluation service. Update the dashboard or service before continuing.'
  const messages = validationMessages(raw)
  if (messages.some((message) => message.includes('fenced lease authority')))
    return 'This analysis job was started by a worker that no longer owns its lease. Select an active run and start a new analysis.'
  if (messages.length) return messages.map(humanValidationMessage).join(' ')
  if (/network|fetch|connection/i.test(raw)) return 'The evaluation service is not reachable. Check the connection and try again.'
  return 'The requested action could not be completed. Review the selected values and try again.'
}

function validationMessages(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((issue) => {
      if (!issue || typeof issue !== 'object') return []
      const message = (issue as Record<string, unknown>).message
      return typeof message === 'string' ? [message] : []
    })
  } catch { return [] }
}

function humanValidationMessage(message: string): string {
  return message
    .replace(/\bids?\b/gi, 'selection')
    .replace(/\brequired\b/gi, 'is required')
    .replace(/^./, (letter) => letter.toUpperCase())
    .replace(/\.?$/, '.')
}

function dashboardRuntimeConfig(): DashboardRuntimeConfig {
  return globalThis.__AGENT_EVAL_DASHBOARD__ ?? {}
}
