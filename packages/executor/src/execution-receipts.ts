import { mkdir, open, readFile, rename } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ToolResultAck } from '@agent-kernel/shared'

const MAX_RECEIPTS = 500
const RECEIPT_TTL_MS = 24 * 60 * 60_000

type Receipt = { completedAt: number; result: ToolResultAck }
type CommitWaiter = { generation: number; resolve(): void; reject(error: unknown): void }

export class ExecutionReceiptStore {
  private readonly receipts = new Map<string, Receipt>()
  private generation = 0
  private durableGeneration = 0
  private drainPromise: Promise<void> | null = null
  private drainScheduled = false
  private readonly waiters: CommitWaiter[] = []

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as Record<string, Receipt>
      for (const [callId, receipt] of Object.entries(parsed)) this.receipts.set(callId, receipt)
      this.prune()
    } catch {}
  }

  get(callId: string): ToolResultAck | undefined {
    this.prune()
    return this.receipts.get(callId)?.result
  }

  set(callId: string, result: ToolResultAck): Promise<void> {
    // Refresh insertion order so capacity pruning retains recently repeated IDs.
    this.receipts.delete(callId)
    this.receipts.set(callId, { completedAt: Date.now(), result })
    this.prune()
    const generation = ++this.generation
    const committed = new Promise<void>((resolve, reject) => {
      this.waiters.push({ generation, resolve, reject })
    })
    this.scheduleDrain()
    return committed
  }

  async flush(): Promise<void> {
    while (this.drainScheduled || this.drainPromise !== null || this.durableGeneration < this.generation) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    }
  }

  private scheduleDrain(): void {
    if (this.drainScheduled || this.drainPromise !== null) return
    this.drainScheduled = true
    queueMicrotask(() => {
      this.drainScheduled = false
      this.drainPromise = this.drain()
        .catch(() => undefined)
        .finally(() => {
          this.drainPromise = null
          if (this.durableGeneration < this.generation && this.waiters.length > 0) this.scheduleDrain()
        })
    })
  }

  private async drain(): Promise<void> {
    while (this.durableGeneration < this.generation) {
      const targetGeneration = this.generation
      try {
        await this.persist(targetGeneration)
        this.durableGeneration = targetGeneration
        this.settleWaiters(targetGeneration)
      } catch (error) {
        this.rejectWaiters(targetGeneration, error)
        // The failed generation has no remaining caller to acknowledge. Advance
        // the barrier; a later set() creates a fresh generation and retries the
        // complete in-memory snapshot without running concurrent writers.
        this.durableGeneration = targetGeneration
        return
      }
    }
  }

  private async persist(generation: number): Promise<void> {
    const parent = dirname(this.path)
    await mkdir(parent, { recursive: true })
    const temp = `${this.path}.tmp-${process.pid}-${generation}`
    const file = await open(temp, 'w', 0o600)
    try {
      await file.writeFile(JSON.stringify(Object.fromEntries(this.receipts)), 'utf8')
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(temp, this.path)
    // POSIX permits fsync on the parent directory to make the rename durable.
    // Windows does not support opening directories this way (EPERM/EISDIR), so
    // the file fsync + atomic rename above is the strongest portable barrier.
    if (process.platform !== 'win32') {
      const directory = await open(parent, 'r')
      try {
        await directory.sync()
      } finally {
        await directory.close()
      }
    }
  }

  private settleWaiters(generation: number): void {
    const ready = this.waiters.filter((waiter) => waiter.generation <= generation)
    for (const waiter of ready) waiter.resolve()
    this.removeWaitersThrough(generation)
  }

  private rejectWaiters(generation: number, error: unknown): void {
    const failed = this.waiters.filter((waiter) => waiter.generation <= generation)
    for (const waiter of failed) waiter.reject(error)
    this.removeWaitersThrough(generation)
  }

  private removeWaitersThrough(generation: number): void {
    let count = 0
    while (count < this.waiters.length && this.waiters[count]!.generation <= generation) count++
    this.waiters.splice(0, count)
  }

  private prune(): void {
    const cutoff = Date.now() - RECEIPT_TTL_MS
    for (const [id, receipt] of this.receipts) {
      if (receipt.completedAt < cutoff) this.receipts.delete(id)
    }
    while (this.receipts.size > MAX_RECEIPTS) {
      const oldest = this.receipts.keys().next().value
      if (oldest === undefined) break
      this.receipts.delete(oldest)
    }
  }
}
