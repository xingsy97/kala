import type { ModelInfo } from '@agent-kernel/shared'

/** Pure model-identity helpers (extracted from app.tsx for unit testing). */

export function modelKey(model: ModelInfo | null | undefined): string {
  return model?.ref ?? model?.id ?? ''
}


export function resolveModelKey(models: readonly ModelInfo[], value: string | null | undefined): string {
  if (!value) return ''
  const exact = models.find((model) => modelKey(model) === value)
  if (exact) return modelKey(exact)
  const byId = models.filter((model) => model.id === value)
  return byId.length === 1 ? modelKey(byId[0]) : ''
}

