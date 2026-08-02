import { describe, expect, it } from 'vitest'

import { MemoryOrganizationStore, permits } from './store.js'

describe('Organization domain', () => {
  it('creates a stable owner organization and supports shared membership', async () => {
    const store = new MemoryOrganizationStore()
    const owner = { issuer: 'https://id.example', subject: 'owner', displayName: 'Acme' }
    const member = { issuer: 'https://id.example', subject: 'member' }
    const first = await store.getOrCreateForIdentity(owner)
    expect((await store.getOrCreateForIdentity(owner)).organization.unitId).toBe(first.organization.unitId)
    await store.addMember(first.organization.id, member, 'member')
    expect((await store.findAccess(member))?.organization.unitId).toBe(first.organization.unitId)
  })

  it('uses a fail-closed fixed permission matrix', () => {
    expect(permits('owner', 'organization:manage')).toBe(true)
    expect(permits('admin', 'policy:manage')).toBe(true)
    expect(permits('member', 'runtime:write')).toBe(true)
    expect(permits('member', 'organization:manage')).toBe(false)
    expect(permits('viewer', 'runtime:read')).toBe(true)
    expect(permits('viewer', 'runtime:write')).toBe(false)
  })

  it('does not permit removing or demoting the owner', async () => {
    const store = new MemoryOrganizationStore()
    const owner = { issuer: 'https://id.example', subject: 'owner' }
    const access = await store.getOrCreateForIdentity(owner)
    await expect(store.removeMember(access.organization.id, owner)).rejects.toThrow(/immutable/)
    await expect(store.updateMemberRole(access.organization.id, owner, 'viewer')).rejects.toThrow(/immutable/)
  })

  it('transfers ownership atomically while preserving exactly one owner', async () => {
    const store = new MemoryOrganizationStore()
    const owner = { issuer: 'https://id.example', subject: 'owner' }
    const next = { issuer: 'https://id.example', subject: 'next' }
    const access = await store.getOrCreateForIdentity(owner)
    await store.addMember(access.organization.id, next, 'admin')
    await store.transferOwnership(access.organization.id, owner, next)
    const members = await store.listMembers(access.organization.id)
    expect(members.filter((member) => member.role === 'owner')).toHaveLength(1)
    expect((await store.findAccess(next))?.membership.role).toBe('owner')
    expect((await store.findAccess(owner))?.membership.role).toBe('admin')
    await expect(store.transferOwnership(access.organization.id, owner, next)).rejects.toThrow('current owner not found')
  })
})
