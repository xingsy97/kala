import type { ModelInfo, ServerModelsPayload } from '@agent-kernel/shared'
import { useQuery, useQueryClient } from '@tanstack/react-query'

/** Loads the available models from the host, with a manual reload. */
export function useModels(enabled = true): { models: readonly ModelInfo[]; defaultModel: string; reload(): void } {
  const client = useQueryClient()
  const query = useQuery({
    queryKey: ['models'],
    queryFn: async (): Promise<ServerModelsPayload | null> => {
      const r = await fetch('/models', { cache: 'no-store' })
      if (!r.ok) return null
      return (await r.json()) as ServerModelsPayload
    },
    staleTime: 60_000,
    enabled,
    retry: false,
  })
  return {
    models: query.data?.models ?? [],
    defaultModel: query.data?.defaultModel ?? '',
    reload: () => {
      void client.invalidateQueries({ queryKey: ['models'] })
    },
  }
}
