// Full-rollout RL export. Walks the trials/ directory of a benchmark run
// (SWE-bench EvalTrial JSON and/or Terminal-Bench TrialResult JSON) and
// emits one JSONL row per trial, shaped for a downstream trainer.
//
// This is DIFFERENT from ../rl-export.ts (per-session sidecar/adapter for a
// single rollout) and DIFFERENT from ./badcase-export.ts (failures only with
// reward=0). Here we export ALL trials for a run — successes with reward=1
// and failures with reward=0 — so a verl/slime trainer can consume the full
// rollout distribution.
//
// The shapes mirror the committed contract fixtures under
// packages/host/fixtures/rl-adapters/{verl,slime}/. We do not invent extras.
//
//   verl rows:  { schemaVersion, frameworkTarget:'verl',  rolloutId, taskId,
//                 reward, metadata }
//                 — token ids are captured only per-session (see rl-export.ts);
//                 at the run level we index by rolloutId + reward so a trainer
//                 can join back to captured-token artifacts on disk.
//   slime rows: { schemaVersion, frameworkTarget:'slime', rolloutId, taskId,
//                 reward, entrypoint:'custom_rollout_manifest', metadata }
//
// See docs/planning/enhancement/04-agentic-rl-rollout-export.md and docs/planning/roadmap-notes/rl-e2e.md.

import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { EvalTrial } from '@agent-kernel/shared/enhancement'

import { sweBenchRunLayout } from '../swebench/swebench.js'
import { terminalBenchRunLayout, type TerminalBenchTrialResult } from '../terminal-bench/terminal-bench.js'

export type RolloutExportTarget = 'verl' | 'slime'

export type ExportRolloutsInput = {
  rootDir: string
  runId: string
  /**
   * Optional status filter. Values are matched against a normalized status
   * set: 'resolved' | 'unresolved' | 'errored' | 'completed' | 'failed'
   *    | 'timed_out'.
   * When absent or empty, all statuses are included.
   */
  includeStatuses?: readonly string[]
}

type NormalizedTrial = {
  taskId: string
  resolved: boolean
  status: string
  sessionId?: string
  source: 'swebench' | 'terminal-bench'
}

async function walkRunTrials(rootDir: string, runId: string): Promise<NormalizedTrial[]> {
  const out: NormalizedTrial[] = []
  const swe = sweBenchRunLayout(rootDir, runId)
  const tb = terminalBenchRunLayout(rootDir, runId)
  const seen = new Set<string>()
  for (const layout of [swe.trialsDir, tb.trialsDir]) {
    if (!existsSync(layout)) continue
    if (seen.has(layout)) continue
    seen.add(layout)
    const files = (await readdir(layout)).filter((f) => f.endsWith('.json'))
    for (const file of files) {
      const raw = await readFile(join(layout, file), 'utf8')
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        continue
      }
      const asTb = parsed as Partial<TerminalBenchTrialResult>
      if (typeof asTb.taskId === 'string' && asTb.parserOutput && typeof asTb.parserOutput === 'object') {
        // Terminal-Bench: resolved iff parser reports all passed and status==='resolved'.
        out.push({
          taskId: asTb.taskId,
          resolved: asTb.status === 'resolved' && asTb.parserOutput.allPassed === true,
          status: asTb.status ?? 'unresolved',
          source: 'terminal-bench',
        })
        continue
      }
      const asSwe = parsed as Partial<EvalTrial>
      if (typeof asSwe.instanceId === 'string') {
        out.push({
          taskId: asSwe.instanceId,
          resolved: asSwe.resolved === true,
          status: asSwe.status ?? 'failed',
          ...(asSwe.sessionId ? { sessionId: asSwe.sessionId } : {}),
          source: 'swebench',
        })
      }
    }
  }
  return out.sort((a, b) => a.taskId.localeCompare(b.taskId))
}

function filterByStatus(
  trials: readonly NormalizedTrial[],
  includeStatuses: readonly string[] | undefined,
): NormalizedTrial[] {
  if (!includeStatuses || includeStatuses.length === 0) return [...trials]
  const wanted = new Set(includeStatuses.map((s) => s.trim()).filter((s) => s.length > 0))
  if (wanted.size === 0) return [...trials]
  return trials.filter((t) => wanted.has(t.status))
}

function rolloutIdOf(runId: string, taskId: string): string {
  return `rollout_${runId}__${taskId}`
}

function rewardOf(trial: NormalizedTrial): number {
  return trial.resolved ? 1 : 0
}

function buildVerlRow(runId: string, trial: NormalizedTrial): Record<string, unknown> {
  return {
    schemaVersion: 1,
    frameworkTarget: 'verl',
    rolloutId: rolloutIdOf(runId, trial.taskId),
    taskId: trial.taskId,
    reward: rewardOf(trial),
    metadata: {
      runId,
      source: trial.source,
      status: trial.status,
      resolved: trial.resolved,
      ...(trial.sessionId ? { sessionId: trial.sessionId } : {}),
    },
  }
}

function buildSlimeRow(runId: string, trial: NormalizedTrial): Record<string, unknown> {
  return {
    schemaVersion: 1,
    frameworkTarget: 'slime',
    rolloutId: rolloutIdOf(runId, trial.taskId),
    taskId: trial.taskId,
    reward: rewardOf(trial),
    entrypoint: 'custom_rollout_manifest',
    metadata: {
      runId,
      source: trial.source,
      status: trial.status,
      resolved: trial.resolved,
      ...(trial.sessionId ? { sessionId: trial.sessionId } : {}),
    },
  }
}

function toJsonl(rows: readonly Record<string, unknown>[]): string {
  if (rows.length === 0) return ''
  return `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`
}

export async function exportRolloutsVerl(input: ExportRolloutsInput): Promise<string> {
  const trials = filterByStatus(await walkRunTrials(input.rootDir, input.runId), input.includeStatuses)
  return toJsonl(trials.map((t) => buildVerlRow(input.runId, t)))
}

export async function exportRolloutsSlime(input: ExportRolloutsInput): Promise<string> {
  const trials = filterByStatus(await walkRunTrials(input.rootDir, input.runId), input.includeStatuses)
  return toJsonl(trials.map((t) => buildSlimeRow(input.runId, t)))
}

export async function exportRollouts(input: ExportRolloutsInput & { target: RolloutExportTarget }): Promise<{
  content: string
  rolloutCount: number
}> {
  const trials = filterByStatus(await walkRunTrials(input.rootDir, input.runId), input.includeStatuses)
  const rows = trials.map((t) => (input.target === 'verl' ? buildVerlRow(input.runId, t) : buildSlimeRow(input.runId, t)))
  return { content: toJsonl(rows), rolloutCount: rows.length }
}
