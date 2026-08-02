import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { planJsonControlImport } from './json-control-import.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

describe('JSON control import planning', () => {
  it('validates and counts organization v4 and browser session v1 files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'control-import-')); roots.push(root)
    const directory = join(root, 'directory.json'); const sessions = join(root, 'sessions.json')
    const identity = { issuer: 'https://identity.example', subject: 'alice', displayName: 'Alice' }
    await writeFile(directory, JSON.stringify({ schemaVersion: 4, organizations: [{ id: 'org_a', name: 'A', unitId: 'tenant_a', createdAt: '2026-01-01T00:00:00.000Z' }], memberships: [{ organizationId: 'org_a', identity, role: 'owner', createdAt: '2026-01-01T00:00:00.000Z' }], executorInviteUnits: {} }))
    await writeFile(sessions, JSON.stringify({ schemaVersion: 1, sessions: [{ id: 'bs_a', tokenHash: 'hash', identity, cacheNamespace: 'cache', device: { label: 'Browser' }, createdAt: 1, lastSeenAt: 1, idleExpiresAt: 2, absoluteExpiresAt: 3 }] }))
    const plan = await planJsonControlImport(directory, sessions)
    expect(plan.organizations).toHaveLength(1)
    expect(plan.memberships).toHaveLength(1)
    expect(plan.sessions).toHaveLength(1)
    expect(plan.checksum).toMatch(/^[a-f0-9]{64}$/u)
  })

  it('rejects dangling memberships before touching PostgreSQL', async () => {
    const root = await mkdtemp(join(tmpdir(), 'control-import-')); roots.push(root)
    const directory = join(root, 'directory.json')
    await writeFile(directory, JSON.stringify({ schemaVersion: 4, organizations: [], memberships: [{ organizationId: 'missing', identity: { issuer: 'i', subject: 's' }, role: 'owner', createdAt: '2026-01-01T00:00:00.000Z' }] }))
    await expect(planJsonControlImport(directory)).rejects.toThrow('dangling organization membership')
  })
})
