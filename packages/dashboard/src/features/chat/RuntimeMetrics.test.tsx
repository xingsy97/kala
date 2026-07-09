import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { createInitialState } from '@agent-kernel/kernel'

import { RuntimeMetrics } from './RuntimeMetrics.js'

describe('RuntimeMetrics', () => {
  it('shows only the compact context window indicator', () => {
    const state = {
      ...createInitialState({ sessionId: 'sess-runtime' }),
      cursor: 12,
      pendingCalls: [
        {
          callId: 'c1',
          name: 'bash',
          input: { command: 'pwd' },
          status: 'pending_approval' as const,
        },
      ],
      usage: { inputTokens: 1_200, outputTokens: 34 },
    }

    render(
      <RuntimeMetrics
        state={state}
        config={{ contextLimit: 4_000, autoCompactThreshold: 0.8 }}
        modelInfo={{ id: 'gpt-test', label: 'gpt-test', provider: 'openai', contextWindow: 8_000 }}
        queuedMessages={2}
      />,
    )

    const indicator = screen.getByTestId('context-usage-indicator')
    expect(indicator.textContent ?? '').toContain('30%')
    expect(indicator.textContent ?? '').not.toContain('Events')
    expect(indicator.textContent ?? '').not.toContain('Tools')
    expect(indicator.textContent ?? '').not.toContain('Tokens')
    expect(indicator.getAttribute('title') ?? '').toContain('Context window')

    fireEvent.click(indicator)
    const popover = screen.getByTestId('context-pressure-popover')
    expect(popover.textContent ?? '').toContain('Context pressure')
    expect(popover.textContent ?? '').toContain('user window')
    expect(popover.textContent ?? '').toContain('model window')
    expect(popover.textContent ?? '').toContain('queued')
    expect(popover.textContent ?? '').toContain('2')
    expect(popover.textContent ?? '').toContain('estimates')
  })
})
