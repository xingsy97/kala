import { describe, expect, it } from 'vitest'

import { createConfig } from '@agent-kernel/kernel'

import { snapshotFromConfig, shouldAutoCompact } from './manager.js'
import type { SessionRecord } from '../store/session.js'

const baseMessage = { role: 'user' as const, content: [{ type: 'text' as const, text: 'hello' }] }

describe('ContextManager', () => {
  it('keeps pressure none when no context limit is configured', () => {
    const snap = snapshotFromConfig(createConfig({ tools: [] }), [baseMessage])

    expect(snap.pressureLevel).toBe('none')
    expect(snap.effectiveLimit).toBeUndefined()
    expect(snap.reasonCodes).toContain('context_limit_unknown')
  })

  it('calculates pressure from current model-visible input, tool schemas, and reserve', () => {
    const config = createConfig({
      tools: [{ name: 'read', description: 'Read files', inputSchema: { type: 'object' }, requiresApproval: false }],
      contextLimit: 1_000,
      softThreshold: 0.5,
      hardThreshold: 0.8,
    })

    const soft = snapshotFromConfig(config, [{ role: 'user', content: [{ type: 'text', text: 'a'.repeat(1_700) }] }])
    const hard = snapshotFromConfig(config, [{ role: 'user', content: [{ type: 'text', text: 'b'.repeat(3_000) }] }])

    expect(soft.pressureLevel).toBe('soft')
    expect(hard.pressureLevel).toBe('hard')
    expect(hard.estimatedTotalInputTokens).toBeGreaterThan(hard.estimatedMessageTokens)
  })

  it('uses selected model context override ahead of the session config limit', () => {
    const config = createConfig({ tools: [], contextLimit: 400_000 })
    const snap = snapshotFromConfig(config, [baseMessage], {
      model: 'claude-opus-4.7-1m-internal',
      contextWindow: 1_000_000,
    })

    expect(snap.effectiveLimit).toBe(1_000_000)
    expect(snap.contextWindow).toBe(1_000_000)
    expect(snap.contextWindowSource).toBe('model')
    expect(snap.contextWindowModel).toBe('claude-opus-4.7-1m-internal')
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
    }

    expect(shouldAutoCompact(record)).toBe(true)
  })
})
