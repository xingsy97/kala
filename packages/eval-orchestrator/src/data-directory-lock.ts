import { AsyncLocalStorage } from 'node:async_hooks'
import { open, readFile, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

const heldLocks = new AsyncLocalStorage<ReadonlySet<string>>()
const localTails = new Map<string, Promise<void>>()

/**
 * Cross-process exclusive fence for standalone data-directory mutations.
 * Maintenance holds this fence for its complete journal + artifact boundary;
 * normal journal and artifact operations take the same fence briefly.
 */
export async function withDataDirectoryLock<T>(dataDirectory: string, action: () => Promise<T>): Promise<T> {
  const root = resolve(dataDirectory)
  if (heldLocks.getStore()?.has(root)) return await action()
  const previous = localTails.get(root) ?? Promise.resolve()
  let releaseLocal!: () => void
  const current = new Promise<void>((resolveTail) => { releaseLocal = resolveTail })
  localTails.set(root, current)
  await previous
  try { return await acquireDataDirectoryLock(root, action) }
  finally { releaseLocal(); if (localTails.get(root) === current) localTails.delete(root) }
}

async function acquireDataDirectoryLock<T>(root: string, action: () => Promise<T>): Promise<T> {
  const lockPath = join(root, '.offline-maintenance.lock')
  let handle: Awaited<ReturnType<typeof open>>
  try { handle = await open(lockPath, 'wx', 0o600) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    let owner = 0
    try { owner = Number((await readFile(lockPath, 'utf8')).trim()) } catch { /* malformed stale lock */ }
    if (owner > 0) {
      try { process.kill(owner, 0); throw new Error('standalone data directory is locked by an active operation') }
      catch (ownerError) { if ((ownerError as NodeJS.ErrnoException).code !== 'ESRCH') throw ownerError }
    }
    await rm(lockPath, { force: true })
    try { handle = await open(lockPath, 'wx', 0o600) } catch { throw new Error('standalone data directory is locked by an active operation') }
  }
  await handle.writeFile(String(process.pid), 'utf8'); await handle.sync()
  try {
    const locks = new Set(heldLocks.getStore() ?? []); locks.add(root)
    return await heldLocks.run(locks, action)
  } finally {
    await handle.close()
    await rm(lockPath, { force: true })
  }
}

export function dataDirectoryForJournal(journalPath: string): string { return dirname(resolve(journalPath)) }
export function dataDirectoryForArtifacts(artifactRoot: string): string { return dirname(resolve(artifactRoot)) }
