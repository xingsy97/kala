import { act, render, renderHook, waitFor } from '@testing-library/react'
import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createInitialState } from '@agent-kernel/kernel'
import { PROTOCOL_VERSION } from '@agent-kernel/shared'

import { useControlPlane, useDashboardControlSocket, useSession, type TimelineEntry } from './session.js'
import { createSessionViewCache } from './session-view-cache.js'

type Handler = (payload: any) => void

const sockets: MockSocket[] = []

vi.mock('socket.io-client', () => ({
  io: vi.fn((_url: string, _options: unknown) => {
    const socket = new MockSocket()
    sockets.push(socket)
    return socket
  }),
}))

class MockSocket {
  handlers = new Map<string, Handler[]>()
  emitted: Array<{ event: string; payload: unknown }> = []
  io = { on: vi.fn() }
  connected = true

  on(event: string, handler: Handler): this {
    const list = this.handlers.get(event) ?? []
    list.push(handler)
    this.handlers.set(event, list)
    return this
  }

  off(event: string, handler: Handler): this {
    const list = this.handlers.get(event) ?? []
    this.handlers.set(event, list.filter((candidate) => candidate !== handler))
    return this
  }

  emit(event: string, payload: unknown): this {
    this.emitted.push({ event, payload })
    return this
  }

  close(): void {
    this.connected = false
  }

  serverEmit(event: string, payload: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) handler(payload)
  }
}

function timelineEntry(seq: number): TimelineEntry {
  return {
    seq,
    ts: `2026-07-21T00:00:0${seq}.000Z`,
    event: { kind: 'user_message', text: `message ${seq}` },
    effects: [],
  }
}

function cachedView(sessionId: string, timeline: readonly TimelineEntry[]) {
  return {
    sessionId,
    status: 'ready' as const,
    state: createInitialState({ sessionId }),
    config: { systemPrompt: 'cached', tools: [] },
    contextSnapshot: null,
    timeline,
    queuedMessages: [],
    lastError: null,
    parentSessionId: null,
    parentCursor: null,
    selectedModel: null,
    hydratedSessionId: sessionId,
    cachedAt: Date.now(),
    estimatedBytes: 1,
    estimateParts: { staticBytes: 1, stateBytes: 1, timelineBytes: 1 },
  }
}

afterEach(() => {
  sockets.length = 0
})

describe('useSession session view cache', () => {
  it('reuses one physical control socket while switching selected sessions', async () => {
    sockets.length = 0
    const wrapper = ({ sessionId }: { sessionId: string }) => {
      const socket = useDashboardControlSocket('http://host', undefined, true)
      useSession({ host: 'http://host', sessionId, socket })
      return null
    }
    const view = render(React.createElement(wrapper, { sessionId: 's1' }))
    await waitFor(() => expect(sockets).toHaveLength(1))
    view.rerender(React.createElement(wrapper, { sessionId: 's2' }))
    await waitFor(() => expect(sockets[0]?.emitted.some((entry) => entry.event === 'client:subscribe_channels' && (entry.payload as { channels?: string[] }).channels?.includes('session:s2'))).toBe(true))
    expect(sockets).toHaveLength(1)
    expect(sockets[0]?.connected).toBe(true)
  })
  it('keeps a dashboard control socket independent from the selected session hook', async () => {
    const { rerender, unmount } = renderHook(
      ({ sessionId }) => ({
        control: useDashboardControlSocket('http://host.test'),
        session: useSession({ host: 'http://host.test', sessionId }),
      }),
      { initialProps: { sessionId: 's1' as string | null } },
    )

    await waitFor(() => expect(sockets).toHaveLength(2))
    const controlSocket = sockets[0]!
    const sessionSocket = sockets[1]!
    expect(controlSocket.emitted.some((entry) => entry.event === 'client:subscribe_channels' && (entry.payload as { channels?: string[] }).channels?.includes('global'))).toBe(true)
    expect(sessionSocket.connected).toBe(true)

    rerender({ sessionId: null })

    expect(sessionSocket.connected).toBe(false)
    expect(controlSocket.connected).toBe(true)

    unmount()
    expect(controlSocket.connected).toBe(false)
  })

  it('keeps control-plane data loaded when the selected session is cleared', async () => {
    const { result, rerender } = renderHook(
      ({ sessionId }) => {
        const controlSocket = useDashboardControlSocket('http://host.test')
        return {
          control: useControlPlane(controlSocket),
          session: useSession({ host: 'http://host.test', sessionId }),
        }
      },
      { initialProps: { sessionId: 's1' as string | null } },
    )

    await waitFor(() => expect(sockets).toHaveLength(2))
    const controlSocket = sockets[0]!
    const sessionSocket = sockets[1]!

    act(() => {
      controlSocket.serverEmit('server:executors', { executors: [] })
      controlSocket.serverEmit('server:sessions', {
        sessions: [{ sessionId: 's1', createdAt: 't0', eventCount: 0 }],
      })
    })

    await waitFor(() => {
      expect(result.current.control.executorsLoaded).toBe(true)
      expect(result.current.control.sessionsLoaded).toBe(true)
      expect(result.current.control.sessions).toHaveLength(1)
    })

    rerender({ sessionId: null })

    expect(sessionSocket.connected).toBe(false)
    expect(controlSocket.connected).toBe(true)
    expect(result.current.control.executorsLoaded).toBe(true)
    expect(result.current.control.sessionsLoaded).toBe(true)
    expect(result.current.control.sessions.map((session) => session.sessionId)).toEqual(['s1'])
  })

  it('batches high-frequency control summary events into one animation frame', async () => {
    const { result } = renderHook(() => {
      const controlSocket = useDashboardControlSocket('http://host.test')
      return useControlPlane(controlSocket)
    })
    await waitFor(() => expect(sockets).toHaveLength(1))
    const controlSocket = sockets[0]!
    act(() => controlSocket.serverEmit('server:sessions', {
      sessions: [{ sessionId: 's1', createdAt: 't0', eventCount: 0, status: 'idle' }],
    }))
    act(() => {
      controlSocket.serverEmit('event:appended', {
        sessionId: 's1', seq: 1, ts: 't1', event: { kind: 'user_message', text: 'one' }, effects: [],
      })
      controlSocket.serverEmit('state:changed', {
        sessionId: 's1', state: { ...createInitialState({ sessionId: 's1' }), status: 'thinking' }, contextSnapshot: null,
      })
    })
    expect(result.current.sessions[0]?.eventCount).toBe(0)
    await waitFor(() => expect(result.current.sessions[0]?.eventCount).toBe(1))
    expect(result.current.sessions[0]?.status).toBe('thinking')
  })

  it('checkpoints cache updates instead of writing on every projection commit', async () => {
    vi.useFakeTimers()
    try {
      const memory = createSessionViewCache({ maxBytes: 1024 * 1024 })
      const set = vi.fn(memory.set)
      const cache = { ...memory, set }
      const { result } = renderHook(() => useSession({ host: 'http://host.test', sessionId: 's1', cache }))
      await act(async () => {})
      act(() => sockets[0]!.serverEmit('session:ready', {
        sessionId: 's1', reason: 'load', cursor: 0, state: createInitialState({ sessionId: 's1' }),
        config: { systemPrompt: 'live', tools: [] }, contextSnapshot: null,
      }))
      act(() => sockets[0]!.serverEmit('event:appended', {
        sessionId: 's1', seq: 1, ts: 't1', event: { kind: 'user_message', text: 'one' }, effects: [],
      }))
      act(() => sockets[0]!.serverEmit('event:appended', {
        sessionId: 's1', seq: 2, ts: 't2', event: { kind: 'user_message', text: 'two' }, effects: [],
      }))
      expect(set).not.toHaveBeenCalled()
      await act(async () => vi.advanceTimersByTime(1_000))
      expect(set).toHaveBeenCalledTimes(1)
      expect(result.current.timeline.map((item) => item.seq)).toEqual([1, 2])
    } finally {
      vi.useRealTimers()
    }
  })

  it('flushes the pending cache checkpoint when switching sessions', async () => {
    vi.useFakeTimers()
    try {
      const memory = createSessionViewCache({ maxBytes: 1024 * 1024 })
      const set = vi.fn(memory.set)
      const cache = { ...memory, set }
      const { rerender } = renderHook(({ sessionId }) => useSession({ host: 'http://host.test', sessionId, cache }), {
        initialProps: { sessionId: 's1' as string | null },
      })
      await act(async () => {})
      act(() => sockets[0]!.serverEmit('session:ready', {
        sessionId: 's1', reason: 'load', cursor: 0, state: createInitialState({ sessionId: 's1' }),
        config: { systemPrompt: 'live', tools: [] }, contextSnapshot: null,
      }))
      expect(set).not.toHaveBeenCalled()
      rerender({ sessionId: 's2' })
      expect(set).toHaveBeenCalledTimes(1)
      expect(set.mock.calls[0]?.[0]).toBe('s1')
    } finally {
      vi.useRealTimers()
    }
  })

  it('opens the live socket without waiting for durable hydration', async () => {
    let resolveHydrate: ((view: null) => void) | null = null
    const hydrate = vi.fn(() => new Promise<null>((resolve) => { resolveHydrate = resolve }))
    const cache = { ...createSessionViewCache({ maxBytes: 1024 * 1024 }), hydrate }
    renderHook(() => useSession({
      host: 'http://host.test',
      sessionId: 's1',
      cache,
    }))

    await waitFor(() => expect(sockets).toHaveLength(1))
    expect(hydrate).toHaveBeenCalledWith('s1')
    act(() => resolveHydrate?.(null))
  })

  it('ignores durable hydration that arrives after the live baseline', async () => {
    let resolveHydrate: ((view: ReturnType<typeof cachedView>) => void) | null = null
    const hydrate = vi.fn(() => new Promise<ReturnType<typeof cachedView>>((resolve) => { resolveHydrate = resolve }))
    const cache = { ...createSessionViewCache({ maxBytes: 1024 * 1024 }), hydrate }
    const { result } = renderHook(() => useSession({
      host: 'http://host.test',
      sessionId: 's1',
      cache,
    }))
    await waitFor(() => expect(sockets).toHaveLength(1))
    const liveState = createInitialState({ sessionId: 's1' })
    act(() => sockets[0]!.serverEmit('session:ready', {
      sessionId: 's1', reason: 'load', cursor: 0, state: liveState,
      config: { systemPrompt: 'live', tools: [] }, contextSnapshot: null,
    }))
    act(() => resolveHydrate?.(cachedView('s1', [timelineEntry(4)])))
    await Promise.resolve()

    expect(result.current.config?.systemPrompt).toBe('live')
    expect(result.current.timeline).toEqual([])
  })

  it('restores cached timeline immediately and refreshes history from the cached cursor', async () => {
    const cache = createSessionViewCache({ maxBytes: 1024 * 1024 })
    const state = createInitialState({ sessionId: 's1' })
    cache.set('s1', {
      sessionId: 's1',
      status: 'ready',
      state,
      config: { systemPrompt: 'test', tools: [] },
      contextSnapshot: null,
      timeline: [timelineEntry(1), timelineEntry(3)],
      queuedMessages: [],
      lastError: null,
      parentSessionId: null,
      parentCursor: null,
      selectedModel: null,
      hydratedSessionId: 's1',
    })

    const { result } = renderHook(() => useSession({ host: 'http://host.test', sessionId: 's1', cache }))

    await waitFor(() => expect(result.current.timeline.map((entry) => entry.seq)).toEqual([1, 3]))
    expect(result.current.hydratedSessionId).toBe('s1')

    sockets[0]!.serverEmit('session:ready', {
      sessionId: 's1',
      reason: 'load',
      cursor: 5,
      state,
      config: { systemPrompt: 'test', tools: [] },
      contextSnapshot: null,
    })

    expect(sockets[0]!.emitted).toContainEqual({
      event: 'client:load_history',
      payload: { sessionId: 's1', sinceCursor: 3 },
    })
  })

  it('does a full history refresh when cached cursor is ahead of host cursor', async () => {
    const cache = createSessionViewCache({ maxBytes: 1024 * 1024 })
    const state = createInitialState({ sessionId: 's1' })
    cache.set('s1', {
      sessionId: 's1',
      status: 'ready',
      state,
      config: { systemPrompt: 'test', tools: [] },
      contextSnapshot: null,
      timeline: [timelineEntry(4)],
      queuedMessages: [],
      lastError: null,
      parentSessionId: null,
      parentCursor: null,
      selectedModel: null,
      hydratedSessionId: 's1',
    })

    renderHook(() => useSession({ host: 'http://host.test', sessionId: 's1', token: PROTOCOL_VERSION, cache }))

    sockets[0]!.serverEmit('session:ready', {
      sessionId: 's1',
      reason: 'load',
      cursor: 2,
      state,
      config: { systemPrompt: 'test', tools: [] },
      contextSnapshot: null,
    })

    expect(cache.get('s1')).toBeNull()
    expect(sockets[0]!.emitted).toContainEqual({
      event: 'client:load_history',
      payload: { sessionId: 's1' },
    })
  })

  it('replaces stale cached timeline after host cursor rollback', async () => {
    const cache = createSessionViewCache({ maxBytes: 1024 * 1024 })
    const state = createInitialState({ sessionId: 's1' })
    cache.set('s1', {
      sessionId: 's1',
      status: 'ready',
      state,
      config: { systemPrompt: 'test', tools: [] },
      contextSnapshot: null,
      timeline: [timelineEntry(4)],
      queuedMessages: [],
      lastError: null,
      parentSessionId: null,
      parentCursor: null,
      selectedModel: null,
      hydratedSessionId: 's1',
    })

    const { result } = renderHook(() => useSession({ host: 'http://host.test', sessionId: 's1', cache }))

    sockets[0]!.serverEmit('session:ready', {
      sessionId: 's1',
      reason: 'load',
      cursor: 2,
      state,
      config: { systemPrompt: 'test', tools: [] },
      contextSnapshot: null,
    })
    sockets[0]!.serverEmit('server:history', {
      sessionId: 's1',
      entries: [timelineEntry(1), timelineEntry(2)],
    })

    await waitFor(() => expect(result.current.timeline.map((entry) => entry.seq)).toEqual([1, 2]))
    await waitFor(() => expect(cache.get('s1')?.timeline.map((entry) => entry.seq)).toEqual([1, 2]), { timeout: 2_000 })
  })
})
