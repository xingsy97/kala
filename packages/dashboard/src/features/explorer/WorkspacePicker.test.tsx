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
} {
  let handler: Handler | null = null
  return {
    socket: {
      on: vi.fn((event: string, cb: Handler) => {
        if (event === 'server:dir_list') handler = cb
      }),
      off: vi.fn((event: string, cb: Handler) => {
        if (event === 'server:dir_list' && handler === cb) handler = null
      }),
      emit: vi.fn(),
    },
    emitDirList(payload) {
      handler?.(payload)
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
        onCancel={() => {}}
      />,
    )
    expect(container.firstChild).toBeNull()
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
      harness.emitDirList({
        requestId: 'r1',
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
      harness.emitDirList({
        requestId: 'r2',
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

  it('allows manual cwd entry', () => {
    const onCreate = vi.fn()
    const harness = makeSocket()
    render(
      <NewSessionDialog
        open
        workspaces={[wsA]}
        socket={harness.socket as never}
        onCreate={onCreate}
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

  it('preselects the requested workspace', async () => {
    const harness = makeSocket()
    render(
      <NewSessionDialog
        open
        workspaces={[wsA, wsB]}
        initialWorkspaceId="ws-b"
        socket={harness.socket as never}
        onCreate={() => {}}
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
})
