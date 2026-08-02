import { createHash, randomBytes } from 'node:crypto'

import type { AuthenticatedIdentity } from '../assignments/store.js'
import { identityKey, inviteKey } from '../assignments/store.js'

export type OrganizationRole = 'owner' | 'admin' | 'member' | 'viewer'
export type OrganizationPermission = 'runtime:read' | 'runtime:write' | 'workspace:manage' | 'organization:manage' | 'policy:manage'

export type Organization = { id: string; name: string; unitId: string; createdAt: string }
export type OrganizationMembership = { organizationId: string; identity: AuthenticatedIdentity; role: OrganizationRole; createdAt: string }
export type OrganizationAccess = { organization: Organization; membership: OrganizationMembership }

export interface OrganizationStore {
  getOrCreateForIdentity(identity: AuthenticatedIdentity): Promise<OrganizationAccess>
  findAccess(identity: AuthenticatedIdentity): Promise<OrganizationAccess | undefined>
  listMembers(organizationId: string): Promise<readonly OrganizationMembership[]>
  addMember(organizationId: string, identity: AuthenticatedIdentity, role: Exclude<OrganizationRole, 'owner'>): Promise<OrganizationMembership>
  updateMemberRole(organizationId: string, identity: AuthenticatedIdentity, role: Exclude<OrganizationRole, 'owner'>): Promise<void>
  removeMember(organizationId: string, identity: AuthenticatedIdentity): Promise<void>
  transferOwnership(organizationId: string, currentOwner: AuthenticatedIdentity, nextOwner: AuthenticatedIdentity): Promise<void>
  bindExecutorInvite(inviteToken: string, unitId: string): Promise<void>
  findUnitByExecutorInvite(inviteToken: string): Promise<string | undefined>
  administrationSnapshot?(organizationId: string): Promise<Record<string, unknown>>
  updateRetentionPolicy?(organizationId: string, policy: { sessionDays: number; artifactDays: number; auditDays: number; deletedResourceGraceDays: number }): Promise<void>
}

const ROLE_PERMISSIONS: Record<OrganizationRole, ReadonlySet<OrganizationPermission>> = {
  owner: new Set(['runtime:read', 'runtime:write', 'workspace:manage', 'organization:manage', 'policy:manage']),
  admin: new Set(['runtime:read', 'runtime:write', 'workspace:manage', 'organization:manage', 'policy:manage']),
  member: new Set(['runtime:read', 'runtime:write']),
  viewer: new Set(['runtime:read']),
}

export function permits(role: OrganizationRole, permission: OrganizationPermission): boolean {
  return ROLE_PERMISSIONS[role].has(permission)
}

export class MemoryOrganizationStore implements OrganizationStore {
  protected readonly organizations = new Map<string, Organization>()
  protected readonly memberships = new Map<string, OrganizationMembership>()
  protected readonly executorInviteUnits = new Map<string, string>()

  async getOrCreateForIdentity(identity: AuthenticatedIdentity): Promise<OrganizationAccess> {
    const existing = await this.findAccess(identity)
    if (existing) return existing
    const opaque = createHash('sha256').update(identityKey(identity)).digest('hex').slice(0, 26)
    const organization: Organization = { id: `org_${opaque}`, unitId: `tenant_${opaque}`, name: identity.displayName?.trim() || 'My organization', createdAt: new Date().toISOString() }
    const membership: OrganizationMembership = { organizationId: organization.id, identity, role: 'owner', createdAt: organization.createdAt }
    this.organizations.set(organization.id, organization)
    this.memberships.set(identityKey(identity), membership)
    return { organization, membership }
  }

  async findAccess(identity: AuthenticatedIdentity): Promise<OrganizationAccess | undefined> {
    const membership = this.memberships.get(identityKey(identity))
    const organization = membership ? this.organizations.get(membership.organizationId) : undefined
    return membership && organization ? { organization, membership } : undefined
  }

  async listMembers(organizationId: string): Promise<readonly OrganizationMembership[]> {
    return [...this.memberships.values()].filter((membership) => membership.organizationId === organizationId)
  }

  async addMember(organizationId: string, identity: AuthenticatedIdentity, role: Exclude<OrganizationRole, 'owner'>): Promise<OrganizationMembership> {
    if (!this.organizations.has(organizationId)) throw new Error('organization not found')
    const membership = { organizationId, identity, role, createdAt: new Date().toISOString() }
    this.memberships.set(identityKey(identity), membership)
    return membership
  }

  async updateMemberRole(organizationId: string, identity: AuthenticatedIdentity, role: Exclude<OrganizationRole, 'owner'>): Promise<void> {
    const current = this.memberships.get(identityKey(identity))
    if (!current || current.organizationId !== organizationId || current.role === 'owner') throw new Error('membership not found or immutable')
    this.memberships.set(identityKey(identity), { ...current, role })
  }

  async removeMember(organizationId: string, identity: AuthenticatedIdentity): Promise<void> {
    const key = identityKey(identity); const current = this.memberships.get(key)
    if (!current || current.organizationId !== organizationId || current.role === 'owner') throw new Error('membership not found or immutable')
    this.memberships.delete(key)
  }

  async transferOwnership(organizationId: string, currentOwner: AuthenticatedIdentity, nextOwner: AuthenticatedIdentity): Promise<void> {
    const currentKey = identityKey(currentOwner), nextKey = identityKey(nextOwner)
    const current = this.memberships.get(currentKey), next = this.memberships.get(nextKey)
    if (!current || current.organizationId !== organizationId || current.role !== 'owner') throw new Error('current owner not found')
    if (!next || next.organizationId !== organizationId || next.role === 'owner') throw new Error('next owner must be an active member')
    this.memberships.set(currentKey, { ...current, role: 'admin' })
    this.memberships.set(nextKey, { ...next, role: 'owner' })
  }

  async bindExecutorInvite(inviteToken: string, unitId: string): Promise<void> { this.executorInviteUnits.set(inviteKey(inviteToken), unitId) }
  async findUnitByExecutorInvite(inviteToken: string): Promise<string | undefined> { return this.executorInviteUnits.get(inviteKey(inviteToken)) }
}

export function newOrganizationId(): string { return `org_${randomBytes(13).toString('hex')}` }
