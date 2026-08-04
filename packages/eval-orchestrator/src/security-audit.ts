import { open, readFile } from 'node:fs/promises'

import { canonicalJson, sha256Hex } from '@agent-kernel/eval-protocol'

export type SecurityReloadAuditEntry = {
  schemaVersion: 1
  sequence: number
  at: string
  actorId: string
  outcome: 'succeeded' | 'failed'
  generation: number
  configDigest?: string
  previousHash: string | null
  entryHash: string
}

export class SecurityReloadAuditLog {
  private tail: Promise<void> = Promise.resolve()
  constructor(readonly path: string) {}

  readAll(): Promise<SecurityReloadAuditEntry[]> {
    return this.enqueue(async () => await this.readVerified())
  }

  append(input: Omit<SecurityReloadAuditEntry, 'schemaVersion' | 'sequence' | 'previousHash' | 'entryHash'>): Promise<SecurityReloadAuditEntry> {
    return this.enqueue(async () => {
      const existing = await this.readVerified(); const previous = existing.at(-1)
      const unsigned = { schemaVersion: 1 as const, sequence: existing.length, ...input, previousHash: previous?.entryHash ?? null }
      const entry = { ...unsigned, entryHash: await sha256Hex(canonicalJson(unsigned)) }
      const handle = await open(this.path, 'a', 0o600)
      try { await handle.writeFile(JSON.stringify(entry) + '\n'); await handle.sync() } finally { await handle.close() }
      return entry
    })
  }

  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    const result = this.tail.then(action)
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }

  private async readVerified(): Promise<SecurityReloadAuditEntry[]> {
    let text: string
    try { text = await readFile(this.path, 'utf8') } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
    const entries = text.trim() ? text.trimEnd().split('\n').map((line) => JSON.parse(line) as SecurityReloadAuditEntry) : []
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index]!
      if (entry.schemaVersion !== 1 || entry.sequence !== index || entry.previousHash !== (entries[index - 1]?.entryHash ?? null)) throw new Error('security reload audit hash chain mismatch at ' + String(index))
      const { entryHash, ...unsigned } = entry
      if (await sha256Hex(canonicalJson(unsigned)) !== entryHash) throw new Error('security reload audit entry hash mismatch at ' + String(index))
    }
    return entries
  }
}
