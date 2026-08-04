import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { BearerTokenAuthenticator, loadBearerAuthConfig, requirePrincipal } from './auth.js'

const principal = { schemaVersion: 1 as const, principalId: 'viewer-one', kind: 'user' as const, role: 'viewer' as const, scopes: ['platform:read' as const] }

describe('bearer authentication', () => {
  it('rejects malformed, incorrect, and duplicate bearer tokens', () => {
    const authenticator = new BearerTokenAuthenticator({ schemaVersion: 1, keys: [{ key: 'correct-token', principal }] })
    for (const authorization of [undefined, '', 'Basic correct-token', 'Bearer', 'Bearer correct-token extra', 'bearer correct-token', 'Bearer wrong-token']) {
      expect(() => requirePrincipal(authenticator, authorization, 'platform:read')).toThrow('valid Bearer')
    }
    expect(() => new BearerTokenAuthenticator({ schemaVersion: 1, keys: [{ key: 'duplicate', principal }, { key: 'duplicate', principal }] })).toThrow('duplicate bearer key')
  })

  it('loads replaced token configuration without retaining revoked tokens', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'eval-auth-'))
    const path = join(directory, 'auth.json')
    await writeFile(path, JSON.stringify({ schemaVersion: 1, keys: [{ key: 'old-token', principal }] }))
    const oldAuthenticator = new BearerTokenAuthenticator(await loadBearerAuthConfig(path))
    await writeFile(path, JSON.stringify({ schemaVersion: 1, keys: [{ key: 'new-token', principal }] }))
    const rotatedAuthenticator = new BearerTokenAuthenticator(await loadBearerAuthConfig(path))
    expect(oldAuthenticator.authenticate('Bearer old-token')).toEqual(principal)
    expect(rotatedAuthenticator.authenticate('Bearer old-token')).toBeUndefined()
    expect(rotatedAuthenticator.authenticate('Bearer new-token')).toEqual(principal)
  })
})
