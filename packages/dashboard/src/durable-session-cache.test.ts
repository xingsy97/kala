import 'fake-indexeddb/auto'

import { createInitialState } from '@agent-kernel/kernel'
import { openDB } from 'idb'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createDurableSessionViewCache, sessionCacheNamespace } from './durable-session-cache.js'

let priorScheduler: unknown
beforeEach(() => {
  priorScheduler = (globalThis as { scheduler?: unknown }).scheduler
  ;(globalThis as { scheduler?: { postTask<T>(callback: () => T | Promise<T>): Promise<T> } }).scheduler = { postTask: async (callback) => await callback() }
})
afterEach(() => {
  if (priorScheduler === undefined) delete (globalThis as { scheduler?: unknown }).scheduler
  else (globalThis as { scheduler?: unknown }).scheduler = priorScheduler
})

describe('durable session cache', () => {
  it('hydrates a snapshot across cache instances and partitions hosts', async () => {
    const namespace = sessionCacheNamespace(`https://host-a-${crypto.randomUUID()}.test/`, '1')
    const database = immediateDatabase()
    const first = createDurableSessionViewCache({ namespace, maxBytes: 1024 * 1024, enabled: true, openDatabase: database.open })
    first.set('s1', snapshot('s1', 3))
    await first.flush()

    const second = createDurableSessionViewCache({ namespace, maxBytes: 1024 * 1024, enabled: true, openDatabase: database.open })
    expect((await second.hydrate('s1'))?.timeline.at(-1)?.seq).toBe(3)

    const otherHost = createDurableSessionViewCache({ namespace: sessionCacheNamespace('https://host-b.test', '1'), maxBytes: 1024 * 1024, enabled: true, openDatabase: database.open })
    expect(await otherHost.hydrate('s1')).toBeNull()
    first.close(); second.close(); otherHost.close()
  })

  it('does not let an older tab overwrite a newer cursor', async () => {
    const namespace = sessionCacheNamespace(`https://host-${crypto.randomUUID()}.test`, '1')
    const database = immediateDatabase()
    const first = createDurableSessionViewCache({ namespace, maxBytes: 1024 * 1024, enabled: true, openDatabase: database.open })
    const stale = createDurableSessionViewCache({ namespace, maxBytes: 1024 * 1024, enabled: true, openDatabase: database.open })
    first.set('s1', snapshot('s1', 8))
    await first.flush()
    stale.set('s1', snapshot('s1', 3))
    await stale.flush()
    const reader = createDurableSessionViewCache({ namespace, maxBytes: 1024 * 1024, enabled: true, openDatabase: database.open })
    expect((await reader.hydrate('s1'))?.timeline.at(-1)?.seq).toBe(8)
    first.close(); stale.close(); reader.close()
  })

  it('clears durable data while disabled but keeps the current memory snapshot', async () => {
    const namespace = sessionCacheNamespace(`https://host-${crypto.randomUUID()}.test`, '1')
    const cache = createDurableSessionViewCache({ namespace, maxBytes: 1024 * 1024, enabled: true })
    cache.set('s1', snapshot('s1', 1))
    await cache.flush()
    cache.setEnabled(false)
    expect(cache.get('s1')).not.toBeNull()
    expect(await cache.durableStats()).toEqual({ sessions: 0, estimatedBytes: 0, maxBytes: 1024 * 1024 })
    await cache.flush()
    const reader = createDurableSessionViewCache({ namespace, maxBytes: 1024 * 1024, enabled: true })
    expect(await reader.hydrate('s1')).toBeNull()
    reader.close()
    cache.close()
  })

  it('does not resurrect a session deleted while its database write is opening', async () => {
    const namespace = sessionCacheNamespace(`https://host-${crypto.randomUUID()}.test`, '1')
    const delayed = delayedDatabase()
    const cache = createDurableSessionViewCache({ namespace, maxBytes: 1024 * 1024, enabled: true, openDatabase: delayed.open })
    cache.set('s1', snapshot('s1', 1))
    await nextTask()
    cache.delete('s1')
    delayed.release()
    await cache.flush()

    const reader = createDurableSessionViewCache({ namespace, maxBytes: 1024 * 1024, enabled: true, openDatabase: delayed.open })
    expect(await reader.hydrate('s1')).toBeNull()
    cache.close(); reader.close()
  })

  it('leaves the namespace empty when cleared during an in-flight write', async () => {
    const namespace = sessionCacheNamespace(`https://host-${crypto.randomUUID()}.test`, '1')
    const delayed = delayedDatabase()
    const cache = createDurableSessionViewCache({ namespace, maxBytes: 1024 * 1024, enabled: true, openDatabase: delayed.open })
    cache.set('s1', snapshot('s1', 1))
    await nextTask()
    const clearing = cache.clearDurable()
    delayed.release()
    await clearing
    await cache.flush()

    const reader = createDurableSessionViewCache({ namespace, maxBytes: 1024 * 1024, enabled: true, openDatabase: delayed.open })
    expect(await reader.hydrate('s1')).toBeNull()
    cache.close(); reader.close()
  })

  it('disabling during an in-flight write preserves memory and clears durable data', async () => {
    const namespace = sessionCacheNamespace(`https://host-${crypto.randomUUID()}.test`, '1')
    const delayed = delayedDatabase()
    const cache = createDurableSessionViewCache({ namespace, maxBytes: 1024 * 1024, enabled: true, openDatabase: delayed.open })
    cache.set('s1', snapshot('s1', 1))
    await nextTask()
    cache.setEnabled(false)
    delayed.release()
    await cache.flush()
    expect(cache.get('s1')).not.toBeNull()

    const reader = createDurableSessionViewCache({ namespace, maxBytes: 1024 * 1024, enabled: true, openDatabase: delayed.open })
    expect(await reader.hydrate('s1')).toBeNull()
    cache.close(); reader.close()
  })
})

function immediateDatabase() {
  const database = openDB(`session-cache-test-${crypto.randomUUID()}`, 1, {
    upgrade(db) {
      const store = db.createObjectStore('sessions', { keyPath: 'key' })
      store.createIndex('namespace', 'namespace')
      store.createIndex('cachedAt', 'cachedAt')
    },
  })
  return { open: async () => database as never }
}

function delayedDatabase() {
  let release!: () => void
  const barrier = new Promise<void>((resolve) => { release = resolve })
  const database = openDB(`session-cache-test-${crypto.randomUUID()}`, 1, {
    upgrade(db) {
      const store = db.createObjectStore('sessions', { keyPath: 'key' })
      store.createIndex('namespace', 'namespace')
      store.createIndex('cachedAt', 'cachedAt')
    },
  })
  return {
    release,
    open: async () => {
      await barrier
      return database as never
    },
  }
}

async function nextTask(): Promise<void> {
  await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
}

function snapshot(sessionId: string, cursor: number) {
  return {
    sessionId, status: 'ready' as const, state: createInitialState({ sessionId }),
    config: { systemPrompt: 'test', tools: [] }, contextSnapshot: null,
    timeline: [{ seq: cursor, ts: new Date(0).toISOString(), event: { kind: 'user_message' as const, message: { role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] } }, effects: [] }],
    queuedMessages: [], lastError: null, parentSessionId: null, parentCursor: null, selectedModel: null, hydratedSessionId: sessionId,
  }
}
