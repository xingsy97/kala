import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export type SweBenchRunRegistryEntry = {
  runId: string
  dataset: string
  split?: string
  model: string
  planPath: string
  runDir: string
  selectedCount: number
  maxWorkers: number
  shardCount: number
  registeredAt: string
  updatedAt: string
}

export type SweBenchRunRegistry = {
  schemaVersion: 1
  updatedAt: string
  entries: readonly SweBenchRunRegistryEntry[]
}

export type RegisterSweBenchRunInput = {
  rootDir: string
  runId: string
  dataset: string
  split?: string
  model: string
  planPath: string
  runDir: string
  selectedCount: number
  maxWorkers: number
  shardCount: number
  now?: () => Date
}

export function sweBenchRunRegistryPath(rootDir: string): string {
  return join(rootDir, 'registry', 'run-index.json')
}

export async function readSweBenchRunRegistry(rootDir: string): Promise<SweBenchRunRegistry> {
  const path = sweBenchRunRegistryPath(rootDir)
  try {
    const text = await readFile(path, 'utf8')
    const parsed = JSON.parse(text) as SweBenchRunRegistry
    if (parsed && parsed.schemaVersion === 1 && Array.isArray(parsed.entries)) {
      return parsed
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code && code !== 'ENOENT') throw error
  }
  return { schemaVersion: 1, updatedAt: new Date(0).toISOString(), entries: [] }
}

export async function registerSweBenchRun(
  input: RegisterSweBenchRunInput,
): Promise<{ path: string; registry: SweBenchRunRegistry; entry: SweBenchRunRegistryEntry }> {
  const now = (input.now ?? (() => new Date()))()
  const nowIso = now.toISOString()
  const existing = await readSweBenchRunRegistry(input.rootDir)
  const priorEntry = existing.entries.find((entry) => entry.runId === input.runId)
  const entry: SweBenchRunRegistryEntry = {
    runId: input.runId,
    dataset: input.dataset,
    ...(input.split ? { split: input.split } : {}),
    model: input.model,
    planPath: input.planPath,
    runDir: input.runDir,
    selectedCount: input.selectedCount,
    maxWorkers: input.maxWorkers,
    shardCount: input.shardCount,
    registeredAt: priorEntry?.registeredAt ?? nowIso,
    updatedAt: nowIso,
  }
  const nextEntries = existing.entries.filter((prev) => prev.runId !== input.runId).concat([entry])
  nextEntries.sort((a, b) => (a.registeredAt < b.registeredAt ? -1 : a.registeredAt > b.registeredAt ? 1 : a.runId.localeCompare(b.runId)))
  const registry: SweBenchRunRegistry = {
    schemaVersion: 1,
    updatedAt: nowIso,
    entries: nextEntries,
  }
  const path = sweBenchRunRegistryPath(input.rootDir)
  await mkdir(join(input.rootDir, 'registry'), { recursive: true })
  await writeFile(path, `${JSON.stringify(registry, null, 2)}\n`, 'utf8')
  return { path, registry, entry }
}
