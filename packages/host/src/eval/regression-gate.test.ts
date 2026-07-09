import { mkdtempSync, rmSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { parseEnhancementCli } from '../ops-cli.js'
import { evaluateRegressionGate, parseFailureCapArgs } from './regression-gate.js'

function summaryFixture(overrides: Record<string, unknown> = {}): unknown {
  return {
    experimentId: 'exp',
    dataset: 'swebench',
    model: 'a',
    trialCount: 10,
    completed: 10,
    failed: 2,
    timedOut: 0,
    resolved: 8,
    unresolved: 2,
    emptyPatch: 0,
    failureCounts: { agent_error: 2 },
    metrics: { passRate: 0.8 },
    ...overrides,
  }
}

describe('eval regression gate', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ak-regression-gate-'))
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('passes when candidate matches baseline within all thresholds', async () => {
    const baseline = join(dir, 'baseline.json')
    const candidate = join(dir, 'candidate.json')
    await writeFile(baseline, JSON.stringify(summaryFixture()), 'utf8')
    await writeFile(candidate, JSON.stringify(summaryFixture()), 'utf8')

    const result = await evaluateRegressionGate({
      rootDir: dir,
      baselineSummaryPath: baseline,
      candidateSummaryPath: candidate,
      policy: {
        minPassRate: 0.7,
        maxPassRateDrop: 0.05,
        maxFailedIncrease: 1,
        maxTimeoutIncrease: 0,
        maxResolvedDrop: 0,
        failureLabelCaps: { agent_error: 0 },
      },
    })

    expect(result.verdict.pass).toBe(true)
    expect(result.verdict.reasons).toHaveLength(0)
    const persisted = JSON.parse(await readFile(result.verdictPath, 'utf8'))
    expect(persisted.pass).toBe(true)
  })

  it('fails on pass-rate drop, minimum pass rate, and failure-label caps', async () => {
    const baseline = join(dir, 'baseline.json')
    const candidate = join(dir, 'candidate.json')
    await writeFile(baseline, JSON.stringify(summaryFixture({ metrics: { passRate: 0.9 }, resolved: 9, failed: 1, failureCounts: { agent_error: 1 } })), 'utf8')
    await writeFile(
      candidate,
      JSON.stringify(
        summaryFixture({
          metrics: { passRate: 0.6 },
          resolved: 6,
          failed: 3,
          failureCounts: { agent_error: 3 },
        }),
      ),
      'utf8',
    )

    const result = await evaluateRegressionGate({
      rootDir: dir,
      baselineSummaryPath: baseline,
      candidateSummaryPath: candidate,
      policy: {
        minPassRate: 0.7,
        maxPassRateDrop: 0.1,
        maxFailedIncrease: 1,
        maxTimeoutIncrease: 0,
        maxResolvedDrop: 1,
        failureLabelCaps: { agent_error: 0 },
      },
    })

    expect(result.verdict.pass).toBe(false)
    const codes = result.verdict.reasons.map((r) => r.code).sort()
    expect(codes).toContain('pass_rate_below_minimum')
    expect(codes).toContain('pass_rate_regression')
    expect(codes).toContain('failed_trials_increase')
    expect(codes).toContain('resolved_regression')
    expect(codes).toContain('failure_label_increase:agent_error')
  })

  it('does not require every threshold to be defined', async () => {
    const baseline = join(dir, 'baseline.json')
    const candidate = join(dir, 'candidate.json')
    await writeFile(baseline, JSON.stringify(summaryFixture()), 'utf8')
    await writeFile(candidate, JSON.stringify(summaryFixture({ metrics: { passRate: 0.5 }, resolved: 5, failed: 5 })), 'utf8')

    const only = await evaluateRegressionGate({
      rootDir: dir,
      baselineSummaryPath: baseline,
      candidateSummaryPath: candidate,
      policy: { minPassRate: 0.7 },
    })

    expect(only.verdict.pass).toBe(false)
    expect(only.verdict.reasons.map((r) => r.code)).toEqual(['pass_rate_below_minimum'])
  })

  it('parses --failure-cap CLI arguments', () => {
    expect(parseFailureCapArgs([])).toBeUndefined()
    expect(
      parseFailureCapArgs(['--failure-cap', 'agent_error=0', '--failure-cap', 'test_failed=2']),
    ).toEqual({ agent_error: 0, test_failed: 2 })
    expect(() => parseFailureCapArgs(['--failure-cap', 'nope'])).toThrow(/label=N/)
    expect(() => parseFailureCapArgs(['--failure-cap', 'bad=-1'])).toThrow(/non-negative/)
  })

  it('parses the CLI verb into a regression-gate command', () => {
    expect(
      parseEnhancementCli([
        'enhancement',
        'eval',
        'regression-gate',
        '--baseline-summary',
        'runs/base/summary.json',
        '--candidate-summary',
        'runs/cand/summary.json',
        '--root-dir',
        'runs/eval/regression-gate',
        '--min-pass-rate',
        '0.8',
        '--max-pass-rate-drop',
        '0.05',
        '--max-failed-increase',
        '1',
        '--max-timeout-increase',
        '0',
        '--max-resolved-drop',
        '2',
        '--failure-cap',
        'agent_error=0',
        '--output',
        'gate.json',
      ]),
    ).toMatchObject({
      kind: 'eval-regression-gate',
      baselineSummaryPath: 'runs/base/summary.json',
      candidateSummaryPath: 'runs/cand/summary.json',
      rootDir: 'runs/eval/regression-gate',
      outputFilename: 'gate.json',
      policy: {
        minPassRate: 0.8,
        maxPassRateDrop: 0.05,
        maxFailedIncrease: 1,
        maxTimeoutIncrease: 0,
        maxResolvedDrop: 2,
        failureLabelCaps: { agent_error: 0 },
      },
    })
  })
})
