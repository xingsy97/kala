import { describe, expect, it } from 'vitest'

import { createConfig } from '@agent-kernel/kernel'
import { evaluateContextPressure } from '@agent-kernel/shared/context-policy'

import { snapshotFromConfig, shouldAutoCompact } from './manager.js'
import type { SessionRecord } from '../store/session.js'

const baseMessage = { role: 'user' as const, content: [{ type: 'text' as const, text: 'hello' }] }

describe('ContextManager', () => {
  it('records unknown context window when no limit is configured', () => {
    const snap = snapshotFromConfig(createConfig({ tools: [] }), [baseMessage])

    expect(snap.contextWindow).toEqual({ tokens: null, source: 'unknown' })
    expect(snap.usage.inputTokens).toBe(snap.usage.totalTokens)
    expect(evaluateContextPressure(snap).level).toBe('unknown')
  })

  it('estimates current model-visible input, tool schemas, and reserve', () => {
    const config = createConfig({
      tools: [{ name: 'read', description: 'Read files', inputSchema: { type: 'object' }, requiresApproval: false }],
      contextLimit: 1_000,
      softThreshold: 0.5,
      hardThreshold: 0.8,
    })

    const soft = snapshotFromConfig(config, [{ role: 'user', content: [{ type: 'text', text: 'a'.repeat(1_700) }] }])
    const hard = snapshotFromConfig(config, [{ role: 'user', content: [{ type: 'text', text: 'b'.repeat(3_000) }] }])

    expect(evaluateContextPressure(soft, {}, { mediumRatio: 0.5, highRatio: 0.5, criticalRatio: 0.8 }).level).toBe('high')
    expect(evaluateContextPressure(hard, {}, { mediumRatio: 0.5, highRatio: 0.5, criticalRatio: 0.8 }).level).toBe('critical')
    expect(hard.usage.inputTokens).toBeGreaterThan(hard.breakdown.transcript)
    expect(hard.usage.inputTokens).toBe(hard.breakdown.transcript + hard.breakdown.tools + hard.breakdown.system)
  })

  it('splits the transcript breakdown by message role (user / assistant / tool)', () => {
    const config = createConfig({ tools: [], contextLimit: 100_000 })
    const snap = snapshotFromConfig(config, [
      { role: 'user', content: [{ type: 'text', text: 'u'.repeat(400) }] },
      { role: 'assistant', content: [{ type: 'text', text: 'a'.repeat(800) }] },
      { role: 'tool', content: [{ type: 'tool_result', callId: 'c1', ok: true, content: 't'.repeat(1200) }] },
    ])

    const b = snap.breakdown.transcriptBreakdown
    expect(b).toBeDefined()
    expect(b!.userMessages).toBeGreaterThan(0)
    expect(b!.assistantMessages).toBeGreaterThan(b!.userMessages)
    expect(b!.toolResults).toBeGreaterThan(b!.assistantMessages)
    // The three role buckets together approximate the flat transcript total.
    expect(b!.userMessages + b!.assistantMessages + b!.toolResults).toBe(snap.breakdown.transcript)
  })

  it('uses selected model context override ahead of the session config limit', () => {
    const config = createConfig({ tools: [], contextLimit: 400_000 })
    const snap = snapshotFromConfig(config, [baseMessage], {
      model: 'claude-opus-4.7-1m-internal',
      contextWindow: 1_000_000,
    })

    expect(snap.contextWindow).toEqual({ tokens: 1_000_000, source: 'model_registry' })
    expect(snap.model).toMatchObject({ ref: 'claude-opus-4.7-1m-internal', id: 'claude-opus-4.7-1m-internal' })
  })

  it('keeps provider-qualified model refs separate from provider-native ids', () => {
    const config = createConfig({ tools: [], contextLimit: 400_000 })
    const snap = snapshotFromConfig(config, [baseMessage], {
      model: 'anthropic:claude-opus-4.7-1m-internal',
      modelId: 'claude-opus-4.7-1m-internal',
      provider: 'anthropic',
      contextWindow: 1_000_000,
    })

    expect(snap.model).toEqual({
      ref: 'anthropic:claude-opus-4.7-1m-internal',
      id: 'claude-opus-4.7-1m-internal',
      provider: 'anthropic',
    })
  })

  it('uses a manual context token cap ahead of the model registry window', () => {
    const config = createConfig({ tools: [], contextLimit: 400_000 })
    const snap = snapshotFromConfig(config, [baseMessage], {
      model: 'claude-opus-4.7-1m-internal',
      contextWindow: 1_000_000,
      contextTokens: 250_000,
    })

    expect(snap.contextWindow).toEqual({ tokens: 250_000, source: 'manual_config' })
    expect(snap.model.ref).toBe('claude-opus-4.7-1m-internal')
  })

  it('is the host-owned auto-compaction trigger', () => {
    const state = {
      sessionId: 's1',
      messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'x'.repeat(3_000) }] }],
      pendingCalls: [],
      status: 'done' as const,
      usage: { inputTokens: 99_000, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
      cursor: 1,
      approvalMode: 'auto' as const,
    }
    const record: SessionRecord = {
      sessionId: 's1',
      state,
      config: createConfig({ tools: [], contextLimit: 1_000, hardThreshold: 0.8 }),
      logPath: '/tmp/s1.jsonl',
      createdAt: '2026-07-15T00:00:00.000Z',
      preferences: {},
    }

    expect(shouldAutoCompact(record)).toBe(true)
  })
})
