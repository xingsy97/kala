import { describe, expect, it, vi } from 'vitest'
import { COPILOT_AGENT_RUNTIME_CAPABILITIES, KERNEL_AGENT_RUNTIME_CAPABILITIES, type ClientUserMessage, type RuntimeMetadataEntry } from '@agent-kernel/shared'

import { buildCompactionMetadataIndex, consumeCompactionMetadata, handleUserMessage, loadDashboardSession, type DashboardDeps } from './dashboard-ns.js'
import { terminalOwnerSessionId, terminalSessionRoom } from './rooms.js'
import type { SessionStore } from '../store/session.js'

function makeMeta(
  action: string,
  payload: Record<string, unknown>,
  ts = '2026-08-01T00:00:00.000Z',
): RuntimeMetadataEntry {
  return {
    kind: 'runtime_metadata',
    ts,
    sessionId: 's1',
    action,
    payload,
  }
}

describe('dashboard user message routing', () => {
  function messageHarness(
    status: 'idle' | 'thinking',
    agentRuntime: 'kernel' | 'copilot' = 'copilot',
    pending = 0,
  ) {
    const order: string[] = []
    const send = vi.fn(async () => { order.push('send') })
    const cancel = vi.fn(async () => { order.push('cancel') })
    const enqueue = vi.fn(async () => { order.push('enqueue') })
    const drain = vi.fn(async () => { order.push('drain') })
    const commitReferences = vi.fn(async () => { order.push('commit') })
    const requestStopAtBoundary = vi.fn()
    const record = {
      sessionId: 'copilot-session',
      agentRuntime,
      preferences: { selectedModel: 'copilot:gpt-5' },
      state: { status },
    }
    const deps = {
      store: { get: vi.fn(() => record) },
      agentRuntimes: {
        require: vi.fn(() => ({
          descriptor: () => ({
            label: agentRuntime === 'copilot' ? 'Copilot' : 'Kernel',
            capabilities: agentRuntime === 'copilot' ? COPILOT_AGENT_RUNTIME_CAPABILITIES : KERNEL_AGENT_RUNTIME_CAPABILITIES,
          }),
          send,
          cancel,
        })),
      },
      loop: {
        hasActiveTurn: vi.fn(() => status === 'thinking'),
        hasActiveLlmCall: vi.fn(() => status === 'thinking'),
        recoverInterruptedLlm: vi.fn(),
        requestStopAtBoundary,
      },
      loopDeps: { messageAttachments: { commitReferences } },
      messageQueues: {
        pending: vi.fn(() => pending),
        enqueue,
        drain,
      },
      broadcastError: vi.fn(),
    } as unknown as DashboardDeps
    return { deps, order, send, cancel, enqueue, drain, commitReferences, requestStopAtBoundary }
  }

  it.each(['kernel', 'copilot'] as const)('durably queues a %s queue-mode message with committed references while another turn is active', async (agentRuntime) => {
    const { deps, order, send, enqueue, drain, commitReferences } = messageHarness('thinking', agentRuntime)
    const content = [{ type: 'text' as const, text: 'details' }]
    const message: ClientUserMessage = {
      sessionId: 'copilot-session',
      operationId: 'copilot-follow-up',
      text: 'follow up',
      content,
      mode: 'queue',
    }

    await handleUserMessage(deps, message)

    expect(send).not.toHaveBeenCalled()
    expect(commitReferences).toHaveBeenCalledWith(message.sessionId, content)
    expect(enqueue).toHaveBeenCalledWith(message.sessionId, expect.objectContaining({
      operationId: message.operationId,
      text: message.text,
      content,
      model: 'copilot:gpt-5',
      mode: 'queue',
    }), undefined)
    expect(drain).toHaveBeenCalledWith(message.sessionId)
    expect(order.indexOf('commit')).toBeLessThan(order.indexOf('enqueue'))
  })

  it('keeps an idle Copilot steer immediate but commits references before sending', async () => {
    const { deps, order, send, enqueue } = messageHarness('idle')
    const message: ClientUserMessage = {
      sessionId: 'copilot-session',
      operationId: 'copilot-steer',
      text: 'redirect',
      mode: 'steer',
    }

    await handleUserMessage(deps, message)

    expect(enqueue).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      text: message.text,
      operationId: message.operationId,
      model: 'copilot:gpt-5',
    }))
    expect(order.indexOf('commit')).toBeLessThan(order.indexOf('send'))
  })

  it('defers a busy Copilot steer without cancelling or starting an overlapping generation', async () => {
    const { deps, order, send, cancel, enqueue, drain, requestStopAtBoundary } = messageHarness('thinking')
    const message: ClientUserMessage = {
      sessionId: 'copilot-session',
      operationId: 'copilot-busy-steer',
      text: 'redirect after the child finishes',
      mode: 'steer',
    }

    await handleUserMessage(deps, message)

    expect(send).not.toHaveBeenCalled()
    expect(cancel).not.toHaveBeenCalled()
    expect(enqueue).toHaveBeenCalledWith(message.sessionId, expect.objectContaining({
      operationId: message.operationId,
      text: message.text,
      model: 'copilot:gpt-5',
      mode: 'steer',
    }), 'front')
    expect(drain).toHaveBeenCalledWith(message.sessionId)
    expect(requestStopAtBoundary).not.toHaveBeenCalled()
    expect(order.indexOf('commit')).toBeLessThan(order.indexOf('enqueue'))
  })

  it('does not bypass an existing Copilot queue with an otherwise resting steer', async () => {
    const { deps, send, enqueue } = messageHarness('idle', 'copilot', 1)
    const message: ClientUserMessage = {
      sessionId: 'copilot-session',
      operationId: 'copilot-steer-behind-claim',
      text: 'redirect safely',
      mode: 'steer',
    }

    await handleUserMessage(deps, message)

    expect(send).not.toHaveBeenCalled()
    expect(enqueue).toHaveBeenCalledWith(message.sessionId, expect.objectContaining({
      text: message.text,
      operationId: message.operationId,
      model: 'copilot:gpt-5',
      mode: 'steer',
    }), 'front')
  })
})

describe('temporary workspace terminal identity', () => {
  it('maps an isolated PTY id to its authorized owner session and rejects malformed ids', () => {
    expect(terminalOwnerSessionId('session-1')).toBe('session-1')
    expect(terminalOwnerSessionId('workspace-terminal:session-1:request-1')).toBe('session-1')
    expect(terminalSessionRoom('workspace-terminal:session-1:request-1')).toBe('session:session-1')
    expect(terminalOwnerSessionId('workspace-terminal:')).toBeUndefined()
    expect(terminalOwnerSessionId('workspace-terminal::request-1')).toBeUndefined()
  })
})

describe('history compaction-metadata correlator', () => {
  it('rebuilds trigger/token metadata by replaceRange, preserving order for duplicates', () => {
    const entries: RuntimeMetadataEntry[] = [
      makeMeta('compaction_applied', {
        trigger: 'auto',
        attemptId: 'cmp_1',
        replaceRange: { start: 1, end: 3 },
        replacedCount: 2,
        tokensBefore: 12000,
        tokensAfter: 4000,
      }),
      makeMeta('compaction_applied', {
        trigger: 'preflight',
        attemptId: 'cmp_2',
        replaceRange: { start: 1, end: 5 },
        replacedCount: 4,
        tokensBefore: 18000,
        tokensAfter: 6000,
      }),
      // Second compaction that happens to share replaceRange with cmp_1 —
      // must not clobber the first; we pop them in append order.
      makeMeta('compaction_applied', {
        trigger: 'manual',
        attemptId: 'cmp_3',
        replaceRange: { start: 1, end: 3 },
        replacedCount: 2,
        tokensBefore: 30000,
        tokensAfter: 5000,
      }),
      // Unrelated action — must be ignored.
      makeMeta('compaction_skipped', { trigger: 'auto', reason: 'circuit_breaker_open' }),
    ]

    const index = buildCompactionMetadataIndex(entries)

    const first = consumeCompactionMetadata(index, { start: 1, end: 3 })
    expect(first).toEqual({
      trigger: 'auto',
      attemptId: 'cmp_1',
      tokensBefore: 12000,
      tokensAfter: 4000,
      replacedCount: 2,
    })

    const second = consumeCompactionMetadata(index, { start: 1, end: 5 })
    expect(second?.trigger).toBe('preflight')
    expect(second?.tokensBefore).toBe(18000)

    // Same key again should now return the second cmp_3 entry, not cmp_1.
    const third = consumeCompactionMetadata(index, { start: 1, end: 3 })
    expect(third?.attemptId).toBe('cmp_3')
    expect(third?.trigger).toBe('manual')

    // Exhausted.
    expect(consumeCompactionMetadata(index, { start: 1, end: 3 })).toBeUndefined()
    expect(consumeCompactionMetadata(index, { start: 1, end: 5 })).toBeUndefined()
  })

  it('tolerates missing / malformed fields by dropping the entry (no crash)', () => {
    const entries: RuntimeMetadataEntry[] = [
      // trigger missing → drop.
      makeMeta('compaction_applied', {
        replaceRange: { start: 1, end: 2 },
        tokensBefore: 100,
        tokensAfter: 20,
        replacedCount: 1,
      }),
      // replaceRange missing → drop.
      makeMeta('compaction_applied', {
        trigger: 'auto',
        tokensBefore: 100,
        tokensAfter: 20,
        replacedCount: 1,
      }),
      // token counts missing → default to 0 (honest under-count is preferable
      // to dropping the whole record).
      makeMeta('compaction_applied', {
        trigger: 'tool_result',
        replaceRange: { start: 2, end: 5 },
      }),
    ]

    const index = buildCompactionMetadataIndex(entries)
    const only = consumeCompactionMetadata(index, { start: 2, end: 5 })
    expect(only).toEqual({
      trigger: 'tool_result',
      tokensBefore: 0,
      tokensAfter: 0,
      replacedCount: 3,
    })
  })

  describe('Dashboard Session hydration', () => {
    it('runs external Runtime recovery even when an unrecovered record is cached', async () => {
      const cached = { sessionId: 'copilot-session', agentRuntime: 'copilot' as const, state: { status: 'idle' as const, cursor: 0 } }
      const recovered = { ...cached, state: { status: 'error' as const, cursor: 2 } }
      const store = {
        get: vi.fn(() => cached),
        load: vi.fn(async () => recovered),
      } as unknown as SessionStore

      await expect(loadDashboardSession(store, cached.sessionId)).resolves.toBe(recovered)
      expect(store.load).toHaveBeenCalledWith(cached.sessionId, undefined)
    })

    it('does not eagerly recover a cached Kernel Session during hydration', async () => {
      const cached = { sessionId: 'kernel-session', agentRuntime: 'kernel' as const, state: { status: 'thinking' as const, cursor: 4 } }
      const store = {
        get: vi.fn(() => cached),
        load: vi.fn(),
      } as unknown as SessionStore

      await expect(loadDashboardSession(store, cached.sessionId)).resolves.toBe(cached)
      expect(store.load).not.toHaveBeenCalled()
    })
  })
})
