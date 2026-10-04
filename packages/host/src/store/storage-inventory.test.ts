import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { STORAGE_INVENTORY_PERSISTENCE_INTERVAL_MS, StorageInventory } from './storage-inventory.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(): { root: string; sessionsDir: string; indexPath: string } {
  const root = mkdtempSync(join(process.cwd(), '.kala-storage-inventory-'))
  roots.push(root)
  const sessionsDir = join(root, 'sessions')
  mkdirSync(sessionsDir)
  return { root, sessionsDir, indexPath: join(root, 'inventory.sqlite') }
}

function log(
  sessionsDir: string,
  slug: string,
  sessionId: string,
  options: { parentSessionId?: string; runtime?: string; tail?: string } = {},
): string {
  const path = join(sessionsDir, `${slug}.jsonl`)
  writeFileSync(path, `${JSON.stringify({
    kind: 'header',
    seq: 0,
    ts: '2026-09-30T00:00:00.000Z',
    sessionId,
    ...(options.parentSessionId ? { parentSessionId: options.parentSessionId } : {}),
    ...(options.runtime ? { agentRuntime: options.runtime } : {}),
  })}\n${options.tail ?? ''}`)
  return path
}

describe('StorageInventory', () => {
  it('coalesces persistence for ten minutes by default', () => {
    expect(STORAGE_INVENTORY_PERSISTENCE_INTERVAL_MS).toBe(600_000)
  })

  it('does not scan sessions on construction or cached queries', () => {
    const { sessionsDir, indexPath } = fixture()
    log(sessionsDir, '2026-09-30_parent', 'parent')
    const inventory = new StorageInventory(sessionsDir, { indexPath })

    expect(inventory.getCachedSession('parent')).toBeUndefined()
    expect(inventory.getCachedGlobal()).toMatchObject({
      totalBytes: 0,
      totalFiles: 0,
      state: { measuredAt: null, generation: 0, stale: true, scan: { status: 'idle' } },
    })
    inventory.close()
  })

  it('persists a stale marker on close and tolerates late advisory invalidation', async () => {
    const { sessionsDir, indexPath } = fixture()
    log(sessionsDir, '2026-09-30_parent', 'parent')
    const inventory = new StorageInventory(sessionsDir, { indexPath })
    await inventory.reconcile()
    expect(inventory.getCachedGlobal().state.stale).toBe(false)

    inventory.close()
    expect(() => inventory.invalidate()).not.toThrow()

    const reopened = new StorageInventory(sessionsDir, { indexPath })
    expect(reopened.getCachedGlobal().state.stale).toBe(true)
    reopened.close()
  })

  it('accounts for root files and reads only a JSONL header during explicit reconcile', async () => {
    const { sessionsDir, indexPath } = fixture()
    const logPath = log(sessionsDir, '2026-09-30_session', 'session', {
      runtime: 'copilot',
      tail: `${'x'.repeat(128 * 1024)}\n`,
    })
    const slug = basename(logPath, '.jsonl')
    writeFileSync(join(sessionsDir, `${slug}.snapshot.json`), 'snapshot')
    writeFileSync(join(sessionsDir, `${slug}.jsonl.summary.json`), 'summary')
    writeFileSync(join(sessionsDir, `${slug}.jsonl.context.json`), 'ctx')
    writeFileSync(join(sessionsDir, 'old.backup'), 'backup')
    writeFileSync(join(sessionsDir, 'broken.jsonl'), '{broken\n')
    writeFileSync(join(sessionsDir, 'notes.txt'), 'other')
    const artifact = join(sessionsDir, 'artifacts', slug, 'tool-catalog')
    mkdirSync(artifact, { recursive: true })
    writeFileSync(join(artifact, 'catalog.json'), 'artifact')

    const inventory = new StorageInventory(sessionsDir, { indexPath, yieldEvery: 1 })
    const result = await inventory.reconcile()
    const session = inventory.getCachedSession('session')

    expect(session).toMatchObject({
      sessionId: 'session',
      runtime: 'copilot',
      categories: {
        jsonl: { bytes: expect.any(Number), files: 1 },
        snapshot: { bytes: 8, files: 1 },
        summary: { bytes: 7, files: 1 },
        context: { bytes: 3, files: 1 },
        'session-artifacts': { bytes: 8, files: 1 },
      },
    })
    expect(result.categories.backup).toEqual({ bytes: 6, files: 1 })
    expect(result.categories.corrupt.files).toBe(1)
    expect(result.categories.other).toEqual({ bytes: 5, files: 1 })
    expect(result.state).toMatchObject({ measuredAt: expect.any(String), generation: 1, scan: { status: 'idle' } })
    inventory.close()
  })

  it('aggregates descendants into parent trees', async () => {
    const { sessionsDir, indexPath } = fixture()
    log(sessionsDir, 'a_parent', 'parent')
    log(sessionsDir, 'b_child', 'child', { parentSessionId: 'parent' })
    log(sessionsDir, 'c_grandchild', 'grandchild', { parentSessionId: 'child' })
    const inventory = new StorageInventory(sessionsDir, { indexPath })
    await inventory.reconcile()

    const parent = inventory.getCachedTree('parent')
    const child = inventory.getCachedTree('child')
    expect(parent?.descendantCount).toBe(2)
    expect(parent?.treeBytes).toBe(
      inventory.getCachedSession('parent')!.directBytes
      + inventory.getCachedSession('child')!.directBytes
      + inventory.getCachedSession('grandchild')!.directBytes,
    )
    expect(child?.descendantCount).toBe(1)
    inventory.close()
  })

  it('classifies artifacts without a matching session slug as orphan candidates', async () => {
    const { sessionsDir, indexPath } = fixture()
    const orphan = join(sessionsDir, 'artifacts', 'missing-session', 'router-decisions')
    mkdirSync(orphan, { recursive: true })
    writeFileSync(join(orphan, 'one.json'), '1234')
    writeFileSync(join(orphan, 'two.json'), '56')
    const inventory = new StorageInventory(sessionsDir, { indexPath })

    const global = await inventory.reconcile()
    expect(global.categories['orphan-artifacts']).toEqual({ bytes: 6, files: 2 })
    expect(global.orphanCandidates).toContainEqual({
      id: 'missing-session',
      category: 'orphan-artifacts',
      bytes: 6,
      files: 2,
    })
    inventory.close()
  })

  it('does not offer artifacts owned by an unreadable session record for cleanup', async () => {
    const { sessionsDir, indexPath } = fixture()
    writeFileSync(join(sessionsDir, 'claimed.jsonl'), '{"kind":"header","sessionId":"unterminated')
    const claimed = join(sessionsDir, 'artifacts', 'claimed')
    mkdirSync(claimed, { recursive: true })
    writeFileSync(join(claimed, 'one.json'), '1234')
    const inventory = new StorageInventory(sessionsDir, { indexPath })

    const global = await inventory.reconcile()

    expect(global.categories.corrupt.files).toBe(1)
    expect(global.categories['session-artifacts']).toEqual({ bytes: 4, files: 1 })
    expect(global.categories['orphan-artifacts']).toEqual({ bytes: 0, files: 0 })
    expect(global.orphanCandidates).not.toContainEqual(expect.objectContaining({
      id: 'claimed',
      category: 'orphan-artifacts',
    }))
    inventory.close()
  })

  it('shows dirty deltas immediately and persists them only when flushed', async () => {
    const { sessionsDir, indexPath } = fixture()
    log(sessionsDir, 'session_slug', 'session')
    const inventory = new StorageInventory(sessionsDir, { indexPath, persistenceIntervalMs: 60_000 })
    await inventory.reconcile()
    inventory.flush()
    const baseline = inventory.getCachedSession('session')!.directBytes

    inventory.markDirty('session', 'jsonl', 25)
    expect(inventory.getCachedSession('session')?.directBytes).toBe(baseline + 25)

    const beforeFlush = new StorageInventory(sessionsDir, { indexPath })
    expect(beforeFlush.getCachedSession('session')?.directBytes).toBe(baseline)
    beforeFlush.close()

    inventory.flush()
    const afterFlush = new StorageInventory(sessionsDir, { indexPath })
    expect(afterFlush.getCachedSession('session')?.directBytes).toBe(baseline + 25)
    expect(afterFlush.getCachedGlobal().state.stale).toBe(false)
    afterFlush.close()
    inventory.close()
  })

  it('invalidates cached measurements without scanning or synchronously persisting', async () => {
    const { sessionsDir, indexPath } = fixture()
    log(sessionsDir, 'session_slug', 'session')
    const inventory = new StorageInventory(sessionsDir, { indexPath, persistenceIntervalMs: 60_000 })
    await inventory.reconcile()
    inventory.flush()

    inventory.invalidate()
    expect(inventory.getCachedGlobal().state).toMatchObject({ measuredAt: null, stale: true })
    expect(inventory.getCachedSession('session')).toBeDefined()

    const beforeFlush = new StorageInventory(sessionsDir, { indexPath })
    expect(beforeFlush.getCachedGlobal().state.stale).toBe(false)
    beforeFlush.close()

    inventory.flush()
    const afterFlush = new StorageInventory(sessionsDir, { indexPath })
    expect(afterFlush.getCachedGlobal().state.stale).toBe(true)
    afterFlush.close()
    inventory.close()
  })

  it('singleflights concurrent reconcile calls', async () => {
    const { sessionsDir, indexPath } = fixture()
    for (let index = 0; index < 20; index += 1) log(sessionsDir, `slug_${index}`, `session-${index}`)
    const inventory = new StorageInventory(sessionsDir, { indexPath, yieldEvery: 1 })

    const first = inventory.reconcile()
    const second = inventory.reconcile()
    expect(second).toBe(first)
    await Promise.all([first, second])
    expect(inventory.getCachedGlobal().state.generation).toBe(1)
    inventory.close()
  })

  it('preserves dirty deltas recorded while reconciliation is yielding', async () => {
    const { sessionsDir, indexPath } = fixture()
    log(sessionsDir, 'session_slug', 'session')
    const inventory = new StorageInventory(sessionsDir, { indexPath, yieldEvery: 1 })
    const reconciliation = inventory.reconcile()
    inventory.markDirty('session', 'jsonl', 4096)
    await reconciliation

    const diskBytes = Buffer.byteLength(readFileSync(join(sessionsDir, 'session_slug.jsonl'), 'utf8'))
    expect(inventory.getCachedSession('session')?.categories.jsonl?.bytes).toBe(diskBytes + 4096)
    inventory.close()
  })

  it('keeps a reconciliation stale when storage is invalidated during the scan', async () => {
    const { sessionsDir, indexPath } = fixture()
    for (let index = 0; index < 20; index += 1) log(sessionsDir, `slug_${index}`, `session-${index}`)
    const inventory = new StorageInventory(sessionsDir, { indexPath, yieldEvery: 1 })

    const reconciliation = inventory.reconcile()
    inventory.invalidate()
    const global = await reconciliation

    expect(global.state).toMatchObject({ measuredAt: null, stale: true, scan: { status: 'idle' } })
    inventory.close()
  })

  it('ignores symlinked files and directories', async () => {
    const { root, sessionsDir, indexPath } = fixture()
    const outside = join(root, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'large.bin'), 'not-counted')
    symlinkSync(join(outside, 'large.bin'), join(sessionsDir, 'linked.jsonl'))
    mkdirSync(join(sessionsDir, 'artifacts'))
    symlinkSync(outside, join(sessionsDir, 'artifacts', 'linked-artifacts'))
    const inventory = new StorageInventory(sessionsDir, { indexPath })

    const global = await inventory.reconcile()
    expect(global.totalBytes).toBe(0)
    expect(global.totalFiles).toBe(0)
    inventory.close()
  })
})
