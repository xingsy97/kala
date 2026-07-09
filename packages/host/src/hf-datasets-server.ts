const DEFAULT_BASE_URL = 'https://datasets-server.huggingface.co'
const MAX_ROWS_PER_REQUEST = 100
const DEFAULT_RETRIES = 3
const DEFAULT_BASE_DELAY_MS = 1000
const DEFAULT_MAX_DELAY_MS = 60_000
const DEFAULT_TIMEOUT_MS = 30_000

export type HuggingFaceFetchInput = {
  datasetRef: string
  config?: string
  split?: string
  limit?: number
  hfToken?: string
  baseUrl?: string
  fetchImpl?: typeof fetch
  retries?: number
  timeoutMs?: number
  onRetry?: (attempt: number, reason: string) => void
}

export type HuggingFaceFetchResult = {
  rows: Array<Record<string, unknown>>
  totalRows: number
  datasetRef: string
  config: string
  split: string
  requestedLimit?: number
  requestCount: number
}

type RowsResponse = {
  rows: Array<{ row_idx: number; row: Record<string, unknown> }>
  num_rows_total?: number
}

export async function fetchHuggingFaceRows(
  input: HuggingFaceFetchInput,
): Promise<HuggingFaceFetchResult> {
  if (!input.datasetRef.trim()) throw new Error('datasetRef is required')
  const config = input.config?.trim() || 'default'
  const split = input.split?.trim() || 'test'
  const baseUrl = (input.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
  const fetchImpl = input.fetchImpl ?? fetch
  const retries = input.retries ?? DEFAULT_RETRIES
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const rows: Array<Record<string, unknown>> = []
  let offset = 0
  let totalRows = 0
  let requestCount = 0
  while (true) {
    const remaining = input.limit === undefined ? MAX_ROWS_PER_REQUEST : input.limit - rows.length
    if (remaining <= 0) break
    const length = Math.min(MAX_ROWS_PER_REQUEST, remaining)
    const url = new URL(`${baseUrl}/rows`)
    url.searchParams.set('dataset', input.datasetRef)
    url.searchParams.set('config', config)
    url.searchParams.set('split', split)
    url.searchParams.set('offset', String(offset))
    url.searchParams.set('length', String(length))
    const payload = await fetchWithRetry(url.toString(), {
      fetchImpl,
      hfToken: input.hfToken,
      retries,
      timeoutMs,
      onRetry: input.onRetry,
    })
    requestCount += 1
    if (typeof payload.num_rows_total === 'number') totalRows = payload.num_rows_total
    for (const entry of payload.rows) {
      if (input.limit !== undefined && rows.length >= input.limit) break
      rows.push(entry.row)
    }
    if (payload.rows.length === 0) break
    offset += payload.rows.length
    if (payload.rows.length < length) break
    if (input.limit === undefined && totalRows > 0 && offset >= totalRows) break
  }
  return {
    rows,
    totalRows: totalRows || rows.length,
    datasetRef: input.datasetRef,
    config,
    split,
    ...(input.limit !== undefined ? { requestedLimit: input.limit } : {}),
    requestCount,
  }
}

async function fetchWithRetry(
  url: string,
  options: {
    fetchImpl: typeof fetch
    hfToken?: string
    retries: number
    timeoutMs: number
    onRetry?: (attempt: number, reason: string) => void
  },
): Promise<RowsResponse> {
  let lastError: string | undefined
  for (let attempt = 1; attempt <= options.retries + 1; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), options.timeoutMs)
    try {
      const response = await options.fetchImpl(url, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          'user-agent': 'agent-kernel-host',
          ...(options.hfToken ? { authorization: `Bearer ${options.hfToken}` } : {}),
        },
        signal: controller.signal,
      })
      clearTimeout(timer)
      if (response.ok) return (await response.json()) as RowsResponse
      const bodyText = await safeReadText(response)
      const shortBody = bodyText.slice(0, 200)
      if (response.status === 429 || response.status >= 500) {
        lastError = `huggingface datasets-server ${response.status}: ${shortBody}`
        if (attempt > options.retries) break
        const delayMs = computeBackoffMs(response, attempt)
        options.onRetry?.(attempt, `status ${response.status}`)
        await delay(delayMs)
        continue
      }
      throw new NonRetriableHttpError(`huggingface datasets-server ${response.status}: ${shortBody}`)
    } catch (err) {
      clearTimeout(timer)
      if (err instanceof NonRetriableHttpError) throw err
      const message = err instanceof Error ? err.message : String(err)
      lastError = message
      if (attempt > options.retries) break
      options.onRetry?.(attempt, message)
      await delay(computeBackoffMs(undefined, attempt))
    }
  }
  throw new Error(lastError ?? 'huggingface datasets-server request failed')
}

function computeBackoffMs(response: Response | undefined, attempt: number): number {
  const header = response?.headers.get('ratelimit') ?? response?.headers.get('RateLimit')
  if (header) {
    const match = /t=(\d+)/.exec(header)
    if (match) {
      const seconds = Number(match[1])
      if (Number.isFinite(seconds) && seconds > 0) {
        return Math.min(seconds * 1000, DEFAULT_MAX_DELAY_MS)
      }
    }
  }
  const raw = DEFAULT_BASE_DELAY_MS * Math.pow(2, attempt - 1)
  return Math.min(raw, DEFAULT_MAX_DELAY_MS)
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text()
  } catch {
    return ''
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

class NonRetriableHttpError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NonRetriableHttpError'
  }
}
