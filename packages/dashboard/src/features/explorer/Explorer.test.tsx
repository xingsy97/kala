import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { AttachedExecutor, SessionSummary } from '@agent-kernel/shared'
import { createConfig, createInitialState } from '@agent-kernel/kernel'

vi.mock('react-use-measure', () => ({
  default: () => [() => {}, { width: 240, height: 400 }, () => {}],
}))

import { Explorer } from './Explorer.js'
import { canDropWorkspacesAtRoot, reorderWorkspaceIds } from './tree-model.js'
import { createSessionViewCache } from '../../session-view-cache.js'
import { HIDDEN_WORKSPACES_STORAGE_KEY } from './hidden-workspaces.js'
import type { CachedSessionView } from '../../session-view-cache.js'

const executor: AttachedExecutor = {
  executorId: 'ex-1',
  workspaceId: 'ws-1',
  workspaceName: 'my-mbp',
  tools: [],
  runtime: 'node',
  runtimeVersion: 'v22',
  os: 'darwin',
  ipAddresses: ['192.0.2.10'],
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
  beforeEach(() => {
    localStorage.clear()
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: query === '(hover: hover) and (pointer: fine)',
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    })
  })

  it('uses a compositor-only loader without SVG spin or full-row sweep', () => {
    render(
      <Explorer
        executors={[]}
        sessions={[]}
        loading
        selectedSessionId={null}
        onSelect={() => {}}
        onNewSession={() => {}}
        onConnectWorkspace={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
      />,
    )
    const loading = screen.getByTestId('explorer-loading')
    const spinner = loading.querySelector('.ak-loading-spinner')
    expect(spinner).not.toBeNull()
    expect(loading.querySelector('svg.animate-spin')).toBeNull()
    expect(loading.querySelectorAll('.ak-explorer-loading-row')).toHaveLength(5)
  })

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
    fireEvent.click(screen.getByTestId('connect-workspace-button'))
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
    expect(wsRow.className).toContain('grid-cols-[1rem_minmax(0,1fr)_auto]')
    expect(wsRow.className).toContain('relative')
    expect(wsRow.textContent).toContain('my-mbp')
    expect(screen.getByTestId('workspace-drag-handle')).toBeTruthy()
    expect(screen.getByTestId('workspace-drag-handle').className).toContain('absolute')
    expect(screen.getByTestId('workspace-drag-handle').className).toContain('w-1.5')
    expect(screen.getByTestId('workspace-drag-handle').querySelector('svg')?.className.baseVal).toContain('opacity-0')
    expect(screen.getByTestId('workspace-drag-handle').querySelector('svg')?.className.baseVal).toContain('group-hover/drag:opacity-100')
    expect(screen.queryByTestId('workspace-status-pill')).toBeNull()
    expect(screen.queryByTestId('workspace-status-indicator')).toBeNull()
    const workspaceStatus = screen.getByTestId('workspace-status-badge')
    expect(workspaceStatus.className).toContain('rounded-full')
    expect(workspaceStatus.className).toContain('bg-emerald-500')
    expect(workspaceStatus.getAttribute('aria-label')).toBe('online')
    expect(workspaceStatus.textContent).toBe('online')
    expect(screen.queryByTestId('workspace-row-meta')).toBeNull()
    expect(wsRow.textContent).not.toContain('node')
    expect(wsRow.textContent).not.toContain('v22')
    expect(wsRow.textContent).not.toContain('192.0.2.10')
  })

  it('persists workspace ordering preference from local storage', () => {
    const secondExecutor: AttachedExecutor = {
      ...executor,
      executorId: 'ex-2',
      workspaceId: 'ws-2',
      workspaceName: 'z-workspace',
    }
    localStorage.setItem('agent-kernel:explorer:workspace-order:v1', JSON.stringify(['ws-2', 'ws-1']))

    render(
      <Explorer
        executors={[executor, secondExecutor]}
        sessions={[]}
        selectedSessionId={null}
        onSelect={() => {}}
        onNewSession={() => {}}
        onConnectWorkspace={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
      />,
    )

    expect(screen.getAllByTestId('workspace-row').map((row) => row.getAttribute('data-workspace-id'))).toEqual(['ws-2', 'ws-1'])
  })

  it('hides a workspace and its sessions from the explorer tree', () => {
    const secondExecutor: AttachedExecutor = {
      ...executor,
      executorId: 'ex-2',
      workspaceId: 'ws-2',
      workspaceName: 'second-box',
    }
    const secondSession: SessionSummary = {
      ...sessionSummary,
      sessionId: '02JXXXXXXXXXXXXXXXXXXXXX',
      workspaceId: 'ws-2',
      workspaceName: 'second-box',
      firstUserMessage: 'second session',
    }

    render(
      <Explorer
        executors={[executor, secondExecutor]}
        sessions={[sessionSummary, secondSession]}
        selectedSessionId={null}
        onSelect={() => {}}
        onNewSession={() => {}}
        onConnectWorkspace={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
      />,
    )

    fireEvent.click(screen.getByTestId('workspace-hide-ws-1'))

    expect(screen.getAllByTestId('workspace-row').map((row) => row.getAttribute('data-workspace-id'))).toEqual(['ws-2'])
    expect(screen.queryByText('please write hello.txt')).toBeNull()
    expect(screen.getByText('second session')).toBeTruthy()
    expect(screen.getByTestId('hidden-workspaces-bar').textContent).toContain('1 hidden workspace')
    expect(localStorage.getItem(HIDDEN_WORKSPACES_STORAGE_KEY)).toContain('ws-1')
  })

  it('restores a hidden workspace from the hidden workspaces list', () => {
    localStorage.setItem(HIDDEN_WORKSPACES_STORAGE_KEY, JSON.stringify({ version: 1, ids: ['ws-1'] }))

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

    expect(screen.queryByTestId('workspace-row')).toBeNull()
    expect(screen.getByTestId('explorer-hidden-empty').textContent).toContain('All workspaces are hidden')

    fireEvent.click(screen.getByTestId('hidden-workspaces-toggle'))
    expect(screen.getByTestId('hidden-workspaces-list').textContent).toContain('my-mbp')
    fireEvent.click(screen.getByTestId('workspace-unhide-ws-1'))

    expect(screen.getByTestId('workspace-row').getAttribute('data-workspace-id')).toBe('ws-1')
    expect(screen.getByTestId('session-row').textContent).toContain('please write hello.txt')
    expect(localStorage.getItem(HIDDEN_WORKSPACES_STORAGE_KEY)).toBeNull()
  })

  it('keeps the same status-indicator DOM node when a running session flips thinking↔executing_tools', () => {
    const runningSummary = { ...sessionSummary, status: 'thinking' as const }
    // Stable callbacks so areExplorerPropsEqual isn't tripped by callback
    // identity (in the real app these are useCallback-stable); this isolates
    // the status flip as the only changing input.
    const noop = () => {}
    const props = {
      executors: [executor],
      selectedSessionId: runningSummary.sessionId,
      onSelect: noop,
      onNewSession: noop,
      onConnectWorkspace: noop,
      onDelete: noop,
      onRename: noop,
    }
    const { rerender } = render(<Explorer {...props} sessions={[runningSummary]} />)
    const before = screen.getByTestId('session-status-indicator')
    const beforeSpinner = screen.getByTestId('session-status-spinner')

    // A tool-step flip: same session moves to executing_tools. The sidebar
    // renders an identical spinner for both, so the indicator node must NOT be
    // torn down and rebuilt (which would restart the spin animation).
    rerender(<Explorer {...props} sessions={[{ ...runningSummary, status: 'executing_tools' as const }]} />)
    const after = screen.getByTestId('session-status-indicator')
    expect(after).toBe(before)
    expect(screen.getByTestId('session-status-spinner')).toBe(beforeSpinner)
  })

  it('does not offer hide for the unassigned workspace bucket', () => {
    render(
      <Explorer
        executors={[]}
        sessions={[{ ...sessionSummary, workspaceId: undefined, workspaceName: undefined }]}
        selectedSessionId={null}
        onSelect={() => {}}
        onNewSession={() => {}}
        onConnectWorkspace={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
      />,
    )

    expect(screen.getByTestId('workspace-row').getAttribute('data-workspace-id')).toBe('unassigned')
    expect(screen.queryByTestId('workspace-hide-null')).toBeNull()
    expect(screen.queryByTestId('hidden-workspaces-bar')).toBeNull()
  })

  it('allows workspace drops on the react-arborist root node', () => {
    expect(canDropWorkspacesAtRoot({
      parentNode: { id: '__REACT_ARBORIST_INTERNAL_ROOT__', isRoot: true },
      dragNodes: [{ data: { kind: 'workspace', workspaceId: 'ws-1' } }],
    })).toBe(true)
    expect(canDropWorkspacesAtRoot({
      parentNode: { id: 'ws:ws-2', isRoot: false },
      dragNodes: [{ data: { kind: 'workspace', workspaceId: 'ws-1' } }],
    })).toBe(false)
    expect(canDropWorkspacesAtRoot({
      parentNode: { id: '__REACT_ARBORIST_INTERNAL_ROOT__', isRoot: true },
      dragNodes: [{ data: { kind: 'workspace', workspaceId: null } }],
    })).toBe(false)
  })

  it('reorders workspace ids for root-level workspace drags', () => {
    expect(reorderWorkspaceIds(['ws-1', 'ws-2', 'ws-3'], ['ws-1', 'ws-2', 'ws-3'], ['ws-3'], 0)).toEqual(['ws-3', 'ws-1', 'ws-2'])
    expect(reorderWorkspaceIds(['ws-1', 'ws-2', 'ws-3'], ['ws-1', 'ws-2', 'ws-3'], ['ws-1'], 3)).toEqual(['ws-2', 'ws-3', 'ws-1'])
  })

  it('does not render a workspace drag handle for unassigned sessions', () => {
    render(
      <Explorer
        executors={[]}
        sessions={[{ ...sessionSummary, workspaceId: undefined, workspaceName: undefined }]}
        selectedSessionId={null}
        onSelect={() => {}}
        onNewSession={() => {}}
        onConnectWorkspace={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
      />,
    )

    expect(screen.getByTestId('workspace-row').getAttribute('data-workspace-id')).toBe('unassigned')
    expect(screen.queryByTestId('workspace-drag-handle')).toBeNull()
  })

  it('renames a workspace from the workspace row action', () => {
    const onRenameWorkspace = vi.fn()
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
        onRenameWorkspace={onRenameWorkspace}
      />,
    )

    fireEvent.click(screen.getByTestId('workspace-rename-ws-1'))
    const input = screen.getByTestId('workspace-rename-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'renamed workspace' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onRenameWorkspace).toHaveBeenCalledWith('ws-1', 'renamed workspace')
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
    expect(sessionRow.className).toContain('grid-cols-[1rem_1rem_minmax(0,1fr)_auto]')
    expect(sessionRow.textContent).toContain('please write hello.txt')
    expect(sessionRow.textContent).not.toContain('done')
    expect(sessionRow.textContent).not.toContain('4 evt')
    expect(screen.getByTestId('session-status-indicator').getAttribute('title')).toBe('Done')
    expect(screen.getByTestId('session-status-indicator').querySelector('span')?.className).toContain('h-2.5 w-2.5')
    expect(screen.getByTestId('session-drag-handle').querySelector('svg')?.className.baseVal).not.toContain('opacity-0')
    // The working directory is no longer a persistent second line — it is shown
    // on hover via the session name's title tooltip (keeps the card single-line).
    expect(sessionRow.querySelector('[title="/tmp"]')).not.toBeNull()
    expect(screen.queryByTestId('session-row-cwd')).toBeNull()
  })

  it('overrides the selected session row with the live working status', () => {
    render(
      <Explorer
        executors={[executor]}
        sessions={[{ ...sessionSummary, status: 'done' }]}
        selectedSessionId={sessionSummary.sessionId}
        sessionStatuses={new Map([[sessionSummary.sessionId, 'loading']])}
        onSelect={() => {}}
        onNewSession={() => {}}
        onConnectWorkspace={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
      />,
    )

    const indicator = screen.getByTestId('session-status-indicator')
    expect(indicator.getAttribute('data-status')).toBe('loading')
    expect(indicator.getAttribute('title')).toBe('Working')
  })

  it('shows per-session working status independently of selection', () => {
    render(
      <Explorer
        executors={[executor]}
        sessions={[{ ...sessionSummary, status: 'done' }]}
        selectedSessionId="different-session"
        sessionStatuses={new Map([[sessionSummary.sessionId, 'loading']])}
        onSelect={() => {}}
        onNewSession={() => {}}
        onConnectWorkspace={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
      />,
    )

    const indicator = screen.getByTestId('session-status-indicator')
    expect(indicator.getAttribute('data-status')).toBe('loading')
    expect(indicator.getAttribute('title')).toBe('Working')
  })

  it('keeps running indicators scoped to each session row in the same workspace', () => {
    const second: SessionSummary = {
      ...sessionSummary,
      sessionId: '02JXXXXXXXXXXXXXXXXXXXXX',
      firstUserMessage: 'second task',
      status: 'done',
    }
    render(
      <Explorer
        executors={[executor]}
        sessions={[sessionSummary, second]}
        selectedSessionId={sessionSummary.sessionId}
        sessionStatuses={new Map([
          [sessionSummary.sessionId, 'loading'],
          [second.sessionId, 'executing_tools'],
        ])}
        onSelect={() => {}}
        onNewSession={() => {}}
        onConnectWorkspace={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
      />,
    )

    const rows = screen.getAllByTestId('session-row')
    const firstRow = rows.find((row) => row.getAttribute('data-session-id') === sessionSummary.sessionId)
    const secondRow = rows.find((row) => row.getAttribute('data-session-id') === second.sessionId)
    expect(firstRow?.querySelector('[data-testid="session-status-indicator"]')?.getAttribute('data-status')).toBe('loading')
    expect(secondRow?.querySelector('[data-testid="session-status-indicator"]')?.getAttribute('data-status')).toBe('executing_tools')
  })

  it('presents sessions with no workspaceId as ordinary Chats', () => {
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
    expect(wsRow.textContent).toContain('Chats')
    expect(wsRow.textContent).toContain('personal conversations')
    expect(wsRow.textContent).not.toContain('no workspace')
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

  it('commits a running-session switch on pointerdown before a click can be lost', () => {
    const onSelect = vi.fn()
    const running = { ...sessionSummary, status: 'executing_tools' as const }
    const target = { ...sessionSummary, sessionId: 'target-session', status: 'idle' as const }
    render(
      <Explorer
        executors={[executor]}
        sessions={[running, target]}
        selectedSessionId={running.sessionId}
        onSelect={onSelect}
        onNewSession={() => {}}
        onConnectWorkspace={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
      />,
    )

    const targetRow = screen.getAllByTestId('session-row').find((row) => row.getAttribute('data-session-id') === target.sessionId)!
    fireEvent.mouseDown(targetRow, { button: 0 })

    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalledWith(target.sessionId)
  })

  it('does not activate a session on mobile pointerdown before the tap target is known', () => {
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

    const row = screen.getByTestId('session-row')
    fireEvent.pointerDown(row, { button: 0, pointerType: 'touch' })
    expect(onSelect).not.toHaveBeenCalled()

    fireEvent.click(row)
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalledWith(sessionSummary.sessionId)
  })

  it('does not activate a session when a pointer starts on its drag rail', () => {
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

    const handle = screen.getByTestId('session-drag-handle')
    fireEvent.pointerDown(handle, { button: 0, pointerType: 'touch' })
    fireEvent.click(handle)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('keeps click as a fallback when Tree activation is lost after pointerdown', () => {
    const onSelect = vi.fn()
    const target = { ...sessionSummary, sessionId: 'click-fallback-session', status: 'idle' as const }
    render(
      <Explorer
        executors={[executor]}
        sessions={[sessionSummary, target]}
        selectedSessionId={sessionSummary.sessionId}
        onSelect={onSelect}
        onNewSession={() => {}}
        onConnectWorkspace={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
      />,
    )

    const targetRow = screen.getAllByTestId('session-row').find((row) => row.getAttribute('data-session-id') === target.sessionId)!
    fireEvent.click(targetRow)
    expect(onSelect).toHaveBeenCalledWith(target.sessionId)
  })

  it('clears the focused session when clicking empty explorer space', () => {
    const onSelect = vi.fn()
    const onClearSelection = vi.fn()
    render(
      <Explorer
        executors={[executor]}
        sessions={[sessionSummary]}
        selectedSessionId={sessionSummary.sessionId}
        onSelect={onSelect}
        onClearSelection={onClearSelection}
        onNewSession={() => {}}
        onConnectWorkspace={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
      />,
    )

    fireEvent.click(screen.getByTestId('explorer-column'))
    expect(onClearSelection).toHaveBeenCalledTimes(1)
    expect(onSelect).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('session-row'))
    expect(onSelect).toHaveBeenCalledWith(sessionSummary.sessionId)
    expect(onClearSelection).toHaveBeenCalledTimes(1)
  })

  it('opens a confirmation dialog and always requests tree deletion', () => {
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

  it('warns about descendants and deletes the complete tree', () => {
    const onDelete = vi.fn()
    const child: SessionSummary = {
      ...sessionSummary,
      sessionId: 'child-session',
      parentSessionId: sessionSummary.sessionId,
      firstUserMessage: 'child task',
    }
    const grandchild: SessionSummary = {
      ...sessionSummary,
      sessionId: 'grandchild-session',
      parentSessionId: child.sessionId,
      firstUserMessage: 'grandchild task',
    }
    render(
      <Explorer
        executors={[executor]}
        sessions={[sessionSummary, child, grandchild]}
        selectedSessionId={null}
        onSelect={() => {}}
        onNewSession={() => {}}
        onConnectWorkspace={() => {}}
        onDelete={onDelete}
        onRename={() => {}}
      />,
    )

    const parentRow = screen.getAllByTestId('session-row').find((row) => row.getAttribute('data-session-id') === sessionSummary.sessionId)
    expect(parentRow).toBeTruthy()
    fireEvent.click(parentRow!.querySelector('[data-testid="session-delete-button"]')!)
    expect(screen.getByText(/2 descendant sessions/i)).toBeTruthy()
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

  it('does not allow renaming sessions under an offline workspace', () => {
    const onRename = vi.fn()
    render(
      <Explorer
        executors={[]}
        sessions={[{ ...sessionSummary, workspaceId: 'ws-offline', workspaceName: 'offline box' }]}
        selectedSessionId={null}
        onSelect={() => {}}
        onNewSession={() => {}}
        onConnectWorkspace={() => {}}
        onDelete={() => {}}
        onRename={onRename}
      />,
    )

    fireEvent.doubleClick(screen.getByTestId('session-row'))
    expect(screen.queryByTestId('session-rename-input')).toBeNull()
    const button = screen.getByTestId('session-rename-button') as HTMLButtonElement
    expect(button.disabled).toBe(true)
    fireEvent.click(button)
    expect(onRename).not.toHaveBeenCalled()
  })

  it('submits session rename only once when Enter is followed by blur', () => {
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
    fireEvent.change(input, { target: { value: 'renamed once' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.blur(input)

    expect(onRename).toHaveBeenCalledTimes(1)
    expect(onRename).toHaveBeenCalledWith(sessionSummary.sessionId, 'renamed once')
  })

  it('keeps session editing stable across runtime-only summary refreshes', () => {
    const stableProps = {
      onSelect: () => {},
      onNewSession: () => {},
      onConnectWorkspace: () => {},
      onDelete: () => {},
      onRename: () => {},
    }
    const { rerender } = render(
      <Explorer
        executors={[executor]}
        sessions={[sessionSummary]}
        selectedSessionId={sessionSummary.sessionId}
        {...stableProps}
      />,
    )
    fireEvent.doubleClick(screen.getByTestId('session-row'))
    const input = screen.getByTestId('session-rename-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'draft rename' } })

    rerender(
      <Explorer
        executors={[executor]}
        sessions={[{ ...sessionSummary, eventCount: sessionSummary.eventCount + 20, lastEventAt: new Date().toISOString() }]}
        selectedSessionId={sessionSummary.sessionId}
        {...stableProps}
      />,
    )

    expect(screen.getByTestId('session-rename-input')).toHaveProperty('value', 'draft rename')
  })

  it('shows explicit row actions for rename and session info', () => {
    const onRename = vi.fn()
    const onOpenSessionInfo = vi.fn()
    const onSelect = vi.fn()
    render(
      <Explorer
        executors={[executor]}
        sessions={[sessionSummary]}
        selectedSessionId={sessionSummary.sessionId}
        onSelect={onSelect}
        onNewSession={() => {}}
        onConnectWorkspace={() => {}}
        onDelete={() => {}}
        onRename={onRename}
        onOpenSessionInfo={onOpenSessionInfo}
      />,
    )

    fireEvent.click(screen.getByTestId('session-info-button'))
    expect(onOpenSessionInfo).toHaveBeenCalledWith(sessionSummary.sessionId)
    expect(onSelect).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('session-rename-button'))
    const input = screen.getByTestId('session-rename-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'renamed from button' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onRename).toHaveBeenCalledWith(
      sessionSummary.sessionId,
      'renamed from button',
    )
  })

  it('offers all secondary session actions from the compact touch menu', () => {
    const onRename = vi.fn()
    const onOpenSessionInfo = vi.fn()
    const onHideSession = vi.fn()
    const onDelete = vi.fn()
    render(
      <Explorer
        executors={[executor]}
        sessions={[sessionSummary]}
        selectedSessionId={sessionSummary.sessionId}
        onSelect={() => {}}
        onNewSession={() => {}}
        onConnectWorkspace={() => {}}
        onDelete={onDelete}
        onRename={onRename}
        onOpenSessionInfo={onOpenSessionInfo}
        onHideSession={onHideSession}
      />,
    )

    fireEvent.click(screen.getByTestId('session-more-button'))
    const menu = screen.getByTestId('session-action-menu')
    expect(menu.textContent).toContain('Rename')
    expect(menu.textContent).toContain('Session info')
    expect(menu.textContent).toContain('Hide')
    expect(menu.textContent).toContain('Delete')
    fireEvent.click(within(menu).getByText('Session info'))
    expect(onOpenSessionInfo).toHaveBeenCalledWith(sessionSummary.sessionId)
    expect(screen.queryByTestId('session-action-menu')).toBeNull()
  })

  it('never selects the session when clicking any row action button', () => {
    const onSelect = vi.fn()
    const onDelete = vi.fn()
    const onOpenSessionInfo = vi.fn()
    const onHideSession = vi.fn()
    render(
      <Explorer
        executors={[executor]}
        sessions={[sessionSummary]}
        selectedSessionId={undefined}
        onSelect={onSelect}
        onNewSession={() => {}}
        onConnectWorkspace={() => {}}
        onDelete={onDelete}
        onRename={() => {}}
        onOpenSessionInfo={onOpenSessionInfo}
        onHideSession={onHideSession}
      />,
    )

    // Clicking action buttons must run their own handler only, never select.
    fireEvent.click(screen.getByTestId('session-info-button'))
    fireEvent.click(screen.getByTestId('session-rename-button'))

    expect(onOpenSessionInfo).toHaveBeenCalledWith(sessionSummary.sessionId)
    // The rename button entered edit mode rather than activating the row.
    expect(screen.getByTestId('session-rename-input')).toHaveProperty('tagName', 'INPUT')
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('does not let the hidden date layer intercept clicks over the action buttons', () => {
    // Regression: the date layer and the action-button overlay share the same
    // grid cell (col-start-4 row-start-1). When the date layer stays clickable
    // while faded out on hover, it sits on top of the buttons and swallows the
    // click, so pressing rename/hide/delete only switched sessions. The hidden
    // layer must be pointer-events:none and the action overlay must re-enable
    // pointer events on hover.
    render(
      <Explorer
        executors={[executor]}
        sessions={[sessionSummary]}
        selectedSessionId={undefined}
        onSelect={() => {}}
        onNewSession={() => {}}
        onConnectWorkspace={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
        onOpenSessionInfo={() => {}}
        onHideSession={() => {}}
      />,
    )

    const actionOverlay = screen
      .getByTestId('session-rename-button')
      .closest('[data-row-action]') as HTMLElement
    expect(actionOverlay.className).toContain('pointer-events-none')
    expect(actionOverlay.className).toContain('group-hover:pointer-events-auto')

    const dateLayer = screen
      .getByTestId('session-row')
      .querySelector('.ak-touch-hide') as HTMLElement
    expect(dateLayer.className).toContain('pointer-events-none')
  })

  it('renders active running statuses with the same row-local spinner', () => {
    const second: SessionSummary = {
      ...sessionSummary,
      sessionId: '02JXXXXXXXXXXXXXXXXXXXXX',
      firstUserMessage: 'second task',
    }
    render(
      <Explorer
        executors={[executor]}
        sessions={[sessionSummary, second]}
        selectedSessionId={sessionSummary.sessionId}
        sessionStatuses={new Map([
          [sessionSummary.sessionId, 'thinking'],
          [second.sessionId, 'executing_tools'],
        ])}
        onSelect={() => {}}
        onNewSession={() => {}}
        onConnectWorkspace={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
      />,
    )

    const indicators = screen.getAllByTestId('session-status-indicator')
    expect(indicators.map((indicator) => indicator.getAttribute('data-status'))).toEqual(['thinking', 'executing_tools'])
    for (const indicator of indicators) {
      const spinner = indicator.querySelector('[data-testid="session-status-spinner"]')
      const icon = indicator.querySelector('svg')
      expect(spinner?.className).toContain('ak-session-status-spinner')
      expect(icon?.className.baseVal).not.toContain('animate-spin')
      expect(icon?.className.baseVal).not.toContain('translateZ')
      expect(indicator.querySelector('.animate-pulse')).toBeNull()
    }
  })

  it('marks the selected session without shifting the row grid', () => {
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
    expect(sessionRow.className).toMatch(/bg-accent/)
    expect(sessionRow.className).toContain('grid-cols-[1rem_1rem_minmax(0,1fr)_auto]')
    expect(sessionRow.className).not.toMatch(/border-l-primary/)
    expect(sessionRow.className).toContain('shadow-[inset_0_0_0_1px')
    expect(screen.queryByTestId('session-selected-marker')).toBeNull()
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

  it('shows a cached lightweight preview when hovering a loaded session on desktop', async () => {
    vi.useFakeTimers()
    try {
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
          getCachedSessionView={() => cachedSessionView(sessionSummary.sessionId)}
        />,
      )

      fireEvent.pointerEnter(screen.getByTestId('session-row'), { pointerType: 'mouse' })
      await act(async () => {
        vi.advanceTimersByTime(50)
      })

      const preview = screen.getByTestId('session-hover-preview')
      expect(preview).toBeTruthy()
      expect(preview.style.height).toBe('')
      expect(screen.getByTestId('session-preview-activity').textContent).toContain('Idle')
      expect(screen.getByTestId('session-preview-goal').textContent).toContain('please write hello.txt')
      expect(screen.getByTestId('session-preview-response').textContent).toContain('Done.')
      expect(screen.queryByTestId('session-preview-row')).toBeNull()
      expect(screen.queryByTestId('virtual-transcript')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('refreshes an open hover preview when its cache entry changes', async () => {
    vi.useFakeTimers()
    try {
      const cache = createSessionViewCache({ maxBytes: 1024 * 1024 })
      cache.set(sessionSummary.sessionId, cachedSessionView(sessionSummary.sessionId))
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
          getCachedSessionView={cache.peek}
          subscribeCachedSessionView={cache.subscribe}
        />,
      )
      fireEvent.pointerEnter(screen.getByTestId('session-row'), { pointerType: 'mouse' })
      await act(async () => vi.advanceTimersByTime(50))
      expect(screen.getByTestId('session-preview-response').textContent).toContain('Done.')
      const updated = cachedSessionView(sessionSummary.sessionId)
      act(() => {
        cache.set(sessionSummary.sessionId, {
          ...updated,
          timeline: [...updated.timeline, {
            seq: 3, ts: '2026-07-05T10:00:01.000Z',
            event: { kind: 'llm_response', message: { role: 'assistant', content: [{ type: 'text', text: 'Latest realtime checkpoint.' }] } }, effects: [],
          }],
        })
      })
      expect(screen.getByTestId('session-preview-response').textContent).toContain('Latest realtime checkpoint.')
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows only the latest human goal instead of a raw event window for long sessions', async () => {
    vi.useFakeTimers()
    try {
      const cached = cachedSessionView(sessionSummary.sessionId)
      const timeline = Array.from({ length: 16 }, (_, index) => ({
        seq: index + 1,
        ts: `2026-07-05T10:00:${String(index).padStart(2, '0')}.000Z`,
        event: { kind: 'user_message' as const, text: `history-message-${index + 1}` },
        effects: [],
      }))
      render(
        <Explorer
          executors={[executor]} sessions={[sessionSummary]} selectedSessionId={null}
          onSelect={() => {}} onNewSession={() => {}} onConnectWorkspace={() => {}}
          onDelete={() => {}} onRename={() => {}}
          getCachedSessionView={() => ({ ...cached, timeline })}
        />,
      )
      fireEvent.pointerEnter(screen.getByTestId('session-row'), { pointerType: 'mouse' })
      await act(async () => vi.advanceTimersByTime(50))
      expect(screen.getByTestId('session-hover-preview').style.height).toBe('')
      expect(screen.getByTestId('session-preview-goal').textContent).toContain('history-message-16')
      expect(screen.getByTestId('session-hover-preview-summary').textContent).not.toContain('history-message-15')
      expect(screen.queryByTestId('session-preview-row')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not load or select a session when hover preview has no cached view', async () => {
    vi.useFakeTimers()
    const onSelect = vi.fn()
    const getCachedSessionView = vi.fn(() => null)
    try {
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
          getCachedSessionView={getCachedSessionView}
        />,
      )

      fireEvent.pointerEnter(screen.getByTestId('session-row'), { pointerType: 'mouse' })
      await act(async () => {
        vi.advanceTimersByTime(50)
      })

      expect(getCachedSessionView).toHaveBeenCalledWith(sessionSummary.sessionId)
      expect(screen.queryByTestId('session-hover-preview')).toBeNull()
      expect(onSelect).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not show hover preview for the currently selected session', async () => {
    vi.useFakeTimers()
    const getCachedSessionView = vi.fn(() => cachedSessionView(sessionSummary.sessionId))
    try {
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
          getCachedSessionView={getCachedSessionView}
        />,
      )

      fireEvent.pointerEnter(screen.getByTestId('session-row'), { pointerType: 'mouse' })
      await act(async () => {
        vi.advanceTimersByTime(50)
      })

      expect(getCachedSessionView).not.toHaveBeenCalled()
      expect(screen.queryByTestId('session-hover-preview')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not show hover preview when the device has no fine hover pointer', async () => {
    vi.useFakeTimers()
    const getCachedSessionView = vi.fn(() => cachedSessionView(sessionSummary.sessionId))
    vi.mocked(window.matchMedia).mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }))
    try {
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
          getCachedSessionView={getCachedSessionView}
        />,
      )

      fireEvent.pointerEnter(screen.getByTestId('session-row'), { pointerType: 'mouse' })
      await act(async () => {
        vi.advanceTimersByTime(50)
      })

      expect(getCachedSessionView).not.toHaveBeenCalled()
      expect(screen.queryByTestId('session-hover-preview')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})

function cachedSessionView(sessionId: string): CachedSessionView {
  const ts = '2026-07-05T10:00:00.000Z'
  return {
    sessionId,
    status: 'ready',
    state: createInitialState({ sessionId }),
    config: createConfig({ tools: [] }),
    contextSnapshot: null,
    timeline: [
      {
        seq: 1,
        ts,
        event: { kind: 'user_message', text: 'please write hello.txt' },
        effects: [],
      },
      {
        seq: 2,
        ts,
        event: {
          kind: 'llm_response',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
        },
        effects: [],
      },
    ],
    queuedMessages: [],
    lastError: null,
    parentSessionId: null,
    parentCursor: null,
    selectedModel: 'anthropic/claude-opus-4.1',
    hydratedSessionId: sessionId,
    cachedAt: Date.now(),
    estimatedBytes: 1,
    estimateParts: { staticBytes: 1, stateBytes: 0, timelineBytes: 0 },
  }
}
