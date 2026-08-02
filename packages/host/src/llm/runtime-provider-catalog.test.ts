import { describe, expect, it, vi } from 'vitest'

import type { LLMAdapter } from './adapter.js'
import { createRuntimeProviderRuntime, parseRuntimeProviderCatalog } from './runtime-provider-catalog.js'

describe('Runtime Provider Catalog', () => {
  const catalog = {
    version: 1 as const,
    defaultModel: 'box-openai:gpt-main',
    providers: [
      { id: 'box-openai', wire: 'openai' as const, baseUrl: 'http://box/v1', credentialRef: 'file:key', models: [{ id: 'gpt-main' }] },
      { id: 'box-anthropic', wire: 'anthropic' as const, baseUrl: 'http://box', credentialRef: 'file:key', models: [{ id: 'claude-main' }] },
    ],
  }

  it('validates unique refs and an existing default', () => {
    expect(parseRuntimeProviderCatalog(catalog)).toEqual(catalog)
    expect(() => parseRuntimeProviderCatalog({ ...catalog, defaultModel: 'missing' })).toThrow(/defaultModel is unknown/)
  })

  it('creates one adapter per provider and routes model refs to provider model ids', async () => {
    const calls: Array<{ adapter: string; model?: string }> = []
    const create = vi.fn(async (config: { id: string }) => ({
      name: config.id,
      call: async (params: { model?: string }) => {
        calls.push({ adapter: config.id, ...(params.model ? { model: params.model } : {}) })
        return { message: { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'ok' }] } }
      },
    }) satisfies LLMAdapter)
    const runtime = await createRuntimeProviderRuntime(catalog, { create })
    expect(create).toHaveBeenCalledTimes(2)
    expect(runtime.models.map((model) => model.ref)).toEqual(['box-openai:gpt-main', 'box-anthropic:claude-main'])
    await runtime.llm.call({ messages: [], tools: [], signal: new AbortController().signal, model: 'box-anthropic:claude-main' })
    expect(calls).toEqual([{ adapter: 'box-anthropic', model: 'claude-main' }])
  })
})
