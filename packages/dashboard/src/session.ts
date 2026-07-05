/**
 * The single hook that owns a Socket.IO connection to the host's `/dashboard`
 * namespace and mirrors the session's state locally.
 *
 * Everything the UI needs (state, event log, pending approvals, usage) is
 * derived from server events. User actions become socket emits  -  never a
 * local mutation.
 */

import { useEffect, useMemo, useRef, useState } from 'react'

import type {
  AgentConfig,
  AgentEvent,
  AgentState,
  Effect,
} from '@agent-kernel/kernel'
import type {
  ApprovalRequiredEvent,
  AttachedExecutor,
  DashboardClientToServerEvents,
  DashboardServerToClientEvents,
  SessionErrorEvent,
  SessionForkedEvent,
  SessionSummary,
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
  config: AgentConfig | null
  timeline: readonly TimelineEntry[]
  streamingText: string
  pendingApprovals: readonly ApprovalRequiredEvent[]
  queuedMessages: number
  lastError: SessionErrorEvent | null
  parentSessionId: string | null
  parentCursor: number | null
  selectedModel: string | null
  socket: DashboardSocket | null
  /**
   * Optimistically drop a pending approval from the local list, so the card
   * disappears the instant the user clicks approve/reject instead of lingering
   * until a `state:changed` roundtrip. The host will eventually emit
   * `event:appended` for the tool_result  -  that path re-renders unrelated UI
   * and does not re-add the approval, so the local drop is safe.
   */
  dismissApproval(callId: string): void
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
  const [config, setConfig] = useState<AgentConfig | null>(null)
  const [timeline, setTimeline] = useState<readonly TimelineEntry[]>([])
  const [streamingText, setStreamingText] = useState('')
  const [pendingApprovals, setPendingApprovals] = useState<
    readonly ApprovalRequiredEvent[]
  >([])
  const [queuedMessages, setQueuedMessages] = useState(0)
  const [lastError, setLastError] = useState<SessionErrorEvent | null>(null)
  const [parentSessionId, setParentSessionId] = useState<string | null>(null)
  const [parentCursor, setParentCursor] = useState<number | null>(null)
  const [selectedModel, setSelectedModel] = useState<string | null>(null)
  const socketRef = useRef<DashboardSocket | null>(null)
  const onForkedRef = useRef(onForked)
  onForkedRef.current = onForked

  useEffect(() => {
    setStatus('connecting')
    setState(null)
    setConfig(null)
    setTimeline([])
    setStreamingText('')
    setPendingApprovals([])
    setQueuedMessages(0)
    setLastError(null)
    setParentSessionId(null)
    setParentCursor(null)
    setSelectedModel(null)

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
      setConfig(p.config)
      setParentSessionId(p.parentSessionId ?? null)
      setParentCursor(p.parentCursor ?? null)
      setSelectedModel(p.selectedModel ?? null)
      // Timeline was cleared for a fresh connect; ask the host to replay
      // the log so a page reload doesn't leave the user staring at an
      // empty timeline for a session that already has history. Live
      // event:appended events overlapping the tail of history are
      // deduped by seq below.
      socket.emit('client:load_history', { sessionId: p.sessionId })
    })
    socket.on('server:history', (p) => {
      const entries: TimelineEntry[] = p.entries.map((e) => ({
        seq: e.seq,
        ts: e.ts,
        event: e.event,
        effects: e.effects,
      }))
      setTimeline((prev) => mergeByseq(prev, entries))
    })
    socket.on('session:forked', (p) => {
      onForkedRef.current?.(p)
    })
    socket.on('state:changed', (p) => {
      setState(p.state)
      if (p.state.status !== 'thinking') setStreamingText('')
    })
    socket.on('event:appended', (p) => {
      setLastError(null)
      if (p.event.kind === 'llm_response' || p.event.kind === 'llm_error') {
        setStreamingText('')
      }
      setTimeline((prev) =>
        mergeByseq(prev, [
          {
            seq: p.seq,
            ts: p.ts,
            event: p.event,
            effects: p.effects,
          },
        ]),
      )
    })
    socket.on('approval:required', (p) => {
      setPendingApprovals((prev) => [...prev, p])
    })
    socket.on('server:message_queue', (p) => {
      if (p.sessionId === sessionId) setQueuedMessages(p.pending)
    })
    socket.on('session:error', (p) => {
      setStreamingText('')
      setLastError(p)
    })
    socket.on('session:token_delta', (p) => {
      if (p.sessionId === sessionId) setStreamingText((prev) => prev + p.text)
    })
    socket.on('session:model_changed', (p) => {
      if (p.sessionId === sessionId) {
        setSelectedModel(p.model.length > 0 ? p.model : null)
      }
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
      config,
      timeline,
      streamingText,
      pendingApprovals,
      queuedMessages,
      lastError,
      parentSessionId,
      parentCursor,
      selectedModel,
      socket: socketRef.current,
      dismissApproval: (callId: string) =>
        setPendingApprovals((prev) => prev.filter((a) => a.callId !== callId)),
    }),
    [
      status,
      state,
      config,
      timeline,
      streamingText,
      pendingApprovals,
      queuedMessages,
      lastError,
      parentSessionId,
      parentCursor,
      selectedModel,
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

export function deleteSession(
  socket: DashboardSocket,
  sessionId: string,
): void {
  socket.emit('client:delete_session', { sessionId })
}

/**
 * Ask the host to materialise a session on disk bound to `workspaceId`.
 * Emitted when the user clicks "New" so the session shows up in the
 * Explorer immediately and is grouped under the right workspace, instead
 * of appearing in Unassigned after the first message triggers lazy-create.
 */
export function createSession(
  socket: DashboardSocket,
  sessionId: string,
  workspaceId: string,
  workspaceName: string | undefined,
  cwd?: string,
): void {
  socket.emit('client:create_session', {
    sessionId,
    workspaceId,
    ...(workspaceName !== undefined ? { workspaceName } : {}),
    ...(cwd !== undefined && cwd.length > 0 ? { cwd } : {}),
  })
}

export function setSessionModel(
  socket: DashboardSocket,
  sessionId: string,
  model: string,
): void {
  socket.emit('client:set_model', { sessionId, model })
}

export function setSessionApprovalMode(
  socket: DashboardSocket,
  sessionId: string,
  mode: import('@agent-kernel/kernel').ApprovalMode,
): void {
  socket.emit('client:set_approval_mode', { sessionId, mode })
}

export type ControlPlaneView = {
  executors: readonly AttachedExecutor[]
  sessions: readonly SessionSummary[]
  refreshSessions(): void
}

/**
 * Subscribes to the host's control-plane events (executors / sessions) using
 * an already-open dashboard socket. Fetches an initial snapshot on socket
 * change and keeps the daemon list live via `server:executor_changed`.
 *
 * Sessions are pulled on `refreshSessions()`  -  we don't yet get a live
 * push for them (v1 keeps the wire small), so the UI polls on load and
 * after actions that mutate the on-disk set (fork completion, initial
 * connect). This is cheap because it's a single read per call.
 */
export function useControlPlane(
  socket: DashboardSocket | null,
): ControlPlaneView {
  const [executors, setExecutors] = useState<readonly AttachedExecutor[]>([])
  const [sessions, setSessions] = useState<readonly SessionSummary[]>([])

  useEffect(() => {
    if (!socket) {
      setExecutors([])
      setSessions([])
      return
    }
    const onExecutors = (p: { executors: readonly AttachedExecutor[] }): void => {
      setExecutors(p.executors)
    }
    const onSessions = (p: { sessions: readonly SessionSummary[] }): void => {
      setSessions(p.sessions)
    }
    const onExecutorChanged: DashboardServerToClientEvents['server:executor_changed'] = (
      change,
    ) => {
      setExecutors((prev) => {
        if (change.change === 'detached') {
          return prev.filter((e) => e.executorId !== change.executorId)
        }
        const next = prev.filter((e) => e.executorId !== change.executorId)
        next.push(change.executor)
        return next
      })
    }
    socket.on('server:executors', onExecutors)
    socket.on('server:sessions', onSessions)
    socket.on('server:executor_changed', onExecutorChanged)
    const onSessionDeleted: DashboardServerToClientEvents['server:session_deleted'] = (
      payload,
    ) => {
      setSessions((prev) => prev.filter((s) => s.sessionId !== payload.sessionId))
    }
    socket.on('server:session_deleted', onSessionDeleted)

    const requestBoth = (): void => {
      socket.emit('client:list_executors', {})
      socket.emit('client:list_sessions', {})
    }
    if (socket.connected) requestBoth()
    socket.on('connect', requestBoth)

    return () => {
      socket.off('server:executors', onExecutors)
      socket.off('server:sessions', onSessions)
      socket.off('server:executor_changed', onExecutorChanged)
      socket.off('server:session_deleted', onSessionDeleted)
      socket.off('connect', requestBoth)
    }
  }, [socket])

  const refreshSessions = useMemo(
    () => () => {
      if (socket && socket.connected) socket.emit('client:list_sessions', {})
    },
    [socket],
  )

  return { executors, sessions, refreshSessions }
}

function mergeByseq(
  prev: readonly TimelineEntry[],
  add: readonly TimelineEntry[],
): readonly TimelineEntry[] {
  if (add.length === 0) return prev
  const map = new Map<number, TimelineEntry>()
  for (const e of prev) map.set(e.seq, e)
  for (const e of add) map.set(e.seq, e)
  const out = [...map.values()]
  out.sort((a, b) => a.seq - b.seq)
  return out
}
