import { describe, expect, it, vi } from 'vitest'
import type { RuntimeMetadataEntry } from '@agent-kernel/shared'

import { buildCompactionMetadataIndex, consumeCompactionMetadata, loadDashboardSession, terminalOwnerSessionId } from './dashboard-ns.js'
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

describe('temporary workspace terminal identity', () => {
  it('maps an isolated PTY id to its authorized owner session and rejects malformed ids', () => {
    expect(terminalOwnerSessionId('session-1')).toBe('session-1')
    expect(terminalOwnerSessionId('workspace-terminal:session-1:request-1')).toBe('session-1')
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
