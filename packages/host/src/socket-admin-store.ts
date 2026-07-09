import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export type SocketAdminRecord = {
  version: 1
  username: string
  passwordHash: string
  createdAt: string
  mode?: 'development' | 'production'
}

export type SocketAdminStore = {
  readonly path: string
  load(): SocketAdminRecord | null
  initialize(input: { username: string; passwordHash: string; createdAt?: string; mode?: 'development' | 'production' }): SocketAdminRecord
  updateMode(mode: 'development' | 'production'): SocketAdminRecord
}

export function createSocketAdminStore(path: string): SocketAdminStore {
  return {
    path,
    load() {
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<SocketAdminRecord>
        if (parsed.version !== 1) return null
        if (typeof parsed.username !== 'string' || typeof parsed.passwordHash !== 'string' || typeof parsed.createdAt !== 'string') return null
        const mode = parsed.mode === 'development' || parsed.mode === 'production' ? parsed.mode : undefined
        return { version: 1, username: parsed.username, passwordHash: parsed.passwordHash, createdAt: parsed.createdAt, ...(mode ? { mode } : {}) }
      } catch (err) {
        if (isMissingFile(err)) return null
        throw err
      }
    },
    initialize(input) {
      if (this.load()) throw new Error('Socket.IO Admin UI password is already initialized')
      const record: SocketAdminRecord = {
        version: 1,
        username: input.username,
        passwordHash: input.passwordHash,
        createdAt: input.createdAt ?? new Date().toISOString(),
        ...(input.mode ? { mode: input.mode } : {}),
      }
      writeRecord(path, record)
      return record
    },
    updateMode(mode) {
      const current = this.load()
      if (!current) throw new Error('Socket.IO Admin UI password is not initialized')
      const record: SocketAdminRecord = { ...current, mode }
      writeRecord(path, record)
      return record
    },
  }
}

function writeRecord(path: string, record: SocketAdminRecord): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, path)
}

function isMissingFile(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && 'code' in err && (err as { code?: unknown }).code === 'ENOENT')
}
