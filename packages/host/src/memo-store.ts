import { createHash } from 'node:crypto'
import { mkdir, open, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export type MemoDocument = { content: string; revision: number; updatedAt: string }

export class MemoStore {
  private readonly tails = new Map<string, Promise<void>>()
  constructor(private readonly root: string) {}

  async read(owner: string): Promise<MemoDocument> {
    try { return JSON.parse(await readFile(this.path(owner), 'utf8')) as MemoDocument }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { content: '', revision: 0, updatedAt: new Date(0).toISOString() }; throw error }
  }

  async write(owner: string, input: { content: string; expectedRevision?: number }): Promise<MemoDocument> {
    if (Buffer.byteLength(input.content, 'utf8') > 10 * 1024 * 1024) throw new Error('memo_too_large')
    const prior = this.tails.get(owner) ?? Promise.resolve()
    let result!: MemoDocument
    const commit = prior.catch(() => undefined).then(async () => {
      const current = await this.read(owner)
      if (input.expectedRevision !== undefined && current.revision !== input.expectedRevision) throw new Error('memo_revision_conflict')
      result = { content: input.content, revision: current.revision + 1, updatedAt: new Date().toISOString() }
      const path = this.path(owner); await mkdir(dirname(path), { recursive: true })
      const temp = `${path}.tmp-${process.pid}-${Date.now()}`
      await writeFile(temp, `${JSON.stringify(result)}\n`, { mode: 0o600 })
      const handle = await open(temp, 'r'); try { await handle.sync() } finally { await handle.close() }
      await rename(temp, path)
    })
    this.tails.set(owner, commit)
    try { await commit; return result } finally { if (this.tails.get(owner) === commit) this.tails.delete(owner) }
  }

  private path(owner: string): string { return join(this.root, `${createHash('sha256').update(owner).digest('hex')}.json`) }
}
