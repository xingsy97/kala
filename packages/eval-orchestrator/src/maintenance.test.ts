import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtemp } from 'node:fs/promises'

import { canonicalJson, sha256Hex } from '@agent-kernel/eval-protocol'
import { describe, expect, it } from 'vitest'

import { createBackup, readMaintenanceStatus, restoreBackup, verifyBackup } from './maintenance.js'

async function sourceDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'eval-maintenance-source-'))
  await mkdir(join(root, 'artifacts', 'nested'), { recursive: true })
  const unsigned = { schemaVersion: 1 as const, transactionSequence: 0, transactionId: 'seed', committedAt: '2026-08-03T00:00:00.000Z', previousHash: null, records: [{ kind: 'audit.recorded' as const, record: { schemaVersion: 1 as const, sequence: 0, at: '2026-08-03T00:00:00.000Z', actor: { kind: 'control-plane' as const, id: 'maintenance' }, operation: 'seed', resourceType: 'journal', resourceId: 'seed', committedSequence: 0, details: {} } }] }
  await writeFile(join(root, 'control-plane.jsonl'), JSON.stringify({ ...unsigned, transactionHash: await sha256Hex(canonicalJson(unsigned)) }) + '\n')
  await writeFile(join(root, 'artifacts', 'nested', 'evidence.txt'), 'evidence')
  return root
}

describe('offline maintenance', () => {
  it('creates a hashed consistent backup and restores it into a new verified directory', async () => {
    const source = await sourceDirectory(); const backup = source + '-backup'; const restored = source + '-restored'
    const manifest = await createBackup(source, backup, { rpoTargetSeconds: 60, rtoTargetSeconds: 60 })
    expect(manifest.artifacts).toMatchObject([{ path: 'nested/evidence.txt', bytes: 8 }])
    expect((await verifyBackup(backup)).manifestHash).toBe(manifest.manifestHash)
    const result = await restoreBackup(backup, restored, 'restore:' + restored)
    expect(result.rtoMet).toBe(true)
    expect(await readFile(join(restored, 'artifacts', 'nested', 'evidence.txt'), 'utf8')).toBe('evidence')
  })

  it('fails closed on artifact corruption and refuses an existing restore destination', async () => {
    const source = await sourceDirectory(); const backup = source + '-backup'
    await createBackup(source, backup, { rpoTargetSeconds: 60, rtoTargetSeconds: 60 })
    await writeFile(join(backup, 'artifacts', 'nested', 'evidence.txt'), 'tampered')
    await expect(verifyBackup(backup)).rejects.toThrow('artifact integrity mismatch')
    await expect(restoreBackup(backup, source, 'restore:' + source)).rejects.toThrow()
  })

  it('requires exact confirmation for restore drills', async () => {
    const source = await sourceDirectory(); const backup = source + '-backup'; const restored = source + '-restored'
    await createBackup(source, backup, { rpoTargetSeconds: 60, rtoTargetSeconds: 60 })
    await expect(restoreBackup(backup, restored, 'restore:other')).rejects.toThrow('exact destructive confirmation')
  })

  it('serializes concurrent status updates without losing actors or backup records', async () => {
    const source = await sourceDirectory()
    await Promise.all([
      createBackup(source, source + '-backup-a', { rpoTargetSeconds: 60, rtoTargetSeconds: 60 }, 'operator-a'),
      createBackup(source, source + '-backup-b', { rpoTargetSeconds: 60, rtoTargetSeconds: 60 }, 'operator-b'),
    ])
    const status = await readMaintenanceStatus(source)
    expect(status.backups).toHaveLength(2)
    expect(status.audit.slice(0, 2).map((entry) => entry.actor).sort()).toEqual(['operator-a', 'operator-b'])
  })

  it('records failed maintenance with actor and removes partial output', async () => {
    const source = await sourceDirectory(); const output = source + '-failed-backup'
    await symlink('evidence.txt', join(source, 'artifacts', 'nested', 'link.txt'))
    await expect(createBackup(source, output, { rpoTargetSeconds: 60, rtoTargetSeconds: 60 }, 'operator-failure')).rejects.toThrow('refuses artifact symlinks')
    const status = await readMaintenanceStatus(source)
    expect(status.audit[0]).toMatchObject({ operation: 'backup.created', outcome: 'failed', actor: 'operator-failure' })
    await expect(readFile(join(output, 'backup-manifest.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
