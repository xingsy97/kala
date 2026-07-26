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
 *     `server:control_update` directly.
 *   - Background shell exit: observed on the timeline-derived task list; toasts
 *     when a running task transitions to done/killed.
 */

import { useEffect, useRef } from 'react'

import type { ApprovalRequiredEvent, ControlUpdate, SessionErrorEvent, SessionSummary } from '@agent-kernel/shared'

import type { BackgroundTerminalTask } from './background-terminal.js'
import { decideInactiveSummaryNotification } from './domain/notification-policy.js'
import { notify } from './notify.js'
import type { DashboardSocket } from './session.js'

export type SessionToastInput = {
  sessionId: string | null
  sessionLabel: string
  connectionStatus: string
  pendingApprovals: readonly ApprovalRequiredEvent[]
  lastError: SessionErrorEvent | null
  /**
   * Current approval mode of the session. When `'allow_all'`, incoming tool
   * calls are auto-dispatched by the kernel and the operator never needs to
   * act — so any `pendingApprovals` we still observe are either transient
   * (races between mode change and call arrival) or pre-existing calls that
   * were parked before the switch. Either way surfacing an "Approval
   * requested" toast is misleading; suppress it in this mode.
   */
  approvalMode?: string
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
  approvalMode,
  onFocusApprovals,
}: SessionToastInput): void {
  const firstApproval = pendingApprovals[0]
  const suppressApprovalToast = approvalMode === 'allow_all'
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

    if (firstApproval && approvalSig !== previous?.approvalSig && !suppressApprovalToast) {
      // Skip the toast when the tab is focused — the composer already flips to
      // an approval card and the pending list is visible, so a right-corner
      // toast is a third copy of the same signal. When the user is away
      // (hidden tab), the toast is what they'll see on return.
      const tabVisible = typeof document !== 'undefined' && document.visibilityState === 'visible'
      if (!tabVisible) {
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
    }

    if (lastError && errorSig !== previous?.errorSig) {
      // Intentionally no in-app toast for the focused session's own error:
      // <SessionErrorBanner> already surfaces it right above the composer, and
      // stacking a right-corner toast on top felt like the same event shouting
      // twice. Non-focused sessions still get a toast via
      // useInactiveSessionSummaryToasts. Desktop notifications (when tab is
      // backgrounded) come from useInterventionDesktopNotifications.
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
    suppressApprovalToast,
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
  // Pending "session finished" toasts, keyed by sessionId. A completion toast is
  // DEBOUNCED (not fired immediately): during a single autonomous turn the kernel
  // status can briefly flip to `done`/`idle` between steps (e.g. a tool-less LLM
  // response, or right before a queued message re-drives the session), then go
  // back to running. Firing on that transient flip produces the false
  // "turn finished / you can step in" notification while the session is actually
  // still working. We hold the completion toast for a short window; if the
  // session goes back to running (or changes) before it elapses, we cancel it.
  const finishTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  useEffect(() => {
    const prev = previous.current
    const next = new Map<string, SessionSummary['status'] | undefined>()

    for (const session of sessions) {
      next.set(session.sessionId, session.status)
      const before = prev.get(session.sessionId)

      // If a completion toast was pending for this session and it is no longer in
      // a terminal-completed state, the earlier `done` was a transient mid-turn
      // flip — cancel the pending toast.
      const pendingFinish = finishTimers.current.get(session.sessionId)
      if (pendingFinish !== undefined) {
        const stillResting = session.status === 'idle' || session.status === 'done'
        const hasQueue = (session.queuedCount ?? 0) > 0
        if (!stillResting || hasQueue) {
          clearTimeout(pendingFinish)
          finishTimers.current.delete(session.sessionId)
        }
      }

      const decision = decideInactiveSummaryNotification({
        previousStatus: before,
        nextStatus: session.status,
        focusedSessionId: activeSessionId,
        eventSessionId: session.sessionId,
        queuedCount: session.queuedCount,
      })
      if (!decision.notify) continue

      const label = sessionSummaryLabel(session)
      if (decision.reason === 'approval_required') {
        // Approval + error are stable, actionable states — fire immediately.
        notify.info(`Approval requested — ${label}`, {
          id: `inactive-session-approval-${session.sessionId}`,
          duration: 8000,
        })
      } else if (decision.reason === 'error') {
        notify.error(`Session failed — ${label}`, {
          id: `inactive-session-error-${session.sessionId}`,
          duration: 10000,
        })
      } else if (decision.reason === 'background_session_completed') {
        // Debounce: only fire if the session is still finished after the window.
        const existing = finishTimers.current.get(session.sessionId)
        if (existing !== undefined) clearTimeout(existing)
        const timer = setTimeout(() => {
          finishTimers.current.delete(session.sessionId)
          notify.success(`Session finished — ${label}`, {
            id: `inactive-session-finished-${session.sessionId}`,
            duration: 6000,
          })
        }, FINISH_NOTIFY_DEBOUNCE_MS)
        finishTimers.current.set(session.sessionId, timer)
      }
    }

    previous.current = next
  }, [activeSessionId, sessions])

  useEffect(() => {
    const timers = finishTimers.current
    return () => {
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
    }
  }, [])
}

/**
 * How long to wait before firing a background "session finished" toast, to ride
 * out transient mid-turn `done`/`idle` flips. Long enough to cover the gap
 * between a turn's terminal status and a queued message re-driving the session,
 * short enough to still feel prompt.
 */
const FINISH_NOTIFY_DEBOUNCE_MS = 1500


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

    const onControlUpdate = (payload: ControlUpdate): void => {
      if (payload.kind === 'sub_agent_started') onStarted(payload)
      if (payload.kind === 'sub_agent_finished') onFinished(payload)
    }

    socket.on('server:control_update', onControlUpdate)
    return () => {
      socket.off('server:control_update', onControlUpdate)
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

function sessionSummaryLabel(session: SessionSummary): string {
  const raw = session.label?.trim() || session.firstUserMessage?.trim() || session.sessionId
  return raw.length <= 48 ? raw : `${raw.slice(0, 45)}...`
}
