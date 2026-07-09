/**
 * `eval profile-aggregate` command: walks a runs directory tree, discovers
 * every `profile.json` artifact produced by `profile session`, and computes a
 * cross-trial distribution of cost, tokens, latency, and TTFT. When a
 * summary.json is present at the root, it also computes cost-per-resolved-task
 * and per-model cost breakdowns.
 *
 * This is a pure aggregation step over already-persisted profile artifacts. It
 * does not read session logs and does not invent numbers when profiles report
 * `costStatus: 'unknown'`; those trials are counted separately.
 */

import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, sep } from 'node:path'

import type { EvalRunSummary, SessionProfile } from '@agent-kernel/shared/enhancement'

export type ProfileAggregateInput = {
  rootDir: string
  outputFilename?: string
  summaryPath?: string
}

export type NumericDistribution = {
  count: number
  min: number
  max: number
  mean: number
  p50: number
  p95: number
  total: number
}

export type ProfileAggregateReport = {
  rootDir: string
  generatedAt: string
  profileCount: number
  profilePaths: readonly string[]
  costStatus: {
    estimated: number
    unknown: number
  }
  models: Record<string, number>
  totals: {
    llmCalls: number
    toolCalls: number
    toolErrors: number
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheCreationTokens: number
    missingUsageCalls: number
    llmTraceMissingCalls: number
    estimatedCostUsd: number
  }
  distributions: {
    llmCalls?: NumericDistribution
    toolCalls?: NumericDistribution
    wallTimeMs?: NumericDistribution
    estimatedCostUsd?: NumericDistribution
    averageLlmDurationMs?: NumericDistribution
    p95LlmDurationMs?: NumericDistribution
    averageTimeToFirstChunkMs?: NumericDistribution
    p95TimeToFirstChunkMs?: NumericDistribution
    inputTokens?: NumericDistribution
    outputTokens?: NumericDistribution
  }
  perModelCostUsd?: Record<string, number>
  summary?: {
    experimentId: string
    trialCount: number
    resolved: number
    costPerResolvedUsd?: number
    costPerTrialUsd?: number
  }
}

export async function aggregateProfiles(
  input: ProfileAggregateInput,
): Promise<{ report: ProfileAggregateReport; reportPath: string }> {
  const profilePaths = await findProfileJsonFiles(input.rootDir)
  const profiles: SessionProfile[] = []
  for (const path of profilePaths) {
    const raw = await readFile(path, 'utf8')
    try {
      profiles.push(JSON.parse(raw) as SessionProfile)
    } catch (err) {
      throw new Error(`could not parse profile ${path}: ${(err as Error).message}`)
    }
  }
  let summary: EvalRunSummary | undefined
  if (input.summaryPath) {
    summary = JSON.parse(await readFile(input.summaryPath, 'utf8')) as EvalRunSummary
  }
  const report = buildProfileAggregate({
    rootDir: input.rootDir,
    profilePaths: profilePaths.map((p) => relative(input.rootDir, p).split(sep).join('/')),
    profiles,
    ...(summary ? { summary } : {}),
  })
  await mkdir(input.rootDir, { recursive: true })
  const reportPath = join(input.rootDir, input.outputFilename ?? 'profile-aggregate.json')
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  return { report, reportPath }
}

export function buildProfileAggregate(input: {
  rootDir: string
  profilePaths: readonly string[]
  profiles: readonly SessionProfile[]
  summary?: EvalRunSummary
}): ProfileAggregateReport {
  const modelCounts: Record<string, number> = {}
  const perModelCost: Record<string, number> = {}
  const totals = {
    llmCalls: 0,
    toolCalls: 0,
    toolErrors: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    missingUsageCalls: 0,
    llmTraceMissingCalls: 0,
    estimatedCostUsd: 0,
  }
  let estimated = 0
  let unknown = 0
  const llmCallsValues: number[] = []
  const toolCallsValues: number[] = []
  const wallTimeValues: number[] = []
  const costValues: number[] = []
  const avgDurValues: number[] = []
  const p95DurValues: number[] = []
  const avgTtftValues: number[] = []
  const p95TtftValues: number[] = []
  const inputTokenValues: number[] = []
  const outputTokenValues: number[] = []

  for (const profile of input.profiles) {
    if (profile.costStatus === 'estimated') estimated += 1
    else unknown += 1
    for (const model of profile.models) {
      modelCounts[model] = (modelCounts[model] ?? 0) + 1
    }
    totals.llmCalls += profile.llmCalls
    totals.toolCalls += profile.toolCalls
    totals.toolErrors += profile.toolErrors
    totals.inputTokens += profile.totalInputTokens
    totals.outputTokens += profile.totalOutputTokens
    totals.cacheReadTokens += profile.totalCacheReadTokens
    totals.cacheCreationTokens += profile.totalCacheCreationTokens
    totals.missingUsageCalls += profile.missingUsageCalls
    totals.llmTraceMissingCalls += profile.llmTraceMissingCalls
    llmCallsValues.push(profile.llmCalls)
    toolCallsValues.push(profile.toolCalls)
    if (profile.wallTimeMs !== undefined) wallTimeValues.push(profile.wallTimeMs)
    if (profile.estimatedCostUsd !== undefined) {
      totals.estimatedCostUsd += profile.estimatedCostUsd
      costValues.push(profile.estimatedCostUsd)
      if (profile.models.length === 1) {
        const model = profile.models[0]!
        perModelCost[model] = (perModelCost[model] ?? 0) + profile.estimatedCostUsd
      }
    }
    if (profile.averageLlmDurationMs !== undefined) avgDurValues.push(profile.averageLlmDurationMs)
    if (profile.p95LlmDurationMs !== undefined) p95DurValues.push(profile.p95LlmDurationMs)
    if (profile.averageTimeToFirstChunkMs !== undefined) avgTtftValues.push(profile.averageTimeToFirstChunkMs)
    if (profile.p95TimeToFirstChunkMs !== undefined) p95TtftValues.push(profile.p95TimeToFirstChunkMs)
    inputTokenValues.push(profile.totalInputTokens)
    outputTokenValues.push(profile.totalOutputTokens)
  }

  const totalCostForSummary = roundCost(totals.estimatedCostUsd)
  totals.estimatedCostUsd = totalCostForSummary
  const distributions: ProfileAggregateReport['distributions'] = {
    ...maybeDistribution('llmCalls', llmCallsValues),
    ...maybeDistribution('toolCalls', toolCallsValues),
    ...maybeDistribution('wallTimeMs', wallTimeValues),
    ...maybeDistribution('estimatedCostUsd', costValues),
    ...maybeDistribution('averageLlmDurationMs', avgDurValues),
    ...maybeDistribution('p95LlmDurationMs', p95DurValues),
    ...maybeDistribution('averageTimeToFirstChunkMs', avgTtftValues),
    ...maybeDistribution('p95TimeToFirstChunkMs', p95TtftValues),
    ...maybeDistribution('inputTokens', inputTokenValues),
    ...maybeDistribution('outputTokens', outputTokenValues),
  }

  const report: ProfileAggregateReport = {
    rootDir: input.rootDir,
    generatedAt: new Date().toISOString(),
    profileCount: input.profiles.length,
    profilePaths: input.profilePaths,
    costStatus: { estimated, unknown },
    models: Object.fromEntries(Object.entries(modelCounts).sort(([a], [b]) => a.localeCompare(b))),
    totals,
    distributions,
    ...(Object.keys(perModelCost).length > 0 ? {
      perModelCostUsd: Object.fromEntries(
        Object.entries(perModelCost)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, value]) => [key, roundCost(value)]),
      ),
    } : {}),
  }
  if (input.summary) {
    const resolved = input.summary.resolved
    const trialCount = input.summary.trialCount
    const summaryBlock: NonNullable<ProfileAggregateReport['summary']> = {
      experimentId: input.summary.experimentId,
      trialCount,
      resolved,
    }
    if (resolved > 0 && costValues.length > 0) {
      summaryBlock.costPerResolvedUsd = roundCost(totals.estimatedCostUsd / resolved)
    }
    if (trialCount > 0 && costValues.length > 0) {
      summaryBlock.costPerTrialUsd = roundCost(totals.estimatedCostUsd / trialCount)
    }
    report.summary = summaryBlock
  }
  return report
}

function maybeDistribution(
  key: keyof ProfileAggregateReport['distributions'],
  values: readonly number[],
): Partial<ProfileAggregateReport['distributions']> {
  if (values.length === 0) return {}
  return { [key]: distributionOf(values) } as Partial<ProfileAggregateReport['distributions']>
}

function distributionOf(values: readonly number[]): NumericDistribution {
  const sorted = [...values].sort((a, b) => a - b)
  const total = sorted.reduce((sum, value) => sum + value, 0)
  return {
    count: sorted.length,
    min: round(sorted[0]!),
    max: round(sorted[sorted.length - 1]!),
    mean: round(total / sorted.length),
    p50: round(percentile(sorted, 0.5)),
    p95: round(percentile(sorted, 0.95)),
    total: round(total),
  }
}

function percentile(sorted: readonly number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))
  return sorted[idx]!
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}

function roundCost(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}

async function findProfileJsonFiles(rootDir: string): Promise<string[]> {
  const rootStat = await stat(rootDir).catch(() => undefined)
  if (!rootStat) return []
  const out: string[] = []
  await visit(rootDir, out)
  out.sort()
  return out
}

async function visit(dir: string, out: string[]): Promise<void> {
  const dirents = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const dirent of dirents) {
    const child = join(dir, dirent.name)
    if (dirent.isDirectory()) {
      await visit(child, out)
      continue
    }
    if (dirent.isFile() && basename(child) === 'profile.json') {
      out.push(child)
      continue
    }
  }
}

/** Used by tests to derive an in-directory path. */
export function profileAggregatePathFor(rootDir: string, filename = 'profile-aggregate.json'): string {
  return join(rootDir, filename)
}

/** Small helper used by ops-cli tests to sanity-check the discovery walker. */
export async function listProfileArtifactPaths(rootDir: string): Promise<readonly string[]> {
  const paths = await findProfileJsonFiles(rootDir)
  return paths.map((p) => relative(rootDir, p).split(sep).join('/'))
}

/** Exposes the parent directory of a discovered profile.json, used by trial identification. */
export function trialIdFromProfilePath(rootDir: string, profilePath: string): string {
  return relative(rootDir, dirname(profilePath)).split(sep).join('/') || '.'
}
