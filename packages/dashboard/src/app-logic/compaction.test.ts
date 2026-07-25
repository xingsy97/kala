import { describe, expect, it } from 'vitest'

import {
  compactFailureMessage,
  compactReasonMessage,
  hasCompactableContent,
  isCompactTerminalEvent,
  isCompactionSuccess,
} from './compaction.js'

describe('hasCompactableContent', () => {
  it('is false for null / only a leading system message', () => {
    expect(hasCompactableContent(null)).toBe(false)
    expect(hasCompactableContent({ messages: [{ role: 'system' }] } as never)).toBe(false)
  })
  it('is true when there is any non-system-leading message', () => {
    expect(hasCompactableContent({ messages: [{ role: 'system' }, { role: 'user' }] } as never)).toBe(true)
    expect(hasCompactableContent({ messages: [{ role: 'user' }] } as never)).toBe(true)
  })
})

describe('compaction event predicates', () => {
  it('detects terminal + success events', () => {
    expect(isCompactTerminalEvent('messages_replaced')).toBe(true)
    expect(isCompactTerminalEvent('event:appended')).toBe(false)
    expect(isCompactionSuccess({ kind: 'messages_replaced', reason: 'compaction' })).toBe(true)
    expect(isCompactionSuccess({ kind: 'messages_replaced', reason: 'other' })).toBe(false)
  })
})

describe('compaction failure messaging', () => {
  it('maps known reason codes to friendly text', () => {
    expect(compactReasonMessage('summary_too_short')).toMatch(/too short/i)
    expect(compactReasonMessage('circuit_breaker_open')).toMatch(/paused/i)
  })
  it('humanizes unknown reason codes', () => {
    expect(compactReasonMessage('some_new_reason')).toBe('some new reason')
  })
  it('compactFailureMessage uses the reason or a default', () => {
    expect(compactFailureMessage({ kind: 'x', reason: 'empty' })).toMatch(/nothing to compact/i)
    expect(compactFailureMessage({ kind: 'x' })).toBe('Compaction failed.')
  })
})
