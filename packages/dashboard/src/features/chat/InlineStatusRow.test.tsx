import { act, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { CompactFeedbackRow, InlineStatusRow, formatTokensShort } from './InlineStatusRow.js'

describe('agent activity card', () => {
  const state = { sessionId: 's', status: 'thinking' as const, messages: [], pendingCalls: [], usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 }, cursor: 0, approvalMode: 'auto' as const }

  it('uses Intention as the primary copy and expresses prior success visually', () => {
    render(<InlineStatusRow state={state} streamingActive={false} toolExecutionStartedAt={Date.now() - 2_000} progress={{ phase: 'thinking', label: 'Inspect the real activity component.', intention: 'Inspect the real activity component.', outcome: 'succeeded', callId: 'c1' }} />)
    expect(screen.getByTestId('inline-status-label').textContent).toContain('Inspect the real activity component.')
    expect(screen.getByLabelText('Succeeded')).toBeTruthy()
    expect(screen.getByTestId('inline-status-thinking').className).toContain('w-fit')
    expect(screen.queryByTestId('inline-status-intention')).toBeNull()
    expect(screen.getByTestId('inline-status-thinking').textContent).not.toContain('In progress')
    expect(screen.getByTestId('inline-status-thinking').textContent).not.toContain('Previous step completed')
  })

  it('shows only Thinking when no persisted Tool intention exists', () => {
    render(<InlineStatusRow state={state} streamingActive={false} progress={{ phase: 'thinking', label: 'Thinking' }} />)
    expect(screen.getByTestId('inline-status-label').textContent).toContain('Thinking')
    expect(screen.queryByTestId('inline-status-intention')).toBeNull()
  })

  it('keeps breathing and elapsed busy feedback live and yields to streaming', () => {
    vi.useFakeTimers()
    try {
      const { rerender } = render(<InlineStatusRow state={state} streamingActive={false} />)
      const row = screen.getByTestId('inline-status-thinking')
      expect(row.getAttribute('role')).toBe('status')
      expect(row.getAttribute('aria-live')).toBe('polite')
      expect(row.querySelector('.ak-thinking-dot')).toBeTruthy()
      expect(screen.getByTestId('inline-status-elapsed').textContent).toBe('0s')
      act(() => vi.advanceTimersByTime(2_100))
      expect(screen.getByTestId('inline-status-elapsed').textContent).toBe('2s')
      rerender(<InlineStatusRow state={state} streamingActive />)
      expect(screen.queryByTestId('inline-status-thinking')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('expresses failure and approval without verbose lifecycle prefixes', () => {
    const { rerender } = render(<InlineStatusRow state={state} streamingActive={false} progress={{ phase: 'thinking', label: 'Verify the change.', intention: 'Verify the change.', outcome: 'failed' }} />)
    expect(screen.getByLabelText('Failed')).toBeTruthy()
    expect(screen.getByTestId('inline-status-label').textContent).toContain('Verify the change.')
    rerender(<InlineStatusRow state={{ ...state, status: 'awaiting_approval' }} streamingActive={false} progress={{ phase: 'approval', label: 'Apply the requested patch.', intention: 'Apply the requested patch.', outcome: 'approval' }} />)
    expect(screen.getByLabelText('Approval needed')).toBeTruthy()
    expect(screen.getByTestId('inline-status-thinking').textContent).not.toContain('Awaiting approval')
  })

  it('keeps settled Tool duration fixed and omits approval timing without duration evidence', () => {
    const { rerender } = render(<InlineStatusRow state={state} streamingActive={false} progress={{ phase: 'thinking', label: 'Check the persisted result.', intention: 'Check the persisted result.', outcome: 'succeeded', durationMs: 2_400 }} />)
    expect(screen.getByTestId('inline-status-elapsed').textContent).toBe('2s')
    rerender(<InlineStatusRow state={{ ...state, status: 'awaiting_approval' }} streamingActive={false} progress={{ phase: 'approval', label: 'Approve the write.', intention: 'Approve the write.', outcome: 'approval' }} />)
    expect(screen.queryByTestId('inline-status-elapsed')).toBeNull()
  })
})

describe('compact context display', () => {
  it('labels the value as current context rather than cumulative token usage', () => {
    render(<CompactFeedbackRow kind="running" startedAt={Date.now()} tokensBefore={823_456} />)
    expect(screen.getByTestId('inline-compact-running').textContent).toContain('context 823.5k tokens')
    expect(screen.getByTestId('inline-compact-running').textContent).not.toContain('↑')
  })

  it('formats only genuinely million-sized snapshots as millions', () => {
    expect(formatTokensShort(999_999)).toBe('1000.0k tokens')
    expect(formatTokensShort(1_100_000)).toBe('1.1m tokens')
  })
})
