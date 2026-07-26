import { describe, expect, it } from 'vitest'

import { resolveModelMetadata } from './resolve-model-metadata.js'
import type { LoadedModelCatalog } from './types.js'

const catalog: LoadedModelCatalog = {
  source: 'models.dev-seed',
  updatedAt: '2026-07-26T00:00:00.000Z',
  models: [
    { providerId: 'openai', modelId: 'gpt-5.6-sol', limits: { context: 1_050_000, input: 922_000, output: 128_000 } },
    { providerId: 'proxy-a', modelId: 'shared-model', limits: { context: 200_000 } },
    { providerId: 'proxy-b', modelId: 'shared-model', limits: { context: 200_000 } },
    { providerId: 'proxy-a', modelId: 'conflict', limits: { context: 100_000 } },
    { providerId: 'proxy-b', modelId: 'conflict', limits: { context: 200_000 } },
  ],
}

describe('resolveModelMetadata', () => {
  it('maps an OpenAI-compatible custom endpoint to the canonical OpenAI model entry', () => {
    expect(resolveModelMetadata({ providerId: 'openai-newapi', modelId: 'gpt-5.6-sol', catalog })).toMatchObject({
      limits: { context: 1_050_000, input: 922_000, output: 128_000 },
      source: 'models.dev-seed',
      match: 'canonical-model-exact',
    })
  })

  it('uses explicit and live provider limits before catalog metadata', () => {
    const providerMetadata = [{ providerId: 'custom', modelId: 'gpt-5.6-sol', limits: { context: 900_000 } }]
    expect(resolveModelMetadata({ providerId: 'custom', modelId: 'gpt-5.6-sol', providerMetadata, catalog })?.limits.context).toBe(900_000)
    expect(resolveModelMetadata({
      providerId: 'custom',
      modelId: 'gpt-5.6-sol',
      explicitLimits: { context: 800_000 },
      providerMetadata,
      catalog,
    })).toMatchObject({ limits: { context: 800_000 }, source: 'manual' })
  })

  it('accepts consistent model-id consensus and rejects conflicting unknown providers', () => {
    expect(resolveModelMetadata({ providerId: 'custom', modelId: 'shared-model', catalog })).toMatchObject({
      limits: { context: 200_000 },
      match: 'model-id-consensus',
    })
    expect(resolveModelMetadata({ providerId: 'custom', modelId: 'conflict', catalog })).toBeUndefined()
  })
})
