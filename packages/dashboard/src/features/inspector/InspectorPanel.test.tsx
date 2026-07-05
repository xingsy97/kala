import { fireEvent, render, screen } from '@testing-library/react'
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

  describe('fork confirmation', () => {
    it('reports fork clicks with the cursor of the row after confirming the dialog', () => {
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
      fireEvent.click(screen.getByLabelText(/fork at cursor 1/))
      const confirm = screen.getByTestId('confirm-fork-button')
      fireEvent.click(confirm)
      expect(onFork).toHaveBeenCalledWith(1)
    })

    it('does not fork when the user cancels the confirm dialog', () => {
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
      fireEvent.click(screen.getByLabelText(/fork at cursor 1/))
      const cancel = screen.getByRole('button', { name: /cancel/i })
      fireEvent.click(cancel)
      expect(onFork).not.toHaveBeenCalled()
    })
  })

  it('renders inbound source labels and effect target labels for known event kinds', () => {
    render(
      <InspectorPanel
        state={{
          ...baseState,
          messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        }}
        timeline={[
          {
            seq: 1,
            ts: '2026-07-04T00:00:00Z',
            event: { kind: 'user_message', text: 'hi' },
            effects: [{ kind: 'call_llm', messages: [], tools: [] }],
          },
          {
            seq: 2,
            ts: '2026-07-04T00:00:01Z',
            event: {
              kind: 'llm_response',
              message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'ok' }],
              },
            },
            effects: [{ kind: 'finish' }],
          },
        ]}
      />,
    )
    // Inbound labels  -  one for each event row.
    expect(screen.getAllByText('user').length).toBeGreaterThan(0)
    expect(screen.getAllByText('llm').length).toBeGreaterThan(0)
    // Outbound effect targets  -  one child row per effect.
    expect(screen.getByText('call_llm')).toBeTruthy()
    expect(screen.getByText('finish')).toBeTruthy()
  })

  it('invokes onJumpToMessage with the message index of a clicked row', () => {
    const onJumpToMessage = vi.fn()
    render(
      <InspectorPanel
        state={{
          ...baseState,
          messages: [
            { role: 'user', content: [{ type: 'text', text: 'hi' }] },
            { role: 'assistant', content: [{ type: 'text', text: 'hey' }] },
          ],
        }}
        timeline={[
          {
            seq: 1,
            ts: '2026-07-04T00:00:00Z',
            event: { kind: 'user_message', text: 'hi' },
            effects: [],
          },
          {
            seq: 2,
            ts: '2026-07-04T00:00:01Z',
            event: {
              kind: 'llm_response',
              message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'hey' }],
              },
            },
            effects: [],
          },
        ]}
        onJumpToMessage={onJumpToMessage}
      />,
    )
    fireEvent.click(screen.getByTitle(/scroll chat to message #1/))
    expect(onJumpToMessage).toHaveBeenCalledWith(1)
  })

  it('expands a timeline row to show event JSON', () => {
    render(
      <InspectorPanel
        state={baseState}
        timeline={[
          {
            seq: 1,
            ts: '2026-07-04T00:00:00Z',
            event: { kind: 'user_message', text: 'hello world' },
            effects: [{ kind: 'call_llm', messages: [], tools: [] }],
          },
        ]}
      />,
    )
    // Before clicking, no details section rendered.
    expect(screen.queryByTestId('timeline-row-details')).toBeNull()
    // Click the row header  -  whole row is now the toggle target, not a
    // trivial chevron button.
    fireEvent.click(screen.getByTestId('timeline-row-header'))
    const details = screen.getByTestId('timeline-row-details')
    // JsonBlock renders the event kind in its label ("event  -  user_message").
    expect(details.textContent ?? '').toMatch(/user_message/)
  })
})
