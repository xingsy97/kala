import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { JsonRuntimeAssignmentStore } from './json-store.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

describe('JsonRuntimeAssignmentStore', () => {
  it('serializes concurrent first login and survives restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenant-directory-')); roots.push(root)
    const path = join(root, 'directory.json')
    const directory = new JsonRuntimeAssignmentStore(path)
    const identity = { issuer: 'https://id.test', subject: 'alice' }
    const [a, b] = await Promise.all([directory.getOrCreateForIdentity(identity), directory.getOrCreateForIdentity(identity)])
    expect(a).toEqual(b)
    const restored = new JsonRuntimeAssignmentStore(path)
    await restored.load()
    expect(await restored.findByIdentity(identity)).toEqual(a)
    expect(await restored.getOrCreateForIdentity(identity)).toEqual(a)
    await restored.bindExecutorInvite('ak_invite_test', a.unitId)
    const withInvite = new JsonRuntimeAssignmentStore(path)
    await withInvite.load()
    expect(await withInvite.findUnitByExecutorInvite('ak_invite_test')).toBe(a.unitId)
    expect(await withInvite.findUnitByExecutorInvite('ak_invite_other')).toBeUndefined()
  })

  it('preserves the existing Unit when the local OIDC issuer moves to the single-domain port', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenant-directory-migrate-')); roots.push(root)
    const path = join(root, 'directory.json')
    await (await import('node:fs/promises')).writeFile(path, JSON.stringify({
      schemaVersion: 1,
      assignments: [{
        unitId: 'tenant_existing',
        hostname: 'old.runlab.localhost',
        identity: { issuer: 'https://auth.localhost:13001', subject: 'alice' },
      }],
    }))
    const directory = new JsonRuntimeAssignmentStore(path)
    await directory.load()
    const migrated = await directory.getOrCreateForIdentity({ issuer: 'http://localhost:13002', subject: 'alice' })
    expect(migrated.unitId).toBe('tenant_existing')
    expect(migrated.identity.issuer).toBe('http://localhost:13002')
  })
})
