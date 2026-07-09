import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { LLMAdapter } from './adapter.js'
import {
  classifyProviderError,
  createProviderHealthRegistry,
  writeFallbackArtifact,
} from './provider-health.js'
import { routerAdapter, toFallbackArtifact } from './router.js'

function stubAdapter(name: string, impl?: (params: Parameters<LLMAdapter['call']>[0]) => Promise<unknown>): LLMAdapter {
  return {
    name,
    async call(params) {
      const runner = impl ?? (async () => ({ message: { role: 'assistant', content: [] } }))
      const value = await runner(params)
      return value as never
    },
  }
}

describe('classifyProviderError', () => {
  it('respects an explicit label field', () => {
    expect(classifyProviderError({ label: 'rate_limited' })).toBe('rate_limited')
  })

  it('maps HTTP status codes to labels', () => {
    expect(classifyProviderError({ status: 401 })).toBe('auth_error')
    expect(classifyProviderError({ status: 429 })).toBe('rate_limited')
    expect(classifyProviderError({ status: 500 })).toBe('retryable')
    expect(classifyProviderError({ status: 400 })).toBe('schema_error')
    expect(classifyProviderError({ status: 404 })).toBe('model_not_found')
  })

  it('falls back to message heuristics', () => {
    expect(classifyProviderError(new Error('rate limit exceeded'))).toBe('rate_limited')
    expect(classifyProviderError(new Error('unauthorized: invalid api key'))).toBe('auth_error')
    expect(classifyProviderError(new Error('context length exceeded'))).toBe('context_length_exceeded')
    expect(classifyProviderError(new Error('request timed out'))).toBe('retryable')
    expect(classifyProviderError(new Error('unknown situation'))).toBe('unknown')
  })
})

describe('ProviderHealthRegistry', () => {
  it('accumulates counters and opens the circuit after consecutive errors', () => {
    const registry = createProviderHealthRegistry({ circuitBreakerThreshold: 2, circuitBreakerCooldownMs: 5_000 })
    registry.record({ provider: 'openai', ok: false, label: 'retryable', timestamp: new Date().toISOString() })
    registry.record({ provider: 'openai', ok: false, label: 'retryable', timestamp: new Date().toISOString() })
    const entry = registry.entry('openai')!
    expect(entry.errorCount).toBe(2)
    expect(entry.consecutiveErrors).toBe(2)
    expect(entry.circuitOpenUntil).toBeDefined()
    expect(registry.isProviderHealthy('openai')).toBe(false)
  })

  it('resets consecutive errors after a successful call', () => {
    const registry = createProviderHealthRegistry({ circuitBreakerThreshold: 3 })
    registry.record({ provider: 'anthropic', ok: false, label: 'rate_limited', timestamp: new Date().toISOString() })
    registry.record({ provider: 'anthropic', ok: true, timestamp: new Date().toISOString() })
    const entry = registry.entry('anthropic')!
    expect(entry.successCount).toBe(1)
    expect(entry.consecutiveErrors).toBe(0)
  })
})

describe('routerAdapter fallback', () => {
  it('returns the first successful adapter', async () => {
    const first = stubAdapter('anthropic-fail', async () => { throw { status: 429 } })
    const second = stubAdapter('openai-ok', async () => ({ message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } }))
    const registry = createProviderHealthRegistry()
    const router = routerAdapter({ defaultAdapter: first, byPrefix: [{ prefix: 'gpt-', adapter: second }], healthRegistry: registry, maxFallbacks: 2 })
    const response = await router.call({ messages: [], tools: [], model: 'claude-4' })
    expect((response.message.content[0] as { text: string }).text).toBe('hi')
    const decision = router.lastDecision()!
    expect(decision.finalOutcome).toBe('success')
    expect(decision.attempts).toHaveLength(2)
    expect(decision.attempts[0]?.label).toBe('rate_limited')
    expect(decision.selectedProvider).toBe('openai')
  })

  it('stops on unretryable auth errors', async () => {
    const first = stubAdapter('anthropic-auth-fail', async () => { throw { status: 401 } })
    const second = stubAdapter('openai-ok', async () => ({ message: { role: 'assistant', content: [] } }))
    const router = routerAdapter({ defaultAdapter: first, byPrefix: [{ prefix: 'x', adapter: second }] })
    await expect(router.call({ messages: [], tools: [], model: 'claude' })).rejects.toBeTruthy()
    const decision = router.lastDecision()!
    expect(decision.finalOutcome).toBe('unretryable')
  })

  it('skips providers whose circuit is open', async () => {
    const first = stubAdapter('anthropic-open', async () => ({ message: { role: 'assistant', content: [{ type: 'text', text: 'unhealthy path' }] } }))
    const second = stubAdapter('openai-ok', async () => ({ message: { role: 'assistant', content: [{ type: 'text', text: 'healthy path' }] } }))
    const registry = createProviderHealthRegistry({ circuitBreakerThreshold: 1, circuitBreakerCooldownMs: 60_000 })
    registry.record({ provider: 'anthropic', ok: false, label: 'auth_error', timestamp: new Date().toISOString() })
    const router = routerAdapter({ defaultAdapter: first, byPrefix: [{ prefix: 'gpt-', adapter: second }], healthRegistry: registry })
    const response = await router.call({ messages: [], tools: [], model: 'claude-4' })
    expect((response.message.content[0] as { text: string }).text).toBe('healthy path')
  })

  it('routes provider-qualified refs even when model ids collide', async () => {
    const anthropic = stubAdapter('anthropic:shared', async () => ({ message: { role: 'assistant', content: [{ type: 'text', text: 'anthropic' }] } }))
    const openai = stubAdapter('openai:shared', async () => ({ message: { role: 'assistant', content: [{ type: 'text', text: 'openai' }] } }))
    const router = routerAdapter({
      defaultAdapter: anthropic,
      byPrefix: [
        { prefix: 'anthropic:shared-model', adapter: anthropic },
        { prefix: 'openai-local:shared-model', adapter: openai },
      ],
    })

    const response = await router.call({ messages: [], tools: [], model: 'openai-local:shared-model' })
    expect((response.message.content[0] as { text: string }).text).toBe('openai')
    expect(router.lastDecision()?.selectedAdapter).toBe('openai:shared')
  })

  it('routes by provider-qualified ref without sending the ref as the provider model id', async () => {
    const seenModels: Array<string | undefined> = []
    const openai = stubAdapter('openai:gpt-5.5', async (params) => {
      seenModels.push(params.model)
      return { message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } }
    })
    const router = routerAdapter({
      defaultAdapter: openai,
      byPrefix: [
        { prefix: 'newapi:gpt-5.5', adapter: openai, routedModel: 'gpt-5.5' },
        { prefix: 'gpt-5.5', adapter: openai },
      ],
    })

    await router.call({ messages: [], tools: [], model: 'newapi:gpt-5.5' })
    expect(seenModels).toEqual(['gpt-5.5'])
    expect(router.lastDecision()?.selectedModel).toBe('newapi:gpt-5.5')
  })
})

describe('writeFallbackArtifact', () => {
  it('writes an artifact JSON file under router-decisions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'router-'))
    try {
      const artifact = toFallbackArtifact({
        attempts: [{ provider: 'openai', retryCount: 0 }],
        finalOutcome: 'success',
        selectedProvider: 'openai',
      })
      const path = await writeFallbackArtifact({ rootDir: dir, sessionId: 'session-1', eventSeq: 3, artifact })
      const raw = await readFile(path, 'utf8')
      const parsed = JSON.parse(raw) as { finalOutcome: string }
      expect(parsed.finalOutcome).toBe('success')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
