// Bad-case mining. Scans a run's trial artifacts and produces a normalized
// list of failing/erroring/unresolved cases so a human (or later a training
// pipeline) can triage them. Supports both SWE-bench trial JSON
// (packages/host/src/eval/swebench.ts writes EvalTrial) and Terminal-Bench
// trial JSON (TerminalBenchTrialResult).
//
// The response is intentionally free of absolute filesystem paths; only
// per-instance identifiers and short in-line trace excerpts leave this
// module. See docs/meta/principles.md §A1 and docs/evals/badcase-mining.md.

import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { EvalTrial } from '@agent-kernel/shared/enhancement'

import { sweBenchRunLayout } from '../swebench/swebench.js'
import { terminalBenchRunLayout, type TerminalBenchTrialResult } from '../terminal-bench/terminal-bench.js'

export type FailureCategory =
  | 'patch-apply-failure'
  | 'test-timeout'
  | 'agent-error'
  | 'infra-error'
  | 'verifier-failure'
  | 'unresolved-other'

export type BadCase = {
  instanceId: string
  failureCategory: FailureCategory
  traceHead: string[]
  traceTail: string[]
  toolCallErrors: string[]
  verifierReason?: string
  minimalRepro?: string
}

export type MineBadCasesInput = {
  rootDir: string
  runId: string
}

export type MineBadCasesResult = {
  runId: string
  cases: BadCase[]
  counts: Record<FailureCategory, number>
}

const CATEGORY_KEYS: readonly FailureCategory[] = [
  'patch-apply-failure',
  'test-timeout',
  'agent-error',
  'infra-error',
  'verifier-failure',
  'unresolved-other',
]

export function classifyFailure(
  trial: EvalTrial | TerminalBenchTrialResult,
): FailureCategory {
  if (isTerminalBenchTrial(trial)) {
    if (trial.status === 'resolved') return 'unresolved-other'
    if (trial.agentTimedOut || trial.testTimedOut) return 'test-timeout'
    if (trial.errorMessage && /agent/i.test(trial.errorMessage)) return 'agent-error'
    if (trial.status === 'errored') return 'infra-error'
    if (trial.parserOutput && trial.parserOutput.allPassed === false) return 'verifier-failure'
    return 'unresolved-other'
  }
  const label = trial.failureLabel
  switch (label) {
    case 'patch_apply_failed':
    case 'empty_patch':
      return 'patch-apply-failure'
    case 'agent_timeout':
      return 'test-timeout'
    case 'agent_error':
      return 'agent-error'
    case 'infrastructure_error':
    case 'harness_error':
      return 'infra-error'
    case 'test_failed':
      return 'verifier-failure'
    default:
      break
  }
  if (trial.status === 'timed_out') return 'test-timeout'
  if (trial.status === 'failed') return 'verifier-failure'
  return 'unresolved-other'
}

function isTerminalBenchTrial(
  trial: EvalTrial | TerminalBenchTrialResult,
): trial is TerminalBenchTrialResult {
  return typeof (trial as TerminalBenchTrialResult).taskId === 'string'
    && typeof (trial as TerminalBenchTrialResult).parserOutput === 'object'
}

export async function mineBadCases(input: MineBadCasesInput): Promise<MineBadCasesResult> {
  const cases: BadCase[] = []
  cases.push(...await scanSweBenchTrials(input))
  cases.push(...await scanTerminalBenchTrials(input))
  const counts: Record<FailureCategory, number> = Object.fromEntries(
    CATEGORY_KEYS.map((key) => [key, 0]),
  ) as Record<FailureCategory, number>
  for (const badCase of cases) counts[badCase.failureCategory] += 1
  cases.sort((a, b) => a.instanceId.localeCompare(b.instanceId))
  return { runId: input.runId, cases, counts }
}

async function scanSweBenchTrials(input: MineBadCasesInput): Promise<BadCase[]> {
  const layout = sweBenchRunLayout(input.rootDir, input.runId)
  if (!existsSync(layout.trialsDir)) return []
  const files = (await readdir(layout.trialsDir)).filter((f) => f.endsWith('.json'))
  const out: BadCase[] = []
  for (const file of files) {
    const raw = await readFile(join(layout.trialsDir, file), 'utf8')
    let trial: EvalTrial
    try {
      trial = JSON.parse(raw) as EvalTrial
    } catch {
      continue
    }
    // Skip Terminal-Bench trial files that landed in the same trials/ dir.
    if (typeof trial.instanceId !== 'string') continue
    if (trial.resolved) continue
    // Include failed, timed_out, and completed-but-unresolved trials.
    if (trial.status !== 'failed' && trial.status !== 'timed_out' && !(trial.status === 'completed' && trial.resolved === false)) {
      continue
    }
    const category = classifyFailure(trial)
    const { head, tail, toolErrors, verifierReason } = await gatherSweBenchTrialEvidence(input.rootDir, input.runId, trial)
    out.push({
      instanceId: trial.instanceId,
      failureCategory: category,
      traceHead: head,
      traceTail: tail,
      toolCallErrors: toolErrors,
      ...(verifierReason ? { verifierReason } : {}),
    })
  }
  return out
}

async function scanTerminalBenchTrials(input: MineBadCasesInput): Promise<BadCase[]> {
  const layout = terminalBenchRunLayout(input.rootDir, input.runId)
  if (!existsSync(layout.trialsDir)) return []
  const files = (await readdir(layout.trialsDir)).filter((f) => f.endsWith('.json'))
  const out: BadCase[] = []
  for (const file of files) {
    const raw = await readFile(join(layout.trialsDir, file), 'utf8')
    let trial: TerminalBenchTrialResult
    try {
      trial = JSON.parse(raw) as TerminalBenchTrialResult
    } catch {
      continue
    }
    // The SWE-bench and Terminal-Bench layouts share `<runId>/trials/*.json`.
    // Skip anything that lacks a taskId — it's a SWE-bench EvalTrial that
    // was already handled by scanSweBenchTrials.
    if (typeof trial.taskId !== 'string' || typeof trial.parserOutput !== 'object') continue
    if (trial.status === 'resolved') continue
    const category = classifyFailure(trial)
    const combined = `${trial.agentStdout ?? ''}\n${trial.agentStderr ?? ''}\n${trial.testStdout ?? ''}\n${trial.testStderr ?? ''}`
    const lines = combined.split('\n').filter((l) => l.trim().length > 0)
    out.push({
      instanceId: trial.taskId,
      failureCategory: category,
      traceHead: lines.slice(0, 5),
      traceTail: lines.slice(-5),
      toolCallErrors: (trial.agentStderr ?? '').split('\n').filter((l) => /error|traceback|fail/i.test(l)).slice(0, 5),
      ...(trial.parserOutput?.details ? { verifierReason: trial.parserOutput.details.slice(0, 500) } : {}),
      ...(trial.errorMessage ? { minimalRepro: trial.errorMessage } : {}),
    })
  }
  return out
}

async function gatherSweBenchTrialEvidence(
  rootDir: string,
  runId: string,
  trial: EvalTrial,
): Promise<{ head: string[]; tail: string[]; toolErrors: string[]; verifierReason?: string }> {
  const layout = sweBenchRunLayout(rootDir, runId)
  const stdoutPath = join(layout.artifactsDir, trial.instanceId, 'agent.stdout.log')
  const stderrPath = join(layout.artifactsDir, trial.instanceId, 'agent.stderr.log')
  let head: string[] = []
  let tail: string[] = []
  let toolErrors: string[] = []
  if (existsSync(stdoutPath)) {
    const lines = (await readFile(stdoutPath, 'utf8')).split('\n').filter((l) => l.trim().length > 0)
    head = lines.slice(0, 5)
    tail = lines.slice(-5)
  }
  if (existsSync(stderrPath)) {
    const errLines = (await readFile(stderrPath, 'utf8')).split('\n').filter((l) => l.trim().length > 0)
    toolErrors = errLines.filter((l) => /error|traceback|fail/i.test(l)).slice(0, 5)
    if (head.length === 0) head = errLines.slice(0, 5)
    if (tail.length === 0) tail = errLines.slice(-5)
  }
  let verifierReason: string | undefined
  const resultPath = join(layout.artifactsDir, trial.instanceId, 'swebench-result.json')
  if (existsSync(resultPath)) {
    try {
      const record = JSON.parse(await readFile(resultPath, 'utf8')) as Record<string, unknown>
      const text = typeof record.failure_reason === 'string'
        ? record.failure_reason
        : typeof record.error === 'string'
          ? record.error
          : undefined
      if (text) verifierReason = text.slice(0, 500)
    } catch {
      // ignore malformed result
    }
  }
  return { head, tail, toolErrors, ...(verifierReason ? { verifierReason } : {}) }
}
