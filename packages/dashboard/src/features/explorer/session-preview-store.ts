import { useSyncExternalStore } from 'react'

import type {
  DashboardServerToClientEvents,
  ServerTokenDeltaEvent,
} from '@agent-kernel/shared'

import type { DashboardSocket } from '../../session.js'
import {
  EMPTY_SESSION_PROJECTION,
  reduceSessionProjection,
  timelineEntry,
  type SessionProjection,
} from '../../session-projection.js'
import type { CachedSessionViewInput, SessionViewCache } from '../../session-view-cache.js'

export type SessionPreviewFreshness = 'cached' | 'live' | 'stale'
const SESSION_PREVIEW_TIMELINE_LIMIT = 48
const SESSION_PREVIEW_PUBLISH_INTERVAL_MS = 100
export type SessionPreviewSnapshot = {
  sessionId: string
  view: CachedSessionViewInput
  streamingText: string
  freshness: SessionPreviewFreshness
  updatedAt: number
}

type Listener = () => void

type PreviewRuntime = {
  generation: number
  projection: SessionProjection
  streamingText: string
}

/**
 * Maintains lightweight projections only for Session previews that are actually
 * open. It reuses the control socket and the Host's existing Session rooms, so a
 * hover does not create another Socket.IO connection or a full Chat workspace.
 */
export class SessionPreviewStore {
  private readonly snapshots = new Map<string, SessionPreviewSnapshot>()
  private readonly listeners = new Map<string, Set<Listener>>()
  private readonly runtimes = new Map<string, PreviewRuntime>()
  private readonly watches = new Map<string, number>()
  private socket: DashboardSocket | null = null
  private cache: SessionViewCache | null = null
  private generation = 0
  private tokenPublishTimer: ReturnType<typeof setTimeout> | null = null
  private readonly tokenDirtySessions = new Set<string>()

  get(sessionId: string): SessionPreviewSnapshot | null {
    return this.snapshots.get(sessionId) ?? null
  }

  set(snapshot: SessionPreviewSnapshot): void {
    if (this.snapshots.get(snapshot.sessionId) === snapshot) return
    this.snapshots.set(snapshot.sessionId, snapshot)
    this.notify(snapshot.sessionId)
  }

  delete(sessionId: string): void {
    this.runtimes.delete(sessionId)
    if (!this.snapshots.delete(sessionId)) return
    this.notify(sessionId)
  }

  subscribe(sessionId: string, listener: Listener): () => void {
    const listeners = this.listeners.get(sessionId) ?? new Set<Listener>()
    listeners.add(listener)
    this.listeners.set(sessionId, listeners)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) this.listeners.delete(sessionId)
    }
  }

  connect(socket: DashboardSocket | null, cache: SessionViewCache): () => void {
    this.detachSocket()
    this.socket = socket
    this.cache = cache
    if (!socket) return () => {}

    socket.on('connect', this.onConnect)
    socket.on('disconnect', this.onDisconnect)
    socket.on('session:ready', this.onReady)
    socket.on('server:history', this.onHistory)
    socket.on('event:appended', this.onAppended)
    socket.on('state:changed', this.onStateChanged)
    socket.on('session:token_delta', this.onTokenDelta)
    socket.on('server:message_queue', this.onMessageQueue)
    socket.on('server:session_deleted', this.onSessionDeleted)
    if (socket.connected) this.onConnect()

    return () => {
      if (this.socket === socket) this.detachSocket()
    }
  }

  watch(sessionId: string): () => void {
    const count = this.watches.get(sessionId) ?? 0
    this.watches.set(sessionId, count + 1)
    if (count === 0) {
      this.seed(sessionId)
      this.requestLive(sessionId)
    }
    return () => {
      const current = this.watches.get(sessionId) ?? 0
      if (current > 1) {
        this.watches.set(sessionId, current - 1)
        return
      }
      this.watches.delete(sessionId)
      this.socket?.emit('unsubscribe', { sessionId })
      this.tokenDirtySessions.delete(sessionId)
      const snapshot = this.snapshots.get(sessionId)
      if (snapshot?.freshness === 'live') this.set({ ...snapshot, freshness: 'cached', updatedAt: Date.now() })
      this.runtimes.delete(sessionId)
    }
  }

  private readonly onConnect = (): void => {
    for (const sessionId of this.watches.keys()) this.requestLive(sessionId)
  }

  private readonly onDisconnect = (): void => {
    for (const sessionId of this.watches.keys()) {
      const snapshot = this.snapshots.get(sessionId)
      if (snapshot) this.set({ ...snapshot, freshness: 'stale', updatedAt: Date.now() })
    }
  }

  private readonly onReady: DashboardServerToClientEvents['session:ready'] = (payload) => {
    const runtime = this.runtimes.get(payload.sessionId)
    if (!runtime) return
    runtime.projection = reduceSessionProjection(runtime.projection, {
      kind: 'ready', generation: runtime.generation, sessionId: payload.sessionId, payload,
    })
    this.publish(payload.sessionId, 'live')
  }

  private readonly onHistory: DashboardServerToClientEvents['server:history'] = (payload) => {
    const runtime = this.runtimes.get(payload.sessionId)
    if (!runtime) return
    runtime.projection = reduceSessionProjection(runtime.projection, {
      kind: 'history', generation: runtime.generation, sessionId: payload.sessionId,
      // The room is joined before history is read. A live event can therefore
      // arrive before this response; merge by seq instead of resetting so that
      // the response cannot erase a newer room event.
      entries: payload.entries.slice(-SESSION_PREVIEW_TIMELINE_LIMIT).map(timelineEntry),
    })
    runtime.projection = boundPreviewProjection(runtime.projection)
    this.publish(payload.sessionId, 'live')
  }

  private readonly onAppended: DashboardServerToClientEvents['event:appended'] = (payload) => {
    const runtime = this.runtimes.get(payload.sessionId)
    if (!runtime) return
    runtime.projection = reduceSessionProjection(runtime.projection, {
      kind: 'appended', generation: runtime.generation, sessionId: payload.sessionId, payload,
    })
    runtime.projection = boundPreviewProjection(runtime.projection)
    if (payload.event.kind === 'llm_response' || payload.event.kind === 'llm_error' || payload.event.kind === 'cancel') {
      this.tokenDirtySessions.delete(payload.sessionId)
      runtime.streamingText = ''
    }
    this.publish(payload.sessionId, 'live')
  }

  private readonly onStateChanged: DashboardServerToClientEvents['state:changed'] = (payload) => {
    const runtime = this.runtimes.get(payload.sessionId)
    if (!runtime) return
    runtime.projection = reduceSessionProjection(runtime.projection, {
      kind: 'authoritative', generation: runtime.generation, sessionId: payload.sessionId, payload,
    })
    runtime.projection = boundPreviewProjection(runtime.projection)
    this.publish(payload.sessionId, 'live')
  }

  private readonly onTokenDelta = (payload: ServerTokenDeltaEvent): void => {
    const runtime = this.runtimes.get(payload.sessionId)
    if (!runtime) return
    runtime.streamingText += payload.text
    this.tokenDirtySessions.add(payload.sessionId)
    this.scheduleTokenPublish()
  }

  private readonly onMessageQueue: DashboardServerToClientEvents['server:message_queue'] = (payload) => {
    const runtime = this.runtimes.get(payload.sessionId)
    if (!runtime) return
    runtime.projection = reduceSessionProjection(runtime.projection, {
      kind: 'queue', generation: runtime.generation, sessionId: payload.sessionId,
      items: payload.items,
    })
    this.publish(payload.sessionId, 'live')
  }

  private readonly onSessionDeleted: DashboardServerToClientEvents['server:session_deleted'] = (payload) => {
    this.watches.delete(payload.sessionId)
    this.tokenDirtySessions.delete(payload.sessionId)
    this.delete(payload.sessionId)
  }

  private seed(sessionId: string): void {
    const cached = this.cache?.peek(sessionId) ?? null
    const generation = ++this.generation
    // Cached content is published immediately for paint, but the live runtime
    // starts empty. This prevents a stale cached entry at the same seq from
    // winning over authoritative history when mergeBySeq applies first-entry
    // semantics.
    const projection = reduceSessionProjection(EMPTY_SESSION_PROJECTION, {
      kind: 'select', generation, sessionId,
    })
    this.runtimes.set(sessionId, { generation, projection, streamingText: '' })
    if (cached) {
      this.set({
        sessionId,
        view: cached,
        streamingText: '',
        freshness: 'cached',
        updatedAt: cached.cachedAt,
      })
    }
  }

  private requestLive(sessionId: string): void {
    const socket = this.socket
    if (!socket?.connected || !this.watches.has(sessionId)) return
    if (!this.runtimes.has(sessionId)) this.seed(sessionId)
    socket.emit('subscribe', { sessionId })
    socket.emit('client:load_history', { sessionId })
  }

  private publish(sessionId: string, freshness: SessionPreviewFreshness): void {
    const runtime = this.runtimes.get(sessionId)
    if (!runtime || !runtime.projection.state || !runtime.projection.config) return
    const p = runtime.projection
    this.set({
      sessionId,
      streamingText: runtime.streamingText,
      freshness,
      updatedAt: Date.now(),
      view: {
        sessionId,
        status: p.status,
        state: p.state,
        config: p.config,
        contextSnapshot: p.contextSnapshot,
        timeline: p.timeline,
        queuedMessages: p.queuedMessages,
        lastError: p.lastError,
        parentSessionId: p.parentSessionId,
        parentCursor: p.parentCursor,
        selectedModel: p.selectedModel,
        hydratedSessionId: p.hydratedSessionId,
      },
    })
  }

  private detachSocket(): void {
    const socket = this.socket
    if (!socket) return
    socket.off('connect', this.onConnect)
    socket.off('disconnect', this.onDisconnect)
    socket.off('session:ready', this.onReady)
    socket.off('server:history', this.onHistory)
    socket.off('event:appended', this.onAppended)
    socket.off('state:changed', this.onStateChanged)
    socket.off('session:token_delta', this.onTokenDelta)
    socket.off('server:message_queue', this.onMessageQueue)
    socket.off('server:session_deleted', this.onSessionDeleted)
    for (const sessionId of this.watches.keys()) socket.emit('unsubscribe', { sessionId })
    if (this.tokenPublishTimer !== null) clearTimeout(this.tokenPublishTimer)
    this.tokenPublishTimer = null
    this.tokenDirtySessions.clear()
    this.socket = null
  }

  private scheduleTokenPublish(): void {
    if (this.tokenPublishTimer !== null) return
    this.tokenPublishTimer = setTimeout(() => {
      this.tokenPublishTimer = null
      const sessionIds = [...this.tokenDirtySessions]
      this.tokenDirtySessions.clear()
      for (const sessionId of sessionIds) {
        if (this.watches.has(sessionId)) this.publish(sessionId, 'live')
      }
    }, SESSION_PREVIEW_PUBLISH_INTERVAL_MS)
  }

  private notify(sessionId: string): void {
    for (const listener of this.listeners.get(sessionId) ?? []) listener()
  }
}

function boundPreviewProjection(projection: SessionProjection): SessionProjection {
  if (projection.timeline.length <= SESSION_PREVIEW_TIMELINE_LIMIT) return projection
  return { ...projection, timeline: projection.timeline.slice(-SESSION_PREVIEW_TIMELINE_LIMIT) }
}

export function useSessionPreview(store: SessionPreviewStore | undefined, sessionId: string | null): SessionPreviewSnapshot | null {
  return useSyncExternalStore(
    (listener) => store && sessionId ? store.subscribe(sessionId, listener) : () => {},
    () => store && sessionId ? store.get(sessionId) : null,
    () => null,
  )
}
