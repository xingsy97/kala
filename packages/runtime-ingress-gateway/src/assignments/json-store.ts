import { createHash } from 'node:crypto'
import type { AuthenticatedIdentity, RuntimeAssignment, RuntimeAssignmentStore } from './store.js'
import { identityKey, inviteKey } from './store.js'
import { readJsonFile, writeJsonFile } from '../persistence/atomic-json-file.js'

type LegacyRuntimeAssignment = RuntimeAssignment & { readonly hostname?: string }
type DirectoryFile = { schemaVersion: 1 | 2 | 3; assignments: LegacyRuntimeAssignment[]; executorInviteUnits?: Record<string, string> }

/** Durable one-user/one-Unit directory with serialized atomic updates. */
export class JsonRuntimeAssignmentStore implements RuntimeAssignmentStore {
  private readonly byIdentity = new Map<string, RuntimeAssignment>()
  private readonly executorInviteUnits = new Map<string, string>()
  private mutation = Promise.resolve()

  constructor(readonly path: string) {}

  async load(): Promise<void> {
    const file = await readJsonFile<DirectoryFile>(this.path)
    if (!file) return
    if (![1, 2, 3].includes(file.schemaVersion) || !Array.isArray(file.assignments)) throw new Error('unsupported tenant directory')
    this.byIdentity.clear()
    this.executorInviteUnits.clear()
    for (const [key, unitId] of Object.entries(file.executorInviteUnits ?? {})) this.executorInviteUnits.set(key, unitId)
    for (const assignment of file.assignments) this.index({ unitId: assignment.unitId, identity: assignment.identity })
    if (file.schemaVersion !== 3) await this.persist()
  }

  async getOrCreateForIdentity(identity: AuthenticatedIdentity): Promise<RuntimeAssignment> {
    const key = identityKey(identity)
    const existing = this.byIdentity.get(key)
    if (existing) return existing
    return this.serialize(async () => {
      const raced = this.byIdentity.get(key)
      if (raced) return raced
      const legacy = this.findLegacyLocalAssignment(identity)
      if (legacy) {
        this.byIdentity.delete(identityKey(legacy.identity))
        const migrated = { ...legacy, identity }
        this.byIdentity.set(key, migrated)
        await this.persist()
        return migrated
      }
      const opaque = createHash('sha256').update(key).digest('hex').slice(0, 26)
      const assignment = { unitId: `tenant_${opaque}`, identity }
      this.index(assignment)
      try { await this.persist() } catch (error) { this.byIdentity.delete(key); throw error }
      return assignment
    })
  }

  async findByIdentity(identity: AuthenticatedIdentity): Promise<RuntimeAssignment | undefined> {
    return this.byIdentity.get(identityKey(identity))
  }

  async bindExecutorInvite(inviteToken: string, unitId: string): Promise<void> {
    await this.serialize(async () => { this.executorInviteUnits.set(inviteKey(inviteToken), unitId); await this.persist() })
  }

  async findUnitByExecutorInvite(inviteToken: string): Promise<string | undefined> {
    return this.executorInviteUnits.get(inviteKey(inviteToken))
  }

  private findLegacyLocalAssignment(identity: AuthenticatedIdentity): RuntimeAssignment | undefined {
    if (!isLocalIdentityIssuer(identity.issuer)) return undefined
    return [...this.byIdentity.values()]
      .filter((assignment) => assignment.identity.subject === identity.subject && isLocalIdentityIssuer(assignment.identity.issuer))
      .sort((a, b) => Number(b.identity.issuer.startsWith('https:')) - Number(a.identity.issuer.startsWith('https:')))[0]
  }

  private index(assignment: RuntimeAssignment): void {
    const key = identityKey(assignment.identity)
    if (this.byIdentity.has(key)) throw new Error('duplicate tenant assignment')
    this.byIdentity.set(key, assignment)
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutation.then(operation, operation)
    this.mutation = result.then(() => undefined, () => undefined)
    return result
  }

  private async persist(): Promise<void> {
    const body: DirectoryFile = { schemaVersion: 3, assignments: [...this.byIdentity.values()], executorInviteUnits: Object.fromEntries(this.executorInviteUnits) }
    await writeJsonFile(this.path, body)
  }
}

function isLocalIdentityIssuer(issuer: string): boolean {
  try {
    const url = new URL(issuer)
    return (url.hostname === 'auth.localhost' || url.hostname === 'localhost') && (url.port === '13001' || url.port === '13002')
  } catch {
    return false
  }
}
