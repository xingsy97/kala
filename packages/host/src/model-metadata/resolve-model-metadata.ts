import type { ModelLimits } from '@agent-kernel/shared'

import type { CatalogModel, LoadedModelCatalog, ModelMetadata, ProviderModelMetadata } from './types.js'

export type ResolveModelMetadataInput = {
  providerId: string
  providerLabel?: string
  modelId: string
  explicitLimits?: ModelLimits
  providerMetadata?: readonly ProviderModelMetadata[]
  catalog?: LoadedModelCatalog
}

export function resolveModelMetadata(input: ResolveModelMetadataInput): ModelMetadata | undefined {
  if (input.explicitLimits) {
    return { limits: input.explicitLimits, source: 'manual', match: 'provider-model-exact' }
  }

  const live = input.providerMetadata?.find(
    (entry) => entry.providerId === input.providerId && entry.modelId === input.modelId,
  )
  if (live) return { limits: live.limits, source: 'provider', match: 'provider-model-exact' }
  if (!input.catalog) return undefined

  const exact = exactProviderMatch(input.catalog.models, input.providerId, input.providerLabel, input.modelId)
  if (exact) return fromCatalog(exact, input.catalog, 'provider-model-exact')

  const candidates = input.catalog.models.filter((entry) => entry.modelId === input.modelId)
  if (candidates.length === 0) return undefined

  const canonical = canonicalProviderForModel(input.modelId)
  const canonicalMatch = canonical
    ? candidates.find((entry) => entry.providerId === canonical)
    : undefined
  if (canonicalMatch) return fromCatalog(canonicalMatch, input.catalog, 'canonical-model-exact')

  const contexts = new Set(candidates.map((entry) => entry.limits.context))
  if (contexts.size !== 1) return undefined
  const representative = candidates[0]!
  const inputLimits = consensusOptionalLimit(candidates, 'input')
  const outputLimits = consensusOptionalLimit(candidates, 'output')
  return {
    limits: {
      context: representative.limits.context,
      ...(inputLimits !== undefined ? { input: inputLimits } : {}),
      ...(outputLimits !== undefined ? { output: outputLimits } : {}),
    },
    source: input.catalog.source,
    match: 'model-id-consensus',
    catalogUpdatedAt: input.catalog.updatedAt,
  }
}

function exactProviderMatch(
  models: readonly CatalogModel[],
  providerId: string,
  providerLabel: string | undefined,
  modelId: string,
): CatalogModel | undefined {
  const identities = new Set([providerId, providerLabel ?? ''].map(normalizeProviderIdentity).filter(Boolean))
  return models.find((entry) => entry.modelId === modelId && identities.has(normalizeProviderIdentity(entry.providerId)))
}

function canonicalProviderForModel(modelId: string): string | undefined {
  const id = modelId.toLowerCase()
  if (/^(?:gpt-|o[134]-|chatgpt-)/.test(id)) return 'openai'
  if (/^claude(?:-|$)/.test(id)) return 'anthropic'
  if (/^(?:gemini-|imagen-)/.test(id)) return 'google'
  if (/^mistral-|^codestral-/.test(id)) return 'mistral'
  return undefined
}

function normalizeProviderIdentity(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function fromCatalog(
  model: CatalogModel,
  catalog: LoadedModelCatalog,
  match: ModelMetadata['match'],
): ModelMetadata {
  return { limits: model.limits, source: catalog.source, match, catalogUpdatedAt: catalog.updatedAt }
}

function consensusOptionalLimit(
  models: readonly CatalogModel[],
  key: 'input' | 'output',
): number | undefined {
  const values = models.map((model) => model.limits[key]).filter((value): value is number => value !== undefined)
  if (values.length === 0 || new Set(values).size !== 1) return undefined
  return values[0]
}
