import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@agent-kernel/shared'

import { SessionRuntimeStore, useSessionRuntime } from './session-runtime-store.js'

const sessionA: SessionSummary = {
  sessionId: 'a',
  createdAt: '2026-01-01T00:00:00.000Z',
  lastEventAt: '2026-01-01T00:00:01.000Z',
  eventCount: 1,
  status: 'idle',
}

const sessionB: SessionSummary = {
  ...sessionA,
  sessionId: 'b',
  status: 'done',
}

describe('SessionRuntimeStore', () => {
  it('notifies only the session whose snapshot changed', () => {
    const store = new SessionRuntimeStore()
    store.sync([sessionA, sessionB])
    const onA = vi.fn()
    const onB = vi.fn()
    store.subscribe('a', onA)
    store.subscribe('b', onB)

    store.sync([{ ...sessionA, status: 'thinking' }, sessionB])

    expect(onA).toHaveBeenCalledTimes(1)
    expect(onB).not.toHaveBeenCalled()
  })

  it('applies status overrides without mixing session ids', () => {
    const store = new SessionRuntimeStore()
    store.sync([sessionA, sessionB], new Map([['b', 'executing_tools']]))

    expect(store.get('a')?.status).toBe('idle')
    expect(store.get('b')?.status).toBe('executing_tools')
  })

  it('provides session-scoped React subscriptions', () => {
    const store = new SessionRuntimeStore()
    store.sync([sessionA, sessionB])
    const a = renderHook(() => useSessionRuntime(store, 'a'))
    const b = renderHook(() => useSessionRuntime(store, 'b'))

    act(() => store.sync([{ ...sessionA, currentCwd: '/new-a' }, sessionB]))

    expect(a.result.current?.currentCwd).toBe('/new-a')
    expect(b.result.current?.currentCwd).toBeUndefined()
  })
})
