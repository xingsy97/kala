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
import { governedSessionTaskCandidate } from '../../evaluation-integration.js'
import { saveFile } from '../../lib/save-file.js'

vi.mock('../../lib/save-file.js', () => ({ saveFile: vi.fn(async () => 'downloaded') }))

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
    history.replaceState({}, '', '/')
    if (!HTMLElement.prototype.hasPointerCapture) {
      Object.defineProperty(HTMLElement.prototype, 'hasPointerCapture', {
        configurable: true,
        value: () => false,
      })
    }
  })

  it('exports a governed private reference and links only an explicit evaluation reference', async () => {
    history.replaceState({}, '', '/?evaluationSessionId=' + baseSummary.sessionId + '&evaluationRunId=run-one&evaluationDefectId=finding-one')
    render(<SessionMetadataDialog open onOpenChange={() => {}} sessionId={baseSummary.sessionId} summary={baseSummary} state={baseState} selectedModel="model-one" onRename={() => {}} onOpenChangeCwdDialog={() => {}} onChangeApprovalMode={() => {}} onChangeToolCardMode={() => {}} />)
    fireEvent.click(screen.getByTestId('session-export-task-candidate'))
    expect(saveFile).toHaveBeenCalledOnce()
    const input = vi.mocked(saveFile).mock.calls[0]![0]
    expect(input).toMatchObject({
      suggestedName: `agent-eval-task-candidate-${baseSummary.sessionId}.json`,
      mimeType: 'application/json',
    })
    expect(input.blob).toBeInstanceOf(Blob)
    const candidate = governedSessionTaskCandidate(baseSummary.sessionId, baseSummary, 'model-one')
    expect(candidate).toMatchObject({ sourceClassification: 'private_workspace', publicTaskPack: false, candidateMetadata: { contentIncluded: false, workspacePathIncluded: false }, governance: { requiresExplicitOperatorReview: true, redactionStatus: 'not_reviewed', provenanceApprovalStatus: 'not_reviewed' } })
    expect(JSON.stringify(candidate)).not.toContain('/tmp/current')
    expect(screen.getByTestId('session-open-evaluation-reference').getAttribute('href')).toContain('/defects?runId=run-one&findingId=finding-one')
  })

  it('does not infer an evaluation link without an explicit session-scoped reference', () => {
    history.replaceState({}, '', '/?evaluationRunId=run-one')
    render(<SessionMetadataDialog open onOpenChange={() => {}} sessionId={baseSummary.sessionId} summary={baseSummary} state={baseState} selectedModel={null} onRename={() => {}} onOpenChangeCwdDialog={() => {}} onChangeApprovalMode={() => {}} onChangeToolCardMode={() => {}} />)
    expect(screen.queryByTestId('session-open-evaluation-reference')).toBeNull()
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
        onChangeToolCardMode={() => {}}
      />,
    )
    const dlg = screen.getByTestId('session-metadata-dialog')
    expect(dlg.textContent).toContain(baseSummary.sessionId)
    expect(dlg.textContent).toContain('my-mbp')
    expect(dlg.textContent).toContain('claude-opus-4-7')
    expect(dlg.textContent).toContain('1,200')
    expect(dlg.className).toContain('!bottom-0')
    expect(dlg.className).toContain('grid-rows-[auto_minmax(0,1fr)_auto]')
    expect(screen.getByTestId('session-metadata-body').className).toContain('overflow-y-auto')
    expect(screen.getByTestId('session-metadata-footer').className).toContain('border-t')
    expect(screen.getByTestId('session-metadata-label').className).toContain('text-base')
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
        onChangeToolCardMode={() => {}}
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
        onChangeToolCardMode={() => {}}
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
        onChangeToolCardMode={() => {}}
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
        onChangeToolCardMode={() => {}}
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
        onChangeToolCardMode={() => {}}
      />,
    )
    fireEvent.click(screen.getByRole('option', { name: 'Ask everything' }))
    expect(onChangeApprovalMode).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('session-metadata-save'))
    expect(onChangeApprovalMode).toHaveBeenCalledWith('ask')
  })

  it('defaults Tool Card Mode to Dots and saves an explicit Standard choice', () => {
    const onChangeToolCardMode = vi.fn()
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
        onChangeToolCardMode={onChangeToolCardMode}
      />,
    )

    expect(screen.getByTestId('session-metadata-tool-card-mode').textContent).toContain('dots')
    fireEvent.click(screen.getByRole('option', { name: 'Standard' }))
    expect(onChangeToolCardMode).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('session-metadata-save'))
    expect(onChangeToolCardMode).toHaveBeenCalledWith('standard')
  })
})
