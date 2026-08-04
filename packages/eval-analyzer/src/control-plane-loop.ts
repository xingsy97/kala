import { setTimeout as delay } from 'node:timers/promises'

const TRANSIENT_CONNECTION_CODES = new Set([
  'EAI_AGAIN',
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'ENETDOWN',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
])

export async function runControlPlaneLoop(options: {
  signal?: AbortSignal
  pollIntervalMs: number
  runOnce: () => Promise<void>
}): Promise<void> {
  while (!options.signal?.aborted) {
    try {
      await options.runOnce()
    } catch (error) {
      if (options.signal?.aborted) return
      if (!isTransientControlPlaneConnectionError(error)) throw error
    }
    await delay(
      options.pollIntervalMs,
      undefined,
      options.signal ? { signal: options.signal } : undefined,
    ).catch(() => undefined)
  }
}

export function isTransientControlPlaneConnectionError(error: unknown): boolean {
  let current: unknown = error
  const seen = new Set<unknown>()
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current)
    const record = current as { cause?: unknown; code?: unknown; message?: unknown; status?: unknown }
    if (typeof record.code === 'string' && TRANSIENT_CONNECTION_CODES.has(record.code)) return true
    if (typeof record.status === 'number' && [502, 503, 504].includes(record.status)) return true
    if (current instanceof TypeError && record.message === 'fetch failed' && record.cause === undefined) return true
    current = record.cause
  }
  return false
}
