import { mkdtempSync, rmSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { parseEnhancementCli } from './ops-cli.js'
import { evaluateReliabilityGate, parseKindCapArgs } from './reliability-gate.js'
import type { ReliabilityChaosReplay } from './reliability.js'

function chaosFixture(overrides: Partial<ReliabilityChaosReplay> = {}): ReliabilityChaosReplay {
  const base: ReliabilityChaosReplay = {
    generatedAt: '2026-07-09T00:00:00.000Z',
    sessionCount: 4,
    recoverableCount: 3,
    danglingCount: 1,
    recoveryEventCount: 2,
    danglingByKind: { llm_call: 1 },
    sessions: [
      { sessionId: 's1', sessionLogPath: 's1.jsonl', status: 'idle', recoverable: true, dangling: false, recoveryEvents: 1, eventCount: 10 },
      { sessionId: 's2', sessionLogPath: 's2.jsonl', status: 'idle', recoverable: true, dangling: false, recoveryEvents: 1, eventCount: 10 },
      { sessionId: 's3', sessionLogPath: 's3.jsonl', status: 'idle', recoverable: true, dangling: false, recoveryEvents: 0, eventCount: 10 },
      { sessionId: 's4', sessionLogPath: 's4.jsonl', status: 'waiting-llm', recoverable: false, dangling: true, danglingKind: 'llm_call', recoveryEvents: 0, eventCount: 10 },
    ],
  }
  return { ...base, ...overrides }
}

describe('reliability gate', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ak-reliability-gate-'))
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('passes when the chaos report fits within all thresholds', async () => {
    const chaosReportPath = join(dir, 'chaos.json')
    await writeFile(chaosReportPath, JSON.stringify(chaosFixture()), 'utf8')

    const result = await evaluateReliabilityGate({
      rootDir: dir,
      chaosReportPath,
      policy: {
        maxDanglingCount: 1,
        minRecoverableRatio: 0.5,
        maxRecoveryEventCount: 5,
        maxDanglingByKind: { llm_call: 1 },
      },
    })

    expect(result.verdict.pass).toBe(true)
    expect(result.verdict.reasons).toHaveLength(0)
    const persisted = JSON.parse(await readFile(result.verdictPath, 'utf8'))
    expect(persisted.pass).toBe(true)
    expect(persisted.chaos.sessionCount).toBe(4)
  })

  it('fails when multiple thresholds are exceeded', async () => {
    const chaosReportPath = join(dir, 'chaos.json')
    await writeFile(
      chaosReportPath,
      JSON.stringify(
        chaosFixture({
          recoverableCount: 1,
          danglingCount: 3,
          recoveryEventCount: 8,
          danglingByKind: { llm_call: 2, tool_call: 1 },
        }),
      ),
      'utf8',
    )

    const result = await evaluateReliabilityGate({
      rootDir: dir,
      chaosReportPath,
      policy: {
        maxDanglingCount: 1,
        minRecoverableRatio: 0.75,
        maxRecoveryEventCount: 5,
        maxDanglingByKind: { llm_call: 1, tool_call: 0 },
      },
    })

    expect(result.verdict.pass).toBe(false)
    const codes = result.verdict.reasons.map((r) => r.code).sort()
    expect(codes).toContain('dangling_count_exceeded')
    expect(codes).toContain('recovery_event_count_exceeded')
    expect(codes).toContain('recoverable_ratio_below_minimum')
    expect(codes).toContain('dangling_kind_exceeded:llm_call')
    expect(codes).toContain('dangling_kind_exceeded:tool_call')
  })

  it('flags sessions whose final status is outside the allowed set', async () => {
    const chaosReportPath = join(dir, 'chaos.json')
    await writeFile(chaosReportPath, JSON.stringify(chaosFixture()), 'utf8')

    const result = await evaluateReliabilityGate({
      rootDir: dir,
      chaosReportPath,
      policy: {
        requireStatusIn: ['idle'],
      },
    })

    expect(result.verdict.pass).toBe(false)
    const reasons = result.verdict.reasons
    expect(reasons).toHaveLength(1)
    expect(reasons[0]?.code).toBe('session_status_not_allowed')
    expect(reasons[0]?.observed).toBe('waiting-llm')
  })

  it('requires either a chaos report or session logs', async () => {
    await expect(
      evaluateReliabilityGate({
        rootDir: dir,
        policy: {},
      }),
    ).rejects.toThrow(/--chaos-report or --session-logs/)
  })

  it('parses --kind-cap CLI arguments', () => {
    expect(parseKindCapArgs([])).toBeUndefined()
    expect(
      parseKindCapArgs(['--kind-cap', 'llm_call=0', '--kind-cap', 'tool_call=2']),
    ).toEqual({ llm_call: 0, tool_call: 2 })
    expect(() => parseKindCapArgs(['--kind-cap', 'nope'])).toThrow(/kind=N/)
    expect(() => parseKindCapArgs(['--kind-cap', 'llm_call=-1'])).toThrow(/non-negative/)
  })

  it('parses the CLI verb into a reliability-gate command', () => {
    expect(
      parseEnhancementCli([
        'enhancement',
        'reliability',
        'gate',
        '--chaos-report',
        'runs/reliability/chaos/reliability-chaos.json',
        '--root-dir',
        'runs/reliability/gate',
        '--max-dangling',
        '0',
        '--min-recoverable-ratio',
        '0.9',
        '--max-recovery-events',
        '3',
        '--kind-cap',
        'llm_call=0',
        '--require-status',
        'idle,done',
        '--output',
        'gate.json',
      ]),
    ).toMatchObject({
      kind: 'reliability-gate',
      chaosReportPath: 'runs/reliability/chaos/reliability-chaos.json',
      rootDir: 'runs/reliability/gate',
      outputFilename: 'gate.json',
      policy: {
        maxDanglingCount: 0,
        minRecoverableRatio: 0.9,
        maxRecoveryEventCount: 3,
        maxDanglingByKind: { llm_call: 0 },
        requireStatusIn: ['idle', 'done'],
      },
    })
  })
})
