import { createHash } from 'node:crypto'

export type AuthenticatedIdentity = {
  readonly issuer: string
  readonly subject: string
  readonly displayName?: string
  readonly email?: string
  /** Opaque upstream enterprise IdP identifier asserted by the trusted identity broker. */
  readonly upstreamProviderId?: string
}

export type RuntimeAssignment = {
  readonly unitId: string
  readonly identity: AuthenticatedIdentity
}

export interface RuntimeAssignmentStore {
  getOrCreateForIdentity(identity: AuthenticatedIdentity): Promise<RuntimeAssignment>
  findByIdentity(identity: AuthenticatedIdentity): Promise<RuntimeAssignment | undefined>
  bindExecutorInvite(inviteToken: string, unitId: string): Promise<void>
  findUnitByExecutorInvite(inviteToken: string): Promise<string | undefined>
}

/** Deterministic one-user/one-runtime assignment store for the first Private Cloud release. */
export class MemoryRuntimeAssignmentStore implements RuntimeAssignmentStore {
  private readonly byIdentity = new Map<string, RuntimeAssignment>()
  private readonly executorInviteUnits = new Map<string, string>()

  async getOrCreateForIdentity(identity: AuthenticatedIdentity): Promise<RuntimeAssignment> {
    const key = identityKey(identity)
    const existing = this.byIdentity.get(key)
    if (existing) return existing
    const opaque = createHash('sha256').update(key).digest('hex').slice(0, 26)
    const assignment = { unitId: `tenant_${opaque}`, identity }
    this.byIdentity.set(key, assignment)
    return assignment
  }

  async findByIdentity(identity: AuthenticatedIdentity): Promise<RuntimeAssignment | undefined> {
    return this.byIdentity.get(identityKey(identity))
  }

  async bindExecutorInvite(inviteToken: string, unitId: string): Promise<void> {
    this.executorInviteUnits.set(inviteKey(inviteToken), unitId)
  }

  async findUnitByExecutorInvite(inviteToken: string): Promise<string | undefined> {
    return this.executorInviteUnits.get(inviteKey(inviteToken))
  }
}

export function identityKey(identity: AuthenticatedIdentity): string {
  return `${identity.issuer}\0${identity.subject}`
}

export function inviteKey(inviteToken: string): string {
  return createHash('sha256').update(inviteToken).digest('base64url')
}
