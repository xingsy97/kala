import type { RpcAck } from '@agent-kernel/shared'

const MAX_COMPLETED_OPERATIONS = 2_000
const OPERATION_TTL_MS = 10 * 60_000

type Entry = {
  expiresAt: number
  result: RpcAck<unknown>
}

export class OperationDeduper {
  private readonly completed = new Map<string, Entry>()
  private readonly pending = new Map<string, Promise<RpcAck<unknown>>>()

  async run<T>(
    operationId: string | undefined,
    operation: () => Promise<T>,
  ): Promise<RpcAck<T>> {
    if (!operationId) return await execute(operation)
    this.prune()
    const completed = this.completed.get(operationId)
    if (completed) return completed.result as RpcAck<T>
    const pending = this.pending.get(operationId)
    if (pending) return await pending as RpcAck<T>

    const promise = execute(operation) as Promise<RpcAck<unknown>>
    this.pending.set(operationId, promise)
    const result = await promise
    this.pending.delete(operationId)
    this.completed.set(operationId, {
      expiresAt: Date.now() + OPERATION_TTL_MS,
      result,
    })
    this.prune()
    return result as RpcAck<T>
  }

  private prune(): void {
    const now = Date.now()
    for (const [id, entry] of this.completed) {
      if (entry.expiresAt <= now) this.completed.delete(id)
    }
    while (this.completed.size > MAX_COMPLETED_OPERATIONS) {
      const oldest = this.completed.keys().next().value
      if (oldest === undefined) break
      this.completed.delete(oldest)
    }
  }
}

async function execute<T>(operation: () => Promise<T>): Promise<RpcAck<T>> {
  try {
    const value = await operation()
    return value === undefined
      ? ({ ok: true } as RpcAck<T>)
      : ({ ok: true, value } as RpcAck<T>)
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
