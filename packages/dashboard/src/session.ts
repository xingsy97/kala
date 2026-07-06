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
  QueuedMessagePreview,
  SessionErrorEvent,
  SessionForkedEvent,
  SessionSummary,
  LLMTrace,
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
  llmTrace?: LLMTrace
  model?: string
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
  /**
   * Derived from `state.pendingCalls` (status='awaiting_approval'), NOT from
   * the transient `approval:required` socket emit. That emit fires once per
   * request and disappears after a page reload, but `state.pendingCalls`
   * survives every reconnect. Deriving from state guarantees "banner says
   * awaiting approval" and "some ToolCallCard shows Approve/Reject" never
   * disagree  -  they read the same source.
   */
  pendingApprovals: readonly ApprovalRequiredEvent[]
  queuedMessages: readonly QueuedMessagePreview[]
  lastError: SessionErrorEvent | null
  parentSessionId: string | null
  parentCursor: number | null
  selectedModel: string | null
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
  const [config, setConfig] = useState<AgentConfig | null>(null)
  const [timeline, setTimeline] = useState<readonly TimelineEntry[]>([])
  const [streamingText, setStreamingText] = useState('')
  const [queuedMessages, setQueuedMessages] = useState<readonly QueuedMessagePreview[]>([])
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
    setQueuedMessages([])
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
    const isCurrentSocket = (): boolean => socketRef.current === socket

    socket.on('session:ready', (p) => {
      if (!isCurrentSocket() || p.sessionId !== sessionId) return
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
      if (!isCurrentSocket() || p.sessionId !== sessionId) return
      const entries: TimelineEntry[] = p.entries.map((e) => ({
        seq: e.seq,
        ts: e.ts,
        event: e.event,
        effects: e.effects,
        ...(e.llmTrace ? { llmTrace: e.llmTrace } : {}),
        ...(e.model ? { model: e.model } : {}),
      }))
      setTimeline((prev) => mergeBySeq(prev, entries))
    })
    socket.on('session:forked', (p) => {
      if (!isCurrentSocket()) return
      onForkedRef.current?.(p)
    })
    socket.on('state:changed', (p) => {
      if (!isCurrentSocket() || p.sessionId !== sessionId) return
      setState(p.state)
      if (p.state.status !== 'thinking') setStreamingText('')
    })
    socket.on('event:appended', (p) => {
      if (!isCurrentSocket() || p.sessionId !== sessionId) return
      setLastError(null)
      if (p.event.kind === 'llm_response' || p.event.kind === 'llm_error') {
        setStreamingText('')
      }
      setTimeline((prev) =>
        mergeBySeq(prev, [
          {
            seq: p.seq,
            ts: p.ts,
            event: p.event,
            effects: p.effects,
            ...(p.llmTrace ? { llmTrace: p.llmTrace } : {}),
            ...(p.model ? { model: p.model } : {}),
          },
        ]),
      )
    })
    socket.on('approval:required', () => {
      // Best-effort: the reducer's next state:changed already carries the
      // authoritative pendingCalls list, so the derived pendingApprovals
      // updates from that. This handler is left as a hook point for
      // logging/telemetry  -  it must NOT maintain its own list, or the
      // banner-vs-card mismatch across reloads comes back.
    })
    socket.on('server:message_queue', (p) => {
      if (!isCurrentSocket()) return
      if (p.sessionId === sessionId) setQueuedMessages(p.items ?? [])
    })
    socket.on('session:error', (p) => {
      if (!isCurrentSocket() || p.sessionId !== sessionId) return
      setStreamingText('')
      setLastError(p)
    })
    socket.on('session:token_delta', (p) => {
      if (!isCurrentSocket()) return
      if (p.sessionId === sessionId) setStreamingText((prev) => prev + p.text)
    })
    socket.on('session:model_changed', (p) => {
      if (!isCurrentSocket()) return
      if (p.sessionId === sessionId) {
        setSelectedModel(p.model.length > 0 ? p.model : null)
      }
    })
    socket.on('connect_error', () => {
      if (!isCurrentSocket()) return
      setStatus('error')
    })
    socket.on('disconnect', () => {
      if (!isCurrentSocket()) return
      setStatus('disconnected')
    })

    return () => {
      socket.close()
      socketRef.current = null
    }
  }, [host, sessionId, token])

  const pendingApprovals = useMemo<readonly ApprovalRequiredEvent[]>(() => {
    if (!state) return []
    return state.pendingCalls
      .filter((c) => c.status === 'awaiting_approval')
      .map((c) => ({
        sessionId,
        callId: c.callId,
        name: c.name,
        input: c.input,
      }))
  }, [state, sessionId])

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

export function reorderQueuedMessage(
  socket: DashboardSocket,
  sessionId: string,
  id: string,
  beforeId?: string | null,
): void {
  socket.emit('client:reorder_queued_message', {
    sessionId,
    id,
    ...(beforeId !== undefined ? { beforeId } : {}),
  })
}

export function updateQueuedMessage(
  socket: DashboardSocket,
  sessionId: string,
  id: string,
  text: string,
): void {
  socket.emit('client:update_queued_message', { sessionId, id, text })
}

export function deleteQueuedMessage(
  socket: DashboardSocket,
  sessionId: string,
  id: string,
): void {
  socket.emit('client:delete_queued_message', { sessionId, id })
}

export function renameSession(
  socket: DashboardSocket,
  sessionId: string,
  label: string,
): void {
  socket.emit('client:rename_session', { sessionId, label })
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
    let active = true
    const isActive = (): boolean => active
    const onExecutors = (p: { executors: readonly AttachedExecutor[] }): void => {
      if (!isActive()) return
      setExecutors(p.executors)
    }
    const onSessions = (p: { sessions: readonly SessionSummary[] }): void => {
      if (!isActive()) return
      setSessions(p.sessions)
    }
    const onExecutorChanged: DashboardServerToClientEvents['server:executor_changed'] = (
      change,
    ) => {
      if (!isActive()) return
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
      if (!isActive()) return
      setSessions((prev) => prev.filter((s) => s.sessionId !== payload.sessionId))
    }
    socket.on('server:session_deleted', onSessionDeleted)

    const requestBoth = (): void => {
      if (!isActive()) return
      socket.emit('client:list_executors', {})
      socket.emit('client:list_sessions', {})
    }
    if (socket.connected) requestBoth()
    socket.on('connect', requestBoth)

    return () => {
      active = false
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

export function mergeBySeq(
  prev: readonly TimelineEntry[],
  add: readonly TimelineEntry[],
): readonly TimelineEntry[] {
  if (add.length === 0) return prev
  const map = new Map<number, TimelineEntry>()
  for (const e of prev) map.set(e.seq, e)
  for (const e of add) {
    const existing = map.get(e.seq)
    if (!existing) {
      map.set(e.seq, e)
      continue
    }
    if (sameTimelineEvent(existing, e)) map.set(e.seq, { ...existing, ...e })
  }
  const out = [...map.values()]
  out.sort((a, b) => a.seq - b.seq)
  return out
}

function sameTimelineEvent(a: TimelineEntry, b: TimelineEntry): boolean {
  if (a.event.kind !== b.event.kind) return false
  if ('callId' in a.event || 'callId' in b.event) {
    return 'callId' in a.event && 'callId' in b.event && a.event.callId === b.event.callId
  }
  return true
}
