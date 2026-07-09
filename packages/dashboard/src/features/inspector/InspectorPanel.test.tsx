import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { AgentState } from '@agent-kernel/kernel'
import { InspectorPanel } from './InspectorPanel.js'

const baseState: AgentState = {
  sessionId: 's',
  messages: [],
  pendingCalls: [],
  status: 'idle',
  usage: { inputTokens: 42, outputTokens: 7, costUsd: 0 },
  cursor: 3,
}

describe('InspectorPanel', () => {
  it('shows connecting when state is null', () => {
    render(<InspectorPanel state={null} timeline={[]} />)
    expect(screen.getByText(/connecting/i)).toBeTruthy()
  })

  it('shows metrics and empty timeline', () => {
    render(<InspectorPanel state={baseState} timeline={[]} />)
    expect(screen.getAllByText(/idle/).length).toBeGreaterThan(0)
    expect(screen.getAllByText('3').length).toBeGreaterThan(0)
    expect(screen.getByText(/42 in \/ 7 out/)).toBeTruthy()
    expect(screen.getByText(/no events yet/i)).toBeTruthy()
  })

  it('reports fork clicks with the cursor of the row', () => {
    const onFork = vi.fn()
    render(
      <InspectorPanel
        state={baseState}
        timeline={[
          {
            seq: 1,
            ts: '2026-07-04T00:00:00Z',
            event: { kind: 'user_message', text: 'hi' },
            effects: [],
          },
        ]}
        onFork={onFork}
      />,
    )
    const btn = screen.getByTitle(/fork at cursor 1/)
    btn.click()
    expect(onFork).toHaveBeenCalledWith(1)
  })
})
