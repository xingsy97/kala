import { mkdir, open, readFile, rename, rm, stat, truncate } from 'node:fs/promises'
import { dirname } from 'node:path'

import { canonicalJson, sha256Hex } from '@agent-kernel/eval-protocol'

import { JournalTransactionSchema, type JournalTransaction } from './model.js'

export class DurableJournal {
  private tail: Promise<void> = Promise.resolve()

  constructor(readonly path: string) {}

  async initialize(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    const handle = await open(this.path, 'a', 0o600)
    await handle.close()
  }

  async readAll(): Promise<JournalTransaction[]> {
    await this.initialize()
    const text = await readFile(this.path, 'utf8')
    const lines = text.split('\n')
    const transactions: JournalTransaction[] = []
    let validBytes = 0
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!
      if (!line) { if (index < lines.length - 1) validBytes += 1; continue }
      try {
        transactions.push(JournalTransactionSchema.parse(JSON.parse(line)))
        validBytes += Buffer.byteLength(line, 'utf8') + (index < lines.length - 1 ? 1 : 0)
      } catch (error) {
        const isTrailingPartial = index === lines.length - 1 && !text.endsWith('\n')
        if (isTrailingPartial) { await truncate(this.path, validBytes); break }
        throw new Error('invalid durable journal record at line ' + String(index + 1), { cause: error })
      }
    }
    for (let index = 0; index < transactions.length; index += 1) {
      if (transactions[index]!.transactionSequence !== index) throw new Error('journal transaction sequence gap at ' + String(index))
      const transaction = transactions[index]!
      const expectedPrevious = index === 0 ? null : transactions[index - 1]!.transactionHash
      if (transaction.previousHash !== expectedPrevious) throw new Error('journal hash chain mismatch at ' + String(index))
      const { transactionHash, ...unsigned } = transaction
      if (await sha256Hex(canonicalJson(unsigned)) !== transactionHash) throw new Error('journal transaction hash mismatch at ' + String(index))
    }
    return transactions
  }

  append(transaction: JournalTransaction): Promise<void> {
    const parsed = JournalTransactionSchema.parse(transaction)
    const action = this.tail.then(async () => {
      const release = await this.acquireWriterFence()
      try {
        const existing = await this.readAll()
        const previous = existing.at(-1)
        if (parsed.transactionSequence !== existing.length || parsed.previousHash !== (previous?.transactionHash ?? null)) throw new Error('journal writer fenced by a newer transaction')
        const handle = await open(this.path, 'a', 0o600)
        try {
          await handle.writeFile(JSON.stringify(parsed) + '\n', 'utf8')
          await handle.sync()
        } finally { await handle.close() }
      } finally { await release() }
    })
    this.tail = action.catch(() => undefined)
    return action
  }

  async compact(transactions: readonly JournalTransaction[]): Promise<void> {
    const temporary = this.path + '.compact'
    const handle = await open(temporary, 'w', 0o600)
    try {
      for (const transaction of transactions) await handle.writeFile(JSON.stringify(JournalTransactionSchema.parse(transaction)) + '\n', 'utf8')
      await handle.sync()
    } finally { await handle.close() }
    await rename(temporary, this.path)
  }

  async bytes(): Promise<number> { return (await stat(this.path)).size }

  async withWriterFence<T>(action: () => Promise<T>): Promise<T> {
    const release = await this.acquireWriterFence()
    try { return await action() } finally { await release() }
  }

  private async acquireWriterFence(): Promise<() => Promise<void>> {
    const lockPath = this.path + '.writer.lock'
    let handle: Awaited<ReturnType<typeof open>>
    try { handle = await open(lockPath, 'wx', 0o600) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      let owner = 0
      try { owner = Number((await readFile(lockPath, 'utf8')).trim()) } catch { /* stale malformed lock */ }
      if (owner > 0) {
        try { process.kill(owner, 0); throw new Error('standalone data directory already has an active writer') }
        catch (ownerError) { if ((ownerError as NodeJS.ErrnoException).code !== 'ESRCH') throw ownerError }
      }
      await rm(lockPath, { force: true })
      try { handle = await open(lockPath, 'wx', 0o600) } catch { throw new Error('standalone data directory already has an active writer') }
    }
    await handle.writeFile(String(process.pid), 'utf8'); await handle.sync()
    return async () => { await handle.close(); await rm(lockPath, { force: true }) }
  }
}
