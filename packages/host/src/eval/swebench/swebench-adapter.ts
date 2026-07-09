// SWE-bench BenchmarkAdapter wrapper.
//
// Thin delegation layer over swebench.ts. Does NOT reimplement anything;
// see swebench.ts for the actual pipeline. Semantics of `resolved` come from
// the official SWE-bench harness (docs/evals/domain-knowledge/swe-bench-evaluation.md).

import { readFile } from 'node:fs/promises'

import type {
  BenchmarkAdapter,
  BenchmarkRunLayoutBase,
  BenchmarkScoreExplanation,
} from '../core/benchmark-adapter.js'
import {
  ingestSweBenchResults,
  inferSweBenchPatchRun,
  runSweBenchGrade,
  sweBenchRunLayout,
  writeSweBenchPredictionRun,
  type InferSweBenchPatchRunInput,
  type SweBenchGradeInput,
  type SweBenchIngestResultsInput,
  type SweBenchIngestedResult,
  type SweBenchInstance,
  type SweBenchRunLayout,
  type WriteSweBenchPredictionInput,
} from '../swebench/swebench.js'

export type SweBenchResolveInput = {
  instancesJsonl: string
  instanceIds?: readonly string[]
  limit?: number
}

export type SweBenchImportSummary = {
  runId: string
  total: number
  resolved: number
  results: readonly SweBenchIngestedResult[]
}

export type SweBenchAdapter = BenchmarkAdapter<
  SweBenchInstance,
  SweBenchResolveInput,
  { layout: SweBenchRunLayout },
  WriteSweBenchPredictionInput,
  InferSweBenchPatchRunInput,
  Awaited<ReturnType<typeof inferSweBenchPatchRun>>,
  SweBenchGradeInput,
  Awaited<ReturnType<typeof runSweBenchGrade>>,
  SweBenchIngestResultsInput,
  SweBenchImportSummary
>

function layout(rootDir: string, runId: string): BenchmarkRunLayoutBase {
  const l = sweBenchRunLayout(rootDir, runId)
  return { runId: l.runId, rootDir: l.rootDir, progressPath: l.progressPath, summaryPath: l.summaryPath }
}

async function resolveTasks(input: SweBenchResolveInput): Promise<readonly SweBenchInstance[]> {
  const raw = await readFile(input.instancesJsonl, 'utf8')
  const wanted = input.instanceIds && input.instanceIds.length > 0 ? new Set(input.instanceIds) : undefined
  const out: SweBenchInstance[] = []
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue
    const row = JSON.parse(line) as SweBenchInstance
    if (wanted && !wanted.has(row.instance_id)) continue
    out.push(row)
    if (typeof input.limit === 'number' && out.length >= input.limit) break
  }
  return out
}

async function prepareRun(input: WriteSweBenchPredictionInput): Promise<{ layout: SweBenchRunLayout }> {
  const { layout: l } = await writeSweBenchPredictionRun(input)
  return { layout: l }
}

async function importResults(input: SweBenchIngestResultsInput): Promise<SweBenchImportSummary> {
  const { results } = await ingestSweBenchResults(input)
  const resolved = results.filter((r) => r.resolved).length
  return { runId: input.runId, total: results.length, resolved, results }
}

function explainScore(summary: SweBenchImportSummary): BenchmarkScoreExplanation {
  const pct = summary.total === 0 ? 0 : (summary.resolved / summary.total) * 100
  return {
    headline: `${summary.resolved} / ${summary.total} resolved (official SWE-bench harness)`,
    details: {
      resolved: summary.resolved,
      total: summary.total,
      resolvedPct: Number(pct.toFixed(2)),
    },
    officialTerm: 'resolved',
  }
}

export const swebenchAdapter: SweBenchAdapter = {
  kind: 'swe-bench',
  layout,
  resolveTasks,
  prepareRun,
  runAgent: inferSweBenchPatchRun,
  runVerifier: runSweBenchGrade,
  importResults,
  explainScore,
}
