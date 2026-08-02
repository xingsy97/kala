import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export type StoredExecutorIdentity = {
  tokenHash: string
  workspaceId: string
  label?: string
  createdAt: string
  lastSeenAt?: string
  credentialVersion?: number
  revokedAt?: string
}

type FileShape = {
  schemaVersion: 1
  executors: StoredExecutorIdentity[]
  invites?: StoredExecutorInvite[]
  pairings?: ExecutorPairingRecord[]
}

export type ExecutorPairingSummary = { id: string; code: string; workspaceId: string; label?: string; createdAt: string; expiresAt: string; status: 'pending'|'approved'|'rejected'|'claimed'|'expired' }
type ExecutorPairingRecord = ExecutorPairingSummary & { claimHash: string; token?: string }

export type ExecutorInvite = {
  id: string
  inviteToken: string
  label?: string
  workspaceId?: string
  createdAt: string
  expiresAt: string
  lastUsedAt?: string
}

export type ExecutorInviteSummary = Omit<ExecutorInvite, 'inviteToken'> & {
  revoked: boolean
}

type InviteRecord = ExecutorInviteSummary & {
  inviteHash: string
}

const EXECUTOR_INVITE_TTL_MS = 7 * 24 * 60 * 60_000

type StoredExecutorInvite = InviteRecord & {
  expiresAt?: string
  used?: boolean
}

export class ExecutorIdentityStore {
  private identities: StoredExecutorIdentity[] = []
  private invites = new Map<string, InviteRecord>()
  private pairings = new Map<string, ExecutorPairingRecord>()

  constructor(private readonly path: string) {}

  load(): void {
    if (!existsSync(this.path)) return
    const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as FileShape
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.executors)) return
    this.identities = parsed.executors.filter((entry) => typeof entry.tokenHash === 'string' && typeof entry.workspaceId === 'string')
    this.invites.clear()
    for (const invite of parsed.invites ?? []) {
      if (typeof invite.inviteHash !== 'string' || typeof invite.id !== 'string') continue
      const record: InviteRecord = {
        id: invite.id,
        inviteHash: invite.inviteHash,
        createdAt: typeof invite.createdAt === 'string' ? invite.createdAt : new Date().toISOString(),
        expiresAt: typeof invite.expiresAt === 'string' ? invite.expiresAt : new Date(Date.now() + EXECUTOR_INVITE_TTL_MS).toISOString(),
        revoked: invite.revoked === true,
        ...(typeof invite.label === 'string' && invite.label.trim().length > 0 ? { label: invite.label } : {}),
        ...(typeof invite.workspaceId === 'string' && invite.workspaceId.trim().length > 0 ? { workspaceId: invite.workspaceId } : {}),
        ...(typeof invite.lastUsedAt === 'string' ? { lastUsedAt: invite.lastUsedAt } : {}),
      }
      this.invites.set(record.id, record)
    }
    this.pairings = new Map((parsed.pairings ?? []).map((pairing) => [pairing.id, pairing]))
  }

  snapshot(): readonly StoredExecutorIdentity[] {
    return this.identities.filter((entry) => !entry.revokedAt)
  }

  provisionWorkspace(workspaceId: string, label?: string): string {
    const token = `ak_exec_${randomBytes(32).toString('base64url')}`
    const identity: StoredExecutorIdentity = {
      tokenHash: hashToken(token),
      workspaceId,
      ...(label ? { label } : {}),
      createdAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    }
    this.identities = this.identities.filter((entry) => entry.workspaceId !== workspaceId)
    this.identities.push(identity)
    this.save()
    return token
  }

  inviteSnapshot(): readonly ExecutorInviteSummary[] {
    return [...this.invites.values()].map(({ inviteHash: _inviteHash, ...entry }) => entry)
  }

  createInvite(input: { label?: string; workspaceId?: string } = {}): ExecutorInvite {
    const id = `inv_${randomBytes(12).toString('base64url')}`
    const inviteToken = `ak_invite_${randomBytes(24).toString('base64url')}`
    const now = Date.now()
    const invite: InviteRecord = {
      id,
      inviteHash: hashToken(inviteToken),
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + EXECUTOR_INVITE_TTL_MS).toISOString(),
      revoked: false,
      ...(cleanString(input.label) ? { label: cleanString(input.label) } : {}),
      ...(cleanString(input.workspaceId) ? { workspaceId: cleanString(input.workspaceId) } : {}),
    }
    this.invites.set(id, invite)
    this.save()
    return { id, inviteToken, ...(invite.label ? { label: invite.label } : {}), ...(invite.workspaceId ? { workspaceId: invite.workspaceId } : {}), createdAt: invite.createdAt, expiresAt: invite.expiresAt }
  }

  createPairing(input: { workspaceId: string; label?: string }): ExecutorPairingSummary & { claimSecret: string } {
    const activeForWorkspace = [...this.pairings.values()].filter((pairing) => pairing.workspaceId === input.workspaceId && pairing.status === 'pending' && Date.parse(pairing.expiresAt) > Date.now())
    if (activeForWorkspace.length >= 3) throw new Error('too_many_pending_pairings')
    const id=`pair_${randomBytes(12).toString('base64url')}`, claimSecret=`ak_pair_${randomBytes(32).toString('base64url')}`, now=Date.now()
    const record:ExecutorPairingRecord={id,code:String(Math.floor(100000+Math.random()*900000)),workspaceId:input.workspaceId,...(input.label?{label:input.label}:{}),createdAt:new Date(now).toISOString(),expiresAt:new Date(now+10*60_000).toISOString(),status:'pending',claimHash:hashToken(claimSecret)}
    this.pairings.set(id,record);this.save();return {id:record.id,code:record.code,workspaceId:record.workspaceId,...(record.label?{label:record.label}:{}),createdAt:record.createdAt,expiresAt:record.expiresAt,status:record.status,claimSecret}
  }
  pairingSnapshot(): readonly ExecutorPairingSummary[] { return [...this.pairings.values()].map((p)=>({id:p.id,code:p.code,workspaceId:p.workspaceId,...(p.label?{label:p.label}:{}),createdAt:p.createdAt,expiresAt:p.expiresAt,status:Date.parse(p.expiresAt)<=Date.now()&&p.status==='pending'?'expired':p.status})) }
  decidePairing(id:string, approved:boolean): ExecutorPairingSummary|undefined { const p=this.pairings.get(id);if(!p||p.status!=='pending'||Date.parse(p.expiresAt)<=Date.now())return undefined;p.status=approved?'approved':'rejected';if(approved)p.token=this.provisionWorkspace(p.workspaceId,p.label);this.save();return {id:p.id,code:p.code,workspaceId:p.workspaceId,...(p.label?{label:p.label}:{}),createdAt:p.createdAt,expiresAt:p.expiresAt,status:p.status} }
  claimPairing(id:string, secret:string): {status:ExecutorPairingSummary['status'];token?:string}|undefined { const p=this.pairings.get(id);if(!p||p.claimHash!==hashToken(secret))return undefined;if(Date.parse(p.expiresAt)<=Date.now()&&p.status==='pending')p.status='expired';if(p.status==='approved'&&p.token){const token=p.token;delete p.token;p.status='claimed';this.save();return {status:'claimed',token}};return {status:p.status} }

  consumeInvite(inviteToken: string | undefined, workspaceId: string, label?: string): { ok: true; token: string } | { ok: false; reason: string } {
    if (!inviteToken) return { ok: false, reason: 'missing_invite' }
    const invite = this.findInviteByToken(inviteToken)
    if (!invite || invite.revoked) return { ok: false, reason: 'invalid_invite' }
    if (Date.parse(invite.expiresAt) <= Date.now()) return { ok: false, reason: 'invite_expired' }
    if (invite.workspaceId && invite.workspaceId !== workspaceId) return { ok: false, reason: 'workspace_identity_mismatch' }
    invite.workspaceId = workspaceId
    invite.lastUsedAt = new Date().toISOString()
    if (!invite.label && label) invite.label = label
    const token = `ak_exec_${randomBytes(32).toString('base64url')}`
    const identity: StoredExecutorIdentity = {
      tokenHash: hashToken(token),
      workspaceId,
      ...(label ? { label } : {}),
      createdAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    }
    this.identities = this.identities.filter((entry) => entry.workspaceId !== workspaceId)
    this.identities.push(identity)
    this.save()
    return { ok: true, token }
  }

  updateInvite(id: string, input: { label?: string; workspaceId?: string | null }): ExecutorInviteSummary | undefined {
    const invite = this.invites.get(id)
    if (!invite) return undefined
    if (input.label !== undefined) {
      const label = cleanString(input.label)
      if (label) invite.label = label
      else delete invite.label
    }
    if (input.workspaceId !== undefined) {
      const workspaceId = input.workspaceId === null ? undefined : cleanString(input.workspaceId)
      if (workspaceId) invite.workspaceId = workspaceId
      else delete invite.workspaceId
    }
    this.save()
    const { inviteHash: _inviteHash, ...summary } = invite
    return summary
  }

  revokeInvite(id: string): boolean {
    const invite = this.invites.get(id)
    if (!invite || invite.revoked) return false
    if (invite.workspaceId) this.identities = this.identities.filter((entry) => entry.workspaceId !== invite.workspaceId)
    invite.revoked = true
    this.save()
    return true
  }

  regenerateInvite(id: string): ExecutorInvite | undefined {
    const invite = this.invites.get(id)
    if (!invite) return undefined
    const inviteToken = `ak_invite_${randomBytes(24).toString('base64url')}`
    if (invite.workspaceId) this.identities = this.identities.filter((entry) => entry.workspaceId !== invite.workspaceId)
    invite.inviteHash = hashToken(inviteToken)
    invite.revoked = false
    invite.createdAt = new Date().toISOString()
    invite.expiresAt = new Date(Date.now() + EXECUTOR_INVITE_TTL_MS).toISOString()
    delete invite.workspaceId
    delete invite.lastUsedAt
    this.save()
    return {
      id: invite.id,
      inviteToken,
      ...(invite.label ? { label: invite.label } : {}),
      createdAt: invite.createdAt,
      expiresAt: invite.expiresAt,
    }
  }

  resolveToken(token: string | undefined): StoredExecutorIdentity | undefined {
    if (!token) return undefined
    const tokenHash = hashToken(token)
    return this.identities.find((entry) => entry.tokenHash === tokenHash && !entry.revokedAt)
  }

  rotateWorkspaceCredential(workspaceId: string): string {
    const current = this.identities.find((entry) => entry.workspaceId === workspaceId && !entry.revokedAt)
    if (!current) throw new Error('executor identity not found')
    current.revokedAt = new Date().toISOString()
    const token = `ak_exec_${randomBytes(32).toString('base64url')}`
    this.identities.push({ tokenHash: hashToken(token), workspaceId, ...(current.label ? { label: current.label } : {}), createdAt: new Date().toISOString(), credentialVersion: (current.credentialVersion ?? 1) + 1 })
    this.save()
    return token
  }

  markSeen(token: string | undefined): void {
    const entry = this.resolveToken(token)
    if (!entry) return
    entry.lastSeenAt = new Date().toISOString()
    this.save()
  }

  revokeWorkspace(workspaceId: string): boolean {
    const revokedAt = new Date().toISOString()
    this.identities = this.identities.map((entry) => entry.workspaceId === workspaceId && !entry.revokedAt ? { ...entry, revokedAt } : entry)
    if (!this.identities.some((entry) => entry.workspaceId === workspaceId && entry.revokedAt === revokedAt)) return false
    this.save()
    return true
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const invites: StoredExecutorInvite[] = [...this.invites.values()].map((invite) => ({ ...invite }))
    const body: FileShape = { schemaVersion: 1, executors: this.identities, invites, pairings: [...this.pairings.values()] }
    writeFileSync(this.path, `${JSON.stringify(body, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  }

  private findInviteByToken(inviteToken: string): InviteRecord | undefined {
    const inviteHash = hashToken(inviteToken)
    return [...this.invites.values()].find((entry) => entry.inviteHash === inviteHash)
  }
}

export function hashToken(token: string): string {
  return `sha256:${createHash('sha256').update(token).digest('hex')}`
}

function cleanString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}
