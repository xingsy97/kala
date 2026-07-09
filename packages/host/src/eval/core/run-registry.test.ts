import { mkdtempSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  registerSweBenchRun,
  readSweBenchRunRegistry,
  sweBenchRunRegistryPath,
  type SweBenchRunRegistry,
} from '../core/run-registry.js'

describe('SWE-bench run registry', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'swebench-registry-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('creates a fresh registry entry on first registration', async () => {
    const result = await registerSweBenchRun({
      rootDir: dir,
      runId: 'run-1',
      dataset: 'princeton-nlp/SWE-bench_Lite',
      split: 'test',
      model: 'agent-a',
      planPath: join(dir, 'run-1', 'worker-plan.json'),
      runDir: join(dir, 'run-1'),
      selectedCount: 5,
      maxWorkers: 2,
      shardCount: 2,
      now: () => new Date('2026-07-09T10:00:00Z'),
    })

    expect(result.path).toBe(sweBenchRunRegistryPath(dir))
    expect(result.entry.runId).toBe('run-1')
    expect(result.entry.registeredAt).toBe('2026-07-09T10:00:00.000Z')
    expect(result.entry.updatedAt).toBe('2026-07-09T10:00:00.000Z')
    expect(result.registry.entries).toHaveLength(1)

    const parsed = JSON.parse(await readFile(result.path, 'utf8')) as SweBenchRunRegistry
    expect(parsed.schemaVersion).toBe(1)
    expect(parsed.entries[0]?.dataset).toBe('princeton-nlp/SWE-bench_Lite')
    expect(parsed.entries[0]?.split).toBe('test')
    expect(parsed.entries[0]?.planPath).toBe(join(dir, 'run-1', 'worker-plan.json'))
    expect(parsed.entries[0]?.selectedCount).toBe(5)
    expect(parsed.entries[0]?.shardCount).toBe(2)
  })

  it('is idempotent per runId — re-registration updates the entry in place', async () => {
    await registerSweBenchRun({
      rootDir: dir,
      runId: 'run-1',
      dataset: 'ds',
      model: 'agent-a',
      planPath: 'plan.json',
      runDir: 'runs/run-1',
      selectedCount: 3,
      maxWorkers: 1,
      shardCount: 1,
      now: () => new Date('2026-07-09T10:00:00Z'),
    })
    const second = await registerSweBenchRun({
      rootDir: dir,
      runId: 'run-1',
      dataset: 'ds',
      model: 'agent-a',
      planPath: 'plan.json',
      runDir: 'runs/run-1',
      selectedCount: 4,
      maxWorkers: 2,
      shardCount: 2,
      now: () => new Date('2026-07-09T11:30:00Z'),
    })

    expect(second.registry.entries).toHaveLength(1)
    expect(second.entry.registeredAt).toBe('2026-07-09T10:00:00.000Z')
    expect(second.entry.updatedAt).toBe('2026-07-09T11:30:00.000Z')
    expect(second.entry.selectedCount).toBe(4)
    expect(second.entry.maxWorkers).toBe(2)
  })

  it('keeps distinct runIds sorted by registeredAt', async () => {
    await registerSweBenchRun({
      rootDir: dir,
      runId: 'run-b',
      dataset: 'ds',
      model: 'agent-a',
      planPath: 'b.json',
      runDir: 'runs/run-b',
      selectedCount: 1,
      maxWorkers: 1,
      shardCount: 1,
      now: () => new Date('2026-07-09T11:00:00Z'),
    })
    await registerSweBenchRun({
      rootDir: dir,
      runId: 'run-a',
      dataset: 'ds',
      model: 'agent-a',
      planPath: 'a.json',
      runDir: 'runs/run-a',
      selectedCount: 1,
      maxWorkers: 1,
      shardCount: 1,
      now: () => new Date('2026-07-09T10:00:00Z'),
    })

    const registry = await readSweBenchRunRegistry(dir)
    expect(registry.entries.map((entry) => entry.runId)).toEqual(['run-a', 'run-b'])
  })

  it('returns an empty registry when none exists yet', async () => {
    const registry = await readSweBenchRunRegistry(dir)
    expect(registry.schemaVersion).toBe(1)
    expect(registry.entries).toEqual([])
  })
})
