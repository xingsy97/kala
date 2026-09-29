import { createCipheriv, createHash, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'

import { KalaStateStore } from './state-store.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'kala-state-store-'))
  roots.push(value)
  return value
}

describe('KalaStateStore', () => {
  it('persists memo revisions transactionally across store instances', () => {
    const directory = root()
    const first = new KalaStateStore(directory)
    const second = new KalaStateStore(directory)
    expect(first.writeMemo('owner', { content: 'one', expectedRevision: 0 }).revision).toBe(1)
    expect(() => second.writeMemo('owner', { content: 'stale', expectedRevision: 0 })).toThrow('memo_revision_conflict')
    expect(second.readMemo('owner')).toMatchObject({ content: 'one', revision: 1 })
    first.close()
    second.close()
  })

  it('encrypts credentials with an external key and fails closed after tampering', () => {
    const directory = root()
    const keyPath = join(directory, 'keys', 'master.key')
    const state = new KalaStateStore(join(directory, 'state'), { keyPath })
    state.setCredential('serper', 'secret-value', { provider: 'serper' })
    expect(readFileSync(join(directory, 'state', 'state.sqlite')).toString('utf8')).not.toContain('secret-value')
    expect(readFileSync(keyPath)).toHaveLength(32)
    expect(state.getCredential('serper')?.secret).toBe('secret-value')
    state.close()

    const database = new DatabaseSync(join(directory, 'state', 'state.sqlite'))
    database.prepare("UPDATE credentials SET auth_tag = ? WHERE provider = 'serper'").run(Buffer.alloc(16))
    database.close()
    expect(() => new KalaStateStore(join(directory, 'state'), { keyPath }).getCredential('serper')).toThrow()
  })

  it('lazily imports legacy memos without deleting rollback data', () => {
    const directory = root()
    const memos = join(directory, 'memos')
    mkdirSync(memos)
    const owner = 'principal:memo'
    const name = createHash('sha256').update(owner).digest('hex')
    writeFileSync(join(memos, `${name}.json`), JSON.stringify({ content: 'legacy', revision: 7, updatedAt: '2026-09-29T00:00:00.000Z' }))
    const state = new KalaStateStore(directory, { legacyMemoDirectory: memos })
    expect(state.readMemo(owner)).toEqual({ content: 'legacy', revision: 7, updatedAt: '2026-09-29T00:00:00.000Z' })
    expect(readFileSync(join(memos, `${name}.json`), 'utf8')).toContain('legacy')
  })

  it('imports legacy encrypted Search credentials once', () => {
    const directory = root()
    const credentials = join(directory, 'credentials')
    mkdirSync(credentials)
    const legacyKey = randomBytes(32)
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', legacyKey, iv)
    cipher.setAAD(Buffer.from('agent-runlab:web-search-credential:v1:serper'))
    const ciphertext = Buffer.concat([cipher.update('legacy-secret', 'utf8'), cipher.final()])
    writeFileSync(join(credentials, 'master.key'), legacyKey)
    writeFileSync(join(credentials, 'web-search.json'), JSON.stringify({
      version: 1,
      provider: 'serper',
      iv: iv.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      updatedAt: '2026-09-29T00:00:00.000Z',
    }))
    const state = new KalaStateStore(directory, { legacyCredentialDirectory: credentials })
    expect(state.getCredential('serper')?.secret).toBe('legacy-secret')
    writeFileSync(join(credentials, 'web-search.json'), '{broken')
    expect(state.getCredential('serper')?.secret).toBe('legacy-secret')
  })
})
