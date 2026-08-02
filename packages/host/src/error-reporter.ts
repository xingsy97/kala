import { operationalError, type OperationalError } from './operational-metrics.js'

export interface ErrorReporter { capture(error: OperationalError): Promise<{ eventId?: string }> }
export class GlitchTipErrorReporter implements ErrorReporter {
  constructor(private readonly options: { endpoint: string; projectKey: string; release?: string; fetchImpl?: typeof fetch }) {}
  async capture(input: OperationalError): Promise<{ eventId?: string }> {
    const error = operationalError(input)
    const eventId = crypto.randomUUID().replace(/-/gu, '')
    const response = await (this.options.fetchImpl ?? fetch)(this.options.endpoint, { method: 'POST', headers: { 'content-type': 'application/json', 'x-sentry-auth': `Sentry sentry_key=${this.options.projectKey}, sentry_version=7` }, body: JSON.stringify({ event_id: eventId, level: 'error', release: this.options.release, message: error.safeMessage, tags: { component: error.component, operation: error.operation, error_code: error.code }, extra: { retryable: error.retryable, correlationId: error.correlationId } }) })
    return response.ok ? { eventId } : {}
  }
}
