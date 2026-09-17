import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { SessionSummary } from '@agent-kernel/shared'
import type { DashboardSocket } from '../session.js'
import { DesktopActivityTracker, type DesktopSessionSignal } from '../domain/desktop-activity.js'
import { notify } from '../notify.js'
import { useDesktopNotificationPrefs } from './desktop-notifications.js'
import { subscribeDesktopSessionOpen, useDesktopBridge, validDesktopSessionId } from './desktop-bridge.js'
import { DASHBOARD_PREFERENCES, useBooleanPref } from './prefs.js'
import { randomId } from './random-id.js'
import { DesktopSubagentClassifier } from './desktop-subagents.js'

export function useNativeDesktop(input: {
  sessions: readonly SessionSummary[]
  activeSessionId: string | null
  /** Null when Docs, Operations, account/settings overlays, etc. cover the chat. */
  viewedSessionId: string | null
  socket: DashboardSocket | null
  ready: boolean
  workspaceOnline: boolean | null
  onOpenSession(sessionId: string): void
}): void {
  const { t } = useTranslation()
  const native = useDesktopBridge()
  const prefs = useDesktopNotificationPrefs()
  const [showDetails] = useBooleanPref(DASHBOARD_PREFERENCES.desktopNotificationDetails.key, false)
  const [connected, setConnected] = useState(input.socket?.connected ?? false)
  const [clock, tick] = useState(0)
  const tracker = useRef(new DesktopActivityTracker())
  const latest = useRef(input)
  latest.current = input
  const priorConnection = useRef<boolean | null>(null)
  const priorWorkspace = useRef<boolean | null>(null)
  const activitySignature = useRef('')
  const reportedFailures = useRef(new Set<string>())
  const delivered = useRef(new Set<string>())
  const readyAfterConnect = useRef(false)
  const connectionConfirmed = useRef(false)
  const pendingOpenSession = useRef<string | null>(null)
  const [openRevision, setOpenRevision] = useState(0)
  const classifier = useRef<DesktopSubagentClassifier | null>(null)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const fail = useCallback((reason: unknown): void => {
    const detail = reason instanceof Error ? reason.message : String(reason)
    if (reportedFailures.current.has(detail)) return
    reportedFailures.current.add(detail)
    console.error('Native desktop integration failed:', detail)
    notify.error(t('desktopNative.failure', { detail }), { id: 'native-desktop-failure' })
  }, [t])

  useEffect(() => { if (native.error) fail(native.error) }, [native.error, fail])

  useEffect(() => {
    if (!native.bridge || !input.socket) return
    const socket = input.socket
    const current = new DesktopSubagentClassifier(
      (parentSessionId) => socket.timeout(5000).emitWithAck('sub_agent:list', { requestId: randomId(), parentSessionId }),
      () => { if (alive.current) tick((value) => value + 1) },
      fail,
    )
    classifier.current = current
    return () => { current.dispose(); if (classifier.current === current) classifier.current = null }
  }, [native.bridge, input.socket, fail])

  useEffect(() => {
    if (!native.bridge || !input.socket) return
    const socket = input.socket
    const connect = () => { readyAfterConnect.current = false; connectionConfirmed.current = false; classifier.current?.reset(); setConnected(true); activitySignature.current = '' }
    const disconnect = () => { readyAfterConnect.current = false; connectionConfirmed.current = false; classifier.current?.reset(); setConnected(false) }
    const snapshot = () => { readyAfterConnect.current = true; tick((value) => value + 1) }
    // The first mount may follow the initial summary snapshot.
    readyAfterConnect.current = input.ready && socket.connected
    connectionConfirmed.current = false
    setConnected(socket.connected)
    socket.on('connect', connect)
    socket.on('disconnect', disconnect)
    socket.on('server:sessions', snapshot)
    return () => { socket.off('connect', connect); socket.off('disconnect', disconnect); socket.off('server:sessions', snapshot) }
  }, [input.socket, native.bridge])

  useEffect(() => {
    const bridge = native.bridge
    if (typeof bridge?.confirmConnection !== 'function' || !input.ready || !connected || !readyAfterConnect.current || connectionConfirmed.current) return
    connectionConfirmed.current = true
    void bridge.confirmConnection().catch(fail)
  }, [native.bridge, input.socket, input.ready, connected, clock, fail])

  useEffect(() => {
    const bridge = native.bridge
    if (!bridge) return
    return subscribeDesktopSessionOpen(bridge, (sessionId) => {
      pendingOpenSession.current = sessionId
      setOpenRevision((value) => value + 1)
    })
  }, [native.bridge])

  useEffect(() => {
    const sessionId = pendingOpenSession.current
    if (!sessionId || !input.ready || !connected || !readyAfterConnect.current) return
    pendingOpenSession.current = null
    if (input.sessions.some((session) => session.sessionId === sessionId)) latest.current.onOpenSession(sessionId)
    else notify.error(t('desktopNative.sessionUnavailable'), { id: 'native-session-unavailable' })
  }, [input.ready, input.sessions, connected, clock, openRevision, t])

  useEffect(() => {
    if (!native.bridge || !input.socket || !input.ready || !connected || !readyAfterConnect.current) return
    classifier.current?.update(input.sessions)
  }, [native.bridge, input.socket, input.sessions, input.ready, connected, clock, fail])

  useEffect(() => {
    const bridge = native.bridge
    if (!bridge || !native.info) return
    const send = (signal: DesktopSessionSignal): void => {
      if (!prefs.enabled || !prefs.byKind[signal.kind] || delivered.current.has(signal.id)) return
      if (native.info?.notificationsAvailable === false) { fail(t('desktopNative.notificationsUnavailable')); return }
      if (!validDesktopSessionId(signal.session.sessionId)) return
      delivered.current.add(signal.id)
      if (delivered.current.size > 2048) delivered.current.delete(delivered.current.values().next().value!)
      void bridge.notify({
        id: signal.id, sessionId: signal.session.sessionId, title: 'Agent RunLab',
        body: showDetails
          ? t(`desktopNative.${signal.kind}`, { session: (signal.session.label?.trim() || signal.session.firstUserMessage?.trim() || signal.session.sessionId).slice(0, 80) })
          : t(`desktopNative.generic.${signal.kind}`),
        silent: !prefs.sound,
      }).catch(fail)
    }
    const ready = input.ready && connected && readyAfterConnect.current
    const classification = classifier.current?.snapshot
    const result = tracker.current.update({ ...input, activeSessionId: input.viewedSessionId, subAgentSessionIds: classification?.subagents, unresolvedSessionIds: classification?.unresolved, focused: native.info.focused, visible: native.info.visible, ready, now: Date.now() })
    for (const signal of result.signals) send(signal)
    const signature = JSON.stringify(result.activity)
    if (signature !== activitySignature.current) {
      activitySignature.current = signature
      void bridge.setActivity(result.activity).catch(fail)
    }
    const active = input.sessions.find((session) => session.sessionId === input.activeSessionId)
    if (active && !(native.info.focused && native.info.visible)) {
      const kinds = [
        [priorConnection.current === true && !connected, 'connection_lost'],
        [priorWorkspace.current === true && input.workspaceOnline === false, 'workspace_offline'],
      ] as const
      for (const [changed, kind] of kinds) {
        if (changed && prefs.enabled && prefs.byKind[kind]) {
          void bridge.notify({ id: `${kind}:${Date.now()}`, sessionId: active.sessionId, title: 'Agent RunLab', body: t(`desktopNative.generic.${kind}`), silent: !prefs.sound }).catch(fail)
        }
      }
    }
    priorConnection.current = connected
    priorWorkspace.current = input.workspaceOnline
    const deadline = tracker.current.nextDeadline
    const timer = deadline !== null ? setTimeout(() => tick((value) => value + 1), Math.max(0, deadline - Date.now())) : undefined
    return () => { if (timer !== undefined) clearTimeout(timer) }
  }, [native.bridge, native.info, input.sessions, input.activeSessionId, input.viewedSessionId, input.ready, input.workspaceOnline, connected, prefs, showDetails, t, clock, fail])
}
