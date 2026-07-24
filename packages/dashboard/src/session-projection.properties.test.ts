import { createConfig, createInitialState } from '@agent-kernel/kernel'
import type { ContextUsageSnapshot, EventAppendedEvent } from '@agent-kernel/shared'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { EMPTY_SESSION_PROJECTION, reduceSessionProjection, timelineEntry } from './session-projection.js'

const config = createConfig({ systemPrompt: 'system', tools: [] })
const context: ContextUsageSnapshot = {
  model: { ref: 'test' }, contextWindow: { tokens: 1000, source: 'model_catalog' },
  usage: { inputTokens: 0, totalTokens: 0 },
  breakdown: { system: 0, transcript: 0, tools: 0, memory: 0, attachments: 0, pendingUserInput: 0 },
  estimator: { total: { kind: 'heuristic', confidence: 'rough' }, breakdown: { kind: 'heuristic', confidence: 'rough' }, version: 'test' },
  updatedAt: 0,
}

function event(seq: number): EventAppendedEvent {
  return { sessionId: 'active', seq, ts: String(seq), event: { kind: 'user_message', text: String(seq) }, effects: [] }
}

function readyProjection() {
  const state = createInitialState({ sessionId: 'active', systemPrompt: 'system' })
  const selected = reduceSessionProjection(EMPTY_SESSION_PROJECTION, { kind: 'select', generation: 2, sessionId: 'active' })
  return reduceSessionProjection(selected, {
    kind: 'ready', generation: 2, sessionId: 'active',
    payload: { sessionId: 'active', cursor: 0, state, config, contextSnapshot: context },
  })
}

describe('session projection properties', () => {
  it('history remains sorted and deduplicated under arbitrary replay order', () => {
    fc.assert(fc.property(fc.array(fc.integer({ min: 1, max: 30 }), { maxLength: 100 }), (sequences) => {
      const state = reduceSessionProjection(readyProjection(), {
        kind: 'history', generation: 2, sessionId: 'active', entries: sequences.map((seq) => timelineEntry(event(seq))),
      })
      const actual = state.timeline.map((entry) => entry.seq)
      expect(actual).toEqual([...new Set(sequences)].sort((a, b) => a - b))
    }), { numRuns: 150 })
  })

  it('obsolete generations cannot change any projection field', () => {
    fc.assert(fc.property(fc.array(fc.integer({ min: 1, max: 30 }), { maxLength: 100 }), (sequences) => {
      const initial = readyProjection()
      let state = initial
      for (const seq of sequences) {
        state = reduceSessionProjection(state, { kind: 'appended', generation: 1, sessionId: 'stale', payload: event(seq) })
      }
      expect(state).toBe(initial)
    }), { numRuns: 150 })
  })
})
