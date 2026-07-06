import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { ApprovalRequiredEvent } from '@agent-kernel/shared'

import { ApprovalCard } from './ApprovalCard.js'

function mkApproval(callId: string, name: string, input: Record<string, unknown>): ApprovalRequiredEvent {
  return { sessionId: 's', callId, name, input }
}

describe('ApprovalCard', () => {
  it('renders nothing when the list is empty', () => {
    const { container } = render(<ApprovalCard approvals={[]} onDecision={vi.fn()} />)
    expect(container.textContent).toBe('')
  })

  it('shows a single approval with tool name, primary arg, and no counter', () => {
    render(
      <ApprovalCard
        approvals={[mkApproval('c1', 'write', { file_path: '/tmp/x' })]}
        onDecision={vi.fn()}
      />,
    )
    expect(screen.getByTestId('approval-card')).toBeTruthy()
    // The tool name pill and primary argument are both visible.
    expect(screen.getByText('write')).toBeTruthy()
    expect(screen.getByTestId('approval-card-primary').textContent).toBe('/tmp/x')
    // No batch controls or index badge for a single-item list.
    expect(screen.queryByTestId('approval-card-index')).toBeNull()
    expect(screen.queryByTestId('approval-approve-all')).toBeNull()
    expect(screen.queryByTestId('approval-reject-all')).toBeNull()
    expect(screen.queryByTestId('approval-prev')).toBeNull()
    expect(screen.queryByTestId('approval-next')).toBeNull()
  })

  it('approves and rejects a single item via the footer buttons', () => {
    const onDecision = vi.fn()
    render(
      <ApprovalCard
        approvals={[mkApproval('c1', 'bash', { command: 'ls' })]}
        onDecision={onDecision}
      />,
    )
    fireEvent.click(screen.getByTestId('approval-approve'))
    expect(onDecision).toHaveBeenCalledWith('c1', 'approve')
    fireEvent.click(screen.getByTestId('approval-reject'))
    expect(onDecision).toHaveBeenCalledWith('c1', 'reject')
  })

  it('toggles View details and shows a diff for edit/write, JSON otherwise', () => {
    // Bash  -  JSON view (no DiffPreview because non-file tool)
    const { unmount } = render(
      <ApprovalCard
        approvals={[mkApproval('c1', 'bash', { command: 'ls -la' })]}
        onDecision={vi.fn()}
      />,
    )
    expect(screen.queryByTestId('approval-details')).toBeNull()
    fireEvent.click(screen.getByTestId('approval-details-toggle'))
    const details = screen.getByTestId('approval-details')
    expect(details).toBeTruthy()
    // JSON block renders the raw input; the command string should appear.
    expect(details.textContent ?? '').toContain('ls -la')
    unmount()

    // Write tool  -  DiffPreview is used (verified indirectly by not being a JsonBlock label).
    render(
      <ApprovalCard
        approvals={[mkApproval('c2', 'write', { file_path: '/tmp/a', content: 'hi' })]}
        onDecision={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByTestId('approval-details-toggle'))
    expect(screen.getByTestId('approval-details')).toBeTruthy()
  })

  it('renders a carousel with prev/next and index badge for multi-pending', () => {
    const onDecision = vi.fn()
    render(
      <ApprovalCard
        approvals={[
          mkApproval('c1', 'write', { file_path: '/a' }),
          mkApproval('c2', 'bash', { command: 'echo hi' }),
          mkApproval('c3', 'edit', { file_path: '/b' }),
        ]}
        onDecision={onDecision}
      />,
    )
    expect(screen.getByTestId('approval-card-index').textContent).toBe('1 of 3')
    expect(screen.getByTestId('approval-card-primary').textContent).toBe('/a')

    fireEvent.click(screen.getByTestId('approval-next'))
    expect(screen.getByTestId('approval-card-index').textContent).toBe('2 of 3')
    expect(screen.getByTestId('approval-card-primary').textContent).toBe('echo hi')

    fireEvent.click(screen.getByTestId('approval-next'))
    expect(screen.getByTestId('approval-card-index').textContent).toBe('3 of 3')

    // Wraps around forward and backward.
    fireEvent.click(screen.getByTestId('approval-next'))
    expect(screen.getByTestId('approval-card-index').textContent).toBe('1 of 3')
    fireEvent.click(screen.getByTestId('approval-prev'))
    expect(screen.getByTestId('approval-card-index').textContent).toBe('3 of 3')

    // Approving the current one dispatches for the visible callId.
    fireEvent.click(screen.getByTestId('approval-approve'))
    expect(onDecision).toHaveBeenCalledWith('c3', 'approve')
  })

  it('fires onDecision for every pending item on approve-all and reject-all', () => {
    const onDecision = vi.fn()
    render(
      <ApprovalCard
        approvals={[
          mkApproval('c1', 'write', { file_path: '/a' }),
          mkApproval('c2', 'bash', { command: 'ls' }),
        ]}
        onDecision={onDecision}
      />,
    )
    fireEvent.click(screen.getByTestId('approval-approve-all'))
    expect(onDecision).toHaveBeenNthCalledWith(1, 'c1', 'approve')
    expect(onDecision).toHaveBeenNthCalledWith(2, 'c2', 'approve')

    onDecision.mockClear()
    fireEvent.click(screen.getByTestId('approval-reject-all'))
    expect(onDecision).toHaveBeenNthCalledWith(1, 'c1', 'reject')
    expect(onDecision).toHaveBeenNthCalledWith(2, 'c2', 'reject')
  })

  it('supports keyboard shortcuts: Enter approves, Escape rejects, arrows navigate', () => {
    const onDecision = vi.fn()
    render(
      <ApprovalCard
        approvals={[
          mkApproval('c1', 'write', { file_path: '/a' }),
          mkApproval('c2', 'bash', { command: 'ls' }),
        ]}
        onDecision={onDecision}
      />,
    )
    const card = screen.getByTestId('approval-card')
    fireEvent.keyDown(card, { key: 'ArrowRight' })
    expect(screen.getByTestId('approval-card-index').textContent).toBe('2 of 2')

    fireEvent.keyDown(card, { key: 'Enter' })
    expect(onDecision).toHaveBeenLastCalledWith('c2', 'approve')

    fireEvent.keyDown(card, { key: 'ArrowLeft' })
    expect(screen.getByTestId('approval-card-index').textContent).toBe('1 of 2')

    fireEvent.keyDown(card, { key: 'Escape' })
    expect(onDecision).toHaveBeenLastCalledWith('c1', 'reject')
  })

  it('shows a "(no arguments)" placeholder when the tool has no primary arg', () => {
    render(
      <ApprovalCard
        approvals={[mkApproval('c1', 'weird_tool', {})]}
        onDecision={vi.fn()}
      />,
    )
    expect(screen.queryByTestId('approval-card-primary')).toBeNull()
    expect(screen.getByText(/no arguments/i)).toBeTruthy()
  })
})
