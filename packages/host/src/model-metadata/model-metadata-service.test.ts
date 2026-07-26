import type { ModelInfo } from '@agent-kernel/shared'
import { describe, expect, it, vi } from 'vitest'

import { ModelMetadataService } from './model-metadata-service.js'
import type { LoadedModelCatalog } from './types.js'

const seed: LoadedModelCatalog = {
  source: 'models.dev-seed',
  updatedAt: '2026-07-26T00:00:00.000Z',
  models: [{ providerId: 'openai', modelId: 'gpt-5.6-sol', limits: { context: 1_050_000, input: 922_000, output: 128_000 } }],
}

describe('ModelMetadataService', () => {
  it('enriches existing and newly added registry models without leaking provider configuration', async () => {
    const catalog = {
      loadBestAvailable: vi.fn(async () => ({ catalog: seed, stale: false })),
      refresh: vi.fn(async () => undefined),
    }
    const service = new ModelMetadataService({
      catalog: catalog as never,
      discoverProviderMetadata: async () => [],
      refreshIntervalMs: 60_000,
    })
    const providers = [{
      id: 'openai-newapi',
      label: 'Private endpoint',
      wire: 'openai' as const,
      source: 'manual' as const,
      baseUrl: 'https://private.invalid/v1',
      apiKey: 'secret-value',
      models: ['gpt-5.6-sol'],
    }]
    const models: ModelInfo[] = [{
      ref: 'openai-newapi:gpt-5.6-sol',
      id: 'gpt-5.6-sol',
      label: 'GPT',
      provider: 'Private endpoint',
      providerId: 'openai-newapi',
      source: 'manual',
    }]
    await service.start(providers)
    service.enrichModels(models, providers)
    expect(models[0]).toMatchObject({
      contextWindow: 1_050_000,
      limits: { context: 1_050_000, input: 922_000, output: 128_000 },
      metadataMatch: 'canonical-model-exact',
    })
    expect(JSON.stringify(models)).not.toContain('secret-value')
    expect(JSON.stringify(models)).not.toContain('private.invalid')

    models.push({ ref: 'openai-newapi:gpt-5.6-sol', id: 'gpt-5.6-sol', label: 'New', provider: 'Private endpoint', providerId: 'openai-newapi' })
    service.enrichModels(models, providers)
    expect(models[1]?.contextWindow).toBe(1_050_000)
    service.stop()
  })
})
