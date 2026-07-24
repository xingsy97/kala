// ProgramBench BenchmarkAdapter wrapper (parallel to terminal-bench-adapter.ts).
//
// `resolved` semantics: submission contract satisfied AND `./compile.sh`
// produces a fresh top-level `./executable` (compile probe passed). See
// programbench.ts for the trial contract.

import type {
  BenchmarkAdapter,
  BenchmarkRunLayoutBase,
  BenchmarkScoreExplanation,
} from '../core/benchmark-adapter.js'
import {
  importProgramBenchResults,
  programBenchRunLayout,
  resolveProgramBenchTasks,
  runProgramBenchRun,
  runProgramBenchTrial,
  type ImportProgramBenchResultsInput,
  type ProgramBenchRunSummary,
  type ProgramBenchTask,
  type ProgramBenchTrialResult,
  type ResolveProgramBenchTasksInput,
  type RunProgramBenchRunInput,
  type RunProgramBenchTrialInput,
} from './programbench.js'

export type ProgramBenchPrepareInput = { rootDir: string; runId: string }
export type ProgramBenchPreparedRun = { layout: ReturnType<typeof programBenchRunLayout> }

export type ProgramBenchBenchmarkAdapter = BenchmarkAdapter<
  ProgramBenchTask,
  ResolveProgramBenchTasksInput,
  ProgramBenchPreparedRun,
  ProgramBenchPrepareInput,
  RunProgramBenchRunInput,
  Awaited<ReturnType<typeof runProgramBenchRun>>,
  RunProgramBenchTrialInput,
  ProgramBenchTrialResult,
  ImportProgramBenchResultsInput,
  ProgramBenchRunSummary
>

function layout(rootDir: string, runId: string): BenchmarkRunLayoutBase {
  const l = programBenchRunLayout(rootDir, runId)
  return { runId: l.runId, rootDir: l.rootDir, progressPath: l.progressPath, summaryPath: l.summaryPath }
}

async function prepareRun(input: ProgramBenchPrepareInput): Promise<ProgramBenchPreparedRun> {
  return { layout: programBenchRunLayout(input.rootDir, input.runId) }
}

function explainScore(summary: ProgramBenchRunSummary): BenchmarkScoreExplanation {
  const pct = Number((summary.accuracy * 100).toFixed(2))
  return {
    headline: `${summary.resolved} / ${summary.total} resolved (ProgramBench submission contract + compile.sh → executable)`,
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

export const programBenchAdapter: ProgramBenchBenchmarkAdapter = {
  kind: 'program-bench',
  layout,
  resolveTasks: resolveProgramBenchTasks,
  prepareRun,
  runAgent: runProgramBenchRun,
  runVerifier: runProgramBenchTrial,
  importResults: importProgramBenchResults,
  explainScore,
}
