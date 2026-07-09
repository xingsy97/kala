import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createInitialState } from '@agent-kernel/kernel'
import { PROTOCOL_VERSION } from '@agent-kernel/shared'

import { useSession, type TimelineEntry } from './session.js'
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

afterEach(() => {
  sockets.length = 0
})

describe('useSession session view cache', () => {
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
    expect(cache.get('s1')?.timeline.map((entry) => entry.seq)).toEqual([1, 2])
  })
})
