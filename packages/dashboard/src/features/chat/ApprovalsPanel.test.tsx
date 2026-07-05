import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ApprovalsPanel } from './ApprovalsPanel.js'

describe('ApprovalsPanel', () => {
  it('renders nothing when there are no pending approvals', () => {
    const { container } = render(
      <ApprovalsPanel approvals={[]} onDecision={() => {}} />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('renders the tool name and reports the decision', () => {
    const onDecision = vi.fn()
    render(
      <ApprovalsPanel
        approvals={[
          {
            sessionId: 's',
            callId: 'c1',
            name: 'write',
            input: { path: '/tmp/x' },
          },
        ]}
        onDecision={onDecision}
      />,
    )
    expect(screen.getByText('write')).toBeTruthy()
    fireEvent.click(screen.getByTestId('approval-approve'))
    expect(onDecision).toHaveBeenCalledWith('c1', 'approve')
    fireEvent.click(screen.getByTestId('approval-reject'))
    expect(onDecision).toHaveBeenCalledWith('c1', 'reject')
  })

  it('shows a truncated args preview inline', () => {
    render(
      <ApprovalsPanel
        approvals={[
          {
            sessionId: 's',
            callId: 'c1',
            name: 'write',
            input: { path: '/tmp/x', mode: 'append' },
          },
        ]}
        onDecision={() => {}}
      />,
    )
    // Inline preview: "path=... mode=..."  -  order is preserved by Object.entries.
    expect(screen.getByText(/path="\/tmp\/x"/)).toBeTruthy()
    expect(screen.getByText(/mode="append"/)).toBeTruthy()
  })
})
