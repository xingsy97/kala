export type FleetExecutor = { id: string; poolId: string; labels: readonly string[]; status: 'active' | 'draining' | 'maintenance' | 'offline'; version: string; capabilities: readonly string[]; lastSeenAt?: string }
export class ExecutorFleet {
  private readonly executors = new Map<string, FleetExecutor>()
  upsert(executor: FleetExecutor): void { this.executors.set(executor.id, executor) }
  setMode(id: string, mode: 'active' | 'draining' | 'maintenance'): void { const current = this.executors.get(id); if (!current) throw new Error('executor not found'); this.executors.set(id, { ...current, status: mode }) }
  select(input: { poolId: string; requiredCapabilities?: readonly string[]; labels?: readonly string[] }): FleetExecutor | undefined {
    return [...this.executors.values()].filter((executor) => executor.poolId === input.poolId && executor.status === 'active' && (input.requiredCapabilities ?? []).every((capability) => executor.capabilities.includes(capability)) && (input.labels ?? []).every((label) => executor.labels.includes(label))).sort((a, b) => a.id.localeCompare(b.id))[0]
  }
  snapshot(): readonly FleetExecutor[] { return [...this.executors.values()] }
}
