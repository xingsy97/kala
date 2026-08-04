import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { FileBackedSecurityRegistry } from './security-registry.js'

const principal = { schemaVersion: 1 as const, principalId: 'operator-one', kind: 'user' as const, role: 'operator' as const, scopes: ['platform:read' as const, 'admin' as const] }

describe('file-backed security registry', () => {
  it('atomically rotates/revokes tokens and exposes metadata without secret material', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'eval-security-'))
    const authPath = join(directory, 'auth.json'); const trustPath = join(directory, 'trust.json')
    await writeFile(authPath, JSON.stringify({ schemaVersion: 1, keys: [{ key: 'old-secret-token', principal }] }), { mode: 0o600 })
    await writeFile(trustPath, JSON.stringify({ schemaVersion: 1, keys: [{ keyReference: 'trust-one', algorithm: 'ed25519', publicKeySpkiBase64: 'public-material-must-be-redacted', scopes: ['trial_result'], status: 'revoked', validFrom: '2026-01-01T00:00:00.000Z', revokedAt: '2026-02-01T00:00:00.000Z' }] }), { mode: 0o600 })
    const registry = new FileBackedSecurityRegistry(authPath, trustPath); await registry.initialize()
    expect(registry.authenticate('Bearer old-secret-token')?.principalId).toBe('operator-one')
    expect(JSON.stringify(registry.metadata())).not.toContain('old-secret-token')
    expect(JSON.stringify(registry.metadata())).not.toContain('public-material-must-be-redacted')

    await writeFile(authPath, JSON.stringify({ schemaVersion: 1, keys: [{ key: 'new-secret-token', principal }] }), { mode: 0o600 })
    await registry.reload('operator-one')
    expect(registry.authenticate('Bearer old-secret-token')).toBeUndefined()
    expect(registry.authenticate('Bearer new-secret-token')?.principalId).toBe('operator-one')

    await writeFile(authPath, '{invalid', { mode: 0o600 })
    await expect(registry.reload('operator-one')).rejects.toThrow()
    expect(registry.authenticate('Bearer new-secret-token')?.principalId).toBe('operator-one')
    expect(registry.metadata().reloadAudit.at(-1)?.outcome).toBe('failed')
    const auditPath = join(directory, 'security-reload-audit.jsonl')
    const persisted = (await readFile(auditPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { actorId: string; outcome: string; previousHash: string | null; entryHash: string })
    expect(persisted.at(-1)).toMatchObject({ actorId: 'operator-one', outcome: 'failed', previousHash: persisted.at(-2)?.entryHash })
    await writeFile(authPath, JSON.stringify({ schemaVersion: 1, keys: [{ key: 'new-secret-token', principal }] }), { mode: 0o600 })
    const restarted = new FileBackedSecurityRegistry(authPath, trustPath); await restarted.initialize()
    expect(restarted.metadata().reloadAudit.some((entry) => entry.outcome === 'failed')).toBe(true)
    await chmod(authPath, 0o600)
  })

  it('serializes concurrent reloads into a contiguous durable hash chain', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'eval-security-concurrent-'))
    const authPath = join(directory, 'auth.json')
    await writeFile(authPath, JSON.stringify({ schemaVersion: 1, keys: [{ key: 'token', principal }] }), { mode: 0o600 })
    const registry = new FileBackedSecurityRegistry(authPath); await registry.initialize()
    const results = await Promise.all([registry.reload('operator-a'), registry.reload('operator-b')])
    expect(results.map((result) => result.generation)).toEqual([2, 3])
    const entries = (await readFile(join(directory, 'security-reload-audit.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { sequence: number; previousHash: string | null; entryHash: string })
    expect(entries.map((entry) => entry.sequence)).toEqual([0, 1, 2])
    expect(entries[2]?.previousHash).toBe(entries[1]?.entryHash)
  })
})
