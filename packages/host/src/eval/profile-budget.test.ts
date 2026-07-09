import { mkdtempSync, rmSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { parseEnhancementCli } from '../ops-cli.js'
import { evaluateProfileBudget, parseThresholdArgs } from './profile-budget.js'

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

describe('profile budget', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ak-profile-budget-'))
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('passes when profile fits within every threshold', async () => {
    const profilePath = join(dir, 'profile.json')
    await writeFile(profilePath, JSON.stringify(profileFixture()), 'utf8')

    const result = await evaluateProfileBudget({
      rootDir: dir,
      profilePath,
      policy: {
        maxEstimatedCostUsd: 0.1,
        maxInputTokens: 5000,
        maxOutputTokens: 5000,
        maxLlmCalls: 5,
        maxToolCalls: 5,
        maxWallTimeMs: 10000,
        maxP95LlmDurationMs: 2000,
        maxP95TimeToFirstChunkMs: 500,
        requireCostEstimated: true,
      },
    })

    expect(result.verdict.pass).toBe(true)
    expect(result.verdict.reasons).toHaveLength(0)
    const persisted = JSON.parse(await readFile(result.verdictPath, 'utf8'))
    expect(persisted.pass).toBe(true)
    expect(persisted.profile.sessionId).toBe('session-a')
  })

  it('fails when multiple budget thresholds are exceeded', async () => {
    const profilePath = join(dir, 'profile.json')
    await writeFile(
      profilePath,
      JSON.stringify(profileFixture({
        llmCalls: 20,
        toolCalls: 30,
        estimatedCostUsd: 5,
        wallTimeMs: 60000,
        p95LlmDurationMs: 8000,
        p95TimeToFirstChunkMs: 2000,
      })),
      'utf8',
    )

    const result = await evaluateProfileBudget({
      rootDir: dir,
      profilePath,
      policy: {
        maxEstimatedCostUsd: 1,
        maxLlmCalls: 10,
        maxToolCalls: 10,
        maxWallTimeMs: 30000,
        maxP95LlmDurationMs: 5000,
        maxP95TimeToFirstChunkMs: 1000,
      },
    })

    expect(result.verdict.pass).toBe(false)
    const codes = result.verdict.reasons.map((r) => r.code).sort()
    expect(codes).toContain('cost_budget_exceeded')
    expect(codes).toContain('llm_calls_exceeded')
    expect(codes).toContain('tool_calls_exceeded')
    expect(codes).toContain('wall_time_exceeded')
    expect(codes).toContain('p95_llm_duration_exceeded')
    expect(codes).toContain('p95_ttft_exceeded')
  })

  it('reports cost_status_unknown when requireCostEstimated and profile is unknown', async () => {
    const profilePath = join(dir, 'profile.json')
    await writeFile(
      profilePath,
      JSON.stringify(profileFixture({ costStatus: 'unknown', estimatedCostUsd: undefined })),
      'utf8',
    )

    const result = await evaluateProfileBudget({
      rootDir: dir,
      profilePath,
      policy: { requireCostEstimated: true },
    })

    expect(result.verdict.pass).toBe(false)
    expect(result.verdict.reasons.map((r) => r.code)).toEqual(['cost_status_unknown'])
  })

  it('parses --threshold CLI arguments into a policy', () => {
    expect(parseThresholdArgs([])).toBeUndefined()
    expect(
      parseThresholdArgs([
        '--threshold', 'cost=1.5',
        '--threshold', 'p95TtftMs=500',
        '--threshold', 'requireCostEstimated=true',
      ]),
    ).toEqual({
      maxEstimatedCostUsd: 1.5,
      maxP95TimeToFirstChunkMs: 500,
      requireCostEstimated: true,
    })
    expect(() => parseThresholdArgs(['--threshold', 'nope=5'])).toThrow(/not recognized/)
    expect(() => parseThresholdArgs(['--threshold', 'cost=-1'])).toThrow(/non-negative/)
    expect(() => parseThresholdArgs(['--threshold', 'requireCostEstimated=maybe'])).toThrow(/boolean/)
  })

  it('parses the CLI verb into a profile-budget command', () => {
    expect(
      parseEnhancementCli([
        'enhancement',
        'profile',
        'budget',
        '--root-dir',
        'runs/profile/budget',
        '--profile',
        'runs/profile/session/profile.json',
        '--threshold',
        'cost=2',
        '--threshold',
        'p95LlmDurationMs=5000',
        '--output',
        'budget.json',
      ]),
    ).toMatchObject({
      kind: 'profile-budget',
      rootDir: 'runs/profile/budget',
      profilePath: 'runs/profile/session/profile.json',
      outputFilename: 'budget.json',
      policy: {
        maxEstimatedCostUsd: 2,
        maxP95LlmDurationMs: 5000,
      },
    })
  })
})
