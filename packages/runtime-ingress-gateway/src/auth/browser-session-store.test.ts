import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { browserDeviceFromUserAgent, browserSessionTokenHash, FileBrowserSessionStore } from './browser-session-store.js'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function createStore(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'browser-sessions-')); dirs.push(dir)
  const path = join(dir, 'sessions.json')
  return { path, store: new FileBrowserSessionStore(path, options) }
}

function input(token: string, now = Date.now(), issuer = 'https://id.example', subject = 'alice') {
  return {
    tokenHash: browserSessionTokenHash(token),
    identity: { issuer, subject, displayName: 'Alice' },
    cacheNamespace: 'cache-alice',
    device: { label: 'Chrome on Linux' },
    createdAt: now,
    idleExpiresAt: now + 1_000,
    absoluteExpiresAt: now + 10_000,
  }
}

describe('FileBrowserSessionStore', () => {
  it('persists only token hashes and survives restart', async () => {
    const { path, store } = createStore()
    const session = await store.create(input('plain-secret'))
    expect(await store.findByTokenHash(browserSessionTokenHash('plain-secret'))).toEqual(session)
    expect(readFileSync(path, 'utf8')).not.toContain('plain-secret')
    const reloaded = new FileBrowserSessionStore(path)
    await reloaded.load()
    expect((await reloaded.findByTokenHash(browserSessionTokenHash('plain-secret')))?.identity.subject).toBe('alice')
  })

  it('revokes one or every session for exactly one issuer and subject', async () => {
    const { store } = createStore()
    const now = Date.now()
    const current = await store.create(input('a', now))
    const other = await store.create(input('b', now))
    await store.create(input('c', now, 'https://other.example', 'alice'))
    expect(await store.revoke(current.id, 'logout', now + 100)).toBe(true)
    expect(await store.findByTokenHash(browserSessionTokenHash('a'))).toMatchObject({ revokedAt: now + 100 })
    expect(await store.revokeAllForIdentity(other.identity, 'logout_all', now + 200)).toBe(1)
    expect(await store.listForIdentity(other.identity, now + 300)).toHaveLength(0)
    expect(await store.listForIdentity({ issuer: 'https://other.example', subject: 'alice' }, now + 300)).toHaveLength(1)
  })

  it('enforces idle and absolute expiry and caps touch at absolute expiry', async () => {
    const { store } = createStore({ touchPersistenceMs: 0 })
    const now = Date.now()
    const session = await store.create(input('a', now))
    const touched = await store.touch(session.id, now + 500, now + 50_000)
    expect(touched?.idleExpiresAt).toBe(session.absoluteExpiresAt)
    expect(await store.touch(session.id, session.absoluteExpiresAt, now + 60_000)).toBeUndefined()
  })

  it('prunes expired records and enforces capacity', async () => {
    const { store } = createStore({ maxEntries: 1 })
    await store.create(input('a'))
    await expect(store.create(input('b'))).rejects.toThrow('too many browser sessions')
    const expiredAt = Date.now() + 20_000
    expect(await store.prune(expiredAt)).toBe(1)
    await expect(store.create(input('b', expiredAt))).resolves.toBeTruthy()
  })
})

describe('browserDeviceFromUserAgent', () => {
  it('derives a bounded server-owned device label', () => {
    const userAgent = 'Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 Version/18 Safari/604.1'
    expect(browserDeviceFromUserAgent(userAgent)).toMatchObject({ label: 'Safari on iPhone or iPad' })
    expect(browserDeviceFromUserAgent('x'.repeat(500)).userAgent).toHaveLength(256)
  })
})
