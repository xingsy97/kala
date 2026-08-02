export type UnitResourceLimits = { maxConcurrentTurns: number; maxQueuedMessages: number; maxArtifactBytes: number }
export type UnitResourceUsage = { concurrentTurns: number; queuedMessages: number; artifactBytes: number }
export type ResourceDecision = { ok: true } | { ok: false; code: 'concurrency_limit' | 'queue_limit' | 'artifact_quota'; retryable: boolean }

export class UnitResourceGovernor {
  private readonly usage = new Map<string, UnitResourceUsage>()
  constructor(private readonly limits: UnitResourceLimits) {}

  snapshot(unitId: string): UnitResourceUsage { return { ...(this.usage.get(unitId) ?? emptyUsage()) } }

  tryStartTurn(unitId: string): ResourceDecision {
    const usage = this.mutable(unitId)
    if (usage.concurrentTurns >= this.limits.maxConcurrentTurns) return { ok: false, code: 'concurrency_limit', retryable: true }
    usage.concurrentTurns += 1
    return { ok: true }
  }
  finishTurn(unitId: string): void { const usage = this.mutable(unitId); usage.concurrentTurns = Math.max(0, usage.concurrentTurns - 1) }
  tryEnqueue(unitId: string): ResourceDecision {
    const usage = this.mutable(unitId)
    if (usage.queuedMessages >= this.limits.maxQueuedMessages) return { ok: false, code: 'queue_limit', retryable: true }
    usage.queuedMessages += 1
    return { ok: true }
  }
  dequeue(unitId: string): void { const usage = this.mutable(unitId); usage.queuedMessages = Math.max(0, usage.queuedMessages - 1) }
  reserveArtifact(unitId: string, bytes: number): ResourceDecision {
    const usage = this.mutable(unitId)
    if (bytes < 0 || usage.artifactBytes + bytes > this.limits.maxArtifactBytes) return { ok: false, code: 'artifact_quota', retryable: false }
    usage.artifactBytes += bytes
    return { ok: true }
  }
  releaseArtifact(unitId: string, bytes: number): void { const usage = this.mutable(unitId); usage.artifactBytes = Math.max(0, usage.artifactBytes - Math.max(0, bytes)) }
  forget(unitId: string): void { this.usage.delete(unitId) }
  private mutable(unitId: string): UnitResourceUsage { let value = this.usage.get(unitId); if (!value) { value = emptyUsage(); this.usage.set(unitId, value) } return value }
}
function emptyUsage(): UnitResourceUsage { return { concurrentTurns: 0, queuedMessages: 0, artifactBytes: 0 } }
