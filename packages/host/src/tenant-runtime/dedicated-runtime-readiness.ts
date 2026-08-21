import { createHash } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'

import type { HostRestartAttempt, RuntimeCapabilities } from '@agent-kernel/shared'

import { readJsonFile, writeJsonFile } from './atomic-json-file.js'

export type DedicatedRuntimeReadiness = {
  schemaVersion: 1
  pid: number
  readyAt: string
  deployment?: NonNullable<HostRestartAttempt['deployment']>
  stateRoot: { pathDigest: string; device: string; inode: string }
  writeLease: { pathDigest: string }
  capabilities: RuntimeCapabilities
  continuation: {
    attemptId?: string
    participants: number
    completed: number
    failed: number
    sessions: readonly {
      sessionId: string
      cursor: number
      checkpointKind?: 'resting' | 'before_llm' | 'before_tool_dispatch' | 'waiting_for_approval'
      resumeAction: 'none' | 'wait_for_approval' | 'continue_turn' | 'drain_queue'
      outcome: 'pending' | 'running' | 'adopted' | 'settled' | 'failed'
    }[]
  }
}

export type DedicatedProcessReadiness = {
  schemaVersion: 1
  pid: number
  port: number
  readyAt: string
  deployment?: NonNullable<HostRestartAttempt['deployment']>
}

export async function writeDedicatedProcessReadiness(path: string, readiness: DedicatedProcessReadiness): Promise<void> {
  await writeJsonFile(path, readiness)
}

export async function readDedicatedProcessReadiness(path: string): Promise<DedicatedProcessReadiness> {
  const value = await readJsonFile<unknown>(path)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('process readiness is missing')
  const record = value as Partial<DedicatedProcessReadiness>
  if (
    record.schemaVersion !== 1 || !Number.isSafeInteger(record.pid) || (record.pid ?? 0) < 1
    || !Number.isSafeInteger(record.port) || (record.port ?? 0) < 1 || (record.port ?? 0) > 65_535
    || typeof record.readyAt !== 'string' || !Number.isFinite(Date.parse(record.readyAt))
  ) throw new Error('invalid process readiness')
  rejectUnknownFields(record as Record<string, unknown>, new Set(['schemaVersion', 'pid', 'port', 'readyAt', 'deployment']), 'process readiness')
  if (record.deployment) validateDeploymentFence(record.deployment)
  return record as DedicatedProcessReadiness
}

export async function createDedicatedRuntimeReadiness(input: {
  sessionsDir: string
  writeLeasePath: string
  capabilities: RuntimeCapabilities
  restart: HostRestartAttempt | null
  deployment?: NonNullable<HostRestartAttempt['deployment']>
}): Promise<DedicatedRuntimeReadiness> {
  const stateRoot = await realpath(input.sessionsDir)
  const leasePath = await realpath(input.writeLeasePath)
  const stateStat = await stat(stateRoot, { bigint: true })
  const receipts = input.restart?.recoveryReceipts ?? {}
  const continuationSessions = (input.restart?.sessions ?? []).map((session) => ({
    sessionId: session.sessionId,
    cursor: session.cursor,
    ...(session.checkpointKind ? { checkpointKind: session.checkpointKind } : {}),
    resumeAction: session.resumeAction,
    outcome: receipts[session.sessionId]?.state ?? (session.resumeAction === 'continue_turn' ? 'pending' as const : 'settled' as const),
  }))
  return {
    schemaVersion: 1,
    pid: process.pid,
    readyAt: new Date().toISOString(),
    ...(input.deployment ? { deployment: input.deployment } : {}),
    stateRoot: { pathDigest: sha256(stateRoot), device: String(stateStat.dev), inode: String(stateStat.ino) },
    writeLease: { pathDigest: sha256(leasePath) },
    capabilities: input.capabilities,
    continuation: {
      ...(input.restart ? { attemptId: input.restart.attemptId } : {}),
      participants: continuationSessions.length,
      completed: continuationSessions.filter((session) => session.outcome === 'adopted' || session.outcome === 'settled').length,
      failed: continuationSessions.filter((session) => session.outcome === 'failed').length,
      sessions: continuationSessions,
    },
  }
}

export async function writeDedicatedRuntimeReadiness(path: string, readiness: DedicatedRuntimeReadiness): Promise<void> {
  await writeJsonFile(path, readiness)
}

export async function readDedicatedRuntimeReadiness(path: string): Promise<DedicatedRuntimeReadiness> {
  const value = await readJsonFile<unknown>(path)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('runtime readiness is missing')
  const record = value as Partial<DedicatedRuntimeReadiness>
  if (
    record.schemaVersion !== 1 || !Number.isSafeInteger(record.pid) || (record.pid ?? 0) < 1
    || typeof record.readyAt !== 'string' || !Number.isFinite(Date.parse(record.readyAt))
    || !record.stateRoot || !digest(record.stateRoot.pathDigest) || !decimal(record.stateRoot.device) || !decimal(record.stateRoot.inode)
    || !record.writeLease || !digest(record.writeLease.pathDigest)
    || !runtimeCapabilities(record.capabilities) || !record.continuation
    || !Number.isSafeInteger(record.continuation.participants) || record.continuation.participants < 0
    || !Number.isSafeInteger(record.continuation.completed) || record.continuation.completed < 0
    || !Number.isSafeInteger(record.continuation.failed) || record.continuation.failed < 0
    || !Array.isArray(record.continuation.sessions) || record.continuation.sessions.length !== record.continuation.participants
  ) throw new Error('invalid runtime readiness')
  rejectUnknownFields(record as Record<string, unknown>, new Set(['schemaVersion', 'pid', 'readyAt', 'deployment', 'stateRoot', 'writeLease', 'capabilities', 'continuation']), 'runtime readiness')
  rejectUnknownFields(record.stateRoot as unknown as Record<string, unknown>, new Set(['pathDigest', 'device', 'inode']), 'runtime state root')
  rejectUnknownFields(record.writeLease as unknown as Record<string, unknown>, new Set(['pathDigest']), 'runtime write lease')
  rejectUnknownFields(record.continuation as unknown as Record<string, unknown>, new Set(['attemptId', 'participants', 'completed', 'failed', 'sessions']), 'runtime continuation')
  for (const session of record.continuation.sessions) {
    if (
      !session || typeof session.sessionId !== 'string' || !Number.isSafeInteger(session.cursor) || session.cursor < 0
      || !['none', 'wait_for_approval', 'continue_turn', 'drain_queue'].includes(session.resumeAction)
      || !['pending', 'running', 'adopted', 'settled', 'failed'].includes(session.outcome)
    ) throw new Error('invalid runtime readiness continuation')
    rejectUnknownFields(session as unknown as Record<string, unknown>, new Set(['sessionId', 'cursor', 'checkpointKind', 'resumeAction', 'outcome']), 'runtime continuation session')
    if (session.checkpointKind !== undefined && !['resting', 'before_llm', 'before_tool_dispatch', 'waiting_for_approval'].includes(session.checkpointKind)) throw new Error('invalid runtime readiness checkpoint kind')
  }
  if (record.continuation.completed + record.continuation.failed > record.continuation.participants || record.continuation.sessions.filter((session) => session.outcome === 'adopted' || session.outcome === 'settled').length !== record.continuation.completed || record.continuation.sessions.filter((session) => session.outcome === 'failed').length !== record.continuation.failed) throw new Error('runtime continuation counts do not match outcomes')
  if (record.deployment) validateDeploymentFence(record.deployment)
  return record as DedicatedRuntimeReadiness
}

export async function dedicatedRuntimeStateIdentity(sessionsDir: string): Promise<DedicatedRuntimeReadiness['stateRoot']> {
  const stateRoot = await realpath(sessionsDir)
  const stateStat = await stat(stateRoot, { bigint: true })
  return { pathDigest: sha256(stateRoot), device: String(stateStat.dev), inode: String(stateStat.ino) }
}

function sha256(value: string): string { return createHash('sha256').update(value).digest('hex') }
function digest(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value) }
function decimal(value: unknown): value is string { return typeof value === 'string' && /^[0-9]+$/u.test(value) }
function runtimeCapabilities(value: unknown): value is RuntimeCapabilities {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return ['agent', 'workspace', 'operations', 'artifacts', 'pipeline'].every((key) => typeof record[key] === 'boolean')
}
function validateDeploymentFence(value: NonNullable<HostRestartAttempt['deployment']>): void {
  if (!value.deploymentId || !digest(value.targetReleaseDigest) || !Number.isSafeInteger(value.expectedRouteGeneration) || value.expectedRouteGeneration < 1 || value.fencingToken.length < 16) throw new Error('invalid runtime readiness deployment fence')
  rejectUnknownFields(value as unknown as Record<string, unknown>, new Set(['deploymentId', 'targetReleaseDigest', 'expectedRouteGeneration', 'fencingToken']), 'runtime deployment fence')
}
function rejectUnknownFields(input: Record<string, unknown>, allowed: ReadonlySet<string>, name: string): void { for (const key of Object.keys(input)) if (!allowed.has(key)) throw new Error(`unknown ${name} field: ${key}`) }
