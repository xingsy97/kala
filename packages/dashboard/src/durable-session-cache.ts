import { deleteDB, openDB, type DBSchema, type IDBPDatabase } from 'idb'

import { scheduleBackground, type ScheduledTask } from './lib/scheduler.js'
import type { CachedSessionView, CachedSessionViewInput, SessionViewCache } from './session-view-cache.js'
import { createSessionViewCache } from './session-view-cache.js'

const DB_NAME = 'agent-runlab-session-cache'
const DB_VERSION = 1
export const DURABLE_SESSION_CACHE_SCHEMA_VERSION = 1

type StoredSessionView = CachedSessionView & { key: string; namespace: string; cursor: number }

interface SessionCacheDb extends DBSchema {
  sessions: {
    key: string
    value: StoredSessionView
    indexes: { namespace: string; cachedAt: number }
  }
}

export type DurableSessionCacheStats = { sessions: number; estimatedBytes: number; maxBytes: number }

export type DurableSessionViewCache = SessionViewCache & {
  hydrate(sessionId: string): Promise<CachedSessionView | null>
  flush(): Promise<void>
  durableStats(): Promise<DurableSessionCacheStats>
  clearDurable(): Promise<void>
  setEnabled(enabled: boolean): void
  close(): void
}

export function sessionCacheNamespace(host: string, protocolVersion: string): string {
  let normalized = host.trim().replace(/\/+$/, '')
  try {
    const url = new URL(normalized, window.location.href)
    normalized = `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`
  } catch {}
  return `v${DURABLE_SESSION_CACHE_SCHEMA_VERSION}:${protocolVersion}:${normalized}`
}

export function createDurableSessionViewCache(options: {
  namespace: string
  maxBytes: number
  enabled: boolean
  openDatabase?: () => Promise<IDBPDatabase<SessionCacheDb>>
}): DurableSessionViewCache {
  const memory = createSessionViewCache({ maxBytes: options.maxBytes })
  let maxBytes = options.maxBytes
  let enabled = options.enabled
  let closed = false
  let cacheGeneration = 0
  let dbPromise: Promise<IDBPDatabase<SessionCacheDb>> | null = null
  const pendingWrites = new Map<string, ScheduledTask<void>>()
  const activeOperations = new Set<Promise<unknown>>()
  const sessionGenerations = new Map<string, number>()
  let mutationBarrier = Promise.resolve()
  const openDatabase = options.openDatabase ?? openSessionCacheDb
  const db = (): Promise<IDBPDatabase<SessionCacheDb>> => {
    dbPromise ??= openDatabase()
    return dbPromise
  }
  const key = (sessionId: string): string => `${options.namespace}:${sessionId}`
  const sessionGeneration = (sessionId: string): number => sessionGenerations.get(sessionId) ?? 0
  const invalidateSession = (sessionId: string): void => {
    sessionGenerations.set(sessionId, sessionGeneration(sessionId) + 1)
  }
  const track = <T>(operation: Promise<T>): Promise<T> => {
    activeOperations.add(operation)
    void operation.catch(() => {}).finally(() => activeOperations.delete(operation))
    return operation
  }
  const enqueueMutation = (operation: () => Promise<void>): Promise<void> => {
    const queued = mutationBarrier.catch(() => {}).then(operation)
    mutationBarrier = queued
    return track(queued)
  }
  const cancelPendingWrites = (): void => {
    for (const task of pendingWrites.values()) task.cancel()
    pendingWrites.clear()
  }
  const clearNamespace = async (): Promise<void> => {
    try {
      const database = await db()
      const tx = database.transaction('sessions', 'readwrite')
      let cursor = await tx.store.index('namespace').openCursor(options.namespace)
      while (cursor) {
        await cursor.delete()
        cursor = await cursor.continue()
      }
      await tx.done
    } catch {}
  }

  const persist = (entry: CachedSessionView): void => {
    if (!enabled || closed) return
    pendingWrites.get(entry.sessionId)?.cancel()
    const expectedCacheGeneration = cacheGeneration
    const expectedSessionGeneration = sessionGeneration(entry.sessionId)
    const task = scheduleBackground(async (signal) => {
      const isCurrent = (): boolean => !signal.aborted
        && !closed
        && enabled
        && cacheGeneration === expectedCacheGeneration
        && sessionGeneration(entry.sessionId) === expectedSessionGeneration
      if (!isCurrent()) return
      await mutationBarrier.catch(() => {})
      if (!isCurrent()) return
      const database = await db()
      if (!isCurrent()) return
      const entryKey = key(entry.sessionId)
      const tx = database.transaction('sessions', 'readwrite')
      const existing = await tx.store.get(entryKey)
      // Copilot sessions intentionally have no Kernel timeline. Include the
      // projected state/timing cursors so a stale tab cannot overwrite a newer
      // durable snapshot with an apparent cursor of zero.
      const cursor = Math.max(
        entry.timeline.at(-1)?.seq ?? 0,
        entry.state?.cursor ?? 0,
        entry.turnStartedAtCursor ?? 0,
      )
      if (!isCurrent() || (existing && existing.cursor > cursor)) {
        await tx.done
        return
      }
      await tx.store.put({ ...entry, key: entryKey, namespace: options.namespace, cursor })
      await tx.done
      if (!isCurrent()) return
      await enforceDurableLimit(database, options.namespace, maxBytes)
    })
    pendingWrites.set(entry.sessionId, task)
    track(task.promise)
    void task.promise.finally(() => {
      if (pendingWrites.get(entry.sessionId) === task) pendingWrites.delete(entry.sessionId)
    }).catch(() => {})
  }

  const clearDurableState = (clearMemory: boolean): Promise<void> => {
    cacheGeneration += 1
    cancelPendingWrites()
    if (clearMemory) memory.clear()
    return enqueueMutation(clearNamespace)
  }

  return {
    get: memory.get,
    peek: memory.peek,
    subscribe: memory.subscribe,
    set(sessionId, input) {
      invalidateSession(sessionId)
      const entry = memory.set(sessionId, input)
      if (entry) persist(entry)
      return entry
    },
    patch(sessionId, patch) {
      invalidateSession(sessionId)
      const entry = memory.patch(sessionId, patch)
      if (entry) persist(entry)
      return entry
    },
    delete(sessionId) {
      memory.delete(sessionId)
      invalidateSession(sessionId)
      pendingWrites.get(sessionId)?.cancel()
      pendingWrites.delete(sessionId)
      if (enabled && !closed) {
        enqueueMutation(async () => {
          await (await db()).delete('sessions', key(sessionId))
        })
      }
    },
    clear() {
      memory.clear()
      void this.clearDurable()
    },
    setMaxBytes(next) {
      maxBytes = Math.max(0, Math.round(next))
      memory.setMaxBytes(maxBytes)
      if (enabled && !closed) {
        track(mutationBarrier.catch(() => {}).then(async () => {
          if (enabled && !closed) await enforceDurableLimit(await db(), options.namespace, maxBytes)
        }))
      }
    },
    stats: memory.stats,
    async hydrate(sessionId) {
      const inMemory = memory.get(sessionId)
      if (inMemory || !enabled || closed) return inMemory
      const expectedCacheGeneration = cacheGeneration
      const expectedSessionGeneration = sessionGeneration(sessionId)
      try {
        await mutationBarrier.catch(() => {})
        const stored = await (await db()).get('sessions', key(sessionId))
        const current = memory.get(sessionId)
        if (current) return current
        if (!enabled || closed || cacheGeneration !== expectedCacheGeneration || sessionGeneration(sessionId) !== expectedSessionGeneration) return null
        if (!isStoredSessionView(stored, options.namespace, sessionId)) {
          if (stored) await (await db()).delete('sessions', key(sessionId))
          return null
        }
        const hydrated = memory.set(sessionId, { ...stored, cachedAt: Date.now() })
        if (hydrated) persist(hydrated)
        return hydrated
      } catch {
        return null
      }
    },
    async flush() {
      while (activeOperations.size > 0) {
        await Promise.allSettled([...activeOperations])
      }
    },
    async durableStats() {
      if (!enabled) return { sessions: 0, estimatedBytes: 0, maxBytes }
      const entries = await entriesForNamespace(await db(), options.namespace)
      return { sessions: entries.length, estimatedBytes: entries.reduce((sum, entry) => sum + entry.estimatedBytes, 0), maxBytes }
    },
    async clearDurable() {
      await clearDurableState(true)
    },
    setEnabled(next) {
      if (closed || enabled === next) return
      enabled = next
      if (!next) {
        void clearDurableState(false)
      }
    },
    close() {
      if (closed) return
      closed = true
      cacheGeneration += 1
      cancelPendingWrites()
      void (async () => {
        while (activeOperations.size > 0) await Promise.allSettled([...activeOperations])
        const opened = await dbPromise
        opened?.close()
      })().catch(() => {})
    },
  }
}

export async function deleteAllDurableSessionCaches(): Promise<void> {
  await deleteDB(DB_NAME)
}

async function openSessionCacheDb(): Promise<IDBPDatabase<SessionCacheDb>> {
  return openDB<SessionCacheDb>(DB_NAME, DB_VERSION, {
    upgrade(database) {
      const store = database.createObjectStore('sessions', { keyPath: 'key' })
      store.createIndex('namespace', 'namespace')
      store.createIndex('cachedAt', 'cachedAt')
    },
  })
}

async function entriesForNamespace(database: IDBPDatabase<SessionCacheDb>, namespace: string): Promise<StoredSessionView[]> {
  return database.getAllFromIndex('sessions', 'namespace', namespace)
}

async function enforceDurableLimit(database: IDBPDatabase<SessionCacheDb>, namespace: string, maxBytes: number): Promise<void> {
  const entries = (await entriesForNamespace(database, namespace)).sort((a, b) => a.cachedAt - b.cachedAt)
  let total = entries.reduce((sum, entry) => sum + entry.estimatedBytes, 0)
  for (const entry of entries) {
    if (total <= maxBytes && maxBytes > 0) break
    await database.delete('sessions', entry.key)
    total -= entry.estimatedBytes
  }
}

function isStoredSessionView(value: unknown, namespace: string, sessionId: string): value is StoredSessionView {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<StoredSessionView>
  return candidate.namespace === namespace
    && candidate.sessionId === sessionId
    && Array.isArray(candidate.timeline)
    && typeof candidate.estimatedBytes === 'number'
    && typeof candidate.cachedAt === 'number'
}
