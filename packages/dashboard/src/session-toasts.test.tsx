import { render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'events'
import type React from 'react'

vi.mock('./notify.js', () => ({
  notify: {
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    dismiss: vi.fn(),
  },
}))

import type { BackgroundTerminalTask } from './background-terminal.js'
import { notify } from './notify.js'
import type { DashboardSocket } from './session.js'
import {
  commandHead,
  formatDuration,
  useBackgroundShellToasts,
  useInactiveSessionSummaryToasts,
  useSessionToasts,
  useSubAgentToasts,
} from './session-toasts.js'

const mockedNotify = notify as unknown as Record<
  'info' | 'success' | 'warning' | 'error' | 'dismiss',
  ReturnType<typeof vi.fn>
>

beforeEach(() => {
  mockedNotify.info.mockClear()
  mockedNotify.success.mockClear()
  mockedNotify.warning.mockClear()
  mockedNotify.error.mockClear()
})

function SessionToastHarness(props: Parameters<typeof useSessionToasts>[0]): React.ReactElement {
  useSessionToasts(props)
  return <div />
}

function InactiveSummaryHarness(props: Parameters<typeof useInactiveSessionSummaryToasts>[0]): React.ReactElement {
  useInactiveSessionSummaryToasts(props)
  return <div />
}

describe('useSessionToasts', () => {
  it('does not fire on first mount when signals are stable', () => {
    render(
      <SessionToastHarness
        sessionId="s"
        sessionLabel="Session"
        connectionStatus="ready"
        pendingApprovals={[]}
        lastError={null}
      />,
    )
    expect(mockedNotify.info).not.toHaveBeenCalled()
    expect(mockedNotify.warning).not.toHaveBeenCalled()
    expect(mockedNotify.success).not.toHaveBeenCalled()
    expect(mockedNotify.error).not.toHaveBeenCalled()
  })

  it('fires an approval toast the first time an approval appears', () => {
    const { rerender } = render(
      <SessionToastHarness
        sessionId="s"
        sessionLabel="Session"
        connectionStatus="ready"
        pendingApprovals={[]}
        lastError={null}
      />,
    )
    rerender(
      <SessionToastHarness
        sessionId="s"
        sessionLabel="Session"
        connectionStatus="ready"
        pendingApprovals={[{ sessionId: 's', callId: 'c1', name: 'bash', input: {} }]}
        lastError={null}
      />,
    )
    expect(mockedNotify.info).toHaveBeenCalledTimes(1)
    const [msg, opts] = mockedNotify.info.mock.calls[0]!
    expect(msg).toContain('Approval requested — bash')
    expect(opts.id).toBe('approval-s-c1')
    expect(opts.description).toBe('Session')
  })

  it('reports queue length when multiple approvals pending', () => {
    const { rerender } = render(
      <SessionToastHarness
        sessionId="s"
        sessionLabel="Session"
        connectionStatus="ready"
        pendingApprovals={[]}
        lastError={null}
      />,
    )
    rerender(
      <SessionToastHarness
        sessionId="s"
        sessionLabel="Session"
        connectionStatus="ready"
        pendingApprovals={[
          { sessionId: 's', callId: 'c1', name: 'bash', input: {} },
          { sessionId: 's', callId: 'c2', name: 'edit', input: {} },
        ]}
        lastError={null}
      />,
    )
    const [, opts] = mockedNotify.info.mock.calls[0]!
    expect(opts.description).toBe('Session: 1 more request pending')
  })

  it('does not re-fire the same approval on unrelated re-renders', () => {
    const approvals = [{ sessionId: 's', callId: 'c1', name: 'bash', input: {} }]
    const { rerender } = render(
      <SessionToastHarness
        sessionId="s"
        sessionLabel="Session"
        connectionStatus="ready"
        pendingApprovals={approvals}
        lastError={null}
      />,
    )
    // Same approvals, unrelated rerender.
    rerender(
      <SessionToastHarness
        sessionId="s"
        sessionLabel="Session"
        connectionStatus="ready"
        pendingApprovals={approvals}
        lastError={null}
      />,
    )
    expect(mockedNotify.info).toHaveBeenCalledTimes(1)
  })

  it('fires warning + success on disconnect / reconnect transitions', () => {
    const { rerender } = render(
      <SessionToastHarness
        sessionId="s"
        sessionLabel="Session"
        connectionStatus="ready"
        pendingApprovals={[]}
        lastError={null}
      />,
    )
    rerender(
      <SessionToastHarness
        sessionId="s"
        sessionLabel="Session"
        connectionStatus="disconnected"
        pendingApprovals={[]}
        lastError={null}
      />,
    )
    rerender(
      <SessionToastHarness
        sessionId="s"
        sessionLabel="Session"
        connectionStatus="ready"
        pendingApprovals={[]}
        lastError={null}
      />,
    )
    expect(mockedNotify.warning).toHaveBeenCalledTimes(1)
    expect(mockedNotify.success).toHaveBeenCalledTimes(1)
    expect(mockedNotify.warning.mock.calls[0][0]).toBe('Disconnected — trying to reconnect')
    expect(mockedNotify.success.mock.calls[0][0]).toBe('Reconnected')
  })

  it('fires error toast for a new session error and dedupes duplicates', () => {
    const err = { sessionId: 's', scope: 'llm', message: 'boom' } as const
    const { rerender } = render(
      <SessionToastHarness
        sessionId="s"
        sessionLabel="Session"
        connectionStatus="ready"
        pendingApprovals={[]}
        lastError={null}
      />,
    )
    rerender(
      <SessionToastHarness
        sessionId="s"
        sessionLabel="Session"
        connectionStatus="ready"
        pendingApprovals={[]}
        lastError={err as unknown as Parameters<typeof useSessionToasts>[0]['lastError']}
      />,
    )
    rerender(
      <SessionToastHarness
        sessionId="s"
        sessionLabel="Session"
        connectionStatus="ready"
        pendingApprovals={[]}
        lastError={err as unknown as Parameters<typeof useSessionToasts>[0]['lastError']}
      />,
    )
    expect(mockedNotify.error).toHaveBeenCalledTimes(1)
    expect(mockedNotify.error.mock.calls[0][0]).toContain('Session: session error')
    expect(mockedNotify.error.mock.calls[0][1].description).toBe('boom')
  })
})

describe('useInactiveSessionSummaryToasts', () => {
  it('does not toast historical terminal sessions on first observation', () => {
    render(
      <InactiveSummaryHarness
        activeSessionId="a"
        sessions={[summary('b', 'done')]}
      />,
    )

    expect(mockedNotify.success).not.toHaveBeenCalled()
    expect(mockedNotify.error).not.toHaveBeenCalled()
    expect(mockedNotify.info).not.toHaveBeenCalled()
  })

  it('toasts when an inactive running session finishes', () => {
    const { rerender } = render(
      <InactiveSummaryHarness
        activeSessionId="a"
        sessions={[summary('a', 'idle'), summary('b', 'thinking', 'background task')]}
      />,
    )

    rerender(
      <InactiveSummaryHarness
        activeSessionId="a"
        sessions={[summary('a', 'idle'), summary('b', 'done', 'background task')]}
      />,
    )

    expect(mockedNotify.success).toHaveBeenCalledTimes(1)
    expect(mockedNotify.success.mock.calls[0][0]).toBe('Session finished — background task')
    expect(mockedNotify.success.mock.calls[0][1].id).toBe('inactive-session-finished-b')
  })

  it('does not toast the active session summary transition', () => {
    const { rerender } = render(
      <InactiveSummaryHarness
        activeSessionId="b"
        sessions={[summary('b', 'thinking', 'active task')]}
      />,
    )

    rerender(
      <InactiveSummaryHarness
        activeSessionId="b"
        sessions={[summary('b', 'done', 'active task')]}
      />,
    )

    expect(mockedNotify.success).not.toHaveBeenCalled()
  })

  it('toasts inactive error and approval transitions', () => {
    const { rerender } = render(
      <InactiveSummaryHarness
        activeSessionId="a"
        sessions={[summary('b', 'executing_tools', 'needs help'), summary('c', 'thinking', 'will fail')]}
      />,
    )

    rerender(
      <InactiveSummaryHarness
        activeSessionId="a"
        sessions={[summary('b', 'awaiting_approval', 'needs help'), summary('c', 'error', 'will fail')]}
      />,
    )

    expect(mockedNotify.info).toHaveBeenCalledTimes(1)
    expect(mockedNotify.info.mock.calls[0][0]).toBe('Approval requested — needs help')
    expect(mockedNotify.error).toHaveBeenCalledTimes(1)
    expect(mockedNotify.error.mock.calls[0][0]).toBe('Session failed — will fail')
  })
})

function summary(
  sessionId: string,
  status: NonNullable<import('@agent-kernel/shared').SessionSummary['status']>,
  firstUserMessage = sessionId,
): import('@agent-kernel/shared').SessionSummary {
  return {
    sessionId,
    createdAt: '2026-07-21T00:00:00.000Z',
    lastEventAt: '2026-07-21T00:00:00.000Z',
    eventCount: 1,
    firstUserMessage,
    status,
  }
}

function SubAgentHarness({ socket }: { socket: DashboardSocket | null }): React.ReactElement {
  useSubAgentToasts(socket)
  return <div />
}

describe('useSubAgentToasts', () => {
  it('fires success toast on _finished with status completed', () => {
    const emitter = new EventEmitter()
    const fakeSocket = emitter as unknown as DashboardSocket
    render(<SubAgentHarness socket={fakeSocket} />)
    emitter.emit('server:control_update', { kind: 'sub_agent_started', childSessionId: 'c1', agentType: 'general-purpose' })
    emitter.emit('server:control_update', {
      kind: 'sub_agent_finished',
      childSessionId: 'c1',
      status: 'completed',
      durationMs: 12_000,
    })
    expect(mockedNotify.success).toHaveBeenCalledTimes(1)
    expect(mockedNotify.success.mock.calls[0][0]).toBe('Sub-agent done — general-purpose')
    expect(mockedNotify.success.mock.calls[0][1].description).toBe('Finished in 12s')
  })

  it('fires error toast on _finished with status failed', () => {
    const emitter = new EventEmitter()
    const fakeSocket = emitter as unknown as DashboardSocket
    render(<SubAgentHarness socket={fakeSocket} />)
    emitter.emit('server:control_update', { kind: 'sub_agent_started', childSessionId: 'c1', agentType: 'code-reviewer' })
    emitter.emit('server:control_update', {
      kind: 'sub_agent_finished',
      childSessionId: 'c1',
      status: 'failed',
      durationMs: 500,
      error: 'nope',
    })
    expect(mockedNotify.error).toHaveBeenCalledTimes(1)
    const [msg, opts] = mockedNotify.error.mock.calls[0]!
    expect(msg).toBe('Sub-agent failed — code-reviewer')
    expect(opts.description).toBe('nope')
  })

  it('deduplicates repeated _finished for the same childSessionId', () => {
    const emitter = new EventEmitter()
    const fakeSocket = emitter as unknown as DashboardSocket
    render(<SubAgentHarness socket={fakeSocket} />)
    emitter.emit('server:control_update', { kind: 'sub_agent_started', childSessionId: 'c1', agentType: 'x' })
    emitter.emit('server:control_update', {
      kind: 'sub_agent_finished',
      childSessionId: 'c1',
      status: 'completed',
      durationMs: 1000,
    })
    emitter.emit('server:control_update', {
      kind: 'sub_agent_finished',
      childSessionId: 'c1',
      status: 'completed',
      durationMs: 1000,
    })
    expect(mockedNotify.success).toHaveBeenCalledTimes(1)
  })

  it('is inert when socket is null', () => {
    const { unmount } = render(<SubAgentHarness socket={null} />)
    expect(mockedNotify.success).not.toHaveBeenCalled()
    expect(() => unmount()).not.toThrow()
  })
})

function BgShellHarness({
  tasks,
  onOpenPanel,
}: {
  tasks: readonly BackgroundTerminalTask[]
  onOpenPanel?: () => void
}): React.ReactElement {
  useBackgroundShellToasts(tasks, onOpenPanel)
  return <div />
}

const runningTask = (id: string, cmd = 'pnpm test'): BackgroundTerminalTask => ({
  taskId: id,
  callId: `call-${id}`,
  command: cmd,
  status: 'running',
  output: '',
})

describe('useBackgroundShellToasts', () => {
  it('fires info toast when a running task transitions to done', () => {
    const onOpenPanel = vi.fn()
    const t = runningTask('t1', 'pnpm test')
    const { rerender } = render(
      <BgShellHarness tasks={[t]} onOpenPanel={onOpenPanel} />,
    )
    expect(mockedNotify.info).not.toHaveBeenCalled()
    rerender(<BgShellHarness tasks={[{ ...t, status: 'done' }]} onOpenPanel={onOpenPanel} />)
    expect(mockedNotify.info).toHaveBeenCalledTimes(1)
    expect(mockedNotify.info.mock.calls[0][0]).toBe('Shell finished — pnpm')
    const opts = mockedNotify.info.mock.calls[0][1]
    expect(opts.action?.label).toBe('View')
    opts.action?.onClick()
    expect(onOpenPanel).toHaveBeenCalledTimes(1)
  })

  it('does not fire when a task appears already terminal (historical replay)', () => {
    render(<BgShellHarness tasks={[{ ...runningTask('t1'), status: 'done' }]} />)
    expect(mockedNotify.info).not.toHaveBeenCalled()
  })

  it('fires killed variant when transitioning to killed', () => {
    const t = runningTask('t1', 'node server.js')
    const { rerender } = render(<BgShellHarness tasks={[t]} />)
    rerender(<BgShellHarness tasks={[{ ...t, status: 'killed' }]} />)
    expect(mockedNotify.info.mock.calls[0][0]).toBe('Shell was killed — node')
  })
})

describe('helpers', () => {
  it('formatDuration handles the standard cutoffs', () => {
    expect(formatDuration(0)).toBeNull()
    expect(formatDuration(-1)).toBeNull()
    expect(formatDuration(999)).toBe('999ms')
    expect(formatDuration(1500)).toBe('2s')
    expect(formatDuration(60_000)).toBe('1m')
    expect(formatDuration(90_000)).toBe('1m30s')
  })

  it('commandHead extracts the argv[0]', () => {
    expect(commandHead('pnpm test --run')).toBe('pnpm')
    expect(commandHead('   ')).toBe('(shell)')
    expect(commandHead('a'.repeat(40))).toHaveLength(30)
  })
})
