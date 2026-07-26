import type { ProviderSpec } from '../runtime-config.js'
import type { ProviderModelMetadata } from './types.js'

const LIMIT_KEYS = ['context_window', 'context_length', 'max_context_length', 'max_model_len'] as const

export async function discoverProviderModelMetadata(
  providers: readonly ProviderSpec[],
  options: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<readonly ProviderModelMetadata[]> {
  const fetchImpl = options.fetch ?? globalThis.fetch
  const timeoutMs = options.timeoutMs ?? 5_000
  const discovered = await Promise.all(providers.map(async (provider) => {
    if (provider.wire !== 'openai' || !provider.baseUrl) return []
    try {
      const response = await fetchImpl(modelsUrl(provider.baseUrl), {
        headers: { Authorization: `Bearer ${provider.apiKey}` },
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!response.ok) return []
      const payload = await response.json() as unknown
      return parseProviderModels(provider.id, payload)
    } catch {
      return []
    }
  }))
  return discovered.flat()
}

export function parseProviderModels(providerId: string, payload: unknown): ProviderModelMetadata[] {
  if (!isRecord(payload) || !Array.isArray(payload.data)) return []
  return payload.data.flatMap((item) => {
    if (!isRecord(item) || typeof item.id !== 'string') return []
    const context = firstPositiveInt(item, LIMIT_KEYS)
    if (!context) return []
    const input = firstPositiveInt(item, ['max_input_tokens'])
    const output = firstPositiveInt(item, ['max_output_tokens'])
    return [{
      providerId,
      modelId: item.id,
      limits: { context, ...(input ? { input } : {}), ...(output ? { output } : {}) },
    }]
  })
}

function modelsUrl(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, '')
  return normalized.endsWith('/v1') ? `${normalized}/models` : `${normalized}/v1/models`
}

function firstPositiveInt(record: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.floor(value)
  }
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
