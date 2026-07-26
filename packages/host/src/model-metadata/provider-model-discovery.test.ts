import { describe, expect, it } from 'vitest'

import { parseProviderModels } from './provider-model-discovery.js'

describe('parseProviderModels', () => {
  it('reads structured OpenAI-compatible limits and ignores id-only records', () => {
    expect(parseProviderModels('endpoint', { data: [
      { id: 'rich', context_window: 131_072, max_input_tokens: 120_000, max_output_tokens: 11_072 },
      { id: 'id-only' },
    ] })).toEqual([{
      providerId: 'endpoint',
      modelId: 'rich',
      limits: { context: 131_072, input: 120_000, output: 11_072 },
    }])
  })
})
