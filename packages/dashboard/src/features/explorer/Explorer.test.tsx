import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { AttachedExecutor, SessionSummary } from '@agent-kernel/shared'

vi.mock('react-use-measure', () => ({
  default: () => [() => {}, { width: 240, height: 400 }, () => {}],
}))

import { Explorer } from './Explorer.js'

const executor: AttachedExecutor = {
  executorId: 'ex-1',
  workspaceId: 'ws-1',
  workspaceName: 'my-mbp',
  tools: [],
  runtime: 'node',
  runtimeVersion: 'v22',
  os: 'darwin',
  ipAddresses: ['192.168.1.42'],
  attachedAt: '2026-07-05T10:00:00.000Z',
}

const sessionSummary: SessionSummary = {
  sessionId: '01JXXXXXXXXXXXXXXXXXXXXX',
  workspaceId: 'ws-1',
  workspaceName: 'my-mbp',
  createdAt: new Date(Date.now() - 30_000).toISOString(),
  lastEventAt: new Date(Date.now() - 30_000).toISOString(),
  eventCount: 4,
  firstUserMessage: 'please write hello.txt',
  status: 'done',
  currentCwd: '/tmp',
}

describe('Explorer', () => {
  it('shows empty state when there are no daemons and no sessions', () => {
    render(
      <Explorer
        executors={[]}
        sessions={[]}
        selectedSessionId={null}
        onSelect={() => {}}
        onNewSession={() => {}}
        onConnectWorkspace={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
      />,
    )
    expect(screen.getByText(/no daemons attached/i)).toBeTruthy()
    expect(screen.getByText(/pnpm executor:dev/i)).toBeTruthy()
  })

  it('opens workspace connection help from the header button', () => {
    const onConnectWorkspace = vi.fn()
    render(
      <Explorer
        executors={[]}
        sessions={[]}
        selectedSessionId={null}
        onSelect={() => {}}
        onNewSession={() => {}}
        onConnectWorkspace={onConnectWorkspace}
        onDelete={() => {}}
        onRename={() => {}}
      />,
    )
    fireEvent.click(screen.getByTestId('new-session-button'))
    expect(onConnectWorkspace).toHaveBeenCalled()
  })

  it('collapses from the explorer header when provided', () => {
    const onCollapse = vi.fn()
    render(
      <Explorer
        executors={[]}
        sessions={[]}
        selectedSessionId={null}
        onSelect={() => {}}
        onNewSession={() => {}}
        onConnectWorkspace={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
        onCollapse={onCollapse}
      />,
    )
    fireEvent.click(screen.getByTestId('explorer-collapse-button'))
    expect(onCollapse).toHaveBeenCalledTimes(1)
  })

  it('starts a new session from a workspace row', () => {
    const onNewSession = vi.fn()
    render(
      <Explorer
        executors={[executor]}
        sessions={[]}
        selectedSessionId={null}
        onSelect={() => {}}
        onNewSession={onNewSession}
        onConnectWorkspace={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
      />,
    )
    fireEvent.click(screen.getByTestId('workspace-new-session-ws-1'))
    expect(onNewSession).toHaveBeenCalledWith('ws-1')
  })

  it('renders a workspace row for an attached executor', () => {
    render(
      <Explorer
        executors={[executor]}
        sessions={[]}
        selectedSessionId={null}
        onSelect={() => {}}
        onNewSession={() => {}}
        onConnectWorkspace={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
      />,
    )
    const wsRow = screen.getByTestId('workspace-row')
    expect(wsRow.getAttribute('data-workspace-id')).toBe('ws-1')
    expect(wsRow.getAttribute('data-online')).toBe('true')
    expect(wsRow.textContent).toContain('my-mbp')
  })

  it('renders session rows grouped under their workspace', () => {
    render(
      <Explorer
        executors={[executor]}
        sessions={[sessionSummary]}
        selectedSessionId={null}
        onSelect={() => {}}
        onNewSession={() => {}}
        onConnectWorkspace={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
      />,
    )
    const sessionRow = screen.getByTestId('session-row')
    expect(sessionRow.getAttribute('data-session-id')).toBe(
      sessionSummary.sessionId,
    )
    expect(sessionRow.textContent).toContain('please write hello.txt')
    expect(sessionRow.textContent).not.toContain('done')
    expect(sessionRow.textContent).not.toContain('4 evt')
    expect(screen.getByTestId('session-status-indicator').getAttribute('title')).toBe('Done')
    expect(screen.getByTestId('session-row-cwd').textContent).toContain('/tmp')
    expect(screen.getByTestId('session-row-cwd').textContent).not.toContain('cwd')
  })

  it('places sessions with no workspaceId under an Unassigned bucket', () => {
    const orphan: SessionSummary = {
      ...sessionSummary,
      sessionId: 'orphan-1',
      workspaceId: undefined,
      workspaceName: undefined,
      firstUserMessage: 'orphan chat',
    }
    render(
      <Explorer
        executors={[]}
        sessions={[orphan]}
        selectedSessionId={null}
        onSelect={() => {}}
        onNewSession={() => {}}
        onConnectWorkspace={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
      />,
    )
    const wsRow = screen.getByTestId('workspace-row')
    expect(wsRow.getAttribute('data-workspace-id')).toBe('unassigned')
    expect(wsRow.textContent).toContain('Unassigned')
    expect(screen.getByTestId('session-row').textContent).toContain(
      'orphan chat',
    )
  })

  it('reports the clicked sessionId to onSelect', () => {
    const onSelect = vi.fn()
    render(
      <Explorer
        executors={[executor]}
        sessions={[sessionSummary]}
        selectedSessionId={null}
        onSelect={onSelect}
        onNewSession={() => {}}
        onConnectWorkspace={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
      />,
    )
    fireEvent.click(screen.getByTestId('session-row'))
    expect(onSelect).toHaveBeenCalledWith(sessionSummary.sessionId)
  })

  it('opens a confirmation dialog and calls onDelete on confirm', () => {
    const onDelete = vi.fn()
    render(
      <Explorer
        executors={[executor]}
        sessions={[sessionSummary]}
        selectedSessionId={null}
        onSelect={() => {}}
        onNewSession={() => {}}
        onConnectWorkspace={() => {}}
        onDelete={onDelete}
        onRename={() => {}}
      />,
    )
    fireEvent.click(screen.getByTestId('session-delete-button'))
    fireEvent.click(screen.getByTestId('confirm-delete-button'))
    expect(onDelete).toHaveBeenCalledWith(sessionSummary.sessionId)
  })

  it('double-clicking a session enters rename mode; Enter fires onRename', () => {
    const onRename = vi.fn()
    render(
      <Explorer
        executors={[executor]}
        sessions={[sessionSummary]}
        selectedSessionId={null}
        onSelect={() => {}}
        onNewSession={() => {}}
        onConnectWorkspace={() => {}}
        onDelete={() => {}}
        onRename={onRename}
      />,
    )
    fireEvent.doubleClick(screen.getByTestId('session-row'))
    const input = screen.getByTestId('session-rename-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'renamed thing' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onRename).toHaveBeenCalledWith(
      sessionSummary.sessionId,
      'renamed thing',
    )
  })

  it('shows explicit row actions for rename and session info', () => {
    const onRename = vi.fn()
    const onOpenSessionInfo = vi.fn()
    render(
      <Explorer
        executors={[executor]}
        sessions={[sessionSummary]}
        selectedSessionId={sessionSummary.sessionId}
        onSelect={() => {}}
        onNewSession={() => {}}
        onConnectWorkspace={() => {}}
        onDelete={() => {}}
        onRename={onRename}
        onOpenSessionInfo={onOpenSessionInfo}
      />,
    )

    fireEvent.click(screen.getByTestId('session-info-button'))
    expect(onOpenSessionInfo).toHaveBeenCalledWith(sessionSummary.sessionId)

    fireEvent.click(screen.getByTestId('session-rename-button'))
    const input = screen.getByTestId('session-rename-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'renamed from button' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onRename).toHaveBeenCalledWith(
      sessionSummary.sessionId,
      'renamed from button',
    )
  })

  it('marks the selected session with the highlight class', () => {
    render(
      <Explorer
        executors={[executor]}
        sessions={[sessionSummary]}
        selectedSessionId={sessionSummary.sessionId}
        onSelect={() => {}}
        onNewSession={() => {}}
        onConnectWorkspace={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
      />,
    )
    const sessionRow = screen.getByTestId('session-row')
    expect(sessionRow.className).toMatch(/border-l-primary/)
  })

  it('filters sessions locally and highlights matched text', () => {
    const other: SessionSummary = {
      ...sessionSummary,
      sessionId: '02JXXXXXXXXXXXXXXXXXXXXX',
      firstUserMessage: 'review auth flow',
      currentCwd: '/repo/auth',
    }
    render(
      <Explorer
        executors={[executor]}
        sessions={[sessionSummary, other]}
        selectedSessionId={null}
        onSelect={() => {}}
        onNewSession={() => {}}
        onConnectWorkspace={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
      />,
    )

    fireEvent.change(screen.getByTestId('explorer-search'), { target: { value: 'auth' } })

    expect(screen.getByTestId('workspace-row').textContent).toContain('my-mbp')
    expect(screen.getAllByTestId('session-row')).toHaveLength(1)
    expect(screen.getByTestId('session-row').textContent).toContain('review auth flow')
    expect(screen.getAllByTestId('explorer-search-highlight').map((node) => node.textContent)).toContain('auth')
  })

  it('shows an empty filter state when nothing matches', () => {
    render(
      <Explorer
        executors={[executor]}
        sessions={[sessionSummary]}
        selectedSessionId={null}
        onSelect={() => {}}
        onNewSession={() => {}}
        onConnectWorkspace={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
      />,
    )

    fireEvent.change(screen.getByTestId('explorer-search'), { target: { value: 'does-not-exist' } })
    expect(screen.getByTestId('explorer-filter-empty').textContent).toContain('does-not-exist')
  })
})
