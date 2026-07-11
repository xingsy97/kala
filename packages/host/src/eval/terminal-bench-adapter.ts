// Terminal-Bench BenchmarkAdapter wrapper.
//
// Thin delegation layer over terminal-bench.ts. Semantics of `resolved` are:
// testScript exit 0 AND every parsed unit passed. See
// docs/domain-knowledge/terminal-bench-evaluation.md.

import type {
  BenchmarkAdapter,
  BenchmarkRunLayoutBase,
  BenchmarkScoreExplanation,
} from './benchmark-adapter.js'
import {
  importTerminalBenchResults,
  resolveTerminalBenchTasks,
  runTerminalBenchRun,
  runTerminalBenchTrial,
  terminalBenchRunLayout,
  type ImportTerminalBenchResultsInput,
  type ResolveTerminalBenchTasksInput,
  type RunTerminalBenchRunInput,
  type RunTerminalBenchTrialInput,
  type TerminalBenchRunSummary,
  type TerminalBenchTask,
  type TerminalBenchTrialResult,
} from './terminal-bench.js'

// Terminal-Bench has no separate "prepareRun" phase today  -  runTerminalBenchRun
// creates the layout as its first step. We expose the layout helper as the
// prepare stage so both adapters have a place to derive paths pre-execution.
export type TerminalBenchPrepareInput = { rootDir: string; runId: string }
export type TerminalBenchPreparedRun = { layout: ReturnType<typeof terminalBenchRunLayout> }

export type TerminalBenchAdapter = BenchmarkAdapter<
  TerminalBenchTask,
  ResolveTerminalBenchTasksInput,
  TerminalBenchPreparedRun,
  TerminalBenchPrepareInput,
  RunTerminalBenchRunInput,
  Awaited<ReturnType<typeof runTerminalBenchRun>>,
  RunTerminalBenchTrialInput,
  TerminalBenchTrialResult,
  ImportTerminalBenchResultsInput,
  TerminalBenchRunSummary
>

function layout(rootDir: string, runId: string): BenchmarkRunLayoutBase {
  const l = terminalBenchRunLayout(rootDir, runId)
  return { runId: l.runId, rootDir: l.rootDir, progressPath: l.progressPath, summaryPath: l.summaryPath }
}

async function prepareRun(input: TerminalBenchPrepareInput): Promise<TerminalBenchPreparedRun> {
  return { layout: terminalBenchRunLayout(input.rootDir, input.runId) }
}

function explainScore(summary: TerminalBenchRunSummary): BenchmarkScoreExplanation {
  const pct = Number((summary.accuracy * 100).toFixed(2))
  return {
    headline: `${summary.resolved} / ${summary.total} resolved (Terminal-Bench parser + testScript exit 0)`,
    details: {
      resolved: summary.resolved,
      unresolved: summary.unresolved,
      errored: summary.errored,
      total: summary.total,
      accuracyPct: pct,
    },
    officialTerm: 'resolved',
  }
}

export const terminalBenchAdapter: TerminalBenchAdapter = {
  kind: 'terminal-bench',
  layout,
  resolveTasks: resolveTerminalBenchTasks,
  prepareRun,
  runAgent: runTerminalBenchRun,
  runVerifier: runTerminalBenchTrial,
  importResults: importTerminalBenchResults,
  explainScore,
}
