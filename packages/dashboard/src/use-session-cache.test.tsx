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
  it('keeps rapid A to B to A switching on one socket and completes loading only from current history', async () => {
    const wrapper = ({ sessionId }: { sessionId: string }) => {
      const socket = useDashboardControlSocket('http://host', undefined, true)
      return useSession({ host: 'http://host', sessionId, socket })
    }
    const view = renderHook(({ sessionId }) => wrapper({ sessionId }), { initialProps: { sessionId: 'a' } })
    await waitFor(() => expect(sockets).toHaveLength(1))
    const socket = sockets[0]!
    view.rerender({ sessionId: 'b' })
    view.rerender({ sessionId: 'a' })
    await waitFor(() => expect(socket.handlers.get('session:ready')).toHaveLength(1))

    act(() => socket.serverEmit('session:ready', { sessionId: 'b', reason: 'load', cursor: 1, state: createInitialState({ sessionId: 'b' }), config: { tools: [] }, contextSnapshot: null }))
    expect(view.result.current.hydratedSessionId).not.toBe('b')
    act(() => socket.serverEmit('session:ready', { sessionId: 'a', reason: 'load', cursor: 1, state: createInitialState({ sessionId: 'a' }), config: { tools: [] }, contextSnapshot: null }))
    expect(view.result.current.hydratedSessionId).toBe('a')
    expect(view.result.current.historyLoadedSessionId).toBeNull()

    act(() => socket.serverEmit('server:history', { sessionId: 'b', entries: [timelineEntry(1)] }))
    expect(view.result.current.historyLoadedSessionId).toBeNull()
    act(() => socket.serverEmit('server:history', { sessionId: 'a', entries: [timelineEntry(1)] }))
    expect(view.result.current.historyLoadedSessionId).toBe('a')
    expect(view.result.current.timeline.map((entry) => entry.seq)).toEqual([1])
    expect(sockets).toHaveLength(1)
    expect(socket.connected).toBe(true)
  })

  it('removes session listeners when a shared socket is rebound', async () => {
    sockets.length = 0
    const wrapper = ({ sessionId }: { sessionId: string }) => {
      const socket = useDashboardControlSocket('http://host', undefined, true)
      return useSession({ host: 'http://host', sessionId, socket }).streamingText
    }
    const view = renderHook(({ sessionId }) => wrapper({ sessionId }), {
      initialProps: { sessionId: 's1' },
    })
    await waitFor(() => expect(sockets).toHaveLength(1))
    const socket = sockets[0]!
    expect(socket.handlers.get('session:token_delta')).toHaveLength(1)

    view.rerender({ sessionId: 's2' })
    await waitFor(() => expect(socket.handlers.get('session:token_delta')).toHaveLength(1))
    view.rerender({ sessionId: 's1' })
    await waitFor(() => expect(socket.handlers.get('session:token_delta')).toHaveLength(1))

    // Every delta must have exactly one consumer after repeated workspace/session
    // switches; leaked handlers append the same streamed text multiple times.
    expect(socket.handlers.get('event:appended')).toHaveLength(1)
    expect(socket.handlers.get('state:changed')).toHaveLength(1)
  })

  it('keeps streamed text visible while the turn transitions into tool execution', async () => {
    const frames: FrameRequestCallback[] = []
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback)
      return frames.length
    })
    const caf = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})
    const flushFrames = async (count = 20): Promise<void> => {
      for (let index = 0; index < count && frames.length > 0; index += 1) {
        const callback = frames.shift()!
        await act(async () => callback(performance.now()))
      }
    }
    try {
      window.localStorage.setItem('ak-smooth-streaming-text', 'false')
      const { result } = renderHook(() => useSession({ host: 'http://host.test', sessionId: 's1' }))
      await waitFor(() => expect(sockets).toHaveLength(1))
      const socket = sockets[0]!
      const thinking = { ...createInitialState({ sessionId: 's1' }), status: 'thinking' as const }
      act(() => socket.serverEmit('session:ready', {
        sessionId: 's1', reason: 'load', cursor: 1, state: thinking, config: { tools: [] }, contextSnapshot: null,
      }))
      act(() => socket.serverEmit('session:token_delta', { sessionId: 's1', text: 'visible draft before tool' }))
      await flushFrames()
      await waitFor(() => expect(result.current.streamingText).toBe('visible draft before tool'))

      act(() => socket.serverEmit('state:changed', {
        sessionId: 's1',
        state: {
          ...thinking,
          status: 'executing_tools',
          pendingCalls: [{ callId: 'call-1', name: 'bash', input: { command: 'true' }, status: 'dispatched' }],
        },
        contextSnapshot: null,
      }))
      await flushFrames()

      expect(result.current.state?.status).toBe('executing_tools')
      expect(result.current.streamingText).toBe('visible draft before tool')

      act(() => socket.serverEmit('event:appended', {
        sessionId: 's1',
        seq: 2,
        ts: 't2',
        event: {
          kind: 'llm_response',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_call', callId: 'call-1', name: 'bash', input: { command: 'true' } }],
          },
        },
        effects: [{ kind: 'call_tool', callId: 'call-1', name: 'bash', input: { command: 'true' } }],
      }))
      await flushFrames()

      expect(result.current.timeline.at(-1)?.event.kind).toBe('llm_response')
      expect(result.current.streamingText).toBe('visible draft before tool')
    } finally {
      raf.mockRestore()
      caf.mockRestore()
      window.localStorage.removeItem('ak-smooth-streaming-text')
    }
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

  it('paints the selected Session before checkpointing the previous large cache', async () => {
    vi.useFakeTimers()
    let frame: FrameRequestCallback | null = null
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => { frame = callback; return 1 })
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
      expect(set).not.toHaveBeenCalled()
      await act(async () => { await Promise.resolve() })
      expect(set).not.toHaveBeenCalled()
      expect(frame).not.toBeNull()
      await act(async () => { frame?.(performance.now()) })
      expect(set).not.toHaveBeenCalled()
      await act(async () => vi.runOnlyPendingTimers())
      expect(set).toHaveBeenCalledTimes(1)
      expect(set.mock.calls[0]?.[0]).toBe('s1')
    } finally {
      raf.mockRestore()
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

  it('bounds a lost history response with retries and an actionable terminal error', async () => {
    vi.useFakeTimers()
    try {
      const { result } = renderHook(() => useSession({ host: 'http://host.test', sessionId: 's1' }))
      await act(async () => {})
      act(() => sockets[0]!.serverEmit('session:ready', {
        sessionId: 's1', reason: 'load', cursor: 2, state: createInitialState({ sessionId: 's1' }), config: { tools: [] }, contextSnapshot: null,
      }))
      expect(result.current.historyLoadedSessionId).toBeNull()
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
      expect(sockets[0]!.emitted.filter((entry) => entry.event === 'client:load_history')).toHaveLength(3)
      expect(result.current.historyLoadedSessionId).toBe('s1')
      expect(result.current.lastError?.message).toContain('Conversation history request timed out')
    } finally { vi.useRealTimers() }
  })

  it('uses the authoritative external Runtime baseline without requesting Kernel history', async () => {
    vi.useFakeTimers()
    try {
      const { result } = renderHook(() => useSession({ host: 'http://host.test', sessionId: 's1' }))
      await act(async () => {})
      act(() => sockets[0]!.serverEmit('session:ready', {
        sessionId: 's1',
        reason: 'load',
        agentRuntime: 'copilot',
        cursor: 2,
        state: createInitialState({ sessionId: 's1' }),
        config: { tools: [] },
        contextSnapshot: null,
      }))

      expect(result.current.historyLoadedSessionId).toBe('s1')
      expect(sockets[0]!.emitted.filter((entry) => entry.event === 'client:load_history')).toHaveLength(0)
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
      expect(result.current.lastError).toBeNull()
    } finally { vi.useRealTimers() }
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
    expect(result.current.hydratedSessionId).toBeNull()

    sockets[0]!.serverEmit('session:ready', {
      sessionId: 's1',
      reason: 'load',
      cursor: 5,
      state,
      config: { systemPrompt: 'test', tools: [] },
      contextSnapshot: null,
    })

    await waitFor(() => expect(result.current.hydratedSessionId).toBe('s1'))
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
