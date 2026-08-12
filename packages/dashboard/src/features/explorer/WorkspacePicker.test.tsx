import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { AttachedExecutor, DirListResult } from '@agent-kernel/shared'

import { NewSessionDialog } from './WorkspacePicker.js'

const wsA: AttachedExecutor = {
  executorId: 'ex-a',
  workspaceId: 'ws-a',
  workspaceName: 'mbp',
  tools: [],
  sandboxRoots: ['/tmp/root'],
  runtime: 'node',
  runtimeVersion: 'v22',
  os: 'darwin',
  ipAddresses: ['192.0.2.1'],
  attachedAt: '2026-07-05T10:00:00.000Z',
}

const wsB: AttachedExecutor = {
  ...wsA,
  executorId: 'ex-b',
  workspaceId: 'ws-b',
  workspaceName: 'linux-box',
  sandboxRoots: ['/work/project'],
  os: 'linux',
}

type Handler = (payload: DirListResult) => void

function makeSocket(): {
  socket: { on: ReturnType<typeof vi.fn>; off: ReturnType<typeof vi.fn>; emit: ReturnType<typeof vi.fn> }
  emitDirList(payload: DirListResult): void
  lastDirRequest(): { requestId: string; workspaceId: string; path?: string }
} {
  let handler: Handler | null = null
  const emit = vi.fn()
  return {
    socket: {
      on: vi.fn((event: string, cb: Handler) => {
        if (event === 'server:dir_list') handler = cb
      }),
      off: vi.fn((event: string, cb: Handler) => {
        if (event === 'server:dir_list' && handler === cb) handler = null
      }),
      emit,
    },
    emitDirList(payload) {
      handler?.(payload)
    },
    lastDirRequest() {
      const calls = emit.mock.calls.filter(([event]) => event === 'client:list_dirs')
      return calls.at(-1)?.[1] as { requestId: string; workspaceId: string; path?: string }
    },
  }
}

describe('NewSessionDialog', () => {
  it('renders nothing when closed', () => {
    const { container } = render(
      <NewSessionDialog
        open={false}
        workspaces={[wsA]}
        socket={makeSocket().socket as never}
        onCreate={() => {}}
        onCreateSimpleChat={() => {}}
        onCancel={() => {}}
      />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('presents chat and workspace sessions as explicit creation paths', () => {
    const onCreateSimpleChat = vi.fn()
    render(
      <NewSessionDialog
        open
        workspaces={[wsA]}
        socket={makeSocket().socket as never}
        onCreate={() => {}}
        onCreateSimpleChat={onCreateSimpleChat}
        onCancel={() => {}}
      />,
    )

    expect(screen.getByText('Start a conversation')).toBeTruthy()
    expect(screen.getByText('Workspace sessions')).toBeTruthy()
    expect(screen.getByTestId('new-session-create').textContent).toContain('Create workspace session')
    fireEvent.click(screen.getByTestId('new-session-simple-chat'))
    expect(onCreateSimpleChat).toHaveBeenCalledTimes(1)
  })

  it('requests directories, expands finder columns, and creates with selected cwd', async () => {
    const onCreate = vi.fn()
    const harness = makeSocket()
    render(
      <NewSessionDialog
        open
        workspaces={[wsA]}
        socket={harness.socket as never}
        onCreate={onCreate}
        onCreateSimpleChat={() => {}}
        onCancel={() => {}}
      />,
    )

    await waitFor(() => {
      expect(harness.socket.emit).toHaveBeenCalledWith(
        'client:list_dirs',
        expect.objectContaining({ workspaceId: 'ws-a', path: '/tmp/root' }),
      )
    })

    act(() => {
      const request = harness.lastDirRequest()
      harness.emitDirList({
        requestId: request.requestId,
        workspaceId: 'ws-a',
        path: '/tmp/root',
        roots: ['/tmp/root'],
        entries: [{ name: 'project', path: '/tmp/root/project' }],
      })
    })

    fireEvent.click(await screen.findByText('project'))
    expect(harness.socket.emit).toHaveBeenLastCalledWith(
      'client:list_dirs',
      expect.objectContaining({ workspaceId: 'ws-a', path: '/tmp/root/project' }),
    )

    act(() => {
      const request = harness.lastDirRequest()
      harness.emitDirList({
        requestId: request.requestId,
        workspaceId: 'ws-a',
        path: '/tmp/root/project',
        roots: ['/tmp/root'],
        entries: [{ name: 'src', path: '/tmp/root/project/src' }],
      })
    })

    expect(screen.getAllByTestId('finder-column')).toHaveLength(2)
    expect(screen.getByDisplayValue('/tmp/root/project')).toBeTruthy()

    fireEvent.click(screen.getByTestId('new-session-create'))
    expect(onCreate).toHaveBeenCalledWith({
      workspaceId: 'ws-a',
      workspaceName: 'mbp',
      cwd: '/tmp/root/project',
    })
  })

  it('uses distinct icons and navigation behavior for folders and files', async () => {
    const harness = makeSocket()
    render(
      <NewSessionDialog
        open
        workspaces={[wsA]}
        socket={harness.socket as never}
        onCreate={() => {}}
        onCreateSimpleChat={() => {}}
        onCancel={() => {}}
      />,
    )

    await waitFor(() => expect(harness.lastDirRequest()).toBeTruthy())
    act(() => {
      const request = harness.lastDirRequest()
      harness.emitDirList({
        requestId: request.requestId,
        workspaceId: 'ws-a',
        path: '/tmp/root',
        roots: ['/tmp/root'],
        entries: [
          { name: 'project', path: '/tmp/root/project', type: 'directory' },
          { name: 'README.md', path: '/tmp/root/README.md', type: 'file', size: 42 },
        ],
      })
    })

    expect(screen.getAllByTestId('finder-folder-icon')).toHaveLength(1)
    expect(screen.getAllByTestId('finder-file-icon')).toHaveLength(1)

    const callsBeforeFileClick = harness.socket.emit.mock.calls.length
    fireEvent.click(screen.getByText('README.md'))
    expect(harness.socket.emit).toHaveBeenCalledTimes(callsBeforeFileClick)

    fireEvent.click(screen.getByText('project'))
    expect(harness.socket.emit).toHaveBeenLastCalledWith(
      'client:list_dirs',
      expect.objectContaining({ workspaceId: 'ws-a', path: '/tmp/root/project' }),
    )
  })

  it('allows manual cwd entry', () => {
    const onCreate = vi.fn()
    const harness = makeSocket()
    render(
      <NewSessionDialog
        open
        workspaces={[wsA]}
        socket={harness.socket as never}
        onCreate={onCreate}
        onCreateSimpleChat={() => {}}
        onCancel={() => {}}
      />,
    )

    fireEvent.change(screen.getByTestId('new-session-cwd-input'), {
      target: { value: '/tmp/root/manual' },
    })
    fireEvent.click(screen.getByTestId('new-session-create'))

    expect(onCreate).toHaveBeenCalledWith({
      workspaceId: 'ws-a',
      workspaceName: 'mbp',
      cwd: '/tmp/root/manual',
    })
  })

  it('shows create errors and blocks duplicate submit while creating', () => {
    const onCreate = vi.fn()
    const harness = makeSocket()
    render(
      <NewSessionDialog
        open
        workspaces={[wsA]}
        socket={harness.socket as never}
        error="cwd is not a readable directory"
        submitting
        onCreate={onCreate}
        onCreateSimpleChat={() => {}}
        onCancel={() => {}}
      />,
    )

    expect(screen.getByTestId('new-session-error').textContent).toContain(
      'cwd is not a readable directory',
    )
    const button = screen.getByTestId('new-session-create') as HTMLButtonElement
    const cancel = screen.getByTestId('workspace-picker-cancel') as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(cancel.disabled).toBe(true)
    expect(button.textContent).toContain('Creating')
    fireEvent.click(button)
    expect(onCreate).not.toHaveBeenCalled()
  })

  it('preselects the requested workspace', async () => {
    const harness = makeSocket()
    render(
      <NewSessionDialog
        open
        workspaces={[wsA, wsB]}
        initialWorkspaceId="ws-b"
        socket={harness.socket as never}
        onCreate={() => {}}
        onCreateSimpleChat={() => {}}
        onCancel={() => {}}
      />,
    )

    await waitFor(() => {
      expect(harness.socket.emit).toHaveBeenCalledWith(
        'client:list_dirs',
        expect.objectContaining({ workspaceId: 'ws-b', path: '/work/project' }),
      )
    })
    expect(screen.getByDisplayValue('/work/project')).toBeTruthy()
  })

  it('keeps a requested workspace missing instead of silently switching targets', () => {
    const onCreate = vi.fn()
    const harness = makeSocket()
    render(
      <NewSessionDialog
        open
        workspaces={[wsA]}
        initialWorkspaceId="ws-deleted"
        socket={harness.socket as never}
        onCreate={onCreate}
        onCreateSimpleChat={() => {}}
        onCancel={() => {}}
      />,
    )

    expect(screen.getByTestId('new-session-missing-workspace').textContent).toContain(
      'Selected workspace is offline',
    )
    expect(harness.socket.emit).not.toHaveBeenCalledWith(
      'client:list_dirs',
      expect.objectContaining({ workspaceId: 'ws-a' }),
    )
    const button = screen.getByTestId('new-session-create') as HTMLButtonElement
    expect(button.disabled).toBe(true)
    fireEvent.click(button)
    expect(onCreate).not.toHaveBeenCalled()
  })

  it('does not reset a manual workspace choice when the initial missing workspace stays missing', () => {
    const harness = makeSocket()
    const { rerender } = render(
      <NewSessionDialog
        open
        workspaces={[wsA, wsB]}
        initialWorkspaceId="ws-deleted"
        socket={harness.socket as never}
        onCreate={() => {}}
        onCreateSimpleChat={() => {}}
        onCancel={() => {}}
      />,
    )

    fireEvent.click(screen.getByTestId('workspace-pick-ws-b'))
    expect(screen.getByDisplayValue('/work/project')).toBeTruthy()

    rerender(
      <NewSessionDialog
        open
        workspaces={[wsA, wsB]}
        initialWorkspaceId="ws-deleted"
        socket={harness.socket as never}
        onCreate={() => {}}
        onCreateSimpleChat={() => {}}
        onCancel={() => {}}
      />,
    )

    expect(screen.queryByTestId('new-session-missing-workspace')).toBeNull()
    expect(screen.getByDisplayValue('/work/project')).toBeTruthy()
  })

  it('ignores stale directory responses after a newer request is sent', async () => {
    const harness = makeSocket()
    render(
      <NewSessionDialog
        open
        workspaces={[wsA]}
        socket={harness.socket as never}
        onCreate={() => {}}
        onCreateSimpleChat={() => {}}
        onCancel={() => {}}
      />,
    )

    await waitFor(() => {
      expect(harness.socket.emit).toHaveBeenCalledWith(
        'client:list_dirs',
        expect.objectContaining({ workspaceId: 'ws-a', path: '/tmp/root' }),
      )
    })
    const initialRequest = harness.lastDirRequest()

    fireEvent.change(screen.getByTestId('new-session-cwd-input'), {
      target: { value: '/tmp/root/manual' },
    })
    act(() => {
      harness.emitDirList({
        requestId: 'stale-request',
        workspaceId: 'ws-a',
        path: '/tmp/root/stale',
        roots: ['/tmp/root'],
        entries: [],
      })
    })
    expect(screen.getByDisplayValue('/tmp/root/manual')).toBeTruthy()

    act(() => {
      harness.emitDirList({
        requestId: initialRequest.requestId,
        workspaceId: 'ws-a',
        path: '/tmp/root',
        roots: ['/tmp/root'],
        entries: [],
      })
    })
    expect(screen.getByDisplayValue('/tmp/root/manual')).toBeTruthy()
  })

  it('navigates one level up with the parent button', async () => {
    const harness = makeSocket()
    render(
      <NewSessionDialog
        open
        workspaces={[wsA]}
        socket={harness.socket as never}
        onCreate={() => {}}
        onCreateSimpleChat={() => {}}
        onCancel={() => {}}
      />,
    )

    await waitFor(() => {
      expect(harness.socket.emit).toHaveBeenCalledWith(
        'client:list_dirs',
        expect.objectContaining({ workspaceId: 'ws-a', path: '/tmp/root' }),
      )
    })

    act(() => {
      const request = harness.lastDirRequest()
      harness.emitDirList({
        requestId: request.requestId,
        workspaceId: 'ws-a',
        path: '/tmp/root',
        roots: ['/tmp/root'],
        entries: [{ name: 'project', path: '/tmp/root/project' }],
      })
    })

    fireEvent.click(screen.getByText('project'))
    act(() => {
      const request = harness.lastDirRequest()
      harness.emitDirList({
        requestId: request.requestId,
        workspaceId: 'ws-a',
        path: '/tmp/root/project',
        roots: ['/tmp/root'],
        entries: [{ name: 'src', path: '/tmp/root/project/src' }],
      })
    })

    fireEvent.click(screen.getByText('src'))
    act(() => {
      const request = harness.lastDirRequest()
      harness.emitDirList({
        requestId: request.requestId,
        workspaceId: 'ws-a',
        path: '/tmp/root/project/src',
        roots: ['/tmp/root'],
        entries: [],
      })
    })

    expect(screen.getByDisplayValue('/tmp/root/project/src')).toBeTruthy()

    fireEvent.click(screen.getByTestId('dir-picker-up'))
    expect(harness.socket.emit).toHaveBeenLastCalledWith(
      'client:list_dirs',
      expect.objectContaining({ workspaceId: 'ws-a', path: '/tmp/root/project' }),
    )
    expect(screen.getByDisplayValue('/tmp/root/project')).toBeTruthy()

    fireEvent.click(screen.getByTestId('dir-picker-up'))
    expect(harness.socket.emit).toHaveBeenLastCalledWith(
      'client:list_dirs',
      expect.objectContaining({ workspaceId: 'ws-a', path: '/tmp/root' }),
    )
    // At the workspace root the up button should be disabled.
    expect((screen.getByTestId('dir-picker-up') as HTMLButtonElement).disabled).toBe(true)
  })

  it('debounces manual path edits and reloads the finder', async () => {
    vi.useFakeTimers()
    try {
      const harness = makeSocket()
      render(
        <NewSessionDialog
          open
          workspaces={[wsA]}
          socket={harness.socket as never}
          onCreate={() => {}}
          onCreateSimpleChat={() => {}}
        onCancel={() => {}}
        />,
      )

      // Initial mount fires one list_dirs. Skip past it.
      act(() => {
        vi.advanceTimersByTime(0)
      })
      const initialCalls = harness.socket.emit.mock.calls.filter(
        ([event]: [string]) => event === 'client:list_dirs',
      ).length

      fireEvent.change(screen.getByTestId('new-session-cwd-input'), {
        target: { value: '/tmp/root/typed' },
      })
      // Before the debounce fires, no new request should have been sent.
      const midCalls = harness.socket.emit.mock.calls.filter(
        ([event]: [string]) => event === 'client:list_dirs',
      ).length
      expect(midCalls).toBe(initialCalls)

      act(() => {
        vi.advanceTimersByTime(500)
      })

      expect(harness.socket.emit).toHaveBeenLastCalledWith(
        'client:list_dirs',
        expect.objectContaining({ workspaceId: 'ws-a', path: '/tmp/root/typed' }),
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('jumps to a breadcrumb segment when clicked', async () => {
    const harness = makeSocket()
    render(
      <NewSessionDialog
        open
        workspaces={[wsA]}
        socket={harness.socket as never}
        onCreate={() => {}}
        onCreateSimpleChat={() => {}}
        onCancel={() => {}}
      />,
    )

    await waitFor(() => {
      expect(harness.socket.emit).toHaveBeenCalledWith(
        'client:list_dirs',
        expect.objectContaining({ workspaceId: 'ws-a', path: '/tmp/root' }),
      )
    })

    act(() => {
      const request = harness.lastDirRequest()
      harness.emitDirList({
        requestId: request.requestId,
        workspaceId: 'ws-a',
        path: '/tmp/root',
        roots: ['/tmp/root'],
        entries: [{ name: 'project', path: '/tmp/root/project' }],
      })
    })

    fireEvent.click(screen.getByText('project'))
    act(() => {
      const request = harness.lastDirRequest()
      harness.emitDirList({
        requestId: request.requestId,
        workspaceId: 'ws-a',
        path: '/tmp/root/project',
        roots: ['/tmp/root'],
        entries: [{ name: 'src', path: '/tmp/root/project/src' }],
      })
    })

    fireEvent.click(screen.getByText('src'))
    act(() => {
      const request = harness.lastDirRequest()
      harness.emitDirList({
        requestId: request.requestId,
        workspaceId: 'ws-a',
        path: '/tmp/root/project/src',
        roots: ['/tmp/root'],
        entries: [],
      })
    })

    // Breadcrumbs collapse everything above workspace root into a single
    // "root" chip: [root, project, src]. Clicking "project" jumps up one.
    fireEvent.click(screen.getByTestId('dir-picker-breadcrumb-1'))
    expect(harness.socket.emit).toHaveBeenLastCalledWith(
      'client:list_dirs',
      expect.objectContaining({ workspaceId: 'ws-a', path: '/tmp/root/project' }),
    )
  })

  it('invokes onCreateSimpleChat when the simple chat tile is clicked', () => {
    const onCreateSimpleChat = vi.fn()
    const harness = makeSocket()
    render(
      <NewSessionDialog
        open
        workspaces={[wsA]}
        socket={harness.socket as never}
        onCreate={() => {}}
        onCreateSimpleChat={onCreateSimpleChat}
        onCancel={() => {}}
      />,
    )
    fireEvent.click(screen.getByTestId('new-session-simple-chat'))
    expect(onCreateSimpleChat).toHaveBeenCalledTimes(1)
  })
})
