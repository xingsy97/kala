import { useSyncExternalStore } from 'react'
import type { SessionSummary } from '@agent-kernel/shared'

import type { SessionActivityStatus } from './Explorer.js'

export type SessionRuntimeSnapshot = {
  status?: SessionActivityStatus
  currentCwd?: string
  lastActivityIso: string
}

type Listener = () => void

export class SessionRuntimeStore {
  private readonly values = new Map<string, SessionRuntimeSnapshot>()
  private readonly listeners = new Map<string, Set<Listener>>()

  get(sessionId: string): SessionRuntimeSnapshot | undefined {
    return this.values.get(sessionId)
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

  sync(
    sessions: readonly SessionSummary[],
    statusOverrides?: ReadonlyMap<string, SessionActivityStatus>,
  ): void {
    const nextIds = new Set<string>()
    for (const session of sessions) {
      nextIds.add(session.sessionId)
      this.set(session.sessionId, {
        status: statusOverrides?.get(session.sessionId) ?? session.status,
        currentCwd: session.currentCwd,
        lastActivityIso: session.lastEventAt ?? session.createdAt,
      })
    }
    for (const sessionId of this.values.keys()) {
      if (!nextIds.has(sessionId)) this.delete(sessionId)
    }
  }

  private set(sessionId: string, next: SessionRuntimeSnapshot): void {
    if (sameSnapshot(this.values.get(sessionId), next)) return
    this.values.set(sessionId, next)
    this.notify(sessionId)
  }

  private delete(sessionId: string): void {
    if (!this.values.delete(sessionId)) return
    this.notify(sessionId)
  }

  private notify(sessionId: string): void {
    for (const listener of this.listeners.get(sessionId) ?? []) listener()
  }
}

export function useSessionRuntime(
  store: SessionRuntimeStore,
  sessionId: string,
): SessionRuntimeSnapshot | undefined {
  return useSyncExternalStore(
    (listener) => store.subscribe(sessionId, listener),
    () => store.get(sessionId),
    () => store.get(sessionId),
  )
}

function sameSnapshot(
  a: SessionRuntimeSnapshot | undefined,
  b: SessionRuntimeSnapshot,
): boolean {
  return a?.status === b.status &&
    a?.currentCwd === b.currentCwd &&
    a?.lastActivityIso === b.lastActivityIso
}
