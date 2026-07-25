/**
 * The single hook that owns a Socket.IO connection to the host's `/dashboard`
 * namespace and mirrors the session's state locally.
 *
 * Everything the UI needs (state, event log, pending approvals, usage) is
 * derived from server events. User actions become socket emits — never a
 * local mutation.
 */

import { useEffect, useMemo, useReducer, useRef, useState } from 'react'

import type {
  AgentConfig,
  AgentState,
} from '@agent-kernel/kernel'
import type {
  ApprovalRequiredEvent,
  AttachedExecutor,
  CompactStatusEvent,
  ContextUsageSnapshot,
  ControlUpdate,
  DashboardClientToServerEvents,
  DashboardServerToClientEvents,
  EventAppendedEvent,
  QueuedMessagePreview,
  SessionErrorEvent,
  SessionReadyEvent,
  SessionSummary,
  HostRestartEvent,
  HumanAttentionTimeline,
} from '@agent-kernel/shared'
import { PROTOCOL_VERSION, buildHumanAttentionTimeline } from '@agent-kernel/shared'
import { io, type Socket } from 'socket.io-client'

import { decideSessionHydration } from './session-hydration-policy.js'
import { projectStatusFromEntry } from './state-flow.js'
import {
  EMPTY_SESSION_PROJECTION,
  mergeBySeq,
  reduceSessionProjection,
  timelineEntry,
  type ConnectionStatus,
  type SessionProjectionEvent,
  type TimelineEntry,
} from './session-projection.js'
import type { CachedSessionView, SessionViewCache } from './session-view-cache.js'

export type { ConnectionStatus, TimelineEntry } from './session-projection.js'

export type DashboardSocket = Socket<
  DashboardServerToClientEvents,
  DashboardClientToServerEvents
>

export type SessionView = {
  status: ConnectionStatus
  state: AgentState | null
  config: AgentConfig | null
  contextSnapshot: ContextUsageSnapshot | null
  /**
   * Latest compaction lifecycle event received from the host. Every
   * attached dashboard receives the same broadcast; consumers use it to
   * render "Compacting…" without needing to have originated the request.
   * Null until the first attempt of the session.
   */
  compactStatus: CompactStatusEvent | null
  timeline: readonly TimelineEntry[]
  humanAttention: HumanAttentionTimeline
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
  toolExecutionStartedAt: number | null
  hydratedSessionId: string | null
  socket: DashboardSocket | null
}

type BoundDashboardSocket = {
  sessionId: string
  socket: DashboardSocket
}

export type UseSessionOptions = {
  host: string
  sessionId: string | null
  token?: string
  cache?: SessionViewCache & { hydrate?(sessionId: string): Promise<CachedSessionView | null> }
  onForked?: (payload: SessionReadyEvent) => void
}

const CONTROL_SOCKET_SESSION_ID = '__agent-kernel-control__'

export function useSession({
  host,
  sessionId,
  token,
  cache,
  onForked,
}: UseSessionOptions): SessionView {
  const [projection, dispatchProjection] = useReducer(reduceSessionProjection, EMPTY_SESSION_PROJECTION)
  const [streamingText, setStreamingText] = useState('')
  const [boundSocket, setBoundSocket] = useState<BoundDashboardSocket | null>(null)
  const socketRef = useRef<DashboardSocket | null>(null)
  const generationRef = useRef(0)
  // Streaming smoother: token_delta events land in `streamBufferRef`, and a
  // requestAnimationFrame loop drains a chunk per frame into React state. This
  // collapses 60-100 setState calls/sec into ~60 frames/sec AND paces bursty
  // deltas into a smoother visual flow. Backlog >~200 chars triggers a catch-up.
  const streamBufferRef = useRef('')
  const streamRafRef = useRef<number | null>(null)
  const onForkedRef = useRef(onForked)
  onForkedRef.current = onForked

  useEffect(() => {
    if (!cache || !projection.sessionId || projection.hydratedSessionId !== projection.sessionId) return
    cache.set(projection.sessionId, {
      sessionId: projection.sessionId, status: projection.status, state: projection.state,
      config: projection.config, contextSnapshot: projection.contextSnapshot, timeline: projection.timeline,
      queuedMessages: projection.queuedMessages, lastError: projection.lastError,
      parentSessionId: projection.parentSessionId, parentCursor: projection.parentCursor,
      selectedModel: projection.selectedModel, hydratedSessionId: projection.hydratedSessionId,
    })
  }, [cache, projection])

  useEffect(() => {
    const generation = ++generationRef.current
    if (sessionId === null) {
      socketRef.current?.close()
      socketRef.current = null
      setBoundSocket(null)
      dispatchProjection({ kind: 'select', generation, sessionId: null })
      setStreamingText('')
      return
    }
    let cached = cache?.get(sessionId) ?? null
    dispatchProjection({ kind: 'select', generation, sessionId, cached })
    setStreamingText('')
    streamBufferRef.current = ''
    if (streamRafRef.current !== null) {
      cancelAnimationFrame(streamRafRef.current)
      streamRafRef.current = null
    }
    let resetHistoryBaseOnNextReplay = false

    // Coalesce the two high-frequency projection channels (`event:appended`
    // and `state:changed`) to at most one React commit per animation frame.
    // socket.io delivers each wire message in its own macrotask, so React 18's
    // automatic batching does NOT merge them — during a tool-heavy turn that is
    // dozens of independent re-renders of the whole App per second, which
    // starves the main thread (buttons feel dead, the hover cursor stops
    // updating). We buffer these deltas and flush them in insertion order once
    // per frame. Discrete, order-sensitive events (ready/history/queue/error/
    // model) flush the buffer synchronously first so ordering is never broken.
    let projectionQueue: SessionProjectionEvent[] = []
    let projectionRaf: number | null = null
    const flushProjectionQueue = (): void => {
      if (projectionRaf !== null) {
        cancelAnimationFrame(projectionRaf)
        projectionRaf = null
      }
      if (projectionQueue.length === 0) return
      const batch = projectionQueue
      projectionQueue = []
      for (const evt of batch) dispatchProjection(evt)
    }
    const enqueueProjection = (evt: SessionProjectionEvent): void => {
      projectionQueue.push(evt)
      if (projectionRaf === null) {
        projectionRaf = requestAnimationFrame(() => {
          projectionRaf = null
          flushProjectionQueue()
        })
      }
    }

    // Throttle React commits to ~15fps. The rAF loop previously called
    // setStreamingText on every frame (~60fps), which re-rendered the whole
    // App subtree (transcript + composer + chrome) 60x/sec during streaming —
    // the main cause of typing lag in the composer while the agent is
    // thinking/streaming, and of general jank on mobile/PWA. Committing at most
    // once per ~66ms keeps streaming visually smooth (humans can't read faster)
    // while cutting streaming-driven re-renders ~4x.
    const MIN_COMMIT_MS = 66
    let lastCommitMs = 0
    let pendingCommit = ''
    const commitPending = (): void => {
      if (pendingCommit.length === 0) return
      const chunk = pendingCommit
      pendingCommit = ''
      lastCommitMs = (typeof performance !== 'undefined' ? performance.now() : Date.now())
      setStreamingText((prev) => prev + chunk)
    }
    const drainStreamBuffer = (): void => {
      const buf = streamBufferRef.current
      if (buf.length === 0) {
        // Flush whatever hasn't been committed yet, then stop the loop.
        commitPending()
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
      pendingCommit += chunk
      const now = (typeof performance !== 'undefined' ? performance.now() : Date.now())
      if (now - lastCommitMs >= MIN_COMMIT_MS) commitPending()
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
      pendingCommit = ''
      if (streamRafRef.current !== null) {
        cancelAnimationFrame(streamRafRef.current)
        streamRafRef.current = null
      }
      setStreamingText('')
    }

    let disposed = false
    let socket: DashboardSocket | null = null
    const connect = async (): Promise<void> => {
      if (!cached && cache?.hydrate) {
        cached = await cache.hydrate(sessionId)
        if (disposed) return
        if (cached) {
          dispatchProjection({ kind: 'hydrate', generation, sessionId, cached })
        }
      }

      socket = io(`${host}/dashboard`, {
        auth: {
          sessionId,
          role: 'dashboard',
          clientVersion: PROTOCOL_VERSION,
          ...(token !== undefined ? { token } : {}),
        },
        reconnection: true,
        reconnectionDelay: 500,
        reconnectionDelayMax: 30_000,
        reconnectionAttempts: 30,
        randomizationFactor: 0.5,
      }) as DashboardSocket
      socketRef.current = socket
      setBoundSocket({ sessionId, socket })
      bindSocket(socket)
    }

    const bindSocket = (socket: DashboardSocket): void => {
      const isCurrentSocket = (): boolean => socketRef.current === socket
      let plannedRestartUntil = 0

      const noteHostRestart = (event: HostRestartEvent): void => {
        if (!isCurrentSocket()) return
        if (event.phase === 'restarting') {
          plannedRestartUntil = Date.now() + 120_000
        }
      }

    socket.on('session:ready', (p) => {
      if (!isCurrentSocket()) return
      if (p.reason === 'forked') {
        onForkedRef.current?.(p)
        return
      }
      if (p.sessionId !== sessionId) return
      flushProjectionQueue()
      dispatchProjection({ kind: 'ready', generation, sessionId, payload: p })
      // Timeline was cleared for a fresh connect; ask the host to replay
      // the log so a page reload doesn't leave the user staring at an
      // empty timeline for a session that already has history. Live
      // event:appended events overlapping the tail of history are
      // deduped by seq below.
      const hydration = decideSessionHydration({ cached, hostCursor: p.cursor })
      if (hydration.kind === 'load_full_history') {
        if (hydration.resetTimeline) {
          cache?.delete(p.sessionId)
          resetHistoryBaseOnNextReplay = true
          dispatchProjection({ kind: 'reset_timeline', generation, sessionId })
        }
        socket.emit('client:load_history', { sessionId: p.sessionId })
        return
      }
      socket.emit('client:load_history', {
        sessionId: p.sessionId,
        sinceCursor: hydration.sinceCursor,
      })
    })
    socket.on('server:history', (p) => {
      if (!isCurrentSocket() || p.sessionId !== sessionId) return
      const reset = resetHistoryBaseOnNextReplay
      resetHistoryBaseOnNextReplay = false
      flushProjectionQueue()
      dispatchProjection({ kind: 'history', generation, sessionId, entries: p.entries.map(timelineEntry), reset })
    })
    socket.on('state:changed', (p) => {
      if (!isCurrentSocket() || p.sessionId !== sessionId) return
      // Kept as a fallback / correction channel. The primary path is
      // `session:ready` (baseline) + `event:appended` (client-side fold
      // via kernel step()). This handler runs if a wire event lands
      // out-of-order or if the host pushes a mid-stream correction; in
      // both cases the server-computed state wins.
      //
      // Coalesced to one commit per frame (see enqueueProjection): during a
      // tool-heavy turn state:changed fires very frequently and each one used
      // to re-render the whole App synchronously.
      enqueueProjection({ kind: 'authoritative', generation, sessionId, payload: p })
      if (p.state.status !== 'thinking') resetStream()
    })
    socket.on('event:appended', (p) => {
      if (!isCurrentSocket() || p.sessionId !== sessionId) return
      if (p.event.kind === 'llm_response' || p.event.kind === 'llm_error') {
        // Turn-boundary events: flush any buffered deltas first so ordering is
        // preserved, then reset the streaming tail and apply immediately.
        resetStream()
        flushProjectionQueue()
        dispatchProjection({ kind: 'appended', generation, sessionId, payload: p })
        return
      }
      // High-frequency mid-turn events (tool_call / tool_result): coalesce to
      // one React commit per animation frame.
      enqueueProjection({ kind: 'appended', generation, sessionId, payload: p })
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
      if (p.sessionId === sessionId) {
        const items = p.items ?? []
        dispatchProjection({ kind: 'queue', generation, sessionId, items })
      }
    })
    socket.on('session:error', (p) => {
      if (!isCurrentSocket() || p.sessionId !== sessionId) return
      resetStream()
      flushProjectionQueue()
      dispatchProjection({ kind: 'error', generation, sessionId, error: p })
    })
    socket.on('session:token_delta', (p) => {
      if (!isCurrentSocket()) return
      if (p.sessionId === sessionId) pushStreamDelta(p.text)
    })
    socket.on('server:control_update', (p: ControlUpdate) => {
      if (p.kind === 'host_restart') noteHostRestart(p)
      if (p.kind === 'session_meta_changed' && p.sessionId === sessionId && p.preferences && 'selectedModel' in p.preferences) {
        const model = p.preferences.selectedModel && p.preferences.selectedModel.length > 0 ? p.preferences.selectedModel : null
        dispatchProjection({ kind: 'model', generation, sessionId, selectedModel: model })
      }
    })
    socket.on('connect_error', (err) => {
      if (!isCurrentSocket()) return
      // Version / auth failures are handshake-time — no point retrying.
      // Stop the socket.io retry loop and hold in an error state so the
      // user sees an actionable banner instead of a hot-looping toast.
      const msg = (err as Error | undefined)?.message ?? ''
      if (msg === 'version_incompatible' || msg === 'auth_failed') {
        socket.disconnect()
      }
      dispatchProjection({ kind: 'status', generation, sessionId, status: 'error' })
    })
    socket.io.on('reconnect_failed', () => {
      if (!isCurrentSocket()) return
      dispatchProjection({ kind: 'status', generation, sessionId, status: 'error' })
    })
    socket.on('disconnect', (reason) => {
      if (!isCurrentSocket()) return
      // Server-initiated disconnect (e.g. workspaceId conflict analogue on
      // dashboard side, or host shutdown) is terminal — don't let socket.io
      // keep dialing.
      if (reason === 'io server disconnect') {
        if (Date.now() < plannedRestartUntil) {
          dispatchProjection({ kind: 'status', generation, sessionId, status: 'disconnected' })
          return
        }
        socket.disconnect()
        dispatchProjection({ kind: 'status', generation, sessionId, status: 'error' })
        return
      }
      dispatchProjection({ kind: 'status', generation, sessionId, status: 'disconnected' })
    })
    socket.on('server:compact_status', (p: CompactStatusEvent) => {
      if (!isCurrentSocket() || p.sessionId !== sessionId) return
      dispatchProjection({ kind: 'compact', generation, sessionId, compactStatus: p })
    })
    }

    void connect()

    return () => {
      disposed = true
      if (streamRafRef.current !== null) {
        cancelAnimationFrame(streamRafRef.current)
        streamRafRef.current = null
      }
      if (projectionRaf !== null) {
        cancelAnimationFrame(projectionRaf)
        projectionRaf = null
      }
      // Drop any buffered projection deltas: this socket/session is being torn
      // down (session switch or reconnect), and the fresh connection replays
      // an authoritative baseline via session:ready + history.
      projectionQueue = []
      streamBufferRef.current = ''
      socket?.close()
      if (socketRef.current === socket) socketRef.current = null
      setBoundSocket((current) => current?.socket === socket ? null : current)
    }
  }, [host, sessionId, token, cache])

  const {
    status, state, config, contextSnapshot, compactStatus: remoteCompactStatus, timeline,
    queuedMessages, lastError, parentSessionId, parentCursor, selectedModel, hydratedSessionId,
  } = projection

  const pendingApprovals = useMemo<readonly ApprovalRequiredEvent[]>(() => {
    if (!state || !sessionId) return []
    return state.pendingCalls
      .filter((c) => c.status === 'awaiting_approval')
      .map((c) => ({
        sessionId,
        callId: c.callId,
        name: c.name,
        input: c.input,
      }))
  }, [state, sessionId])

  const toolExecutionStartedAt = useMemo(
    () => deriveToolExecutionStartedAt(state, timeline),
    [state, timeline],
  )

  // Human-attention scoring walks the whole (growing) timeline prefix and is
  // relatively expensive; recomputing it on every timeline delta froze the main
  // thread during tool-heavy turns (hundreds of ms per recompute). It is not
  // real-time-critical — it only drives the attention indicator — so debounce
  // it: recompute only after the timeline has been quiet for a moment. During
  // an active turn the timeline changes constantly, so this collapses dozens of
  // full recomputes into (at most) one per quiet window.
  const [attentionTimeline, setAttentionTimeline] = useState<readonly TimelineEntry[]>(timeline)
  useEffect(() => {
    const handle = window.setTimeout(() => setAttentionTimeline(timeline), 400)
    return () => window.clearTimeout(handle)
  }, [timeline])
  const humanAttention = useMemo(
    () => deriveHumanAttentionTimeline(sessionId, attentionTimeline),
    [sessionId, attentionTimeline],
  )

  return useMemo(
    () => ({
      status,
      state,
      config,
      contextSnapshot,
      compactStatus: remoteCompactStatus,
      timeline,
      humanAttention,
      streamingText,
      pendingApprovals,
      queuedMessages,
      lastError,
      parentSessionId,
      parentCursor,
      selectedModel,
      toolExecutionStartedAt,
      hydratedSessionId,
      socket: boundSocket?.sessionId === sessionId ? boundSocket.socket : null,
    }),
    [
      status,
      state,
      config,
      contextSnapshot,
      remoteCompactStatus,
      timeline,
      humanAttention,
      streamingText,
      pendingApprovals,
      queuedMessages,
      lastError,
      parentSessionId,
      parentCursor,
      selectedModel,
      toolExecutionStartedAt,
      hydratedSessionId,
      boundSocket,
      sessionId,
    ],
  )
}

export function useDashboardControlSocket(host: string, token?: string): DashboardSocket | null {
  const [socket, setSocket] = useState<DashboardSocket | null>(null)

  useEffect(() => {
    const next = io(`${host}/dashboard`, {
      auth: {
        sessionId: CONTROL_SOCKET_SESSION_ID,
        role: 'dashboard',
        clientVersion: PROTOCOL_VERSION,
        ...(token !== undefined ? { token } : {}),
      },
      reconnection: true,
      reconnectionDelay: 500,
      reconnectionDelayMax: 30_000,
      reconnectionAttempts: 30,
      randomizationFactor: 0.5,
    }) as DashboardSocket
    setSocket(next)
    return () => {
      next.close()
      setSocket((current) => current === next ? null : current)
    }
  }, [host, token])

  return socket
}

export function deriveHumanAttentionTimeline(
  sessionId: string | null,
  timeline: readonly TimelineEntry[],
): HumanAttentionTimeline {
  return sessionId ? buildHumanAttentionTimeline(sessionId, timeline) : { sessionId: '', points: [], latest: null }
}

export function deriveToolExecutionStartedAt(
  state: AgentState | null,
  timeline: readonly TimelineEntry[],
): number | null {
  if (!state || state.status !== 'executing_tools') return null
  const activeCallIds = new Set(
    state.pendingCalls
      .filter((call) => call.status === 'dispatched' || call.status === 'approved')
      .map((call) => call.callId),
  )
  if (activeCallIds.size === 0) return null
  let startedAt: number | null = null
  for (const entry of timeline) {
    if (!entry.effects.some((effect) => effect.kind === 'call_tool' && activeCallIds.has(effect.callId))) continue
    const parsed = Date.parse(entry.ts)
    if (!Number.isFinite(parsed)) continue
    startedAt = startedAt === null ? parsed : Math.min(startedAt, parsed)
  }
  return startedAt
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
  options: { cascade?: boolean } = {},
): void {
  socket.emit('client:delete_session', { sessionId, ...(options.cascade ? { cascade: true } : {}) })
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
  input: {
    sessionId: string
    workspaceId?: string
    workspaceName?: string
    cwd?: string
    tools?: readonly string[]
    selectedModel?: string
  },
): void {
  socket.emit('client:create_session', {
    sessionId: input.sessionId,
    ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}),
    ...(input.workspaceName !== undefined ? { workspaceName: input.workspaceName } : {}),
    ...(input.cwd !== undefined && input.cwd.length > 0 ? { cwd: input.cwd } : {}),
    ...(input.tools !== undefined ? { tools: input.tools } : {}),
    ...(input.selectedModel !== undefined && input.selectedModel.length > 0 ? { selectedModel: input.selectedModel } : {}),
  })
}

export function createSessionWithAck(
  socket: DashboardSocket,
  input: {
    sessionId: string
    workspaceId?: string
    workspaceName?: string
    cwd?: string
    tools?: readonly string[]
    selectedModel?: string
  },
  timeoutMs = 10_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      window.clearTimeout(timer)
      socket.off('session:ready', onReady)
      socket.off('session:error', onError)
    }
    const onReady = (payload: SessionReadyEvent): void => {
      if (payload.sessionId !== input.sessionId) return
      cleanup()
      resolve()
    }
    const onError = (payload: SessionErrorEvent): void => {
      if (payload.sessionId !== input.sessionId) return
      cleanup()
      reject(new Error(payload.message))
    }
    const timer = window.setTimeout(() => {
      cleanup()
      reject(new Error('session creation timed out'))
    }, timeoutMs)
    socket.on('session:ready', onReady)
    socket.on('session:error', onError)
    createSession(socket, input)
  })
}

export function updateSessionPreferences(
  socket: DashboardSocket,
  sessionId: string,
  preferences: import('@agent-kernel/shared').SessionPreferences,
): void {
  socket.emit('client:update_preferences', { sessionId, preferences })
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

export function renameWorkspace(
  socket: DashboardSocket,
  workspaceId: string,
  workspaceName: string,
): void {
  socket.emit('client:rename_workspace', { workspaceId, workspaceName })
}

export type ControlPlaneView = {
  executors: readonly AttachedExecutor[]
  sessions: readonly SessionSummary[]
  executorsLoaded: boolean
  sessionsLoaded: boolean
  refreshSessions(): void
}

/**
 * Subscribes to the host's control-plane events (executors / sessions) using
 * an already-open dashboard socket. Fetches an initial snapshot on socket
 * change and keeps the daemon list live via `server:control_update`.
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
  const [executorsLoaded, setExecutorsLoaded] = useState(false)
  const [sessionsLoaded, setSessionsLoaded] = useState(false)

  useEffect(() => {
    if (!socket) {
      setExecutors([])
      setSessions([])
      setExecutorsLoaded(false)
      setSessionsLoaded(false)
      return
    }
    let active = true
    const isActive = (): boolean => active
    const onExecutors = (p: { executors: readonly AttachedExecutor[] }): void => {
      if (!isActive()) return
      setExecutors(p.executors)
      setExecutorsLoaded(true)
    }
    const onSessions = (p: { sessions: readonly SessionSummary[] }): void => {
      if (!isActive()) return
      setSessions((prev) => mergeSessionSummaries(prev, p.sessions))
      setSessionsLoaded(true)
    }
    const onExecutorChanged = (change: Extract<ControlUpdate, { kind: 'executor_changed' }>): void => {
      if (!isActive()) return
      setExecutorsLoaded(true)
      setExecutors((prev) => {
        if (change.change === 'detached') {
          // Host now debounces detach with a grace window, so by the time
          // this event lands the workspace is really gone. Drop by both
          // executorId AND workspaceId — a restarted process reattaches
          // with a fresh executorId but same workspaceId, and we don't
          // want a lingering stale row.
          return prev.filter((e) => e.executorId !== change.executorId)
        }
        // attached/updated: dedupe by workspaceId so an executor process
        // restart (fresh executorId, same workspaceId) replaces the old
        // row in place instead of showing two entries for one machine.
        const next = prev.filter(
          (e) =>
            e.executorId !== change.executorId &&
            e.workspaceId !== change.executor.workspaceId,
        )
        next.push(change.executor)
        return next
      })
    }
    const onControlUpdate = (payload: ControlUpdate): void => {
      if (!isActive()) return
      if (payload.kind === 'session_meta_changed') {
        setSessions((prev) => prev.map((s) => (
          s.sessionId === payload.sessionId
            ? {
                ...s,
                ...(payload.label !== undefined && payload.label.trim().length > 0
                  ? { label: payload.label }
                  : payload.label !== undefined
                    ? { label: undefined }
                    : {}),
                ...(payload.preferences !== undefined
                  ? { preferences: payload.preferences }
                  : {}),
              }
            : s
        )))
      }
      if (payload.kind === 'executor_changed') {
        onExecutorChanged(payload)
      }
    }
    const onEventAppended: DashboardServerToClientEvents['event:appended'] = (p) => {
      if (!isActive()) return
      setSessions((prev) => updateSessionSummaryFromEvent(prev, p))
    }
    const onStateChanged: DashboardServerToClientEvents['state:changed'] = (p) => {
      if (!isActive()) return
      setSessions((prev) => updateSessionSummary(prev, p.sessionId, (s) => ({
        ...s,
        status: p.state.status,
        ...(p.state.cwd ? { currentCwd: p.state.cwd } : { currentCwd: undefined }),
      })))
    }
    const onMessageQueue: DashboardServerToClientEvents['server:message_queue'] = (p) => {
      if (!isActive()) return
      if (p.pending > 0) {
        setSessions((prev) => updateSessionSummary(prev, p.sessionId, (s) => ({
          ...s,
          status: isRestingSessionStatus(s.status) ? 'idle' : s.status,
        })))
      }
    }
    socket.on('server:executors', onExecutors)
    socket.on('server:sessions', onSessions)
    socket.on('server:control_update', onControlUpdate)
    socket.on('event:appended', onEventAppended)
    socket.on('state:changed', onStateChanged)
    socket.on('server:message_queue', onMessageQueue)
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
      socket.off('server:control_update', onControlUpdate)
      socket.off('event:appended', onEventAppended)
      socket.off('state:changed', onStateChanged)
      socket.off('server:message_queue', onMessageQueue)
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

  return { executors, sessions, executorsLoaded, sessionsLoaded, refreshSessions }
}

export function mergeSessionSummaries(
  prev: readonly SessionSummary[],
  incoming: readonly SessionSummary[],
): readonly SessionSummary[] {
  if (prev.length === 0) return incoming
  const incomingById = new Map(incoming.map((s) => [s.sessionId, s]))
  const prevById = new Map(prev.map((s) => [s.sessionId, s]))
  const next: SessionSummary[] = []
  for (const old of prev) {
    const fresh = incomingById.get(old.sessionId)
    if (!fresh) continue
    next.push(fresh)
  }
  for (const fresh of incoming) {
    if (!prevById.has(fresh.sessionId)) next.push(fresh)
  }
  return next
}

function updateSessionSummary(
  sessions: readonly SessionSummary[],
  sessionId: string,
  update: (summary: SessionSummary) => SessionSummary,
): readonly SessionSummary[] {
  let changed = false
  const next = sessions.map((summary) => {
    if (summary.sessionId !== sessionId) return summary
    changed = true
    return update(summary)
  })
  return changed ? next : sessions
}

function updateSessionSummaryFromEvent(
  sessions: readonly SessionSummary[],
  entry: EventAppendedEvent,
): readonly SessionSummary[] {
  return updateSessionSummary(sessions, entry.sessionId, (summary) => {
    const nextStatus = projectStatusFromEntry(summary.status ?? 'idle', timelineEntry(entry))
    const nextCwd = entry.event.kind === 'cwd_changed' ? entry.event.cwd : summary.currentCwd
    return {
      ...summary,
      status: nextStatus,
      lastEventAt: entry.ts,
      eventCount: Math.max(summary.eventCount, entry.seq),
      ...(nextCwd ? { currentCwd: nextCwd } : { currentCwd: undefined }),
      ...(summary.firstUserMessage || entry.event.kind !== 'user_message' || !entry.event.text
        ? {}
        : { firstUserMessage: entry.event.text.slice(0, 120) }),
    }
  })
}

function isRestingSessionStatus(status: SessionSummary['status'] | undefined): boolean {
  return status === undefined || status === 'idle' || status === 'done' || status === 'error'
}

export { mergeBySeq } from './session-projection.js'
