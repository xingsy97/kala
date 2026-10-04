import { act, render, waitFor } from '@testing-library/react'
import { webcrypto } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
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
import {
  commandHead,
  formatDuration,
  useBackgroundShellToasts,
  useInactiveSessionSummaryToasts,
  useSessionToasts,
} from './session-toasts.js'

const mockedNotify = notify as unknown as Record<
  'info' | 'success' | 'warning' | 'error' | 'dismiss',
  ReturnType<typeof vi.fn>
>

beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto)
  localStorage.clear()
  mockedNotify.info.mockClear()
  mockedNotify.success.mockClear()
  mockedNotify.warning.mockClear()
  mockedNotify.error.mockClear()
  mockedNotify.dismiss.mockClear()
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

  it('does not fire approval toast when the tab is visible (banner suffices)', () => {
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
    expect(mockedNotify.info).not.toHaveBeenCalled()
  })

  it('fires an approval toast when the tab is hidden', () => {
    const original = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState')
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    try {
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
    } finally {
      if (original) Object.defineProperty(Document.prototype, 'visibilityState', original)
    }
  })

  it('suppresses approval toast when approvalMode is allow_all (tab hidden)', () => {
    const original = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState')
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    try {
      const { rerender } = render(
        <SessionToastHarness
          sessionId="s"
          sessionLabel="Session"
          connectionStatus="ready"
          pendingApprovals={[]}
          lastError={null}
          approvalMode="allow_all"
        />,
      )
      rerender(
        <SessionToastHarness
          sessionId="s"
          sessionLabel="Session"
          connectionStatus="ready"
          pendingApprovals={[{ sessionId: 's', callId: 'c1', name: 'bash', input: {} }]}
          lastError={null}
          approvalMode="allow_all"
        />,
      )
      // In allow_all mode the kernel auto-dispatches; any pending calls the
      // client still observes are transient — do not pester the operator.
      expect(mockedNotify.info).not.toHaveBeenCalled()
    } finally {
      if (original) Object.defineProperty(Document.prototype, 'visibilityState', original)
    }
  })

  it('reports queue length when multiple approvals pending (tab hidden)', () => {
    const original = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState')
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    try {
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
    } finally {
      if (original) Object.defineProperty(Document.prototype, 'visibilityState', original)
    }
  })

  it('does not re-fire the same approval on unrelated re-renders (tab hidden)', () => {
    const original = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState')
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    try {
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
    } finally {
      if (original) Object.defineProperty(Document.prototype, 'visibilityState', original)
    }
  })

  it('announces an unversioned historical change once, even after remount, then a new Settings change', async () => {
    const base = {
      sessionId: 's',
      sessionLabel: 'Existing session',
      connectionStatus: 'ready',
      pendingApprovals: [],
      lastError: null,
    } as const
    const first = render(<SessionToastHarness {...base} systemPromptOverride={{ prompt: 'old tenant secret' }} />)
    await waitFor(() => expect(mockedNotify.info).toHaveBeenCalledTimes(1))
    first.unmount()
    const { rerender } = render(<SessionToastHarness {...base} systemPromptOverride={{ prompt: 'old tenant secret' }} />)
    await waitFor(() => expect(localStorage.getItem('kala:system-prompt-notice:v1:local-operator:s')).toMatch(/^[a-f0-9]{64}$/))
    expect(mockedNotify.info).toHaveBeenCalledTimes(1)

    rerender(<SessionToastHarness {...base} systemPromptOverride={{ prompt: 'new tenant secret', version: 'settings-v2' }} />)
    await waitFor(() => expect(mockedNotify.info).toHaveBeenCalledTimes(2))
    rerender(<SessionToastHarness {...base} systemPromptOverride={{ prompt: 'new tenant secret', version: 'settings-v2' }} />)
    expect(mockedNotify.info).toHaveBeenCalledTimes(2)
    const [title, options] = mockedNotify.info.mock.calls[1]!
    expect(title).toBe('System prompt updated')
    expect(options.id).toBe('system-prompt-changed-s')
    expect(options.description).toContain('administrator or user settings change')
    expect(JSON.stringify(mockedNotify.info.mock.calls)).not.toContain('tenant secret')
  })

  it('does not acknowledge a stale prompt when the user switches sessions before hashing finishes', async () => {
    let resolveDigest!: (value: ArrayBuffer) => void
    const pending = new Promise<ArrayBuffer>((resolve) => { resolveDigest = resolve })
    vi.stubGlobal('crypto', { subtle: { digest: vi.fn(() => pending) } })
    const base = { sessionLabel: 'Session', connectionStatus: 'ready', pendingApprovals: [], lastError: null } as const
    const { rerender } = render(<SessionToastHarness {...base} sessionId="old" systemPromptOverride={{ prompt: 'old prompt' }} />)
    rerender(<SessionToastHarness {...base} sessionId="new" systemPromptOverride={{ prompt: 'new prompt' }} />)
    await act(async () => { resolveDigest(new Uint8Array(32).buffer); await pending })
    expect(mockedNotify.info).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem('kala:system-prompt-notice:v1:local-operator:old')).toBeNull()
    expect(localStorage.getItem('kala:system-prompt-notice:v1:local-operator:new')).toBe('00'.repeat(32))
  })

  it('isolates acknowledgment by logged-in user and Host namespace', async () => {
    const base = { sessionId: 'shared', sessionLabel: 'Shared session', connectionStatus: 'ready', pendingApprovals: [], lastError: null, systemPromptOverride: { prompt: 'shared system text' } } as const
    const first = render(<SessionToastHarness {...base} cacheNamespace="host-a:user-a" />)
    await waitFor(() => expect(mockedNotify.info).toHaveBeenCalledTimes(1))
    first.unmount()
    const second = render(<SessionToastHarness {...base} cacheNamespace="host-a:user-b" />)
    await waitFor(() => expect(mockedNotify.info).toHaveBeenCalledTimes(2))
    second.unmount()
    render(<SessionToastHarness {...base} cacheNamespace="host-a:user-a" />)
    await act(async () => { await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(base.systemPromptOverride.prompt)) })
    expect(mockedNotify.info).toHaveBeenCalledTimes(2)
  })

  it('announces a versioned Settings change first observed when an existing session is opened', async () => {
    const props = {
      sessionId: 'persisted-change',
      sessionLabel: 'Previously inactive session',
      connectionStatus: 'ready',
      pendingApprovals: [],
      lastError: null,
      systemPromptOverride: { prompt: 'private managed prompt', version: 'settings-v3' },
    } as const

    const { rerender } = render(<SessionToastHarness {...props} />)
    rerender(<SessionToastHarness {...props} />)

    await waitFor(() => expect(mockedNotify.info).toHaveBeenCalledTimes(1))
    expect(mockedNotify.info.mock.calls[0]![1].description).toContain('Previously inactive session')
    expect(JSON.stringify(mockedNotify.info.mock.calls)).not.toContain('private managed prompt')
  })

  it('announces a prompt changed while disconnected from the reconnect baseline without duplicate toast', async () => {
    const base = {
      sessionId: 's',
      sessionLabel: 'Existing session',
      pendingApprovals: [],
      lastError: null,
    } as const
    const { rerender } = render(
      <SessionToastHarness {...base} connectionStatus="ready" />,
    )
    rerender(<SessionToastHarness {...base} connectionStatus="disconnected" />)
    rerender(
      <SessionToastHarness
        {...base}
        connectionStatus="ready"
        systemPromptOverride={{ prompt: 'updated while offline', version: 2 }}
      />,
    )
    rerender(<SessionToastHarness {...base} connectionStatus="disconnected" systemPromptOverride={{ prompt: 'updated while offline', version: 2 }} />)
    rerender(<SessionToastHarness {...base} connectionStatus="ready" systemPromptOverride={{ prompt: 'updated while offline', version: 2 }} />)

    await waitFor(() => expect(mockedNotify.info).toHaveBeenCalledTimes(1))
    expect(mockedNotify.info.mock.calls[0]![1].description).toContain('Existing session')
  })

  it('keeps connection loss inline without a second warning, but confirms reconnection', () => {
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
    expect(mockedNotify.warning).not.toHaveBeenCalled()
    expect(mockedNotify.success).toHaveBeenCalledTimes(1)
    expect(mockedNotify.success.mock.calls[0][0]).toBe('Reconnected')
  })

  it('does not toast a failed subscribe when the active Session already has an inline error', () => {
    const { rerender } = render(<SessionToastHarness sessionId="s" sessionLabel="Session" connectionStatus="ready" pendingApprovals={[]} lastError={null} />)
    rerender(<SessionToastHarness sessionId="s" sessionLabel="Session" connectionStatus="error" pendingApprovals={[]}
      lastError={{ sessionId: 's', scope: 'host', message: 'Unable to subscribe to this Session: unavailable' }} />)
    expect(mockedNotify.warning).not.toHaveBeenCalled()
    expect(mockedNotify.error).not.toHaveBeenCalled()
  })

  it('does not fire toast for focused session errors (banner surfaces them)', () => {
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
    expect(mockedNotify.error).not.toHaveBeenCalled()
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

  it('toasts when an inactive running session finishes (after the debounce window)', () => {
    vi.useFakeTimers()
    try {
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

      // Debounced: nothing yet.
      expect(mockedNotify.success).not.toHaveBeenCalled()

      act(() => {
        vi.advanceTimersByTime(1600)
      })

      expect(mockedNotify.success).toHaveBeenCalledTimes(1)
      expect(mockedNotify.success.mock.calls[0][0]).toBe('Session finished — background task')
      expect(mockedNotify.success.mock.calls[0][1].id).toBe('inactive-session-finished-b')
    } finally {
      vi.useRealTimers()
    }
  })

  it('opens the finished session, not the session currently focused, and ignores deleted sessions', () => {
    vi.useFakeTimers()
    try {
      const open = vi.fn()
      const { rerender } = render(
        <InactiveSummaryHarness activeSessionId="a" onOpenSession={open} sessions={[summary('a', 'idle'), summary('b', 'thinking', 'background task')]} />,
      )
      rerender(
        <InactiveSummaryHarness activeSessionId="a" onOpenSession={open} sessions={[summary('a', 'idle'), summary('b', 'done', 'background task')]} />,
      )
      act(() => vi.advanceTimersByTime(1600))
      const onClick = mockedNotify.success.mock.calls[0]?.[1]?.onClick as (() => void) | undefined
      expect(onClick).toBeTypeOf('function')
      rerender(
        <InactiveSummaryHarness activeSessionId="a" onOpenSession={open} sessions={[summary('a', 'idle'), summary('b', 'done', 'background task')]} />,
      )
      act(() => onClick?.())
      expect(open).toHaveBeenCalledExactlyOnceWith('b')
      expect(mockedNotify.dismiss).toHaveBeenCalledWith('inactive-session-finished-b')
      rerender(<InactiveSummaryHarness activeSessionId="a" onOpenSession={open} sessions={[summary('a', 'idle')]} />)
      act(() => onClick?.())
      expect(open).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does NOT toast on a transient mid-turn done→running flip', () => {
    vi.useFakeTimers()
    try {
      const { rerender } = render(
        <InactiveSummaryHarness
          activeSessionId="a"
          sessions={[summary('a', 'idle'), summary('b', 'thinking', 'background task')]}
        />,
      )

      // Turn flips briefly to done...
      rerender(
        <InactiveSummaryHarness
          activeSessionId="a"
          sessions={[summary('a', 'idle'), summary('b', 'done', 'background task')]}
        />,
      )
      // ...then a queued message re-drives it back to running before the window.
      act(() => {
        vi.advanceTimersByTime(800)
      })
      rerender(
        <InactiveSummaryHarness
          activeSessionId="a"
          sessions={[summary('a', 'idle'), summary('b', 'thinking', 'background task')]}
        />,
      )
      act(() => {
        vi.advanceTimersByTime(2000)
      })

      // The transient done must not have produced a "finished" toast.
      expect(mockedNotify.success).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
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

  it('never treats sub-agent sessions as independent application notifications', () => {
    vi.useFakeTimers()
    try {
      const childThinking = { ...summary('child', 'thinking', 'delegated task'), parentSessionId: 'parent' }
      const { rerender } = render(
        <InactiveSummaryHarness activeSessionId="parent" sessions={[childThinking]} />,
      )

      rerender(
        <InactiveSummaryHarness
          activeSessionId="parent"
          sessions={[{ ...childThinking, status: 'done' }]}
        />,
      )
      act(() => { vi.advanceTimersByTime(2000) })
      rerender(
        <InactiveSummaryHarness
          activeSessionId="parent"
          sessions={[{ ...childThinking, status: 'error' }]}
        />,
      )
      rerender(
        <InactiveSummaryHarness
          activeSessionId="parent"
          sessions={[{ ...childThinking, status: 'awaiting_approval' }]}
        />,
      )

      expect(mockedNotify.success).not.toHaveBeenCalled()
      expect(mockedNotify.error).not.toHaveBeenCalled()
      expect(mockedNotify.info).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
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
