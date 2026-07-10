/**
 * `eval regression-gate` command: reads a baseline and a candidate summary,
 * compares them against a configurable threshold policy, and writes a
 * pass/fail artifact with per-threshold reason codes.
 *
 * This is the CI-facing side of `eval compare-runs`. `compare-runs` produces
 * a neutral delta report; `regression-gate` decides whether the deltas are
 * within budget and exits non-zero via `verdict.pass === false` so callers
 * (GitHub Actions, precommit) can fail the build.
 *
 * The gate never mutates either summary; it only reads them and emits
 * `regression-gate.json` in `--root-dir`.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { EvalRunSummary } from '@agent-kernel/shared/enhancement'

export type RegressionThresholdPolicy = {
  /** Minimum acceptable candidate.metrics.passRate. Failing this triggers `pass_rate_below_minimum`. */
  minPassRate?: number
  /** Maximum acceptable drop (baseline  -  candidate) in pass rate. Failing triggers `pass_rate_regression`. */
  maxPassRateDrop?: number
  /** Maximum acceptable increase in failed trials. Failing triggers `failed_trials_increase`. */
  maxFailedIncrease?: number
  /** Maximum acceptable increase in timed-out trials. Failing triggers `timeout_increase`. */
  maxTimeoutIncrease?: number
  /** Maximum acceptable drop in resolved trials. Failing triggers `resolved_regression`. */
  maxResolvedDrop?: number
  /**
   * Per-failure-label caps on the delta (candidate  -  baseline). Failing any
   * cap triggers `failure_label_increase:<label>`. `agent_error: 0` means
   * "candidate must not introduce any new agent errors beyond baseline".
   */
  failureLabelCaps?: Record<string, number>
}

export type RegressionGateInput = {
  rootDir: string
  baselineSummaryPath: string
  candidateSummaryPath: string
  policy: RegressionThresholdPolicy
  outputFilename?: string
}

export type RegressionGateReason = {
  code: string
  observed: number
  threshold: number
  message: string
}

export type RegressionGateVerdict = {
  pass: boolean
  baseline: Pick<EvalRunSummary, 'experimentId' | 'trialCount' | 'resolved' | 'failed' | 'timedOut'>
  candidate: Pick<EvalRunSummary, 'experimentId' | 'trialCount' | 'resolved' | 'failed' | 'timedOut'>
  deltas: {
    resolved: number
    failed: number
    timedOut: number
    passRate: number
  }
  policy: RegressionThresholdPolicy
  reasons: readonly RegressionGateReason[]
}

export async function evaluateRegressionGate(
  input: RegressionGateInput,
): Promise<{ verdict: RegressionGateVerdict; verdictPath: string }> {
  const baseline = JSON.parse(await readFile(input.baselineSummaryPath, 'utf8')) as EvalRunSummary
  const candidate = JSON.parse(await readFile(input.candidateSummaryPath, 'utf8')) as EvalRunSummary
  const baselinePassRate = numberMetric(baseline.metrics.passRate)
  const candidatePassRate = numberMetric(candidate.metrics.passRate)
  const deltas = {
    resolved: candidate.resolved - baseline.resolved,
    failed: candidate.failed - baseline.failed,
    timedOut: candidate.timedOut - baseline.timedOut,
    passRate: candidatePassRate - baselinePassRate,
  }
  const reasons: RegressionGateReason[] = []
  const policy = input.policy

  if (policy.minPassRate !== undefined && candidatePassRate < policy.minPassRate) {
    reasons.push({
      code: 'pass_rate_below_minimum',
      observed: candidatePassRate,
      threshold: policy.minPassRate,
      message: `candidate passRate ${candidatePassRate} < minimum ${policy.minPassRate}`,
    })
  }
  if (policy.maxPassRateDrop !== undefined) {
    const drop = baselinePassRate - candidatePassRate
    if (drop > policy.maxPassRateDrop) {
      reasons.push({
        code: 'pass_rate_regression',
        observed: drop,
        threshold: policy.maxPassRateDrop,
        message: `passRate dropped by ${drop} > allowed ${policy.maxPassRateDrop}`,
      })
    }
  }
  if (policy.maxFailedIncrease !== undefined && deltas.failed > policy.maxFailedIncrease) {
    reasons.push({
      code: 'failed_trials_increase',
      observed: deltas.failed,
      threshold: policy.maxFailedIncrease,
      message: `failed trials rose by ${deltas.failed} > allowed ${policy.maxFailedIncrease}`,
    })
  }
  if (policy.maxTimeoutIncrease !== undefined && deltas.timedOut > policy.maxTimeoutIncrease) {
    reasons.push({
      code: 'timeout_increase',
      observed: deltas.timedOut,
      threshold: policy.maxTimeoutIncrease,
      message: `timed-out trials rose by ${deltas.timedOut} > allowed ${policy.maxTimeoutIncrease}`,
    })
  }
  if (policy.maxResolvedDrop !== undefined && -deltas.resolved > policy.maxResolvedDrop) {
    reasons.push({
      code: 'resolved_regression',
      observed: -deltas.resolved,
      threshold: policy.maxResolvedDrop,
      message: `resolved trials dropped by ${-deltas.resolved} > allowed ${policy.maxResolvedDrop}`,
    })
  }
  if (policy.failureLabelCaps) {
    for (const [label, cap] of Object.entries(policy.failureLabelCaps)) {
      const delta = (candidate.failureCounts[label] ?? 0) - (baseline.failureCounts[label] ?? 0)
      if (delta > cap) {
        reasons.push({
          code: `failure_label_increase:${label}`,
          observed: delta,
          threshold: cap,
          message: `failure label "${label}" rose by ${delta} > cap ${cap}`,
        })
      }
    }
  }

  const verdict: RegressionGateVerdict = {
    pass: reasons.length === 0,
    baseline: pickSummary(baseline),
    candidate: pickSummary(candidate),
    deltas,
    policy,
    reasons,
  }
  await mkdir(input.rootDir, { recursive: true })
  const verdictPath = join(input.rootDir, input.outputFilename ?? 'regression-gate.json')
  await writeFile(verdictPath, `${JSON.stringify(verdict, null, 2)}\n`, 'utf8')
  return { verdict, verdictPath }
}

/**
 * Parse `--failure-cap label=N` args from an argv slice. Returns undefined
 * when none are present so ops-cli can omit the property.
 */
export function parseFailureCapArgs(argv: readonly string[]): Record<string, number> | undefined {
  const out: Record<string, number> = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg !== '--failure-cap') continue
    const next = argv[i + 1]
    if (!next) throw new Error('--failure-cap requires a label=N argument')
    const eq = next.indexOf('=')
    if (eq <= 0) throw new Error(`--failure-cap value must be label=N, got: ${next}`)
    const label = next.slice(0, eq).trim()
    const value = Number(next.slice(eq + 1))
    if (!Number.isFinite(value) || value < 0) throw new Error(`--failure-cap ${label} must be a non-negative number, got: ${next.slice(eq + 1)}`)
    out[label] = value
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function pickSummary(summary: EvalRunSummary): RegressionGateVerdict['baseline'] {
  return {
    experimentId: summary.experimentId,
    trialCount: summary.trialCount,
    resolved: summary.resolved,
    failed: summary.failed,
    timedOut: summary.timedOut,
  }
}

function numberMetric(value: number | string | boolean | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}
