import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { createInitialState, type AgentState } from '@agent-kernel/kernel'
import { InspectorPanel } from './InspectorPanel.js'

const baseState: AgentState = {
  ...createInitialState({ sessionId: 's' }),
  status: 'idle',
  usage: { inputTokens: 42, outputTokens: 7, costUsd: 0 },
  cursor: 3,
}

describe('InspectorPanel', () => {
  it('shows timeline and empty raw state while state is null', () => {
    render(<InspectorPanel state={null} timeline={[]} />)
    expect(screen.getByText(/timeline/i)).toBeTruthy()
    expect(screen.getByText(/no events yet/i)).toBeTruthy()
    expect(screen.getByText(/Agent state/i)).toBeTruthy()
    expect(screen.getByText(' - ')).toBeTruthy()
  })

  it('shows empty timeline and raw state JSON', () => {
    render(<InspectorPanel state={baseState} timeline={[]} />)
    expect(screen.getByText(/no events yet/i)).toBeTruthy()
    expect(screen.getByText(/full runtime state JSON/)).toBeTruthy()
    expect(document.body.textContent ?? '').toContain('inputTokens')
    expect(document.body.textContent ?? '').toContain('42')
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

  it('switches the history block from timeline to state flow', () => {
    render(
      <InspectorPanel
        state={baseState}
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

    expect(screen.getByTestId('history-view-switch')).toBeTruthy()
    expect(screen.getAllByTestId('timeline-row')).toHaveLength(2)
    expect(screen.queryByTestId('state-flow-row')).toBeNull()

    fireEvent.click(screen.getByTestId('history-view-state-flow'))
    const rows = screen.getAllByTestId('state-flow-row')
    expect(rows).toHaveLength(2)
    expect(rows[0]?.textContent).toContain('Ready  -  Waiting for LLM')
    expect(rows[1]?.textContent).toContain('Waiting for LLM  -  Done')
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

  it('opens a modal with event JSON when clicking a timeline row', () => {
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
    fireEvent.click(screen.getByTestId('timeline-row-header'))
    expect(screen.getByText('Timeline event #1')).toBeTruthy()
    const details = screen.getByTestId('timeline-row-details')
    // JsonBlock renders the event kind in its label ("event  -  user_message").
    expect(details.textContent ?? '').toMatch(/user_message/)
  })
})
