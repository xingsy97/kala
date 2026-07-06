import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { AgentState } from '@agent-kernel/kernel'
import type { SessionSummary } from '@agent-kernel/shared'

import { SessionMetadataDialog } from './SessionMetadataDialog.js'

const baseState: AgentState = {
  status: 'idle',
  messages: [],
  pendingCalls: [],
  usage: {
    inputTokens: 1200,
    outputTokens: 340,
    costUsd: 0.0123,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  },
  todos: [],
  contextPressureLevel: 'none',
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
        onChangeCwd={() => {}}
        onChangeApprovalMode={() => {}}
      />,
    )
    const dlg = screen.getByTestId('session-metadata-dialog')
    expect(dlg.textContent).toContain(baseSummary.sessionId)
    expect(dlg.textContent).toContain('my-mbp')
    expect(dlg.textContent).toContain('claude-opus-4-7')
    expect(dlg.textContent).toContain('1,200')
  })

  it('fires onRename with the trimmed value on blur when label changes', () => {
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
        onChangeCwd={() => {}}
        onChangeApprovalMode={() => {}}
      />,
    )
    const input = screen.getByTestId('session-metadata-label') as HTMLInputElement
    fireEvent.change(input, { target: { value: '  renamed  ' } })
    fireEvent.blur(input)
    expect(onRename).toHaveBeenCalledWith('renamed')
  })

  it('fires onChangeCwd with a new absolute path on blur', () => {
    const onChangeCwd = vi.fn()
    render(
      <SessionMetadataDialog
        open
        onOpenChange={() => {}}
        sessionId={baseSummary.sessionId}
        summary={baseSummary}
        state={baseState}
        selectedModel={null}
        onRename={() => {}}
        onChangeCwd={onChangeCwd}
        onChangeApprovalMode={() => {}}
      />,
    )
    const cwdInput = screen.getByTestId('session-metadata-cwd') as HTMLInputElement
    fireEvent.change(cwdInput, { target: { value: '/tmp/next' } })
    fireEvent.blur(cwdInput)
    expect(onChangeCwd).toHaveBeenCalledWith('/tmp/next')
  })

  it('ignores empty label commits and unchanged cwd', () => {
    const onRename = vi.fn()
    const onChangeCwd = vi.fn()
    render(
      <SessionMetadataDialog
        open
        onOpenChange={() => {}}
        sessionId={baseSummary.sessionId}
        summary={{ ...baseSummary, label: undefined }}
        state={baseState}
        selectedModel={null}
        onRename={onRename}
        onChangeCwd={onChangeCwd}
        onChangeApprovalMode={() => {}}
      />,
    )
    const labelInput = screen.getByTestId('session-metadata-label') as HTMLInputElement
    fireEvent.blur(labelInput)
    expect(onRename).not.toHaveBeenCalled()

    const cwdInput = screen.getByTestId('session-metadata-cwd') as HTMLInputElement
    fireEvent.blur(cwdInput)
    expect(onChangeCwd).not.toHaveBeenCalled()
  })
})
