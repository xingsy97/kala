import { createHash } from 'node:crypto'

import type { AuthenticatedIdentity } from '../assignments/store.js'
import { identityKey, inviteKey } from '../assignments/store.js'
import { readJsonFile, writeJsonFile } from '../persistence/atomic-json-file.js'
import type { Organization, OrganizationAccess, OrganizationMembership, OrganizationRole, OrganizationStore } from './store.js'

type LegacyFile = { schemaVersion: 1 | 2 | 3; assignments: Array<{ unitId: string; identity: AuthenticatedIdentity }>; executorInviteUnits?: Record<string, string> }
type PersistedOrganization = Omit<Organization, 'status'> & { status?: Organization['status'] }
type OrganizationFile = { schemaVersion: 4; organizations: PersistedOrganization[]; memberships: OrganizationMembership[]; executorInviteUnits?: Record<string, string> }

export class JsonOrganizationStore implements OrganizationStore {
  private readonly organizations = new Map<string, Organization>()
  private readonly memberships = new Map<string, OrganizationMembership>()
  private readonly executorInviteUnits = new Map<string, string>()
  private mutation = Promise.resolve()
  constructor(readonly path: string) {}

  async load(): Promise<void> {
    const file = await readJsonFile<LegacyFile | OrganizationFile>(this.path)
    if (!file) return
    this.organizations.clear(); this.memberships.clear(); this.executorInviteUnits.clear()
    for (const [key, unit] of Object.entries(file.executorInviteUnits ?? {})) this.executorInviteUnits.set(key, unit)
    if (file.schemaVersion === 4) {
      for (const organization of file.organizations) this.organizations.set(organization.id, { ...organization, status: organization.status ?? 'active' })
      for (const membership of file.memberships) this.indexMembership(membership)
      for (const membership of this.memberships.values()) if (!this.organizations.has(membership.organizationId)) throw new Error('dangling organization membership')
      return
    }
    if (![1, 2, 3].includes(file.schemaVersion) || !Array.isArray(file.assignments)) throw new Error('unsupported organization directory')
    for (const assignment of file.assignments) {
      const opaque = assignment.unitId.replace(/^tenant_/u, '') || createHash('sha256').update(identityKey(assignment.identity)).digest('hex').slice(0, 26)
      const organization: Organization = { id: `org_${opaque}`, unitId: assignment.unitId, name: assignment.identity.displayName?.trim() || 'My organization', status: 'active', createdAt: new Date().toISOString() }
      this.organizations.set(organization.id, organization)
      this.indexMembership({ organizationId: organization.id, identity: assignment.identity, role: 'owner', createdAt: organization.createdAt })
    }
    await this.persist()
  }

  async getOrCreateForIdentity(identity: AuthenticatedIdentity): Promise<OrganizationAccess> {
    const existing = await this.findAccess(identity); if (existing) return existing
    return this.serialize(async () => {
      const raced = await this.findAccess(identity); if (raced) return raced
      const opaque = createHash('sha256').update(identityKey(identity)).digest('hex').slice(0, 26)
      const organization: Organization = { id: `org_${opaque}`, unitId: `tenant_${opaque}`, name: identity.displayName?.trim() || 'My organization', status: 'active', createdAt: new Date().toISOString() }
      const membership: OrganizationMembership = { organizationId: organization.id, identity, role: 'owner', createdAt: organization.createdAt }
      this.organizations.set(organization.id, organization); this.indexMembership(membership)
      try { await this.persist() } catch (error) { this.organizations.delete(organization.id); this.memberships.delete(identityKey(identity)); throw error }
      return { organization, membership }
    })
  }

  async findAccess(identity: AuthenticatedIdentity): Promise<OrganizationAccess | undefined> {
    const membership = this.memberships.get(identityKey(identity)); const organization = membership ? this.organizations.get(membership.organizationId) : undefined
    return membership && organization ? { organization, membership } : undefined
  }
  async listMembers(organizationId: string) { return [...this.memberships.values()].filter((item) => item.organizationId === organizationId) }
  async addMember(organizationId: string, identity: AuthenticatedIdentity, role: Exclude<OrganizationRole, 'owner'>) { return this.serialize(async () => { if (!this.organizations.has(organizationId)) throw new Error('organization not found'); const membership = { organizationId, identity, role, createdAt: new Date().toISOString() }; this.indexMembership(membership); await this.persist(); return membership }) }
  async updateMemberRole(organizationId: string, identity: AuthenticatedIdentity, role: Exclude<OrganizationRole, 'owner'>) { await this.serialize(async () => { const key=identityKey(identity), current=this.memberships.get(key); if (!current || current.organizationId!==organizationId || current.role==='owner') throw new Error('membership not found or immutable'); this.memberships.set(key,{...current,role}); await this.persist() }) }
  async removeMember(organizationId: string, identity: AuthenticatedIdentity) { await this.serialize(async () => { const key=identityKey(identity), current=this.memberships.get(key); if (!current || current.organizationId!==organizationId || current.role==='owner') throw new Error('membership not found or immutable'); this.memberships.delete(key); await this.persist() }) }
  async transferOwnership(organizationId: string, currentOwner: AuthenticatedIdentity, nextOwner: AuthenticatedIdentity) { await this.serialize(async () => { const currentKey=identityKey(currentOwner), nextKey=identityKey(nextOwner), current=this.memberships.get(currentKey), next=this.memberships.get(nextKey); if (!current || current.organizationId!==organizationId || current.role!=='owner') throw new Error('current owner not found'); if (!next || next.organizationId!==organizationId || next.role==='owner') throw new Error('next owner must be an active member'); this.memberships.set(currentKey,{...current,role:'admin'}); this.memberships.set(nextKey,{...next,role:'owner'}); await this.persist() }) }
  async bindExecutorInvite(token: string, unitId: string) { await this.serialize(async()=>{this.executorInviteUnits.set(inviteKey(token),unitId);await this.persist()}) }
  async findUnitByExecutorInvite(token: string) { return this.executorInviteUnits.get(inviteKey(token)) }
  private indexMembership(membership: OrganizationMembership) { const key=identityKey(membership.identity); if(this.memberships.has(key)) throw new Error('duplicate organization membership'); this.memberships.set(key,membership) }
  private serialize<T>(op:()=>Promise<T>):Promise<T>{const result=this.mutation.then(op,op);this.mutation=result.then(()=>undefined,()=>undefined);return result}
  private async persist(){await writeJsonFile(this.path,{schemaVersion:4,organizations:[...this.organizations.values()],memberships:[...this.memberships.values()],executorInviteUnits:Object.fromEntries(this.executorInviteUnits)} satisfies OrganizationFile)}
}
