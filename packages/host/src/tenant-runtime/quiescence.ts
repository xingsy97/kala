import type { HostServer } from '../server.js'
import type { LoopDrainSessionSnapshot } from '../loop-types.js'

export type UnitQuiescenceSession = Pick<LoopDrainSessionSnapshot, 'sessionId' | 'status' | 'safe' | 'waiting' | 'checkpointKind' | 'cursor'>

export type UnitQuiescence = {
  readonly safe: boolean
  readonly queueStable: boolean
  readonly activeLlmCalls: number
  readonly activeToolCalls: number
  readonly activeCompactions: number
  readonly unsafeSessions: readonly UnitQuiescenceSession[]
  readonly observedAt: string
}

/** Observes natural Session boundaries without changing the loop drain mode. */
export function inspectUnitQuiescence(server: Pick<HostServer, 'loop' | 'store'>, queueStable = true): UnitQuiescence {
  const snapshots = server.store.list().map((session) => server.loop.drainSnapshot(session.sessionId))
  const unsafeSessions = snapshots.filter((snapshot) => !snapshot.safe).map(toPublicSnapshot)
  return {
    safe: unsafeSessions.length === 0 && queueStable,
    queueStable,
    activeLlmCalls: snapshots.filter((snapshot) => snapshot.waiting === 'llm').length,
    activeToolCalls: snapshots.filter((snapshot) => snapshot.waiting === 'tool').length,
    activeCompactions: snapshots.filter((snapshot) => snapshot.waiting === 'compaction').length,
    unsafeSessions,
    observedAt: new Date().toISOString(),
  }
}

function toPublicSnapshot(snapshot: LoopDrainSessionSnapshot): UnitQuiescenceSession {
  return {
    sessionId: snapshot.sessionId,
    status: snapshot.status,
    safe: snapshot.safe,
    waiting: snapshot.waiting,
    ...(snapshot.checkpointKind ? { checkpointKind: snapshot.checkpointKind } : {}),
    ...(snapshot.cursor !== undefined ? { cursor: snapshot.cursor } : {}),
  }
}
