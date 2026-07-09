import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { createInitialState } from '@agent-kernel/kernel'

import { RuntimeMetrics } from './RuntimeMetrics.js'

describe('RuntimeMetrics', () => {
  it('shows readable metric labels with explanatory hover titles', () => {
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
      usage: { inputTokens: 1_200, outputTokens: 34, costUsd: 0 },
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
    expect(indicator.textContent ?? '').toContain('30% context')
    expect(indicator.textContent ?? '').toContain('Events')
    expect(indicator.textContent ?? '').toContain('Tools')
    expect(indicator.textContent ?? '').toContain('Queued')
    expect(screen.getByText('Events').closest('[title]')?.getAttribute('title') ?? '').toContain('Event log position')
    expect(screen.getByText('Tools').closest('[title]')?.getAttribute('title') ?? '').toContain('Pending tool calls')
  })
})
