import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, symlink, unlink } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

import { readJsonFile, writeJsonFile } from './atomic-json-file.js'
import type { UnitQuiescence } from './quiescence.js'
import { advanceStandaloneRoute, otherSlot, type StandaloneRouteState, type StandaloneSlot } from './standalone-slot-state.js'

export type DeploymentPhase =
  | 'staged'
  | 'validating'
  | 'waiting_for_boundary'
  | 'reserved'
  | 'activating'
  | 'verifying'
  | 'completed'
  | 'rolling_back'
  | 'rolled_back'
  | 'failed'

export type DeploymentReceipt = {
  schemaVersion: 1
  deploymentId: string
  operationId: string
  phase: DeploymentPhase
  releaseId: string
  releaseDir: string
  bundleSha256: string
  requestedAt: string
  updatedAt: string
  previousRelease?: string
  previousSlot?: StandaloneSlot
  candidateSlot?: StandaloneSlot
  activatedPid?: number
  error?: string
  quiescence?: UnitQuiescence
}

export type DeploySupervisorAdapter = {
  routeState(): Promise<StandaloneRouteState>
  inspectQuiescence(slot: StandaloneSlot): Promise<UnitQuiescence>
  reserveCutover(slot: StandaloneSlot): Promise<UnitQuiescence>
  selfTestRelease(releaseDir: string): Promise<void>
  activateSlot(slot: StandaloneSlot, releaseDir: string): Promise<void>
  startSlot(slot: StandaloneSlot): Promise<void>
  stopSlot(slot: StandaloneSlot): Promise<void>
  verifySlot(slot: StandaloneSlot, expectedSha256: string): Promise<{ pid: number }>
  switchRoute(state: StandaloneRouteState): Promise<void>
}

export class StandaloneDeploySupervisor {
  private mutation = Promise.resolve()

  constructor(
    private readonly root: string,
    private readonly adapter: DeploySupervisorAdapter,
  ) {}

  async stage(input: { operationId: string; releaseDir: string; expectedSha256: string }): Promise<DeploymentReceipt> {
    return await this.serialize(() => this.stageUnsafe(input))
  }

  private async stageUnsafe(input: { operationId: string; releaseDir: string; expectedSha256: string }): Promise<DeploymentReceipt> {
    if (!input.operationId.trim()) throw new Error('operationId is required')
    const existing = await this.findByOperation(input.operationId)
    if (existing) return existing
    const releaseDir = resolve(input.releaseDir)
    const releasesRoot = resolve(this.root, 'releases')
    if (releaseDir === releasesRoot || !releaseDir.startsWith(`${releasesRoot}/`)) throw new Error('release directory must be an immutable child of the configured releases root')
    const bundlePath = join(releaseDir, 'bundle-dashboard-with-runtime.cjs')
    const actual = sha256(await readFile(bundlePath))
    if (actual !== input.expectedSha256) throw new Error('release bundle checksum mismatch')
    const now = new Date().toISOString()
    const receipt: DeploymentReceipt = {
      schemaVersion: 1,
      deploymentId: randomUUID(),
      operationId: input.operationId,
      phase: 'staged',
      releaseId: basename(releaseDir),
      releaseDir,
      bundleSha256: actual,
      requestedAt: now,
      updatedAt: now,
    }
    await this.persist(receipt)
    return receipt
  }

  async reconcile(deploymentId: string): Promise<DeploymentReceipt> {
    return await this.serialize(() => this.reconcileUnsafe(deploymentId))
  }

  private async reconcileUnsafe(deploymentId: string): Promise<DeploymentReceipt> {
    let receipt = await this.requiredReceipt(deploymentId)
    if (terminal(receipt.phase)) return receipt
    if (receipt.phase === 'rolling_back') return await this.rollback(receipt, receipt.error ?? 'deployment rollback resumed')
    try {
      if (receipt.phase === 'staged') receipt = await this.transition(receipt, 'validating')
      if (receipt.phase === 'validating' || receipt.phase === 'waiting_for_boundary') {
        const route = await this.adapter.routeState()
        const previousSlot = receipt.previousSlot ?? route.activeSlot
        const candidateSlot = receipt.candidateSlot ?? otherSlot(previousSlot)
        await this.adapter.selfTestRelease(receipt.releaseDir)
        const quiescence = await this.adapter.inspectQuiescence(previousSlot)
        if (!quiescence.safe) return await this.transition(receipt, 'waiting_for_boundary', { quiescence, previousSlot, candidateSlot })
        const previousRelease = receipt.previousRelease ?? resolve(this.root, 'releases', route.slots[previousSlot].releaseId)
        const reserved = await this.adapter.reserveCutover(previousSlot)
        if (!reserved.safe) return await this.transition(receipt, 'waiting_for_boundary', { quiescence: reserved, previousRelease, previousSlot, candidateSlot })
        receipt = await this.transition(receipt, 'reserved', { quiescence: reserved, previousRelease, previousSlot, candidateSlot })
      }
      if (receipt.phase === 'reserved') {
        await this.adapter.stopSlot(receipt.previousSlot!)
        receipt = await this.transition(receipt, 'activating')
      }
      if (receipt.phase === 'activating') {
        await this.adapter.activateSlot(receipt.candidateSlot!, receipt.releaseDir)
        await this.adapter.startSlot(receipt.candidateSlot!)
        receipt = await this.transition(receipt, 'verifying')
      }
      const verified = await this.adapter.verifySlot(receipt.candidateSlot!, receipt.bundleSha256)
      const route = await this.adapter.routeState()
      await this.adapter.switchRoute(advanceStandaloneRoute(route, { slot: receipt.candidateSlot!, releaseId: receipt.releaseId }))
      return await this.transition(receipt, 'completed', { activatedPid: verified.pid })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (receipt.previousRelease) return await this.rollback(await this.transition(receipt, 'rolling_back', { error: message }), message)
      return await this.transition(receipt, 'failed', { error: message })
    }
  }

  private async rollback(receipt: DeploymentReceipt, message: string): Promise<DeploymentReceipt> {
    const previousRelease = receipt.previousRelease
    const previousSlot = receipt.previousSlot
    if (!previousRelease || !previousSlot) return await this.transition(receipt, 'failed', { error: `${message}; rollback predecessor missing` })
    try {
      if (receipt.candidateSlot) await this.adapter.stopSlot(receipt.candidateSlot).catch(() => undefined)
      await this.adapter.activateSlot(previousSlot, previousRelease)
      await this.adapter.startSlot(previousSlot)
      await this.adapter.verifySlot(previousSlot, sha256(await readFile(join(previousRelease, 'bundle-dashboard-with-runtime.cjs'))))
      const route = await this.adapter.routeState()
      await this.adapter.switchRoute(advanceStandaloneRoute(route, { slot: previousSlot, releaseId: basename(previousRelease) }))
      return await this.transition(receipt, 'rolled_back', { error: message })
    } catch (rollbackError) {
      return await this.transition(receipt, 'failed', { error: `${message}; rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}` })
    }
  }

  async get(deploymentId: string): Promise<DeploymentReceipt | null> {
    return await readJsonFile<DeploymentReceipt>(this.receiptPath(deploymentId)) ?? null
  }

  private async transition(receipt: DeploymentReceipt, phase: DeploymentPhase, patch: Partial<DeploymentReceipt> = {}): Promise<DeploymentReceipt> {
    const next = { ...receipt, ...patch, phase, updatedAt: new Date().toISOString() }
    await this.persist(next)
    return next
  }

  private async requiredReceipt(deploymentId: string): Promise<DeploymentReceipt> {
    const receipt = await this.get(deploymentId)
    if (!receipt) throw new Error('deployment receipt not found')
    return receipt
  }

  private async findByOperation(operationId: string): Promise<DeploymentReceipt | null> {
    const index = await readJsonFile<Record<string, string>>(join(this.root, 'operation-index.json')) ?? {}
    return index[operationId] ? await this.get(index[operationId]!) : null
  }

  private async persist(receipt: DeploymentReceipt): Promise<void> {
    await mkdir(join(this.root, 'receipts'), { recursive: true, mode: 0o700 })
    await writeJsonFile(this.receiptPath(receipt.deploymentId), receipt)
    const indexPath = join(this.root, 'operation-index.json')
    const index = await readJsonFile<Record<string, string>>(indexPath) ?? {}
    if (!index[receipt.operationId]) await writeJsonFile(indexPath, { ...index, [receipt.operationId]: receipt.deploymentId })
  }

  private receiptPath(deploymentId: string): string {
    if (!/^[0-9a-f-]{36}$/iu.test(deploymentId)) throw new Error('invalid deployment id')
    return join(this.root, 'receipts', `${deploymentId}.json`)
  }

  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutation.then(operation, operation)
    this.mutation = result.then(() => undefined, () => undefined)
    return await result
  }
}

export async function activateRelease(currentLink: string, releaseDir: string): Promise<void> {
  const target = resolve(releaseDir)
  const temp = `${currentLink}.next-${process.pid}`
  await mkdir(dirname(currentLink), { recursive: true, mode: 0o700 })
  await unlink(temp).catch(() => undefined)
  await symlink(target, temp)
  await rename(temp, currentLink)
}

function terminal(phase: DeploymentPhase): boolean {
  return phase === 'completed' || phase === 'rolled_back' || phase === 'failed'
}

async function readLinkTarget(path: string): Promise<string | undefined> {
  return await import('node:fs/promises').then((fs) => fs.readlink(path)).then((target) => resolve(dirname(path), target)).catch(() => undefined)
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}
