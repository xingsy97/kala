/**
 * The single hook that owns a Socket.IO connection to the host's `/dashboard`
 * namespace and mirrors the session's state locally.
 *
 * Everything the UI needs (state, event log, pending approvals, usage) is
 * derived from server events. User actions become socket emits — never a
 * local mutation.
 */

import { useEffect, useMemo, useRef, useState } from 'react'

import type {
  AgentEvent,
  AgentState,
  Effect,
} from '@agent-kernel/kernel'
import type {
  ApprovalRequiredEvent,
  DashboardClientToServerEvents,
  DashboardServerToClientEvents,
  SessionErrorEvent,
  SessionForkedEvent,
} from '@agent-kernel/shared'
import { io, type Socket } from 'socket.io-client'

export type DashboardSocket = Socket<
  DashboardServerToClientEvents,
  DashboardClientToServerEvents
>

export type TimelineEntry = {
  seq: number
  ts: string
  event: AgentEvent
  effects: readonly Effect[]
}

export type ConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'ready'
  | 'error'
  | 'disconnected'

export type SessionView = {
  status: ConnectionStatus
  state: AgentState | null
  timeline: readonly TimelineEntry[]
  pendingApprovals: readonly ApprovalRequiredEvent[]
  lastError: SessionErrorEvent | null
  parentSessionId: string | null
  parentCursor: number | null
  socket: DashboardSocket | null
}

export type UseSessionOptions = {
  host: string
  sessionId: string
  token?: string
  onForked?: (payload: SessionForkedEvent) => void
}

export function useSession({
  host,
  sessionId,
  token,
  onForked,
}: UseSessionOptions): SessionView {
  const [status, setStatus] = useState<ConnectionStatus>('idle')
  const [state, setState] = useState<AgentState | null>(null)
  const [timeline, setTimeline] = useState<readonly TimelineEntry[]>([])
  const [pendingApprovals, setPendingApprovals] = useState<
    readonly ApprovalRequiredEvent[]
  >([])
  const [lastError, setLastError] = useState<SessionErrorEvent | null>(null)
  const [parentSessionId, setParentSessionId] = useState<string | null>(null)
  const [parentCursor, setParentCursor] = useState<number | null>(null)
  const socketRef = useRef<DashboardSocket | null>(null)
  const onForkedRef = useRef(onForked)
  onForkedRef.current = onForked

  useEffect(() => {
    setStatus('connecting')
    setState(null)
    setTimeline([])
    setPendingApprovals([])
    setLastError(null)
    setParentSessionId(null)
    setParentCursor(null)

    const socket = io(`${host}/dashboard`, {
      transports: ['websocket'],
      auth: {
        sessionId,
        role: 'dashboard',
        clientVersion: '0.0.0',
        ...(token !== undefined ? { token } : {}),
      },
      reconnection: true,
      reconnectionDelay: 500,
    }) as DashboardSocket
    socketRef.current = socket

    socket.on('session:ready', (p) => {
      setStatus('ready')
      setState(p.state)
      setParentSessionId(p.parentSessionId ?? null)
      setParentCursor(p.parentCursor ?? null)
    })
    socket.on('session:forked', (p) => {
      onForkedRef.current?.(p)
    })
    socket.on('state:changed', (p) => {
      setState(p.state)
    })
    socket.on('event:appended', (p) => {
      setTimeline((prev) => [
        ...prev,
        {
          seq: p.seq,
          ts: p.ts,
          event: p.event,
          effects: p.effects,
        },
      ])
    })
    socket.on('approval:required', (p) => {
      setPendingApprovals((prev) => [...prev, p])
    })
    socket.on('session:error', (p) => {
      setLastError(p)
    })
    socket.on('connect_error', () => {
      setStatus('error')
    })
    socket.on('disconnect', () => {
      setStatus('disconnected')
    })

    return () => {
      socket.close()
      socketRef.current = null
    }
  }, [host, sessionId, token])

  return useMemo(
    () => ({
      status,
      state,
      timeline,
      pendingApprovals,
      lastError,
      parentSessionId,
      parentCursor,
      socket: socketRef.current,
    }),
    [
      status,
      state,
      timeline,
      pendingApprovals,
      lastError,
      parentSessionId,
      parentCursor,
    ],
  )
}

export function respondApproval(
  socket: DashboardSocket,
  sessionId: string,
  callId: string,
  decision: 'approve' | 'reject',
  reason?: string,
): void {
  if (decision === 'approve') {
    socket.emit('client:user_approve', { sessionId, callId })
  } else {
    socket.emit('client:user_reject', {
      sessionId,
      callId,
      ...(reason !== undefined ? { reason } : {}),
    })
  }
}
