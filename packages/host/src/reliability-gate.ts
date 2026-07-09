/**
 * `reliability gate` command: reads a chaos-replay report (or a set of session
 * logs to replay inline) and evaluates it against a threshold policy — max
 * dangling count, max dangling by kind, min recoverable ratio, integrity
 * issue caps. Writes a `reliability-gate.json` verdict with reason codes and
 * exits non-zero when a threshold is breached so CI runners can block
 * promotion of a benchmark or evaluation batch without extra scripting.
 *
 * The gate reads inputs only; it does not mutate the underlying session logs
 * or chaos report. It is meant to sit next to `eval regression-gate` and
 * `profile budget` in a CI reliability job.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  replayReliabilityChaos,
  type ReliabilityChaosReplay,
} from './reliability.js'

export type ReliabilityGatePolicy = {
  maxDanglingCount?: number
  maxDanglingByKind?: Record<string, number>
  minRecoverableRatio?: number
  maxRecoveryEventCount?: number
  requireStatusIn?: readonly string[]
  maxIntegrityIssueCount?: number
}

export type ReliabilityGateInput = {
  rootDir: string
  chaosReportPath?: string
  sessionLogPaths?: readonly string[]
  policy: ReliabilityGatePolicy
  outputFilename?: string
}

export type ReliabilityGateReason = {
  code: string
  observed: number | string
  threshold: number | string
  message: string
}

export type ReliabilityGateVerdict = {
  pass: boolean
  chaos: Pick<ReliabilityChaosReplay, 'sessionCount' | 'recoverableCount' | 'danglingCount' | 'recoveryEventCount' | 'danglingByKind'>
  policy: ReliabilityGatePolicy
  reasons: readonly ReliabilityGateReason[]
}

export async function evaluateReliabilityGate(
  input: ReliabilityGateInput,
): Promise<{ verdict: ReliabilityGateVerdict; verdictPath: string; report: ReliabilityChaosReplay }> {
  const report = await loadOrReplay(input)
  const policy = input.policy
  const reasons: ReliabilityGateReason[] = []

  if (policy.maxDanglingCount !== undefined && report.danglingCount > policy.maxDanglingCount) {
    reasons.push({
      code: 'dangling_count_exceeded',
      observed: report.danglingCount,
      threshold: policy.maxDanglingCount,
      message: `dangling sessions ${report.danglingCount} > allowed ${policy.maxDanglingCount}`,
    })
  }
  if (policy.maxRecoveryEventCount !== undefined && report.recoveryEventCount > policy.maxRecoveryEventCount) {
    reasons.push({
      code: 'recovery_event_count_exceeded',
      observed: report.recoveryEventCount,
      threshold: policy.maxRecoveryEventCount,
      message: `recovery events ${report.recoveryEventCount} > allowed ${policy.maxRecoveryEventCount}`,
    })
  }
  if (policy.minRecoverableRatio !== undefined && report.sessionCount > 0) {
    const ratio = report.recoverableCount / report.sessionCount
    if (ratio < policy.minRecoverableRatio) {
      reasons.push({
        code: 'recoverable_ratio_below_minimum',
        observed: round(ratio),
        threshold: policy.minRecoverableRatio,
        message: `recoverable ratio ${round(ratio)} < minimum ${policy.minRecoverableRatio}`,
      })
    }
  }
  if (policy.maxDanglingByKind) {
    for (const [kind, cap] of Object.entries(policy.maxDanglingByKind)) {
      const observed = report.danglingByKind[kind] ?? 0
      if (observed > cap) {
        reasons.push({
          code: `dangling_kind_exceeded:${kind}`,
          observed,
          threshold: cap,
          message: `dangling ${kind} sessions ${observed} > allowed ${cap}`,
        })
      }
    }
  }
  if (policy.requireStatusIn && policy.requireStatusIn.length > 0) {
    const allowed = new Set(policy.requireStatusIn)
    for (const session of report.sessions) {
      if (!allowed.has(session.status)) {
        reasons.push({
          code: 'session_status_not_allowed',
          observed: session.status,
          threshold: [...allowed].join(','),
          message: `session ${session.sessionId} final status ${session.status} not in [${[...allowed].join(', ')}]`,
        })
      }
    }
  }

  const verdict: ReliabilityGateVerdict = {
    pass: reasons.length === 0,
    chaos: {
      sessionCount: report.sessionCount,
      recoverableCount: report.recoverableCount,
      danglingCount: report.danglingCount,
      recoveryEventCount: report.recoveryEventCount,
      danglingByKind: report.danglingByKind,
    },
    policy,
    reasons,
  }
  await mkdir(input.rootDir, { recursive: true })
  const verdictPath = join(input.rootDir, input.outputFilename ?? 'reliability-gate.json')
  await writeFile(verdictPath, `${JSON.stringify(verdict, null, 2)}\n`, 'utf8')
  return { verdict, verdictPath, report }
}

async function loadOrReplay(input: ReliabilityGateInput): Promise<ReliabilityChaosReplay> {
  if (input.chaosReportPath) {
    return JSON.parse(await readFile(input.chaosReportPath, 'utf8')) as ReliabilityChaosReplay
  }
  if (input.sessionLogPaths && input.sessionLogPaths.length > 0) {
    const result = await replayReliabilityChaos({
      rootDir: input.rootDir,
      sessionLogPaths: input.sessionLogPaths,
    })
    return result.report
  }
  throw new Error('reliability gate requires --chaos-report or --session-logs')
}

/**
 * Parses paired `--kind-cap kind=N` args into a partial record. Recognized
 * kinds match `SessionReliabilityAudit.danglingKind` — `llm_call`,
 * `tool_call`, `approval`.
 */
export function parseKindCapArgs(argv: readonly string[]): Record<string, number> | undefined {
  const out: Record<string, number> = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg !== '--kind-cap') continue
    const next = argv[i + 1]
    if (!next) throw new Error('--kind-cap requires a kind=N argument')
    const eq = next.indexOf('=')
    if (eq <= 0) throw new Error(`--kind-cap value must be kind=N, got: ${next}`)
    const kind = next.slice(0, eq).trim()
    const raw = next.slice(eq + 1)
    const value = Number(raw)
    if (!Number.isFinite(value) || value < 0) throw new Error(`--kind-cap ${kind} must be a non-negative number, got: ${raw}`)
    out[kind] = value
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}
