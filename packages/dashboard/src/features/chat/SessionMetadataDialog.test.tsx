import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentState } from '@agent-kernel/kernel'
import type { SessionSummary } from '@agent-kernel/shared'

vi.mock('../../components/ui/select.js', async () => {
  const React = await import('react')
  type SelectContextValue = {
    value?: string
    onValueChange?(value: string): void
  }
  const SelectContext = React.createContext<SelectContextValue>({})
  return {
    Select: ({ value, onValueChange, children }: React.PropsWithChildren<SelectContextValue>) => React.createElement(
      SelectContext.Provider,
      { value: { value, onValueChange } },
      children,
    ),
    SelectTrigger: ({ children, ...props }: React.PropsWithChildren<React.ButtonHTMLAttributes<HTMLButtonElement>>) => React.createElement(
      'button',
      { type: 'button', ...props },
      children,
    ),
    SelectValue: () => {
      const ctx = React.useContext(SelectContext)
      return React.createElement('span', null, ctx.value)
    },
    SelectContent: ({ children }: React.PropsWithChildren) => React.createElement('div', null, children),
    SelectItem: ({ value, children }: React.PropsWithChildren<{ value: string }>) => {
      const ctx = React.useContext(SelectContext)
      return React.createElement(
        'button',
        { type: 'button', role: 'option', onClick: () => ctx.onValueChange?.(value) },
        children,
      )
    },
  }
})

import { SessionMetadataDialog } from './SessionMetadataDialog.js'

const baseState: AgentState = {
  status: 'idle',
  messages: [],
  pendingCalls: [],
  usage: {
    inputTokens: 1200,
    outputTokens: 340,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  },
  approvalMode: 'auto',
  cwd: '/tmp/current',
}

const baseSummary: SessionSummary = {
  sessionId: '01JXXXXXXXXXXXXXXXXXXXXX',
  createdAt: '2026-07-01T00:00:00.000Z',
  lastEventAt: '2026-07-05T00:00:00.000Z',
  eventCount: 12,
  workspaceId: 'ws-1',
  workspaceName: 'my-mbp',
  currentCwd: '/tmp/current',
  firstUserMessage: 'hello',
  label: 'my session',
}

describe('SessionMetadataDialog', () => {
  beforeEach(() => {
    if (!HTMLElement.prototype.hasPointerCapture) {
      Object.defineProperty(HTMLElement.prototype, 'hasPointerCapture', {
        configurable: true,
        value: () => false,
      })
    }
  })

  it('renders read-only summary fields', () => {
    render(
      <SessionMetadataDialog
        open
        onOpenChange={() => {}}
        sessionId={baseSummary.sessionId}
        summary={baseSummary}
        state={baseState}
        selectedModel="claude-opus-4-7"
        onRename={() => {}}
        onOpenChangeCwdDialog={() => {}}
        onChangeApprovalMode={() => {}}
      />,
    )
    const dlg = screen.getByTestId('session-metadata-dialog')
    expect(dlg.textContent).toContain(baseSummary.sessionId)
    expect(dlg.textContent).toContain('my-mbp')
    expect(dlg.textContent).toContain('claude-opus-4-7')
    expect(dlg.textContent).toContain('1,200')
  })

  it('shows the current cwd as a read-only display next to a Change trigger', () => {
    render(
      <SessionMetadataDialog
        open
        onOpenChange={() => {}}
        sessionId={baseSummary.sessionId}
        summary={baseSummary}
        state={baseState}
        selectedModel={null}
        onRename={() => {}}
        onOpenChangeCwdDialog={() => {}}
        onChangeApprovalMode={() => {}}
      />,
    )
    expect(screen.getByTestId('session-metadata-cwd').textContent).toContain(
      '/tmp/current',
    )
    // The cwd display is not an <input>: users go through the Change… button,
    // which opens the Finder-style picker.
    expect(
      screen.getByTestId('session-metadata-cwd').tagName.toLowerCase(),
    ).not.toBe('input')
    expect(screen.getByTestId('session-metadata-cwd-change')).toBeTruthy()
  })

  it('closes itself and opens the change-cwd dialog when Change is clicked', () => {
    const onOpenChange = vi.fn()
    const onOpenChangeCwdDialog = vi.fn()
    render(
      <SessionMetadataDialog
        open
        onOpenChange={onOpenChange}
        sessionId={baseSummary.sessionId}
        summary={baseSummary}
        state={baseState}
        selectedModel={null}
        onRename={() => {}}
        onOpenChangeCwdDialog={onOpenChangeCwdDialog}
        onChangeApprovalMode={() => {}}
      />,
    )
    fireEvent.click(screen.getByTestId('session-metadata-cwd-change'))
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(onOpenChangeCwdDialog).toHaveBeenCalledTimes(1)
  })

  it('saves the trimmed label only when Save is clicked', () => {
    const onRename = vi.fn()
    render(
      <SessionMetadataDialog
        open
        onOpenChange={() => {}}
        sessionId={baseSummary.sessionId}
        summary={baseSummary}
        state={baseState}
        selectedModel={null}
        onRename={onRename}
        onOpenChangeCwdDialog={() => {}}
        onChangeApprovalMode={() => {}}
      />,
    )
    const input = screen.getByTestId('session-metadata-label') as HTMLInputElement
    fireEvent.change(input, { target: { value: '  renamed  ' } })
    fireEvent.blur(input)
    expect(onRename).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('session-metadata-save'))
    expect(onRename).toHaveBeenCalledWith('renamed')
  })

  it('ignores empty label commits', () => {
    const onRename = vi.fn()
    render(
      <SessionMetadataDialog
        open
        onOpenChange={() => {}}
        sessionId={baseSummary.sessionId}
        summary={{ ...baseSummary, label: undefined }}
        state={baseState}
        selectedModel={null}
        onRename={onRename}
        onOpenChangeCwdDialog={() => {}}
        onChangeApprovalMode={() => {}}
      />,
    )
    const labelInput = screen.getByTestId('session-metadata-label') as HTMLInputElement
    fireEvent.change(labelInput, { target: { value: '' } })
    fireEvent.click(screen.getByTestId('session-metadata-save'))
    expect(onRename).not.toHaveBeenCalled()
  })

  it('saves approval mode changes only when Save is clicked', () => {
    const onChangeApprovalMode = vi.fn()
    render(
      <SessionMetadataDialog
        open
        onOpenChange={() => {}}
        sessionId={baseSummary.sessionId}
        summary={baseSummary}
        state={baseState}
        selectedModel={null}
        onRename={() => {}}
        onOpenChangeCwdDialog={() => {}}
        onChangeApprovalMode={onChangeApprovalMode}
      />,
    )
    fireEvent.click(screen.getByRole('option', { name: 'Ask everything' }))
    expect(onChangeApprovalMode).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('session-metadata-save'))
    expect(onChangeApprovalMode).toHaveBeenCalledWith('ask')
  })
})
