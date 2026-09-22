import type { ModelInfo, ServerModelsPayload } from '@agent-kernel/shared'
import { useQuery, useQueryClient } from '@tanstack/react-query'

/** Loads the available models from the host, isolated by host and authenticated identity. */
export function useModels(
  enabled = true,
  scope: { host?: string; identity?: string } = {},
): { models: readonly ModelInfo[]; defaultModel: string; reload(): void } {
  const client = useQueryClient()
  const queryKey = ['models', normalizeModelsHost(scope.host), scope.identity ?? 'local-operator'] as const
  const query = useQuery({
    queryKey,
    queryFn: async (): Promise<ServerModelsPayload> => {
      const r = await fetch(modelsEndpoint(scope.host), { cache: 'no-store' })
      if (!r.ok) throw new ModelsRequestError(r.status)
      return (await r.json()) as ServerModelsPayload
    },
    staleTime: 60_000,
    enabled,
    retry: (failures, error) => !(error instanceof ModelsRequestError && (error.status === 401 || error.status === 403)) && failures < 2,
  })
  return {
    models: query.data?.models ?? [],
    defaultModel: query.data?.defaultModel ?? '',
    reload: () => {
      void client.invalidateQueries({ queryKey })
    },
  }
}

export function modelsEndpoint(host: string | undefined): string {
  return host ? new URL('/models', host).toString() : '/models'
}

export function normalizeModelsHost(host: string | undefined): string {
  const value = host?.trim().replace(/\/+$/u, '') ?? ''
  if (!value) return 'same-origin'
  try {
    const url = new URL(value, typeof window === 'undefined' ? 'http://localhost' : window.location.href)
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/u, '')}`
  } catch {
    return value
  }
}

export class ModelsRequestError extends Error {
  constructor(readonly status: number) {
    super(`Models request failed: ${status}`)
    this.name = 'ModelsRequestError'
  }
}
