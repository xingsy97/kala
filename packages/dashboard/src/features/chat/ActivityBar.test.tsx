import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { createInitialState } from '@agent-kernel/kernel'

import { ActivityBar } from './ActivityBar.js'

const baseState = createInitialState({ sessionId: 'sess-activity' })

describe('ActivityBar', () => {
  it('shows readable resting state and runtime counters when idle', () => {
    render(
      <ActivityBar
        state={{
          ...baseState,
          status: 'done',
          cursor: 3,
          usage: { inputTokens: 42, outputTokens: 7, costUsd: 0 },
        }}
        compactStatus={{ kind: 'idle' }}
      />,
    )
    expect(screen.getByText('Agent Done')).toBeTruthy()
    const summary = screen.getByTestId('runtime-summary')
    expect(summary.textContent ?? '').toContain('Cursor3')
    expect(summary.textContent ?? '').toContain('Pending tools0')
    expect(summary.textContent ?? '').toContain('Tokens in/out42 / 7')
  })

  it('shows compact progress and completion', () => {
    const { rerender } = render(
      <ActivityBar state={baseState} compactStatus={{ kind: 'running' }} />,
    )
    expect(screen.getByText('Compacting context')).toBeTruthy()
    expect(screen.getByText('waiting for summarizer response')).toBeTruthy()

    rerender(<ActivityBar state={baseState} compactStatus={{ kind: 'done' }} />)
    expect(screen.getByText('Context compacted')).toBeTruthy()

    rerender(
      <ActivityBar
        state={baseState}
        compactStatus={{ kind: 'error', message: 'provider failed' }}
      />,
    )
    expect(screen.getByText('Compact failed')).toBeTruthy()
    expect(screen.getByText('provider failed')).toBeTruthy()
  })

  it('shows an empty compact hint without labeling it as a failure', () => {
    render(
      <ActivityBar
        state={baseState}
        compactStatus={{ kind: 'empty', message: 'send a message before compacting context' }}
      />,
    )
    expect(screen.getByText('Nothing to compact')).toBeTruthy()
    expect(screen.queryByText('Compact failed')).toBeNull()
    expect(screen.getByText('send a message before compacting context')).toBeTruthy()
  })

  it('shows LLM and tool wait states from agent state', () => {
    const { rerender } = render(
      <ActivityBar
        compactStatus={{ kind: 'idle' }}
        state={{ ...baseState, status: 'thinking' }}
      />,
    )
    expect(screen.getByText('Waiting for LLM response')).toBeTruthy()

    rerender(
      <ActivityBar
        compactStatus={{ kind: 'idle' }}
        state={{
          ...baseState,
          status: 'executing_tools',
          pendingCalls: [
            {
              callId: 'c1',
              name: 'bash',
              input: { command: 'pwd' },
              status: 'dispatched',
            },
          ],
        }}
      />,
    )
    expect(screen.getByText('Running tool')).toBeTruthy()
    expect(screen.getByText('bash')).toBeTruthy()
  })
})
