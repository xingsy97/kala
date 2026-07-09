export type ProviderErrorInput = {
  provider: string
  endpoint: string
  status?: number
  bodyText?: string
  cause?: unknown
}

export class ProviderHTTPError extends Error {
  readonly label?: string

  constructor(readonly input: Required<Pick<ProviderErrorInput, 'provider' | 'endpoint' | 'status'>> & Pick<ProviderErrorInput, 'bodyText'>) {
    super(`${input.provider} HTTP ${input.status} calling ${safeEndpoint(input.endpoint)}: ${trimDetail(input.bodyText)}`)
    this.name = `${input.provider.replace(/\W+/gu, '')}HTTPError`
  }
}

export class ProviderNetworkError extends Error {
  readonly label = 'retryable'

  constructor(readonly input: Required<Pick<ProviderErrorInput, 'provider' | 'endpoint'>> & Pick<ProviderErrorInput, 'cause'>) {
    super(`${input.provider} network error calling ${safeEndpoint(input.endpoint)}: ${networkDetail(input.cause)}`)
    this.name = `${input.provider.replace(/\W+/gu, '')}NetworkError`
    if (input.cause !== undefined) this.cause = input.cause
  }
}

export function wrapProviderFetchError(provider: string, endpoint: string, err: unknown): never {
  if (err instanceof Error && err.name === 'AbortError') throw err
  throw new ProviderNetworkError({ provider, endpoint, cause: err })
}

export function safeEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint)
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return endpoint.split('?')[0] ?? endpoint
  }
}

function trimDetail(text: string | undefined): string {
  const clean = (text ?? '').replace(/\s+/gu, ' ').trim()
  return clean.length > 0 ? clean.slice(0, 500) : 'empty response body'
}

function networkDetail(cause: unknown): string {
  if (cause instanceof Error) {
    const nested = errorCause(cause)
    const detail = nested ? `${cause.message} (cause: ${nested})` : cause.message
    return detail || cause.name
  }
  if (typeof cause === 'string') return cause
  return 'request failed before receiving an HTTP response'
}

function errorCause(err: Error): string | undefined {
  const cause = err.cause
  if (cause instanceof Error) return [errorCode(cause), cause.message].filter(Boolean).join(' ')
  if (cause && typeof cause === 'object') {
    const record = cause as Record<string, unknown>
    return [stringField(record, 'code'), stringField(record, 'message')].filter(Boolean).join(' ')
  }
  if (typeof cause === 'string') return cause
  return undefined
}

function errorCode(err: Error): string | undefined {
  const code = (err as Error & { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}
