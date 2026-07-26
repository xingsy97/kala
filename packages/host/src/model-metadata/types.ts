import type { ModelLimits, ModelMetadataMatch, ModelMetadataSource } from '@agent-kernel/shared'

export type ModelMetadata = {
  limits: ModelLimits
  source: ModelMetadataSource
  match: ModelMetadataMatch
  catalogUpdatedAt?: string
}

export type CatalogModel = {
  providerId: string
  modelId: string
  limits: ModelLimits
}

export type LoadedModelCatalog = {
  models: readonly CatalogModel[]
  source: Extract<ModelMetadataSource, 'models.dev-live' | 'models.dev-cache' | 'models.dev-seed'>
  updatedAt: string
}

export type ProviderModelMetadata = {
  providerId: string
  modelId: string
  limits: ModelLimits
}
