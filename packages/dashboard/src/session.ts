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
  SessionReadyEvent,
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
   * disagree — they read the same source.
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
  // Streaming smoother: token_delta events land in `streamBufferRef`, and a
  // requestAnimationFrame loop drains a chunk per frame into React state. This
  // collapses 60-100 setState calls/sec into ~60 frames/sec AND paces bursty
  // deltas into a smoother visual flow. Backlog >~200 chars triggers a catch-up.
  const streamBufferRef = useRef('')
  const streamRafRef = useRef<number | null>(null)
  const onForkedRef = useRef(onForked)
  onForkedRef.current = onForked

  useEffect(() => {
    setStatus('connecting')
    setState(null)
    setConfig(null)
    setTimeline([])
    setStreamingText('')
    streamBufferRef.current = ''
    if (streamRafRef.current !== null) {
      cancelAnimationFrame(streamRafRef.current)
      streamRafRef.current = null
    }
    setQueuedMessages([])
    setLastError(null)
    setParentSessionId(null)
    setParentCursor(null)
    setSelectedModel(null)

    const drainStreamBuffer = (): void => {
      const buf = streamBufferRef.current
      if (buf.length === 0) {
        streamRafRef.current = null
        return
      }
      // Adaptive rate: 1-2 chars per frame when idle-ish; 10% of backlog when
      // catching up so we don't fall arbitrarily behind on long bursts. Cap by
      // buffer length so we never read past the end.
      const chunkSize = Math.min(
        buf.length,
        Math.max(2, Math.ceil(buf.length / 10)),
      )
      const chunk = buf.slice(0, chunkSize)
      streamBufferRef.current = buf.slice(chunkSize)
      setStreamingText((prev) => prev + chunk)
      streamRafRef.current = requestAnimationFrame(drainStreamBuffer)
    }

    const pushStreamDelta = (text: string): void => {
      streamBufferRef.current += text
      if (streamRafRef.current === null) {
        streamRafRef.current = requestAnimationFrame(drainStreamBuffer)
      }
    }

    const resetStream = (): void => {
      streamBufferRef.current = ''
      if (streamRafRef.current !== null) {
        cancelAnimationFrame(streamRafRef.current)
        streamRafRef.current = null
      }
      setStreamingText('')
    }

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
      if (p.state.status !== 'thinking') resetStream()
    })
    socket.on('event:appended', (p) => {
      if (!isCurrentSocket() || p.sessionId !== sessionId) return
      setLastError(null)
      if (p.event.kind === 'llm_response' || p.event.kind === 'llm_error') {
        resetStream()
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
      // logging/telemetry — it must NOT maintain its own list, or the
      // banner-vs-card mismatch across reloads comes back.
    })
    socket.on('server:message_queue', (p) => {
      if (!isCurrentSocket()) return
      if (p.sessionId === sessionId) setQueuedMessages(p.items ?? [])
    })
    socket.on('session:error', (p) => {
      if (!isCurrentSocket() || p.sessionId !== sessionId) return
      resetStream()
      setLastError(p)
    })
    socket.on('session:token_delta', (p) => {
      if (!isCurrentSocket()) return
      if (p.sessionId === sessionId) pushStreamDelta(p.text)
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
      if (streamRafRef.current !== null) {
        cancelAnimationFrame(streamRafRef.current)
        streamRafRef.current = null
      }
      streamBufferRef.current = ''
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
 * Interrupt the current turn: dispatches a `cancel` event through the FSM so
 * pendingCalls are cleared and the executor is told to stop. This is stronger
 * than `client:cancel_stream`, which only aborts the in-flight HTTP call and
 * lets whatever was streamed become the final assistant message. Use this
 * when the user actually wants to stop the agent, not just cut the stream.
 */
export function cancelSession(
  socket: DashboardSocket,
  sessionId: string,
): void {
  socket.emit('client:cancel', { sessionId })
}

export function clearSession(
  socket: DashboardSocket,
  sessionId: string,
): void {
  socket.emit('client:clear', { sessionId })
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

export function createSessionWithAck(
  socket: DashboardSocket,
  sessionId: string,
  workspaceId: string,
  workspaceName: string | undefined,
  cwd: string | undefined,
  timeoutMs = 10_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      window.clearTimeout(timer)
      socket.off('session:ready', onReady)
      socket.off('session:error', onError)
    }
    const onReady = (payload: SessionReadyEvent): void => {
      if (payload.sessionId !== sessionId) return
      cleanup()
      resolve()
    }
    const onError = (payload: SessionErrorEvent): void => {
      if (payload.sessionId !== sessionId) return
      cleanup()
      reject(new Error(payload.message))
    }
    const timer = window.setTimeout(() => {
      cleanup()
      reject(new Error('session creation timed out'))
    }, timeoutMs)
    socket.on('session:ready', onReady)
    socket.on('session:error', onError)
    createSession(socket, sessionId, workspaceId, workspaceName, cwd)
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
 * Sessions are fetched on connect and on `refreshSessions()`, and then kept
 * coherent by host pushes such as `server:sessions` and
 * `server:session_deleted`. The App still treats the snapshot as advisory and
 * validates navigation targets before switching sessions, because fork/delete
 * races can leave stale parent links in old summaries.
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
