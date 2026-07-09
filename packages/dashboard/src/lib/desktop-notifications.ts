import { useEffect, useMemo, useRef } from 'react'

import type { ApprovalRequiredEvent, SessionErrorEvent } from '@agent-kernel/shared'

import { DASHBOARD_PREFERENCES, useBooleanPref } from './prefs.js'

export type DesktopNotificationKind =
  | 'approval_required'
  | 'waiting_for_user'
  | 'session_error'
  | 'connection_lost'
  | 'workspace_offline'

export const PREF_DESKTOP_NOTIFICATIONS_ENABLED = DASHBOARD_PREFERENCES.desktopNotificationsEnabled.key
export const PREF_DESKTOP_NOTIFICATION_APPROVAL = DASHBOARD_PREFERENCES.desktopNotificationApproval.key
export const PREF_DESKTOP_NOTIFICATION_WAITING = DASHBOARD_PREFERENCES.desktopNotificationWaiting.key
export const PREF_DESKTOP_NOTIFICATION_ERROR = DASHBOARD_PREFERENCES.desktopNotificationError.key
export const PREF_DESKTOP_NOTIFICATION_CONNECTION = DASHBOARD_PREFERENCES.desktopNotificationConnection.key
export const PREF_DESKTOP_NOTIFICATION_WORKSPACE = DASHBOARD_PREFERENCES.desktopNotificationWorkspace.key
export const PREF_DESKTOP_NOTIFICATION_SOUND = DASHBOARD_PREFERENCES.desktopNotificationSound.key

export const DESKTOP_NOTIFICATION_PREFS: ReadonlyArray<{
  kind: DesktopNotificationKind
  key: string
  label: string
  description: string
}> = [
  {
    kind: 'approval_required',
    key: PREF_DESKTOP_NOTIFICATION_APPROVAL,
    label: 'Approval required',
    description: 'A tool call is waiting for approve/reject.',
  },
  {
    kind: 'waiting_for_user',
    key: PREF_DESKTOP_NOTIFICATION_WAITING,
    label: 'Waiting for you',
    description: 'The active turn finished and the session is ready for your next input.',
  },
  {
    kind: 'session_error',
    key: PREF_DESKTOP_NOTIFICATION_ERROR,
    label: 'Session error',
    description: 'The active session reports an execution or protocol error.',
  },
  {
    kind: 'connection_lost',
    key: PREF_DESKTOP_NOTIFICATION_CONNECTION,
    label: 'Host disconnected',
    description: 'The dashboard loses its host websocket connection.',
  },
  {
    kind: 'workspace_offline',
    key: PREF_DESKTOP_NOTIFICATION_WORKSPACE,
    label: 'Workspace offline',
    description: 'The active session needs an executor that is no longer attached.',
  },
]

export type DesktopNotificationPrefs = {
  enabled: boolean
  sound: boolean
  byKind: Record<DesktopNotificationKind, boolean>
}

export function notificationPermission(): NotificationPermission | 'unsupported' {
  const NotificationCtor = window.Notification
  if (typeof NotificationCtor !== 'function') return 'unsupported'
  return NotificationCtor.permission
}

export async function requestNotificationPermission(): Promise<NotificationPermission | 'unsupported'> {
  const NotificationCtor = window.Notification
  if (typeof NotificationCtor !== 'function') return 'unsupported'
  return await NotificationCtor.requestPermission()
}

export function playNotificationSound(): boolean {
  const AudioContextCtor = window.AudioContext
    ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (typeof AudioContextCtor !== 'function') return false

  try {
    const ctx = new AudioContextCtor()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    const now = ctx.currentTime

    osc.type = 'sine'
    osc.frequency.setValueAtTime(880, now)
    gain.gain.setValueAtTime(0.0001, now)
    gain.gain.exponentialRampToValueAtTime(0.08, now + 0.015)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18)
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.start(now)
    osc.stop(now + 0.2)
    osc.onended = () => {
      void ctx.close().catch(() => {})
    }
    return true
  } catch {
    return false
  }
}

export function useDesktopNotificationPrefs(): DesktopNotificationPrefs {
  const [enabled] = useBooleanPref(PREF_DESKTOP_NOTIFICATIONS_ENABLED, false)
  const [sound] = useBooleanPref(PREF_DESKTOP_NOTIFICATION_SOUND, true)
  const [approval] = useBooleanPref(PREF_DESKTOP_NOTIFICATION_APPROVAL, true)
  const [waiting] = useBooleanPref(PREF_DESKTOP_NOTIFICATION_WAITING, true)
  const [error] = useBooleanPref(PREF_DESKTOP_NOTIFICATION_ERROR, true)
  const [connection] = useBooleanPref(PREF_DESKTOP_NOTIFICATION_CONNECTION, true)
  const [workspace] = useBooleanPref(PREF_DESKTOP_NOTIFICATION_WORKSPACE, true)

  return useMemo(
    () => ({
      enabled,
      sound,
      byKind: {
        approval_required: approval,
        waiting_for_user: waiting,
        session_error: error,
        connection_lost: connection,
        workspace_offline: workspace,
      },
    }),
    [approval, connection, enabled, error, sound, waiting, workspace],
  )
}

export function canSendDesktopNotification(
  prefs: DesktopNotificationPrefs,
  kind: DesktopNotificationKind,
): boolean {
  return prefs.enabled && prefs.byKind[kind] && notificationPermission() === 'granted'
}

export function sendDesktopNotification(
  prefs: DesktopNotificationPrefs,
  kind: DesktopNotificationKind,
  title: string,
  options?: NotificationOptions,
): boolean {
  if (!canSendDesktopNotification(prefs, kind)) return false
  const notification = new window.Notification(title, {
    tag: `agent-kernel-${kind}`,
    ...options,
  })
  notification.onclick = () => {
    window.focus()
    notification.close()
  }
  if (prefs.sound) playNotificationSound()
  return true
}

function isDashboardTabFocused(): boolean {
  return document.visibilityState === 'visible' && document.hasFocus()
}

function notifyWaitingForUser(prefs: DesktopNotificationPrefs, sessionLabel: string): void {
  if (!prefs.byKind.waiting_for_user) return
  if (isDashboardTabFocused()) {
    if (prefs.sound) playNotificationSound()
    return
  }
  sendDesktopNotification(prefs, 'waiting_for_user', 'Waiting for you', {
    body: `${sessionLabel}: ready for your next message`,
  })
}

export function useInterventionDesktopNotifications({
  sessionId,
  sessionLabel,
  pendingApprovalsCount,
  pendingApprovalSummary,
  waitingForUser,
  lastError,
  connectionStatus,
  workspaceOnline,
  workspaceLabel,
  suppressWaitingForUser,
  approvalMode,
  ready = true,
}: {
  sessionId: string | null
  sessionLabel: string
  pendingApprovalsCount: number
  pendingApprovalSummary?: Pick<ApprovalRequiredEvent, 'callId' | 'name'>
  waitingForUser: boolean
  lastError: SessionErrorEvent | null
  connectionStatus: string
  workspaceOnline: boolean | null
  workspaceLabel?: string
  suppressWaitingForUser?: boolean
  /**
   * When `'allow_all'`, suppress the "Approval required" desktop
   * notification — the kernel auto-dispatches these calls, so any pending
   * ones the client observes are transient or pre-mode-switch leftovers,
   * neither of which the user should be pinged about.
   */
  approvalMode?: string
  ready?: boolean
}): void {
  const prefs = useDesktopNotificationPrefs()
  const approvalSig = pendingApprovalSummary
    ? `${sessionId}:${pendingApprovalSummary.callId}:${pendingApprovalsCount}`
    : `${sessionId}:none`
  const errorSig = lastError
    ? `${sessionId}:${lastError.scope}:${lastError.message}`
    : `${sessionId}:none`
  const previous = useRef<{
    sessionId: string | null
    approvalSig: string
    waitingForUser: boolean
    errorSig: string
    connectionStatus: string
    workspaceOnline: boolean | null
  } | null>(null)

  useEffect(() => {
    const prev = previous.current
    if (!ready || sessionId === null) {
      previous.current = null
      return
    }
    previous.current = {
      sessionId,
      approvalSig,
      waitingForUser,
      errorSig,
      connectionStatus,
      workspaceOnline,
    }
    if (prev?.sessionId !== sessionId) return

    if (pendingApprovalsCount > 0 && approvalSig !== prev?.approvalSig && approvalMode !== 'allow_all') {
      const tool = pendingApprovalSummary?.name ?? 'tool call'
      sendDesktopNotification(prefs, 'approval_required', 'Approval required', {
        body: `${sessionLabel}: ${tool}${pendingApprovalsCount > 1 ? ` and ${pendingApprovalsCount - 1} more` : ''}`,
      })
    }

    if (waitingForUser && prev?.waitingForUser === false && !suppressWaitingForUser) {
      notifyWaitingForUser(prefs, sessionLabel)
    }

    if (lastError && errorSig !== prev?.errorSig) {
      sendDesktopNotification(prefs, 'session_error', 'Session error', {
        body: `${sessionLabel}: ${lastError.message}`,
      })
    }

    const connectionLost = connectionStatus === 'disconnected' || connectionStatus === 'error'
    const previousLost = prev?.connectionStatus === 'disconnected' || prev?.connectionStatus === 'error'
    if (connectionLost && !previousLost) {
      sendDesktopNotification(prefs, 'connection_lost', 'Host disconnected', {
        body: `${sessionLabel}: dashboard connection is ${connectionStatus}`,
      })
    }

    if (workspaceOnline === false && prev?.workspaceOnline !== false) {
      sendDesktopNotification(prefs, 'workspace_offline', 'Workspace offline', {
        body: workspaceLabel
          ? `${sessionLabel}: ${workspaceLabel} is offline`
          : `${sessionLabel}: active workspace is offline`,
      })
    }
  }, [
    approvalSig,
    approvalMode,
    connectionStatus,
    errorSig,
    lastError,
    pendingApprovalSummary?.name,
    pendingApprovalsCount,
    prefs,
    sessionLabel,
    sessionId,
    suppressWaitingForUser,
    ready,
    waitingForUser,
    workspaceLabel,
    workspaceOnline,
  ])
}
