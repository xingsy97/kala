import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { loadEnterpriseSsoResolver } from './enterprise-sso-config.js'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })

describe('enterprise SSO config', () => {
  it('loads opaque provider mappings and authorizes only matching broker evidence', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'enterprise-sso-')); dirs.push(dir)
    const path = join(dir, 'connections.json')
    await writeFile(path, JSON.stringify({ connections: [{ id: 'sso_acme', providerId: 'idp_123', loginHint: 'user@acme.test' }] }))
    const resolver = await loadEnterpriseSsoResolver(path)
    const connection = await resolver.resolve('sso_acme')
    expect(connection).toEqual({ id: 'sso_acme', providerId: 'idp_123', loginHint: 'user@acme.test' })
    await expect(resolver.authorize(connection!, { issuer: 'issuer', subject: 'user', upstreamProviderId: 'idp_123' })).resolves.toBe(true)
    await expect(resolver.authorize(connection!, { issuer: 'issuer', subject: 'user' })).resolves.toBe(false)
  })

  it('rejects duplicate or non-opaque ids', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'enterprise-sso-')); dirs.push(dir)
    const path = join(dir, 'connections.json')
    await writeFile(path, JSON.stringify({ connections: [{ id: '../bad', providerId: 'idp_1' }] }))
    await expect(loadEnterpriseSsoResolver(path)).rejects.toThrow('invalid enterprise SSO connection id')
  })
})
