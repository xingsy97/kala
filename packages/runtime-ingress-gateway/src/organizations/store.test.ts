import { describe, expect, it } from 'vitest'

import { inviteKey } from '../assignments/store.js'
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

  it('rejects cross-organization membership without changing the stable assignment', async () => {
    const store = new MemoryOrganizationStore()
    const firstOwner = { issuer: 'https://id.example', subject: 'first-owner' }
    const secondOwner = { issuer: 'https://id.example', subject: 'second-owner' }
    const member = { issuer: 'https://id.example', subject: 'member' }
    const first = await store.getOrCreateForIdentity(firstOwner)
    const second = await store.getOrCreateForIdentity(secondOwner)
    await store.addMember(first.organization.id, member, 'member')

    await expect(store.addMember(second.organization.id, member, 'admin'))
      .rejects.toThrow('identity_already_belongs_to_another_organization')
    expect((await store.findAccess(member))?.organization.id).toBe(first.organization.id)
  })

  it('keeps same-organization member updates valid', async () => {
    const store = new MemoryOrganizationStore()
    const owner = { issuer: 'https://id.example', subject: 'owner' }
    const member = { issuer: 'https://id.example', subject: 'member' }
    const access = await store.getOrCreateForIdentity(owner)
    const created = await store.addMember(access.organization.id, member, 'member')
    const updated = await store.addMember(access.organization.id, { ...member, displayName: 'Member' }, 'admin')

    expect(updated.createdAt).toBe(created.createdAt)
    expect((await store.findAccess(member))?.membership.role).toBe('admin')
  })

  it('accepts an invitation once only for the matching IdP-verified email', async () => {
    const store = new MemoryOrganizationStore()
    const owner = { issuer: 'https://id.example', subject: 'owner' }
    const access = await store.getOrCreateForIdentity(owner)
    const created = await store.createInvite(access.organization.id, owner, ' Invitee@Example.Test ', 'admin', new Date(Date.now() + 86_400_000).toISOString())
    const invitee = { issuer: 'https://id.example', subject: 'real-subject', email: 'invitee@example.test', emailVerified: true }

    expect(created.token).toMatch(/^ak_org_invite_/u)
    expect(JSON.stringify(await store.listInvites(access.organization.id))).not.toContain(created.token)
    await expect(store.acceptInvite(inviteKey(created.token), { ...invitee, emailVerified: false })).rejects.toThrow('invite_verified_email_required')
    await expect(store.acceptInvite(inviteKey(created.token), { ...invitee, email: 'other@example.test' })).rejects.toThrow('invite_email_mismatch')
    await expect(store.acceptInvite(inviteKey(created.token), invitee)).resolves.toMatchObject({ membership: { role: 'admin', identity: { subject: 'real-subject' } } })
    await expect(store.acceptInvite(inviteKey(created.token), invitee)).rejects.toThrow('invite_not_available')
  })

  it('fails closed for revoked invitations and identities already bound to another organization', async () => {
    const store = new MemoryOrganizationStore()
    const firstOwner = { issuer: 'https://id.example', subject: 'first-owner' }
    const secondOwner = { issuer: 'https://id.example', subject: 'second-owner' }
    const first = await store.getOrCreateForIdentity(firstOwner)
    const second = await store.getOrCreateForIdentity(secondOwner)
    const identity = { issuer: 'https://id.example', subject: 'member', email: 'member@example.test', emailVerified: true }
    await store.addMember(first.organization.id, identity, 'member')
    const crossTenant = await store.createInvite(second.organization.id, secondOwner, identity.email, 'admin', new Date(Date.now() + 86_400_000).toISOString())
    await expect(store.acceptInvite(inviteKey(crossTenant.token), identity)).rejects.toThrow('identity_already_belongs_to_another_organization')

    const revoked = await store.createInvite(second.organization.id, secondOwner, 'revoked@example.test', 'member', new Date(Date.now() + 86_400_000).toISOString())
    await store.revokeInvite(second.organization.id, revoked.invite.id)
    await expect(store.acceptInvite(inviteKey(revoked.token), { ...identity, subject: 'revoked', email: 'revoked@example.test' })).rejects.toThrow('invite_not_available')
    await expect(store.revokeInvite(first.organization.id, crossTenant.invite.id)).rejects.toThrow('invite_not_found')
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
