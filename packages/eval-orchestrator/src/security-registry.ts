import { createHash } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import {
  BearerAuthConfigSchema, SigningKeyRegistrySchema, type BearerAuthConfig, type Principal,
  type SigningKeyRegistry, type SigningKeyRegistryDocument, type TrustedSigningKey,
} from '@agent-kernel/eval-protocol'

import { BearerTokenAuthenticator, type Authenticator } from './auth.js'
import { SecurityReloadAuditLog } from './security-audit.js'

export type SecurityRegistryMetadata = {
  schemaVersion: 1
  loadedAt: string
  generation: number
  principals: Array<Pick<Principal, 'principalId' | 'kind' | 'role' | 'scopes' | 'serviceId'> & { keyCount: number }>
  serviceKeys: Array<{ principalId: string; serviceId: string; role: string; scopes: string[]; status: 'active' }>
  trustKeys: Array<Omit<TrustedSigningKey, 'publicKeySpkiBase64'>>
  reloadAudit: Array<{ at: string; actorId: string; outcome: 'succeeded' | 'failed'; generation: number; configDigest?: string }>
}

type Snapshot = { authenticator: BearerTokenAuthenticator; auth: BearerAuthConfig; trust: SigningKeyRegistryDocument; loadedAt: string; generation: number; configDigest: string }

/** Atomically swaps validated auth and trust documents; secret/key material is never returned by metadata(). */
export class FileBackedSecurityRegistry implements Authenticator, SigningKeyRegistry {
  private snapshot?: Snapshot
  private readonly audit: SecurityRegistryMetadata['reloadAudit'] = []
  private readonly auditLog: SecurityReloadAuditLog
  private reloadTail: Promise<void> = Promise.resolve()

  constructor(readonly authPath: string, readonly trustPath?: string, auditPath = join(dirname(authPath), 'security-reload-audit.jsonl')) { this.auditLog = new SecurityReloadAuditLog(auditPath) }

  async initialize(): Promise<void> { this.audit.push(...(await this.auditLog.readAll()).slice(-100).map(({ at, actorId, outcome, generation, configDigest }) => ({ at, actorId, outcome, generation, ...(configDigest ? { configDigest } : {}) }))); await this.reload('startup') }

  authenticate(authorization: string | undefined): Principal | undefined { return this.snapshot?.authenticator.authenticate(authorization) }
  resolve(keyReference: string): TrustedSigningKey | undefined { return this.snapshot?.trust.keys.find((key) => key.keyReference === keyReference) }

  reload(actorId: string): Promise<SecurityRegistryMetadata> {
    const operation = this.reloadTail.then(async () => {
      try {
        const [authBody, trustBody] = await Promise.all([readSecureFile(this.authPath), this.trustPath ? readSecureFile(this.trustPath) : Promise.resolve('{"schemaVersion":1,"keys":[]}')])
        const auth = BearerAuthConfigSchema.parse(JSON.parse(authBody))
        const trust = SigningKeyRegistrySchema.parse(JSON.parse(trustBody))
        const next: Snapshot = {
          authenticator: new BearerTokenAuthenticator(auth), auth, trust,
          loadedAt: new Date().toISOString(), generation: (this.snapshot?.generation ?? 0) + 1,
          configDigest: createHash('sha256').update(authBody).update('\0').update(trustBody).digest('hex'),
        }
        await this.persist({ at: next.loadedAt, actorId, outcome: 'succeeded', generation: next.generation, configDigest: next.configDigest })
        this.snapshot = next
        return this.metadata()
      } catch (error) {
        await this.persist({ at: new Date().toISOString(), actorId, outcome: 'failed', generation: this.snapshot?.generation ?? 0 })
        throw error
      }
    })
    this.reloadTail = operation.then(() => undefined, () => undefined)
    return operation
  }

  metadata(): SecurityRegistryMetadata {
    if (!this.snapshot) throw new Error('security registry is not initialized')
    const principals = new Map<string, SecurityRegistryMetadata['principals'][number]>()
    for (const { principal } of this.snapshot.auth.keys) {
      const existing = principals.get(principal.principalId)
      if (existing) existing.keyCount += 1
      else principals.set(principal.principalId, { principalId: principal.principalId, kind: principal.kind, role: principal.role, scopes: [...principal.scopes], ...(principal.serviceId ? { serviceId: principal.serviceId } : {}), keyCount: 1 })
    }
    return {
      schemaVersion: 1, loadedAt: this.snapshot.loadedAt, generation: this.snapshot.generation,
      principals: [...principals.values()].sort((a, b) => a.principalId.localeCompare(b.principalId)),
      serviceKeys: [...principals.values()].filter((entry) => entry.kind === 'service' && entry.serviceId).map((entry) => ({ principalId: entry.principalId, serviceId: entry.serviceId!, role: entry.role, scopes: [...entry.scopes], status: 'active' as const })),
      trustKeys: this.snapshot.trust.keys.map(({ publicKeySpkiBase64: _secretMaterial, ...metadata }) => metadata),
      reloadAudit: [...this.audit],
    }
  }

  private async persist(entry: SecurityRegistryMetadata['reloadAudit'][number]): Promise<void> { await this.auditLog.append(entry); this.audit.push(entry); if (this.audit.length > 100) this.audit.shift() }
}

async function readSecureFile(path: string): Promise<string> {
  const metadata = await lstat(path)
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('security configuration must be a regular non-symlink file')
  if ((metadata.mode & 0o022) !== 0) throw new Error('security configuration must not be group/world writable')
  return await readFile(path, 'utf8')
}
