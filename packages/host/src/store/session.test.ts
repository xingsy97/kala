/**
 * SessionStore tests. Focused on the concurrent-create race that made
 * two dashboard+executor sockets land two different log files on disk for
 * the same sessionId (see docs/adversarial-review-2026-07-04.md, B8).
 */

import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createConfig } from '@agent-kernel/kernel'

import { SessionStore } from './session.js'

const config = createConfig({ tools: [], systemPrompt: 'sys' })

describe('SessionStore.ensure', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ak-store-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('returns the same record for concurrent callers and writes ONE log file', async () => {
    // The race: dashboard + executor sockets arrive in the same tick, both
    // find no cached record, both fail to load, both call create() with a
    // filename that embeds `new Date().toISOString()` — producing TWO
    // distinct files on disk and TWO in-memory records (last write wins).
    const store = new SessionStore(dir)
    const sessionId = 'sess-race'

    const [a, b, c] = await Promise.all([
      store.ensure({ sessionId, defaultConfig: config }),
      store.ensure({ sessionId, defaultConfig: config }),
      store.ensure({ sessionId, defaultConfig: config }),
    ])

    expect(a).toBe(b)
    expect(b).toBe(c)
    expect(store.get(sessionId)).toBe(a)

    // Most important assertion: exactly one log file on disk. Before the
    // fix this was 3.
    const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(new RegExp(`_${sessionId}\\.jsonl$`))
  })

  it('serialises ensure vs load for the same id', async () => {
    // A caller who does `load` while `ensure` is mid-create must observe
    // the same record — not throw "unknown session".
    const store = new SessionStore(dir)
    const sessionId = 'sess-mixed'

    const p1 = store.ensure({ sessionId, defaultConfig: config })
    const p2 = store.load(sessionId)

    const [a, b] = await Promise.all([p1, p2])
    expect(a).toBe(b)
  })

  it('returns the cached record on subsequent calls without touching disk', async () => {
    const store = new SessionStore(dir)
    const rec = await store.ensure({
      sessionId: 'sess-cached',
      defaultConfig: config,
    })
    const filesBefore = readdirSync(dir).length
    const again = await store.ensure({
      sessionId: 'sess-cached',
      defaultConfig: config,
    })
    expect(again).toBe(rec)
    expect(readdirSync(dir).length).toBe(filesBefore)
  })

  it('reloads a persisted session from disk instead of creating anew', async () => {
    // First instance creates the log; a fresh store rehydrates from disk.
    const store1 = new SessionStore(dir)
    const rec1 = await store1.ensure({
      sessionId: 'sess-persist',
      defaultConfig: config,
    })
    const filesAfterFirst = readdirSync(dir).length
    expect(filesAfterFirst).toBe(1)

    const store2 = new SessionStore(dir)
    const rec2 = await store2.ensure({
      sessionId: 'sess-persist',
      defaultConfig: config,
    })
    expect(rec2.sessionId).toBe(rec1.sessionId)
    // No second file was created.
    expect(readdirSync(dir).length).toBe(1)
  })
})
