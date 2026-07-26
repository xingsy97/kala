import type { ManualModelInput, ModelInfo, ModelLimits } from '@agent-kernel/shared'

import type { ProviderSpec } from '../runtime-config.js'
import { ModelsDevCatalog, type ModelsDevCatalogOptions } from './models-dev-catalog.js'
import { discoverProviderModelMetadata } from './provider-model-discovery.js'
import { resolveModelMetadata } from './resolve-model-metadata.js'
import type { LoadedModelCatalog, ProviderModelMetadata } from './types.js'

export type ModelMetadataLogger = {
  debug?(fields: object, message: string): void
  info?(fields: object, message: string): void
  warn?(fields: object, message: string): void
}

export type ModelMetadataServiceOptions = ModelsDevCatalogOptions & {
  catalog?: ModelsDevCatalog
  refreshIntervalMs?: number
  discoverProviderMetadata?: typeof discoverProviderModelMetadata
  logger?: ModelMetadataLogger
}

export class ModelMetadataService {
  private readonly catalogClient: ModelsDevCatalog
  private readonly refreshIntervalMs: number
  private readonly discoverProviderMetadata: typeof discoverProviderModelMetadata
  private readonly logger?: ModelMetadataLogger
  private catalog?: LoadedModelCatalog
  private providerMetadata: readonly ProviderModelMetadata[] = []
  private providers: readonly ProviderSpec[] = []
  private refreshTimer?: ReturnType<typeof setInterval>
  private onUpdate?: () => void

  constructor(options: ModelMetadataServiceOptions = {}) {
    this.catalogClient = options.catalog ?? new ModelsDevCatalog(options)
    this.refreshIntervalMs = options.refreshIntervalMs ?? 6 * 60 * 60 * 1_000
    this.discoverProviderMetadata = options.discoverProviderMetadata ?? discoverProviderModelMetadata
    this.logger = options.logger
  }

  async start(providers: readonly ProviderSpec[]): Promise<void> {
    this.providers = providers
    const { catalog, stale } = await this.catalogClient.loadBestAvailable()
    this.catalog = catalog
    this.logger?.info?.({
      catalogSource: catalog?.source ?? 'unavailable',
      catalogModels: catalog?.models.length ?? 0,
      providerModels: 0,
    }, 'model metadata initialized')

    void this.refreshProviderMetadata()
    if (stale) void this.refresh()
    this.refreshTimer = setInterval(() => void this.refresh(), this.refreshIntervalMs)
    this.refreshTimer.unref?.()
  }

  stop(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer)
    this.refreshTimer = undefined
  }

  setUpdateHandler(handler: () => void): void {
    this.onUpdate = handler
  }

  updateProviders(providers: readonly ProviderSpec[]): void {
    this.providers = providers
  }

  enrichModels(
    models: ModelInfo[],
    providers: readonly ProviderSpec[] = this.providers,
    manualModels: readonly ManualModelInput[] = [],
  ): void {
    for (const model of models) {
      const provider = providers.find((candidate) => candidate.id === model.providerId)
      const explicitContext = provider?.contextWindows?.[model.id]
        ?? manualModels.find((manual) => manual.providerId === model.providerId && manual.id === model.id)?.contextWindow
      const explicitLimits = explicitContext ? { context: explicitContext } satisfies ModelLimits : undefined
      const metadata = resolveModelMetadata({
        providerId: model.providerId,
        providerLabel: provider?.label ?? model.provider,
        modelId: model.id,
        ...(explicitLimits ? { explicitLimits } : {}),
        providerMetadata: this.providerMetadata,
        ...(this.catalog ? { catalog: this.catalog } : {}),
      })
      if (!metadata) {
        delete model.limits
        delete model.metadataSource
        delete model.metadataMatch
        delete model.catalogUpdatedAt
        if (!explicitContext) delete model.contextWindow
        continue
      }
      model.limits = metadata.limits
      model.contextWindow = metadata.limits.context
      model.metadataSource = metadata.source
      model.metadataMatch = metadata.match
      if (metadata.catalogUpdatedAt) model.catalogUpdatedAt = metadata.catalogUpdatedAt
      else delete model.catalogUpdatedAt
    }
  }

  private async refresh(): Promise<void> {
    const [catalogResult, providerResult] = await Promise.allSettled([
      this.catalogClient.refresh(),
      this.discoverProviderMetadata(this.providers),
    ])
    if (catalogResult.status === 'fulfilled') {
      const catalog = catalogResult.value
      if (catalog) this.catalog = catalog
    } else {
      this.logger?.warn?.({ error: errorMessage(catalogResult.reason) }, 'model catalog refresh failed; retaining stale data')
    }
    if (providerResult.status === 'fulfilled') {
      this.providerMetadata = providerResult.value
    } else {
      this.logger?.warn?.({ error: errorMessage(providerResult.reason) }, 'provider model discovery failed; retaining stale data')
    }
    this.onUpdate?.()
    this.logger?.debug?.({
      catalogSource: this.catalog?.source,
      providerModels: this.providerMetadata.length,
    }, 'model metadata refreshed')
  }

  private async refreshProviderMetadata(): Promise<void> {
    const providerMetadata = await this.discoverProviderMetadata(this.providers)
    this.providerMetadata = providerMetadata
    this.onUpdate?.()
    this.logger?.debug?.({ providerModels: providerMetadata.length }, 'provider model metadata refreshed')
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
