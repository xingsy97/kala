import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { JsonOrganizationStore } from './json-store.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('JsonOrganizationStore', () => {
  it('migrates legacy assignments without changing Unit IDs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'org-store-')); roots.push(root); const path = join(root, 'directory.json')
    const identity = { issuer: 'https://id.example', subject: 'alice', displayName: 'Alice' }
    writeFileSync(path, JSON.stringify({ schemaVersion: 3, assignments: [{ unitId: 'tenant_existing', identity }] }))
    const store = new JsonOrganizationStore(path); await store.load()
    const access = await store.findAccess(identity)
    expect(access).toMatchObject({ organization: { unitId: 'tenant_existing' }, membership: { role: 'owner' } })
    expect(JSON.parse(readFileSync(path, 'utf8')).schemaVersion).toBe(4)
  })

  it('persists shared memberships and roles', async () => {
    const root = mkdtempSync(join(tmpdir(), 'org-store-')); roots.push(root); const path = join(root, 'directory.json')
    const owner = { issuer: 'https://id.example', subject: 'owner' }, member = { issuer: 'https://id.example', subject: 'member' }
    const first = new JsonOrganizationStore(path); const access = await first.getOrCreateForIdentity(owner); await first.addMember(access.organization.id, member, 'viewer')
    const second = new JsonOrganizationStore(path); await second.load()
    expect((await second.findAccess(member))?.membership.role).toBe('viewer')
    expect((await second.findAccess(member))?.organization.unitId).toBe(access.organization.unitId)
  })
})
