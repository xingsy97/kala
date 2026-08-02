import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FileLoginStateStore } from './login-state-store.js'
const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))
describe('FileLoginStateStore', () => {
  it('survives restart and consumes PKCE state only once', async () => {
    const root = await mkdtemp(join(tmpdir(), 'login-state-')); roots.push(root); const path = join(root, 'states.json')
    const store = new FileLoginStateStore(path); await store.put('nonce', { codeVerifier: 'v', state: 's', redirectUri: 'http://x', expiresAt: Date.now() + 60_000 })
    const restored = new FileLoginStateStore(path); await restored.load()
    await expect(restored.take('nonce')).resolves.toMatchObject({ state: 's' })
    await expect(restored.take('nonce')).resolves.toBeUndefined()
  })
})
