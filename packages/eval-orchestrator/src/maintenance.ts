import { createHash, randomUUID } from 'node:crypto'
import { copyFile, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { BackupManifestSchema, RetentionSweepResultSchema, canonicalJson, sha256Hex, type BackupManifest, type RetentionSweepResult } from '@agent-kernel/eval-protocol'

import { EvaluationControlPlane } from './control-plane.js'
import { withDataDirectoryLock } from './data-directory-lock.js'
import { DurableJournal } from './journal.js'
import { RegisteredTaskCatalog } from './task-catalog.js'

export type RecoveryTargets = { rpoTargetSeconds: number; rtoTargetSeconds: number }
export type MaintenanceStatus = { schemaVersion: 1; retentionSweeps: unknown[]; backups: unknown[]; restoreDrills: unknown[]; audit: Array<{ at: string; operation: string; outcome: 'succeeded' | 'failed'; actor: string; subjectId?: string; error?: string }> }
const STATUS_FILE = 'maintenance-status.json'

export async function readMaintenanceStatus(dataDirectory: string): Promise<MaintenanceStatus> {
  try { return JSON.parse(await readFile(join(resolve(dataDirectory), STATUS_FILE), 'utf8')) as MaintenanceStatus }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyStatus(); throw error }
}

export async function createBackup(dataDirectory: string, destination: string, targets: RecoveryTargets, actor = 'system'): Promise<BackupManifest> {
  const source = resolve(dataDirectory); const output = resolve(destination)
  if (contained(source, output) || contained(output, source)) throw new Error('backup source and destination must not contain one another')
  await assertNewDirectory(output); await mkdir(output, { recursive: true, mode: 0o700 })
  const journal = new DurableJournal(join(source, 'control-plane.jsonl'))
  try {
    return await journal.withWriterFence(async () => {
      const transactions = await journal.readAll()
      await copyRegularFile(journal.path, join(output, 'control-plane.jsonl'))
      const artifacts = await copyArtifactTree(join(source, 'artifacts'), join(output, 'artifacts'))
      const journalBytes = await readFile(join(output, 'control-plane.jsonl'))
      const createdAt = new Date().toISOString(); const latest = transactions.at(-1)?.committedAt
      const unsigned = {
        schemaVersion: 1 as const, backupId: 'backup-' + randomUUID(), createdAt,
        journal: { path: 'control-plane.jsonl' as const, bytes: journalBytes.byteLength, sha256: digest(journalBytes), transactionCount: transactions.length, tipHash: transactions.at(-1)?.transactionHash ?? null },
        artifacts, recovery: { rpoTargetSeconds: targets.rpoTargetSeconds, rpoObservedSeconds: latest ? Math.max(0, (Date.parse(createdAt) - Date.parse(latest)) / 1000) : 0, rtoTargetSeconds: targets.rtoTargetSeconds, rtoObservedSeconds: null },
      }
      const manifest = BackupManifestSchema.parse({ ...unsigned, manifestHash: await sha256Hex(canonicalJson(unsigned)) })
      await writeDurable(join(output, 'backup-manifest.json'), canonicalJson(manifest) + '\n')
      await recordStatus(source, 'backups', { backupId: manifest.backupId, createdAt: manifest.createdAt, transactionCount: manifest.journal.transactionCount, artifactCount: manifest.artifacts.length, manifestHash: manifest.manifestHash, recovery: manifest.recovery }, 'backup.created', 'succeeded', actor, manifest.backupId)
      return manifest
    })
  } catch (error) {
    await rm(output, { recursive: true, force: true })
    await recordStatus(source, 'backups', undefined, 'backup.created', 'failed', actor, undefined, errorText(error))
    throw error
  }
}

export async function verifyBackup(directory: string): Promise<BackupManifest> {
  const root = await realpath(resolve(directory))
  const manifest = BackupManifestSchema.parse(JSON.parse(await readFile(join(root, 'backup-manifest.json'), 'utf8')))
  const { manifestHash, ...unsigned } = manifest
  if (await sha256Hex(canonicalJson(unsigned)) !== manifestHash) throw new Error('backup manifest hash mismatch')
  const journalBody = await readContained(root, manifest.journal.path)
  if (journalBody.byteLength !== manifest.journal.bytes || digest(journalBody) !== manifest.journal.sha256) throw new Error('backup journal integrity mismatch')
  const journal = new DurableJournal(join(root, manifest.journal.path)); const transactions = await journal.readAll()
  if (transactions.length !== manifest.journal.transactionCount || (transactions.at(-1)?.transactionHash ?? null) !== manifest.journal.tipHash) throw new Error('backup journal authority mismatch')
  for (const artifact of manifest.artifacts) {
    const body = await readContained(root, join('artifacts', artifact.path))
    if (body.byteLength !== artifact.bytes || digest(body) !== artifact.sha256) throw new Error('backup artifact integrity mismatch: ' + artifact.path)
  }
  return manifest
}

export async function restoreBackup(backupDirectory: string, destination: string, confirmation?: string, actor = 'system'): Promise<{ manifest: BackupManifest; rtoObservedSeconds: number; rtoTargetSeconds: number; rtoMet: boolean }> {
  if (confirmation !== 'restore:' + resolve(destination)) throw new Error('restore drill requires exact destructive confirmation: restore:' + resolve(destination))
  const started = performance.now(); const manifest = await verifyBackup(backupDirectory); const source = await realpath(resolve(backupDirectory)); const output = resolve(destination)
  await assertNewDirectory(output); await mkdir(output, { recursive: true, mode: 0o700 })
  try {
    await copyRegularFile(join(source, 'control-plane.jsonl'), join(output, 'control-plane.jsonl'))
    for (const artifact of manifest.artifacts) await copyRegularFile(join(source, 'artifacts', artifact.path), join(output, 'artifacts', artifact.path))
    const restored = new EvaluationControlPlane({ journalPath: join(output, 'control-plane.jsonl'), reportRoot: join(output, 'artifacts'), taskCatalog: new RegisteredTaskCatalog() })
    await restored.initialize()
    const observed = Math.max(0, (performance.now() - started) / 1000)
    const drill = { schemaVersion: 1, backupId: manifest.backupId, verifiedAt: new Date().toISOString(), transactionCount: restored.projection.transactionCount, tipHash: restored.projection.lastTransactionHash, rtoTargetSeconds: manifest.recovery.rtoTargetSeconds, rtoObservedSeconds: observed, rtoMet: observed <= manifest.recovery.rtoTargetSeconds }
    await writeDurable(join(output, 'restore-verification.json'), canonicalJson(drill) + '\n')
    await recordStatus(source, 'restoreDrills', drill, 'restore.drill', 'succeeded', actor, manifest.backupId)
    return { manifest, rtoObservedSeconds: observed, rtoTargetSeconds: manifest.recovery.rtoTargetSeconds, rtoMet: observed <= manifest.recovery.rtoTargetSeconds }
  } catch (error) {
    await rm(output, { recursive: true, force: true })
    await recordStatus(resolve(backupDirectory), 'restoreDrills', undefined, 'restore.drill', 'failed', actor, undefined, errorText(error))
    throw error
  }
}

export async function sweepRetention(dataDirectory: string, policyId: string, dryRun: boolean, now = new Date(), confirmation?: string, actor = 'system'): Promise<RetentionSweepResult> {
  const root = resolve(dataDirectory); const operation = dryRun ? 'retention.sweep.dry-run' : 'retention.sweep.executed'
  try {
    if (!dryRun && confirmation !== 'execute-retention:' + policyId) throw new Error('retention execution requires exact destructive confirmation: execute-retention:' + policyId)
    return await withDataDirectoryLock(root, async () => {
      const controlPlane = new EvaluationControlPlane({ journalPath: join(root, 'control-plane.jsonl'), reportRoot: join(root, 'artifacts'), taskCatalog: new RegisteredTaskCatalog(), now: () => now })
      await controlPlane.initialize()
      const policy = controlPlane.projection.retentionPolicies.get(policyId)
      if (!policy) throw new Error('retention policy not found: ' + policyId)
      const candidates: RetentionSweepResult['candidates'] = []
      for (const run of [...controlPlane.projection.runs.values()].sort((a, b) => a.accepted.spec.runId.localeCompare(b.accepted.spec.runId))) {
        if (!['completed', 'cancelled', 'failed', 'blocked'].includes(run.state)) continue
        const ageDays = Math.max(0, (now.getTime() - Date.parse(run.updatedAt)) / 86_400_000)
        if (ageDays < policy.retainDays) continue
        const runId = run.accepted.spec.runId
        const impact = await controlPlane.query({ resource: 'deletion-impact', runId }) as RetentionSweepResult['candidates'][number]['impact']
        if (impact.blockedByRefs.length) { candidates.push({ runId, ageDays, impact, disposition: 'protected', reason: impact.blockedByRefs.join(',') }); continue }
        if (dryRun) { candidates.push({ runId, ageDays, impact, disposition: 'eligible' }); continue }
        await controlPlane.executeCommand({ schemaVersion: 1, type: 'run.delete', commandId: 'retention-delete-' + randomUUID(), idempotencyKey: 'retention-delete-' + runId + '-' + impact.impactHash, submittedAt: now.toISOString(), runId, expectedImpactHash: impact.impactHash, confirmation: 'delete:' + runId })
        candidates.push({ runId, ageDays, impact, disposition: 'deleted' })
      }
      const result = RetentionSweepResultSchema.parse({ schemaVersion: 1, policyId, dryRun, evaluatedAt: now.toISOString(), candidates })
      await recordStatus(root, 'retentionSweeps', result, operation, 'succeeded', actor, policyId)
      return result
    })
  } catch (error) {
    await recordStatus(root, 'retentionSweeps', undefined, operation, 'failed', actor, policyId, errorText(error))
    throw error
  }
}

async function copyArtifactTree(source: string, destination: string): Promise<Array<{ path: string; bytes: number; sha256: string }>> {
  try { await lstat(source) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
  const files: Array<{ path: string; bytes: number; sha256: string }> = []
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) throw new Error('backup refuses artifact symlinks')
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile()) { const rel = relative(source, path).split(sep).join('/'); const body = await readFile(path); await copyRegularFile(path, join(destination, rel)); files.push({ path: rel, bytes: body.byteLength, sha256: digest(body) }) }
      else throw new Error('backup refuses non-regular artifact: ' + path)
    }
  }
  await visit(source); return files.sort((a, b) => a.path.localeCompare(b.path))
}

async function copyRegularFile(source: string, destination: string): Promise<void> { const metadata = await lstat(source); if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('backup input must be a regular file'); await mkdir(dirname(destination), { recursive: true, mode: 0o700 }); await copyFile(source, destination); const handle = await open(destination, 'r'); try { await handle.sync() } finally { await handle.close() } }
async function writeDurable(path: string, body: string): Promise<void> { const handle = await open(path, 'wx', 0o600); try { await handle.writeFile(body); await handle.sync() } finally { await handle.close() } }
async function assertNewDirectory(path: string): Promise<void> { if (isAbsolute(path) && path === resolve(path, sep)) throw new Error('destination cannot be a filesystem root'); try { await stat(path); throw new Error('destination must not already exist') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error } }
async function readContained(root: string, path: string): Promise<Buffer> { const target = resolve(root, path); if (!contained(root, target)) throw new Error('backup path escaped root'); const metadata = await lstat(target); if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('backup member must be a regular file'); return await readFile(target) }
function contained(root: string, target: string): boolean { const rel = relative(resolve(root), resolve(target)); return rel !== '' && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel) }
function digest(value: Uint8Array): string { return createHash('sha256').update(value).digest('hex') }
function emptyStatus(): MaintenanceStatus { return { schemaVersion: 1, retentionSweeps: [], backups: [], restoreDrills: [], audit: [] } }
async function recordStatus(root: string, collection: 'retentionSweeps' | 'backups' | 'restoreDrills', record: unknown | undefined, operation: string, outcome: 'succeeded' | 'failed', actor: string, subjectId?: string, error?: string): Promise<void> {
  await withDataDirectoryLock(root, async () => {
    const status = await readMaintenanceStatus(root)
    if (record !== undefined) status[collection] = [record, ...status[collection]].slice(0, 50)
    status.audit = [{ at: new Date().toISOString(), operation, outcome, actor, ...(subjectId ? { subjectId } : {}), ...(error ? { error } : {}) }, ...status.audit].slice(0, 100)
    const target = join(resolve(root), STATUS_FILE); const temporary = target + '.tmp-' + randomUUID()
    const handle = await open(temporary, 'wx', 0o600)
    try { await handle.writeFile(canonicalJson(status) + '\n'); await handle.sync() } finally { await handle.close() }
    await rename(temporary, target)
  })
}
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error) }
