import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { fold } from '@agent-kernel/kernel'
import {
  createArtifactStore,
  createModelJudgeTraceArtifact,
  createSessionProfile,
  diffSubAgentUsage,
  summarizeEvalScores,
  type ArtifactRef,
  type EvalScoreResult,
  type EvalScoreSummary,
  type EvalRunSummary,
  type EvalSubAgentUsageDelta,
  type PricingTable,
  type SessionProfile,
} from '@agent-kernel/shared/enhancement'

import { readSessionLog } from '../store/log.js'

export type ScoreSessionInput = {
  rootDir: string
  sessionLogPath: string
  instanceId?: string
  patchPath?: string
  requireDone?: boolean
  workspaceRoot?: string
}

export async function scoreSession(
  input: ScoreSessionInput,
): Promise<{ summary: EvalScoreSummary; scoresPath: string; artifacts: readonly ArtifactRef[] }> {
  const parsed = await readSessionLog(input.sessionLogPath)
  await mkdir(input.rootDir, { recursive: true })
  const store = createArtifactStore(input.rootDir, {
    ...(input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : {}),
  })
  const artifacts: ArtifactRef[] = []
  let patch = ''
  if (input.patchPath) {
    patch = await readFile(input.patchPath, 'utf8')
    artifacts.push(await store.writeText('diff', `artifacts/${basename(input.patchPath)}`, patch))
  }
  const results: EvalScoreResult[] = []
  if (input.patchPath) {
    const passed = patch.trim().length > 0
    results.push({
      scorer: 'patch.non_empty',
      passed,
      ...(passed ? {} : { label: 'empty_patch' }),
      score: passed ? 1 : 0,
      metrics: { patchBytes: Buffer.byteLength(patch, 'utf8') },
      artifactRefs: artifacts,
      explanation: passed ? 'Patch contains changes.' : 'Patch file is empty.',
    })
  }
  const agentError = parsed.events.find((entry) => entry.event.kind === 'llm_error')
  results.push({
    scorer: 'agent.no_llm_error',
    passed: !agentError,
    ...(!agentError ? {} : { label: 'agent_error' as const }),
    score: agentError ? 0 : 1,
    metrics: { llmErrors: agentError ? 1 : 0 },
    artifactRefs: [],
    explanation: agentError ? 'Session contains an llm_error event.' : 'No llm_error event was recorded.',
  })
  const toolErrors = parsed.events.filter((entry) => entry.event.kind === 'tool_result' && entry.event.ok === false).length
  results.push({
    scorer: 'tools.no_failed_results',
    passed: toolErrors === 0,
    ...(toolErrors === 0 ? {} : { label: 'agent_error' as const }),
    score: toolErrors === 0 ? 1 : 0,
    metrics: { toolErrors },
    artifactRefs: [],
  })
  if (input.requireDone) {
    const finalState = fold(parsed.header.initialState, parsed.events.map((entry) => entry.event), parsed.header.config)
    const passed = finalState.status === 'done'
    results.push({
      scorer: 'session.final_status_done',
      passed,
      ...(passed ? {} : { label: 'agent_error' as const }),
      score: passed ? 1 : 0,
      metrics: { finalStatus: finalState.status },
      artifactRefs: [],
    })
  }
  const summary = summarizeEvalScores(results, input.instanceId)
  const scoresPath = join(input.rootDir, 'scores.json')
  await writeFile(scoresPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  return { summary, scoresPath, artifacts }
}

export type ProfileSessionInput = {
  rootDir: string
  sessionLogPath: string
  pricingPath?: string
}

export type JudgeScoreInput = {
  rootDir: string
  promptPath: string
  responsePath: string
  judgeModel: string
  scorer?: string
  instanceId?: string
  threshold?: number
  inputRef?: string
  workspaceRoot?: string
}

export async function judgeScore(
  input: JudgeScoreInput,
): Promise<{ summary: EvalScoreSummary; scoresPath: string; judgeTrace: ArtifactRef }> {
  await mkdir(input.rootDir, { recursive: true })
  const store = createArtifactStore(input.rootDir, {
    ...(input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : {}),
  })
  const prompt = await readFile(input.promptPath, 'utf8')
  const responseRaw = await readFile(input.responsePath, 'utf8')
  const response = parseJudgeResponse(responseRaw)
  const score = extractJudgeScore(response)
  const label = extractJudgeLabel(response)
  const explanation = extractJudgeExplanation(response)
  const scorer = input.scorer ?? 'model_judge.score'
  const trace = createModelJudgeTraceArtifact({
    scorer,
    judgeModel: input.judgeModel,
    ...(input.inputRef ? { inputRef: input.inputRef } : {}),
    prompt,
    response,
    score,
    threshold: input.threshold,
    ...(label ? { label } : {}),
    ...(explanation ? { explanation } : {}),
    metadata: {
      promptFile: basename(input.promptPath),
      responseFile: basename(input.responsePath),
    },
  })
  const judgeTrace = await store.writeJson('eval_judge', `judge/${scorer.replace(/[^a-zA-Z0-9_.-]/g, '_')}.judge-trace.json`, trace)
  const summary = summarizeEvalScores([
    {
      scorer,
      passed: trace.parsed.passed,
      ...(!trace.parsed.passed ? { label: failureLabelForJudge(trace.parsed.label) } : {}),
      score: trace.parsed.score,
      metrics: { threshold: Number(trace.metadata.threshold), judgeScore: trace.parsed.score },
      artifactRefs: [judgeTrace],
      ...(trace.parsed.explanation ? { explanation: trace.parsed.explanation } : {}),
    },
  ], input.instanceId)
  const scoresPath = join(input.rootDir, 'scores.json')
  await writeFile(scoresPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  return { summary, scoresPath, judgeTrace }
}

export async function profileSession(
  input: ProfileSessionInput,
): Promise<{ profile: SessionProfile; profilePath: string }> {
  const parsed = await readSessionLog(input.sessionLogPath)
  await mkdir(input.rootDir, { recursive: true })
  const pricing = input.pricingPath
    ? JSON.parse(await readFile(input.pricingPath, 'utf8')) as PricingTable
    : undefined
  const profile = createSessionProfile({
    header: parsed.header,
    events: parsed.events,
    ...(pricing ? { pricing } : {}),
  })
  const profilePath = join(input.rootDir, 'profile.json')
  await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`, 'utf8')
  return { profile, profilePath }
}

function parseJudgeResponse(raw: string): unknown {
  const trimmed = raw.trim()
  if (!trimmed) throw new Error('judge response is empty')
  try {
    return JSON.parse(trimmed) as unknown
  } catch {
    return { text: raw }
  }
}

function extractJudgeScore(response: unknown): number {
  if (!response || typeof response !== 'object') throw new Error('judge response must contain a numeric score')
  const record = response as Record<string, unknown>
  const candidate = record.score ?? record.rating ?? record.value
  if (typeof candidate !== 'number' || !Number.isFinite(candidate)) throw new Error('judge response must contain a numeric score')
  return candidate
}

function extractJudgeLabel(response: unknown): EvalScoreResult['label'] | undefined {
  if (!response || typeof response !== 'object') return undefined
  const label = (response as Record<string, unknown>).label
  return isEvalFailureLabel(label) ? label : undefined
}

function extractJudgeExplanation(response: unknown): string | undefined {
  if (!response || typeof response !== 'object') return undefined
  const record = response as Record<string, unknown>
  const explanation = record.explanation ?? record.reason
  return typeof explanation === 'string' ? explanation : undefined
}

function isEvalFailureLabel(value: unknown): value is EvalScoreResult['label'] {
  return value === 'resolved' || value === 'agent_timeout' || value === 'agent_error' || value === 'empty_patch' || value === 'patch_apply_failed' || value === 'test_failed' || value === 'harness_error' || value === 'infrastructure_error'
}

function failureLabelForJudge(label: EvalScoreResult['label'] | undefined): NonNullable<EvalScoreResult['label']> {
  return label && label !== 'resolved' ? label : 'agent_error'
}

export type CompareEvalRunsInput = {
  rootDir: string
  baselineSummaryPath: string
  candidateSummaryPath: string
}

export type EvalRunComparison = {
  baseline: Pick<EvalRunSummary, 'experimentId' | 'trialCount' | 'resolved' | 'failed' | 'timedOut'>
  candidate: Pick<EvalRunSummary, 'experimentId' | 'trialCount' | 'resolved' | 'failed' | 'timedOut'>
  deltas: {
    resolved: number
    failed: number
    timedOut: number
    passRate: number
  }
  failureDeltas: Record<string, number>
  subagentUsageDelta?: EvalSubAgentUsageDelta
}

export async function compareEvalRuns(
  input: CompareEvalRunsInput,
): Promise<{ comparison: EvalRunComparison; comparisonPath: string }> {
  const baseline = JSON.parse(await readFile(input.baselineSummaryPath, 'utf8')) as EvalRunSummary
  const candidate = JSON.parse(await readFile(input.candidateSummaryPath, 'utf8')) as EvalRunSummary
  const failureLabels = new Set([...Object.keys(baseline.failureCounts), ...Object.keys(candidate.failureCounts)])
  const failureDeltas: Record<string, number> = {}
  for (const label of [...failureLabels].sort()) {
    failureDeltas[label] = (candidate.failureCounts[label] ?? 0) - (baseline.failureCounts[label] ?? 0)
  }
  const subagentUsageDelta = diffSubAgentUsage(baseline.subagentUsage, candidate.subagentUsage)
  const comparison: EvalRunComparison = {
    baseline: pickComparableSummary(baseline),
    candidate: pickComparableSummary(candidate),
    deltas: {
      resolved: candidate.resolved - baseline.resolved,
      failed: candidate.failed - baseline.failed,
      timedOut: candidate.timedOut - baseline.timedOut,
      passRate: numberMetric(candidate.metrics.passRate) - numberMetric(baseline.metrics.passRate),
    },
    failureDeltas,
    ...(subagentUsageDelta ? { subagentUsageDelta } : {}),
  }
  await mkdir(input.rootDir, { recursive: true })
  const comparisonPath = join(input.rootDir, 'eval-comparison.json')
  await writeFile(comparisonPath, `${JSON.stringify(comparison, null, 2)}\n`, 'utf8')
  return { comparison, comparisonPath }
}

function pickComparableSummary(summary: EvalRunSummary): EvalRunComparison['baseline'] {
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
