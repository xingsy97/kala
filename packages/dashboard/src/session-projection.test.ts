import { createConfig, createInitialState } from '@agent-kernel/kernel'
import type { ContextUsageSnapshot, EventAppendedEvent, SessionReadyEvent } from '@agent-kernel/shared'
import { describe, expect, it } from 'vitest'

import { EMPTY_SESSION_PROJECTION, reduceSessionProjection, reduceSessionProjectionBatch } from './session-projection.js'

const config = createConfig({ systemPrompt: 'system', tools: [] })
const contextSnapshot: ContextUsageSnapshot = {
  model: { ref: 'provider/model' },
  contextWindow: { tokens: 200_000, source: 'model_catalog' },
  usage: { inputTokens: 10, totalTokens: 10 },
  breakdown: { system: 1, transcript: 9, tools: 0, memory: 0, attachments: 0, pendingUserInput: 0 },
  estimator: { total: { kind: 'heuristic', confidence: 'rough' }, breakdown: { kind: 'heuristic', confidence: 'rough' }, version: 'test' },
  updatedAt: 1,
}

function ready(sessionId: string): SessionReadyEvent {
  const state = createInitialState({ sessionId, systemPrompt: 'system' })
  return { sessionId, cursor: state.cursor, state, config, contextSnapshot }
}

function appended(sessionId: string, seq: number, text: string): EventAppendedEvent {
  return {
    sessionId, seq, ts: `2026-07-24T00:00:0${seq}.000Z`,
    event: { kind: 'user_message', text }, effects: [],
  }
}

function selected(sessionId: string, generation = 1) {
  const selected = reduceSessionProjection(EMPTY_SESSION_PROJECTION, { kind: 'select', generation, sessionId })
  return reduceSessionProjection(selected, { kind: 'ready', generation, sessionId, payload: ready(sessionId) })
}

describe('session projection reducer', () => {
  it('reduces a queued frame in exactly the same order as individual events', () => {
    const current = selected('session-a')
    const events = [
      { kind: 'appended', generation: 1, sessionId: 'session-a', payload: appended('session-a', 1, 'first') } as const,
      { kind: 'appended', generation: 1, sessionId: 'session-a', payload: appended('session-a', 2, 'second') } as const,
      { kind: 'status', generation: 1, sessionId: 'session-a', status: 'ready' } as const,
    ]
    const individual = events.reduce(reduceSessionProjection, current)

    expect(reduceSessionProjectionBatch(current, events)).toEqual(individual)
  })

  it('folds state and appends timeline in one transition', () => {
    const current = selected('session-a')
    const next = reduceSessionProjection(current, {
      kind: 'appended', generation: 1, sessionId: 'session-a', payload: appended('session-a', 1, 'hello'),
    })

    expect(next.state?.cursor).toBe(1)
    expect(next.state?.messages.at(-1)?.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(next.timeline.map((entry) => entry.seq)).toEqual([1])
    expect(next.lastError).toBeNull()
  })

  it('merges duplicate and out-of-order events without folding state twice or across a gap', () => {
    const current = selected('session-a')
    const once = reduceSessionProjection(current, {
      kind: 'appended', generation: 1, sessionId: 'session-a', payload: appended('session-a', 1, 'first'),
    })
    const duplicate = reduceSessionProjection(once, {
      kind: 'appended', generation: 1, sessionId: 'session-a', payload: appended('session-a', 1, 'first'),
    })
    const gap = reduceSessionProjection(duplicate, {
      kind: 'appended', generation: 1, sessionId: 'session-a', payload: appended('session-a', 3, 'third'),
    })

    expect(duplicate.state).toBe(once.state)
    expect(duplicate.timeline).toHaveLength(1)
    expect(gap.state?.cursor).toBe(1)
    expect(gap.timeline.map((entry) => entry.seq)).toEqual([1, 3])
  })

  it('keeps cached running state non-authoritative until session:ready', () => {
    const cachedState = { ...createInitialState({ sessionId: 'session-done' }), status: 'executing_tools' as const }
    const cached = {
      sessionId: 'session-done', status: 'ready' as const, state: cachedState, config,
      contextSnapshot, timeline: [], queuedMessages: [], lastError: null,
      parentSessionId: null, parentCursor: null, selectedModel: null, hydratedSessionId: 'session-done',
    }
    const selectedFromCache = reduceSessionProjection(EMPTY_SESSION_PROJECTION, {
      kind: 'select', generation: 1, sessionId: 'session-done', cached,
    })

    expect(selectedFromCache.state?.status).toBe('executing_tools')
    expect(selectedFromCache.hydratedSessionId).toBeNull()

    const authoritativeDone = { ...ready('session-done'), state: { ...ready('session-done').state, status: 'done' as const } }
    const hydrated = reduceSessionProjection(selectedFromCache, {
      kind: 'ready', generation: 1, sessionId: 'session-done', payload: authoritativeDone,
    })
    expect(hydrated.hydratedSessionId).toBe('session-done')
    expect(hydrated.state?.status).toBe('done')
  })

  it('accepts authoritative state and context as one correction', () => {
    const current = selected('session-a')
    const authoritativeState = {
      ...current.state!, cursor: 7, status: 'done' as const,
    }
    const authoritativeContext = { ...contextSnapshot, usage: { inputTokens: 700, totalTokens: 700 }, updatedAt: 7 }
    const next = reduceSessionProjection(current, {
      kind: 'authoritative', generation: 1, sessionId: 'session-a',
      payload: { sessionId: 'session-a', cursor: 7, state: authoritativeState, contextSnapshot: authoritativeContext },
    })

    expect(next.state).toBe(authoritativeState)
    expect(next.contextSnapshot).toBe(authoritativeContext)
  })

  it('ignores events from obsolete session generations', () => {
    const old = selected('session-a', 1)
    const current = reduceSessionProjection(old, { kind: 'select', generation: 2, sessionId: 'session-b' })
    const stale = reduceSessionProjection(current, {
      kind: 'appended', generation: 1, sessionId: 'session-a', payload: appended('session-a', 1, 'stale'),
    })

    expect(stale).toBe(current)
    expect(stale.sessionId).toBe('session-b')
    expect(stale.state).toBeNull()
    expect(stale.timeline).toEqual([])
  })

  it('merges history by sequence while preserving conflicting live entries', () => {
    const current = reduceSessionProjection(selected('session-a'), {
      kind: 'appended', generation: 1, sessionId: 'session-a', payload: appended('session-a', 1, 'live'),
    })
    const conflict = { ...appended('session-a', 1, 'different'), event: { kind: 'llm_error' as const, error: 'different kind' } }
    const next = reduceSessionProjection(current, {
      kind: 'history', generation: 1, sessionId: 'session-a',
      entries: [
        { seq: conflict.seq, ts: conflict.ts, event: conflict.event, effects: [] },
        { ...appended('session-a', 2, 'history'), effects: [] },
      ],
    })

    expect(next.timeline.map((entry) => entry.event.kind)).toEqual(['user_message', 'user_message'])
    expect(next.timeline.map((entry) => entry.seq)).toEqual([1, 2])
  })

  it('authoritative history reset replaces conflicting cached/live entries', () => {
    const current = reduceSessionProjection(selected('session-a'), {
      kind: 'appended', generation: 1, sessionId: 'session-a', payload: appended('session-a', 1, 'stale live'),
    })
    const authoritative = { ...appended('session-a', 1, 'server'), event: { kind: 'llm_error' as const, error: 'server truth' } }
    const next = reduceSessionProjection(current, {
      kind: 'history', generation: 1, sessionId: 'session-a', reset: true,
      entries: [
        { seq: authoritative.seq, ts: authoritative.ts, event: authoritative.event, effects: [] },
        { seq: authoritative.seq, ts: authoritative.ts, event: { kind: 'cancel' }, effects: [] },
      ],
    })
    expect(next.timeline).toHaveLength(1)
    expect(next.timeline[0]?.event).toEqual({ kind: 'llm_error', error: 'server truth' })
  })
})
