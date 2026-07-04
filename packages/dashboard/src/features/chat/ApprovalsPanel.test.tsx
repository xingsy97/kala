import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ApprovalsPanel } from './ApprovalsPanel.js'

describe('ApprovalsPanel', () => {
  it('shows "no pending approvals" when list is empty', () => {
    render(<ApprovalsPanel approvals={[]} onDecision={() => {}} />)
    expect(screen.getByText(/No pending approvals/i)).toBeTruthy()
  })

  it('renders the approval card and reports the decision', () => {
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
    fireEvent.click(screen.getByText('approve'))
    expect(onDecision).toHaveBeenCalledWith('c1', 'approve')
    fireEvent.click(screen.getByText('reject'))
    expect(onDecision).toHaveBeenCalledWith('c1', 'reject')
  })
})
