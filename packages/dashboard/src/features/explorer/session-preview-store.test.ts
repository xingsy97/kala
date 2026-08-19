import { describe, expect, it, vi } from 'vitest'

import { createConfig, createInitialState } from '@agent-kernel/kernel'
import { SessionPreviewStore } from './session-preview-store.js'
import { createSessionViewCache } from '../../session-view-cache.js'

const snapshot = (sessionId: string, updatedAt: number) => ({
  sessionId,
  freshness: 'live' as const,
  updatedAt,
  view: { sessionId } as never,
})

describe('SessionPreviewStore', () => {
  it('notifies only listeners for the updated session', () => {
    const store = new SessionPreviewStore()
    const first = vi.fn()
    const second = vi.fn()
    store.subscribe('a', first)
    store.subscribe('b', second)

    store.set(snapshot('a', 1))

    expect(first).toHaveBeenCalledTimes(1)
    expect(second).not.toHaveBeenCalled()
    expect(store.get('a')?.updatedAt).toBe(1)
  })

  it('removes subscriptions cleanly', () => {
    const store = new SessionPreviewStore()
    const listener = vi.fn()
    const unsubscribe = store.subscribe('a', listener)
    unsubscribe()
    store.set(snapshot('a', 1))
    expect(listener).not.toHaveBeenCalled()
  })

  it('reuses the control socket, ignores high-frequency token deltas, and releases the room', () => {
    const handlers = new Map<string, (...args: never[]) => void>()
    const socket = {
      connected: true,
      on: vi.fn((event: string, handler: (...args: never[]) => void) => { handlers.set(event, handler) }),
      off: vi.fn(),
      emit: vi.fn(),
    } as never
    const cache = createSessionViewCache({ maxBytes: 1024 * 1024 })
    const store = new SessionPreviewStore()
    store.connect(socket, cache)

    const listener = vi.fn()
    const unsubscribe = store.subscribe('preview-session', listener)
    const stop = store.watch('preview-session')
    expect((socket as { emit: ReturnType<typeof vi.fn> }).emit).toHaveBeenCalledWith('client:subscribe_channels', expect.objectContaining({ channels: ['session:preview-session'] }), expect.any(Function))
    expect((socket as { emit: ReturnType<typeof vi.fn> }).emit).toHaveBeenCalledWith('client:load_history', { sessionId: 'preview-session' })

    handlers.get('session:ready')?.({
      sessionId: 'preview-session',
      state: createInitialState({}),
      config: createConfig({ tools: [], systemPrompt: '' }),
    } as never)
    const notificationsAfterReady = listener.mock.calls.length
    expect(handlers.has('session:token_delta')).toBe(false)
    expect(store.get('preview-session')?.streamingText).toBe('')
    expect(listener).toHaveBeenCalledTimes(notificationsAfterReady)

    handlers.get('event:appended')?.({
      sessionId: 'preview-session', seq: 1, ts: '2026-08-09T00:00:00.000Z',
      event: { kind: 'llm_response', message: { role: 'assistant', content: [{ type: 'text', text: 'Durable response.' }] }, usage: { inputTokens: 1, outputTokens: 1 } }, effects: [],
    } as never)
    expect(listener.mock.calls.length).toBeGreaterThan(notificationsAfterReady)

    stop()
    unsubscribe()
    expect((socket as { emit: ReturnType<typeof vi.fn> }).emit).toHaveBeenCalledWith('client:unsubscribe_channels', expect.objectContaining({ channels: ['session:preview-session'] }), expect.any(Function))
  })
})
