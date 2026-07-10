import { mkdtempSync, rmSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { parseEnhancementCli } from '../ops-cli.js'
import { aggregateProfiles, buildProfileAggregate } from './cost-aggregate.js'

function profileFixture(overrides: Record<string, unknown> = {}): unknown {
  return {
    sessionId: 'session-a',
    eventCount: 4,
    llmCalls: 2,
    toolCalls: 2,
    toolErrors: 0,
    totalInputTokens: 1000,
    totalOutputTokens: 500,
    totalCacheReadTokens: 0,
    totalCacheCreationTokens: 0,
    estimatedCostUsd: 0.02,
    costStatus: 'estimated',
    models: ['gpt-test'],
    missingUsageCalls: 0,
    llmTraceMissingCalls: 0,
    llmLatencyCalls: 2,
    averageLlmDurationMs: 800,
    p95LlmDurationMs: 1200,
    averageTimeToFirstChunkMs: 200,
    p95TimeToFirstChunkMs: 350,
    wallTimeMs: 3000,
    firstEventAt: '2026-07-09T00:00:00.000Z',
    lastEventAt: '2026-07-09T00:00:03.000Z',
    ...overrides,
  }
}

function summaryFixture(overrides: Record<string, unknown> = {}): unknown {
  return {
    experimentId: 'exp',
    dataset: 'swebench',
    model: 'gpt-test',
    trialCount: 3,
    completed: 3,
    failed: 0,
    timedOut: 0,
    resolved: 2,
    unresolved: 1,
    emptyPatch: 0,
    failureCounts: {},
    metrics: { passRate: 0.66 },
    ...overrides,
  }
}

describe('profile aggregation', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ak-profile-aggregate-'))
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('walks profile.json files and builds a distribution report', async () => {
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(dir, 'trials/a'), { recursive: true })
    await mkdir(join(dir, 'trials/b'), { recursive: true })
    await mkdir(join(dir, 'trials/c'), { recursive: true })
    await writeFile(join(dir, 'trial-a-profile.json'), 'ignored', 'utf8')
    await writeFile(join(dir, 'trials/a/profile.json'), JSON.stringify(profileFixture()), 'utf8')
    await writeFile(
      join(dir, 'trials/b/profile.json'),
      JSON.stringify(profileFixture({
        sessionId: 'session-b',
        llmCalls: 5,
        toolCalls: 4,
        totalInputTokens: 2000,
        totalOutputTokens: 800,
        estimatedCostUsd: 0.05,
        wallTimeMs: 12000,
        averageLlmDurationMs: 1500,
        p95LlmDurationMs: 2500,
      })),
      'utf8',
    )
    await writeFile(
      join(dir, 'trials/c/profile.json'),
      JSON.stringify(profileFixture({
        sessionId: 'session-c',
        estimatedCostUsd: undefined,
        costStatus: 'unknown',
        models: ['unknown-model'],
        missingUsageCalls: 1,
      })),
      'utf8',
    )

    const result = await aggregateProfiles({ rootDir: dir })

    expect(result.report.profileCount).toBe(3)
    expect(result.report.costStatus).toEqual({ estimated: 2, unknown: 1 })
    expect(result.report.totals.llmCalls).toBe(2 + 5 + 2)
    expect(result.report.totals.estimatedCostUsd).toBeCloseTo(0.07, 6)
    expect(result.report.distributions.llmCalls?.count).toBe(3)
    expect(result.report.distributions.llmCalls?.min).toBe(2)
    expect(result.report.distributions.llmCalls?.max).toBe(5)
    expect(result.report.distributions.estimatedCostUsd?.count).toBe(2)
    expect(result.report.perModelCostUsd?.['gpt-test']).toBeCloseTo(0.07, 6)
    expect(result.report.models['gpt-test']).toBe(2)
    expect(result.report.models['unknown-model']).toBe(1)
    const persisted = JSON.parse(await readFile(result.reportPath, 'utf8'))
    expect(persisted.profileCount).toBe(3)
    expect(persisted.profilePaths).toEqual([
      'trials/a/profile.json',
      'trials/b/profile.json',
      'trials/c/profile.json',
    ])
  })

  it('records cost-per-resolved-task when a summary is supplied', async () => {
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(dir, 'trials/a'), { recursive: true })
    await mkdir(join(dir, 'trials/b'), { recursive: true })
    await writeFile(join(dir, 'trials/a/profile.json'), JSON.stringify(profileFixture()), 'utf8')
    await writeFile(join(dir, 'trials/b/profile.json'), JSON.stringify(profileFixture({ estimatedCostUsd: 0.04 })), 'utf8')
    const summaryPath = join(dir, 'summary.json')
    await writeFile(summaryPath, JSON.stringify(summaryFixture()), 'utf8')

    const result = await aggregateProfiles({ rootDir: dir, summaryPath })

    expect(result.report.summary?.experimentId).toBe('exp')
    expect(result.report.summary?.resolved).toBe(2)
    expect(result.report.summary?.costPerResolvedUsd).toBeCloseTo(0.03, 6)
    expect(result.report.summary?.costPerTrialUsd).toBeCloseTo(0.02, 6)
  })

  it('reports zero-profile aggregations without throwing', () => {
    const report = buildProfileAggregate({
      rootDir: dir,
      profilePaths: [],
      profiles: [],
    })
    expect(report.profileCount).toBe(0)
    expect(report.totals.llmCalls).toBe(0)
    expect(report.costStatus).toEqual({ estimated: 0, unknown: 0 })
    expect(Object.keys(report.distributions)).toEqual([])
  })

  it('parses the CLI verb into a profile-aggregate command', () => {
    expect(
      parseEnhancementCli([
        'enhancement',
        'profile',
        'aggregate',
        '--root-dir',
        'runs/profile/aggregate',
        '--summary',
        'runs/eval/summary.json',
        '--output',
        'aggregate.json',
      ]),
    ).toMatchObject({
      kind: 'profile-aggregate',
      rootDir: 'runs/profile/aggregate',
      summaryPath: 'runs/eval/summary.json',
      outputFilename: 'aggregate.json',
    })
  })
})
