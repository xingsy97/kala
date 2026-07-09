import { describe, expect, it } from 'vitest'

import { deriveSessionState, isSessionResting, isSessionRunning } from './session-derived-state.js'

describe('session-derived-state', () => {
  it('classifies idle and terminal states as accepting user messages', () => {
    expect(deriveSessionState({ status: 'idle' })).toMatchObject({ activity: 'idle', isRunning: false, canAcceptUserMessage: true })
    expect(deriveSessionState({ status: 'done' })).toMatchObject({ activity: 'done', isRunning: false, canAcceptUserMessage: true })
    expect(deriveSessionState({ status: 'error' })).toMatchObject({ activity: 'failed', isRunning: false, canAcceptUserMessage: true })
  })

  it('classifies thinking, loading, and streaming as running thinking activity', () => {
    expect(deriveSessionState({ status: 'thinking' })).toMatchObject({ activity: 'thinking', isRunning: true, shouldShowThinkingIndicator: true, restartResumeAction: 'continue_turn' })
    expect(deriveSessionState({ status: 'idle', streamingActive: true })).toMatchObject({ activity: 'thinking', isRunning: true })
    expect(deriveSessionState({ status: 'loading' })).toMatchObject({ activity: 'thinking', isRunning: true })
  })

  it('classifies tool execution separately from thinking', () => {
    expect(deriveSessionState({ status: 'executing_tools' })).toMatchObject({ activity: 'tooling', isRunning: true, shouldShowToolIndicator: true, restartResumeAction: 'continue_turn' })
  })

  it('treats awaiting approval as waiting for user instead of running', () => {
    expect(deriveSessionState({ status: 'awaiting_approval' })).toMatchObject({ activity: 'waiting_user', isRunning: false, isWaitingForUser: true, restartResumeAction: 'wait_for_approval' })
    expect(deriveSessionState({ status: 'idle', pendingCalls: [{ status: 'awaiting_approval' }] })).toMatchObject({ activity: 'waiting_user' })
  })

  it('exposes running/resting helpers', () => {
    expect(isSessionRunning({ status: 'thinking' })).toBe(true)
    expect(isSessionRunning({ status: 'awaiting_approval' })).toBe(false)
    expect(isSessionResting({ status: 'idle' })).toBe(true)
    expect(isSessionResting({ status: 'awaiting_approval' })).toBe(false)
  })
})
