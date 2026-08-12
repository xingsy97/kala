import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { LocalWebSearchCredentialStore } from './credential-store.js'

const TEST_KEY = 'test-serper-credential-value'

describe('LocalWebSearchCredentialStore', () => {
  it('encrypts credentials, applies private permissions, and survives restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'web-search-credentials-'))
    const directory = join(root, 'credentials')
    const store = new LocalWebSearchCredentialStore(directory)

    expect(await store.status()).toEqual({ configured: false, provider: 'serper' })
    const status = await store.set('serper', TEST_KEY)
    expect(status).toMatchObject({ configured: true, provider: 'serper' })

    const encrypted = await readFile(join(directory, 'web-search.json'), 'utf8')
    expect(encrypted).not.toContain(TEST_KEY)
    expect((await readFile(join(directory, 'master.key'))).length).toBe(32)
    if (process.platform !== 'win32') {
      expect((await stat(directory)).mode & 0o777).toBe(0o700)
      expect((await stat(join(directory, 'master.key'))).mode & 0o777).toBe(0o600)
      expect((await stat(join(directory, 'web-search.json'))).mode & 0o777).toBe(0o600)
    }

    const restarted = new LocalWebSearchCredentialStore(directory)
    expect(await restarted.get('serper')).toBe(TEST_KEY)
    expect(await restarted.status()).toEqual(status)
    expect(await restarted.delete('serper')).toEqual({ configured: false, provider: 'serper' })
    expect(await restarted.get('serper')).toBeUndefined()
  })
})
