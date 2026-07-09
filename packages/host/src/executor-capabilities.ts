import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { AttachedExecutor } from '@agent-kernel/shared'
import type { ExecutorCapabilitySnapshotArtifact } from '@agent-kernel/shared/enhancement'

export type ExecutorCapabilitySnapshotInput = {
  rootDir: string
  outputFilename?: string
  executors: readonly AttachedExecutor[]
  now?: () => Date
}

export type ExecutorCapabilitySnapshotResult = {
  snapshot: ExecutorCapabilitySnapshotArtifact
  snapshotPath: string
}

export function buildExecutorCapabilitySnapshot(input: {
  executors: readonly AttachedExecutor[]
  now?: () => Date
}): ExecutorCapabilitySnapshotArtifact {
  const generatedAt = (input.now?.() ?? new Date()).toISOString()
  const executors = input.executors.map((exec) => ({
    executorId: exec.executorId,
    workspaceId: exec.workspaceId,
    workspaceName: exec.workspaceName,
    runtime: exec.runtime,
    runtimeVersion: exec.runtimeVersion,
    ...(exec.os ? { os: exec.os } : {}),
    ...(exec.hostname ? { hostname: exec.hostname } : {}),
    attachedAt: exec.attachedAt,
    ...(exec.clientVersion ? { clientVersion: exec.clientVersion } : {}),
    tools: [...exec.tools].sort(),
    toolCount: exec.tools.length,
    ...(exec.sandboxRoots && exec.sandboxRoots.length > 0
      ? { sandboxRoots: [...exec.sandboxRoots] }
      : {}),
    ...(exec.workingDir ? { workingDir: exec.workingDir } : {}),
  }))
  executors.sort((a, b) => a.executorId.localeCompare(b.executorId))
  return {
    schemaVersion: 1,
    generatedAt,
    executorCount: executors.length,
    executors,
    summary: summarize(executors),
  }
}

export async function writeExecutorCapabilitySnapshot(
  input: ExecutorCapabilitySnapshotInput,
): Promise<ExecutorCapabilitySnapshotResult> {
  const snapshot = buildExecutorCapabilitySnapshot(input)
  const outputFilename = input.outputFilename ?? 'executor-capabilities.json'
  await mkdir(input.rootDir, { recursive: true })
  const snapshotPath = join(input.rootDir, outputFilename)
  await writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
  return { snapshot, snapshotPath }
}

function summarize(executors: readonly ExecutorCapabilitySnapshotArtifact['executors'][number][]): ExecutorCapabilitySnapshotArtifact['summary'] {
  const runtimes: Record<string, number> = {}
  const osCounts: Record<string, number> = {}
  const toolCoverage: Record<string, number> = {}
  for (const exec of executors) {
    runtimes[exec.runtime] = (runtimes[exec.runtime] ?? 0) + 1
    const osKey = exec.os ?? 'unknown'
    osCounts[osKey] = (osCounts[osKey] ?? 0) + 1
    for (const tool of exec.tools) {
      toolCoverage[tool] = (toolCoverage[tool] ?? 0) + 1
    }
  }
  return {
    runtimes: sortRecord(runtimes),
    osCounts: sortRecord(osCounts),
    toolCoverage: sortRecord(toolCoverage),
  }
}

function sortRecord(record: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)))
}
