/**
 * Fans session-level state changes and socket events out to `notify.*` toasts.
 *
 * Companion to [[useInterventionDesktopNotifications]] — that hook handles OS
 * notifications when the tab is backgrounded and requires permission. This one
 * handles **in-app** feedback: always on, no permission needed, dismissable.
 * They overlap deliberately: a background user gets both a desktop banner and
 * a toast they see when they come back.
 *
 * Signal design:
 *
 *   - Approval: dedup by `callId`; sonner replaces in-place so re-renders
 *     while the same approval is pending don't stack toasts.
 *   - Connection: only fire on transitions (disconnected→connected fires
 *     `Reconnected`, connected→disconnected fires `Disconnected — trying
 *     to reconnect`), not on the first mount.
 *   - Session error: dedup on `scope:message` so repeated identical errors
 *     don't stack, but a distinct new error still fires.
 *   - Sub-agent completed/failed: socket-driven; the app never keeps a per-child
 *     `useSubAgentSession` (that's inside the SubAgentCard), so we listen to
 *     the raw `server:sub_agent_started`/`_finished` events directly.
 *   - Background shell exit: observed on the timeline-derived task list; toasts
 *     when a running task transitions to done/killed.
 */

import { useEffect, useRef } from 'react'

import type { ApprovalRequiredEvent, SessionErrorEvent, SessionSummary } from '@agent-kernel/shared'

import type { BackgroundTerminalTask } from './background-terminal.js'
import { notify } from './notify.js'
import type { DashboardSocket } from './session.js'

export type SessionToastInput = {
  sessionId: string | null
  sessionLabel: string
  connectionStatus: string
  pendingApprovals: readonly ApprovalRequiredEvent[]
  lastError: SessionErrorEvent | null
  /** Called when the user clicks the "Review" action on an approval toast. */
  onFocusApprovals?: () => void
}

/**
 * Watches the three session-level intervention signals and dispatches toasts on
 * meaningful transitions. Safe to mount once per session.
 */
export function useSessionToasts({
  sessionId,
  sessionLabel,
  connectionStatus,
  pendingApprovals,
  lastError,
  onFocusApprovals,
}: SessionToastInput): void {
  const firstApproval = pendingApprovals[0]
  const approvalSig = firstApproval
    ? `${sessionId}:${firstApproval.callId}:${pendingApprovals.length}`
    : `${sessionId}:none`
  const errorSig = lastError ? `${sessionId}:${lastError.scope}:${lastError.message}` : `${sessionId}:none`

  const prev = useRef<{ approvalSig: string; errorSig: string; connectionStatus: string } | null>(null)
  const focusRef = useRef(onFocusApprovals)
  focusRef.current = onFocusApprovals

  useEffect(() => {
    const previous = prev.current
    if (sessionId === null) {
      prev.current = null
      return
    }
    prev.current = { approvalSig, errorSig, connectionStatus }

    if (firstApproval && approvalSig !== previous?.approvalSig) {
      const extras = pendingApprovals.length - 1
      notify.info(`Approval requested — ${firstApproval.name}`, {
        id: `approval-${sessionId}-${firstApproval.callId}`,
        description:
          extras > 0
            ? `${sessionLabel}: ${extras} more request${extras === 1 ? '' : 's'} pending`
            : sessionLabel,
        ...(focusRef.current
          ? { action: { label: 'Review', onClick: () => focusRef.current?.() } }
          : {}),
        duration: 8000,
      })
    }

    if (lastError && errorSig !== previous?.errorSig) {
      notify.error(`${sessionLabel}: session error`, {
        id: `session-error-${sessionId}-${lastError.scope}`,
        description: lastError.message,
        duration: 10000,
      })
    }

    const wasLost = previous?.connectionStatus === 'disconnected' || previous?.connectionStatus === 'error'
    const nowLost = connectionStatus === 'disconnected' || connectionStatus === 'error'
    if (previous && wasLost !== nowLost) {
      if (nowLost) {
        notify.warning('Disconnected — trying to reconnect', {
          id: `connection-${sessionId}`,
          description: sessionLabel,
        })
      } else if (connectionStatus === 'ready') {
        notify.success('Reconnected', {
          id: `connection-${sessionId}`,
          description: sessionLabel,
          duration: 3000,
        })
      }
    }
  }, [
    approvalSig,
    connectionStatus,
    errorSig,
    firstApproval,
    lastError,
    pendingApprovals.length,
    sessionId,
    sessionLabel,
  ])
}

export function useInactiveSessionSummaryToasts({
  sessions,
  activeSessionId,
}: {
  sessions: readonly SessionSummary[]
  activeSessionId: string | null
}): void {
  const previous = useRef<Map<string, SessionSummary['status'] | undefined>>(new Map())

  useEffect(() => {
    const prev = previous.current
    const next = new Map<string, SessionSummary['status'] | undefined>()

    for (const session of sessions) {
      next.set(session.sessionId, session.status)
      if (session.sessionId === activeSessionId) continue

      const before = prev.get(session.sessionId)
      if (!isActiveSummaryStatus(before)) continue
      if (session.status === before) continue

      const label = sessionSummaryLabel(session)
      if (session.status === 'awaiting_approval') {
        notify.info(`Approval requested — ${label}`, {
          id: `inactive-session-approval-${session.sessionId}`,
          duration: 8000,
        })
      } else if (session.status === 'error') {
        notify.error(`Session failed — ${label}`, {
          id: `inactive-session-error-${session.sessionId}`,
          duration: 10000,
        })
      } else if (isRestingSummaryStatus(session.status)) {
        notify.success(`Session finished — ${label}`, {
          id: `inactive-session-finished-${session.sessionId}`,
          duration: 6000,
        })
      }
    }

    previous.current = next
  }, [activeSessionId, sessions])
}

/**
 * Watches sub-agent lifecycle events on the socket and toasts on
 * completion/failure. Keys off `childSessionId` so the same child doesn't
 * double-toast when the parent replays events. Also tracks per-child
 * `agentType` from the `_started` event so completion toasts can label
 * themselves without having to peek at the timeline.
 */
export function useSubAgentToasts(socket: DashboardSocket | null): void {
  useEffect(() => {
    if (!socket) return
    const agentTypeByChild = new Map<string, string>()
    const alreadyToasted = new Set<string>()

    const onStarted = (payload: { childSessionId: string; agentType?: string }): void => {
      if (payload.agentType) agentTypeByChild.set(payload.childSessionId, payload.agentType)
    }
    const onFinished = (payload: {
      childSessionId: string
      status: 'completed' | 'failed' | 'cancelled'
      durationMs: number
      error?: string
    }): void => {
      if (alreadyToasted.has(payload.childSessionId)) return
      alreadyToasted.add(payload.childSessionId)
      const label = agentTypeByChild.get(payload.childSessionId) ?? 'agent'
      const durationLabel = formatDuration(payload.durationMs)
      if (payload.status === 'completed') {
        notify.success(`Sub-agent done — ${label}`, {
          id: `subagent-${payload.childSessionId}`,
          description: durationLabel ? `Finished in ${durationLabel}` : 'Finished',
        })
      } else if (payload.status === 'cancelled') {
        notify.info(`Sub-agent interrupted — ${label}`, {
          id: `subagent-${payload.childSessionId}`,
          description: payload.error ?? 'Cancelled',
        })
      } else {
        notify.error(`Sub-agent failed — ${label}`, {
          id: `subagent-${payload.childSessionId}`,
          description: payload.error ?? 'Unknown failure',
          duration: 10000,
        })
      }
    }

    socket.on('server:sub_agent_started', onStarted)
    socket.on('server:sub_agent_finished', onFinished)
    return () => {
      socket.off('server:sub_agent_started', onStarted)
      socket.off('server:sub_agent_finished', onFinished)
    }
  }, [socket])
}

/**
 * Watches the derived background-terminal task list and fires a toast when a
 * task transitions from running → done/killed. First observation is skipped
 * because the timeline may replay historical tasks that already finished.
 */
export function useBackgroundShellToasts(
  tasks: readonly BackgroundTerminalTask[],
  onOpenPanel?: () => void,
): void {
  const seen = useRef<Map<string, BackgroundTerminalTask['status']>>(new Map())
  const focusRef = useRef(onOpenPanel)
  focusRef.current = onOpenPanel

  useEffect(() => {
    for (const task of tasks) {
      const prevStatus = seen.current.get(task.taskId)
      if (prevStatus === task.status) continue
      const wasKnown = prevStatus !== undefined
      seen.current.set(task.taskId, task.status)
      const isTerminal = task.status === 'done' || task.status === 'killed'
      if (!isTerminal) continue
      if (!wasKnown) continue // appeared already terminal — historical replay
      if (prevStatus !== 'running') continue

      const head = commandHead(task.command)
      const verb = task.status === 'done' ? 'finished' : 'was killed'
      notify.info(`Shell ${verb} — ${head}`, {
        id: `bg-shell-${task.taskId}`,
        ...(focusRef.current
          ? { action: { label: 'View', onClick: () => focusRef.current?.() } }
          : {}),
        duration: 6000,
      })
    }
  }, [tasks])
}

export function formatDuration(ms: number): string | null {
  if (!Number.isFinite(ms) || ms <= 0) return null
  if (ms < 1000) return `${Math.round(ms)}ms`
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rem = s % 60
  return rem === 0 ? `${m}m` : `${m}m${rem}s`
}

export function commandHead(cmd: string): string {
  const trimmed = cmd.trim()
  const head = trimmed.split(/\s+/)[0] ?? ''
  if (head.length === 0) return '(shell)'
  if (head.length <= 32) return head
  return `${head.slice(0, 29)}…`
}

function isActiveSummaryStatus(status: SessionSummary['status'] | undefined): boolean {
  return status === 'thinking' || status === 'executing_tools'
}

function isRestingSummaryStatus(status: SessionSummary['status'] | undefined): boolean {
  return status === 'idle' || status === 'done'
}

function sessionSummaryLabel(session: SessionSummary): string {
  const raw = session.label?.trim() || session.firstUserMessage?.trim() || session.sessionId
  return raw.length <= 48 ? raw : `${raw.slice(0, 45)}...`
}
