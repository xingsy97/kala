// SWE-Marathon BenchmarkAdapter wrapper (parallel to terminal-bench-adapter.ts).
//
// `resolved` semantics: the harbor verifier (tests/test.sh) writes binary
// reward == 1 to /logs/verifier/reward.txt. See swe-marathon.ts.

import type {
  BenchmarkAdapter,
  BenchmarkRunLayoutBase,
  BenchmarkScoreExplanation,
} from '../core/benchmark-adapter.js'
import {
  importSweMarathonResults,
  resolveSweMarathonTasks,
  runSweMarathonRun,
  runSweMarathonTrial,
  sweMarathonRunLayout,
  type ImportSweMarathonResultsInput,
  type ResolveSweMarathonTasksInput,
  type RunSweMarathonRunInput,
  type RunSweMarathonTrialInput,
  type SweMarathonRunSummary,
  type SweMarathonTask,
  type SweMarathonTrialResult,
} from './swe-marathon.js'

export type SweMarathonPrepareInput = { rootDir: string; runId: string }
export type SweMarathonPreparedRun = { layout: ReturnType<typeof sweMarathonRunLayout> }

export type SweMarathonBenchmarkAdapter = BenchmarkAdapter<
  SweMarathonTask,
  ResolveSweMarathonTasksInput,
  SweMarathonPreparedRun,
  SweMarathonPrepareInput,
  RunSweMarathonRunInput,
  Awaited<ReturnType<typeof runSweMarathonRun>>,
  RunSweMarathonTrialInput,
  SweMarathonTrialResult,
  ImportSweMarathonResultsInput,
  SweMarathonRunSummary
>

function layout(rootDir: string, runId: string): BenchmarkRunLayoutBase {
  const l = sweMarathonRunLayout(rootDir, runId)
  return { runId: l.runId, rootDir: l.rootDir, progressPath: l.progressPath, summaryPath: l.summaryPath }
}

async function prepareRun(input: SweMarathonPrepareInput): Promise<SweMarathonPreparedRun> {
  return { layout: sweMarathonRunLayout(input.rootDir, input.runId) }
}

function explainScore(summary: SweMarathonRunSummary): BenchmarkScoreExplanation {
  const pct = Number((summary.accuracy * 100).toFixed(2))
  return {
    headline: `${summary.resolved} / ${summary.total} resolved (SWE-Marathon harbor verifier reward == 1)`,
    details: {
      resolved: summary.resolved,
      unresolved: summary.unresolved,
      errored: summary.errored,
      total: summary.total,
      accuracyPct: pct,
    },
    officialTerm: 'reward',
  }
}

export const sweMarathonAdapter: SweMarathonBenchmarkAdapter = {
  kind: 'swe-marathon',
  layout,
  resolveTasks: resolveSweMarathonTasks,
  prepareRun,
  runAgent: runSweMarathonRun,
  runVerifier: runSweMarathonTrial,
  importResults: importSweMarathonResults,
  explainScore,
}
