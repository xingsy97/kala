/**
 * Verifier reward runner: turns a graded trial result (or a scored Session
 * result) into a canonical `rl_reward` artifact that RL adapters can
 * reference through `RolloutSidecar.reward_ref`.
 *
 * Reward is binary — `1.0` when the trial resolved, `0.0` otherwise — plus a
 * low-cardinality shaped label vocabulary owned by the product RL pipeline.
 * The runner does not run a verifier itself; it reads an already-graded
 * artifact so the reward is reproducible from disk. See enhancement doc §04.
 */

import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'

import {
  createArtifactStore,
  type ArtifactRef,
} from '@agent-kernel/shared/enhancement'

export type RewardSourceKind = 'trial_result' | 'score_result'

export type RlRewardLabel =
  | 'resolved'
  | 'agent_timeout'
  | 'agent_error'
  | 'empty_patch'
  | 'patch_apply_failed'
  | 'test_failed'
  | 'harness_error'
  | 'infrastructure_error'

type TrialRewardInput = {
  trialId?: unknown
  taskId?: unknown
  instanceId?: unknown
  sessionId?: unknown
  status?: unknown
  resolved?: unknown
  failureLabel?: unknown
}

type ScoreRewardInput = {
  taskId?: unknown
  instanceId?: unknown
  resolved?: unknown
  failureLabel?: unknown
  results?: readonly { passed?: unknown; label?: unknown }[]
}

export type RolloutReward = {
  schemaVersion: 1
  taskId: string
  sessionId?: string
  sourceKind: RewardSourceKind
  sourcePath: string
  reward: number
  resolved: boolean
  shapedLabels: readonly RlRewardLabel[]
  reasonCodes: readonly string[]
  createdAt: string
}

export type VerifyRewardInput = {
  rootDir: string
  trialPath?: string
  scorePath?: string
  taskId?: string
  sessionId?: string
  workspaceRoot?: string
}

export type VerifyRewardResult = {
  reward: RolloutReward
  artifact: ArtifactRef
}

export async function verifyReward(input: VerifyRewardInput): Promise<VerifyRewardResult> {
  const source = await loadSource(input)
  const store = createArtifactStore(input.rootDir, {
    ...(input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : {}),
  })
  const reward: RolloutReward = {
    schemaVersion: 1,
    taskId: source.taskId,
    ...(source.sessionId ? { sessionId: source.sessionId } : {}),
    sourceKind: source.kind,
    sourcePath: source.path,
    reward: source.resolved ? 1 : 0,
    resolved: source.resolved,
    shapedLabels: source.shapedLabels,
    reasonCodes: source.reasonCodes,
    createdAt: new Date().toISOString(),
  }
  const artifact = await store.writeJson(
    'rl_reward',
    `rl-rewards/${sanitizeTaskId(source.taskId)}.json`,
    reward,
  )
  return { reward, artifact }
}

type LoadedSource = {
  kind: RewardSourceKind
  path: string
  taskId: string
  sessionId?: string
  resolved: boolean
  shapedLabels: readonly RlRewardLabel[]
  reasonCodes: readonly string[]
}

async function loadSource(input: VerifyRewardInput): Promise<LoadedSource> {
  if (input.trialPath && input.scorePath) {
    throw new Error('provide either --trial or --score, not both')
  }
  if (input.trialPath) return loadTrial(input.trialPath, input)
  if (input.scorePath) return loadScore(input.scorePath, input)
  throw new Error('missing required --trial or --score')
}

async function loadTrial(path: string, input: VerifyRewardInput): Promise<LoadedSource> {
  const raw = JSON.parse(await readFile(path, 'utf8')) as TrialRewardInput
  const trialId = stringValue(raw.trialId)
  const taskId = stringValue(raw.taskId) ?? stringValue(raw.instanceId)
  if (!trialId || !taskId) {
    throw new Error(`trial result missing trialId/taskId: ${path}`)
  }
  const resolved = raw.resolved === true
  const labels: RlRewardLabel[] = []
  const reasonCodes: string[] = ['source:trial_result', `status:${stringValue(raw.status) ?? 'unknown'}`]
  if (resolved) {
    labels.push('resolved')
    reasonCodes.push('resolved')
  } else if (isRlRewardLabel(raw.failureLabel)) {
    labels.push(raw.failureLabel)
    reasonCodes.push(`failure:${raw.failureLabel}`)
  } else {
    reasonCodes.push('no_failure_label')
  }
  return {
    kind: 'trial_result',
    path,
    taskId: input.taskId ?? taskId,
    ...(input.sessionId ?? stringValue(raw.sessionId) ? { sessionId: input.sessionId ?? stringValue(raw.sessionId) } : {}),
    resolved,
    shapedLabels: labels,
    reasonCodes,
  }
}

async function loadScore(path: string, input: VerifyRewardInput): Promise<LoadedSource> {
  const raw = JSON.parse(await readFile(path, 'utf8')) as ScoreRewardInput
  if (typeof raw.resolved !== 'boolean' || !isRlRewardLabel(raw.failureLabel)) {
    throw new Error(`score artifact missing resolved/failureLabel: ${path}`)
  }
  const resolved = raw.resolved === true
  const labels = new Set<RlRewardLabel>()
  labels.add(raw.failureLabel)
  for (const result of raw.results ?? []) {
    if (result.passed === false && isRlRewardLabel(result.label)) labels.add(result.label)
  }
  const reasonCodes: string[] = ['source:score_result']
  if (resolved) reasonCodes.push('resolved')
  else reasonCodes.push(`failure:${raw.failureLabel}`)
  const taskId = input.taskId ?? stringValue(raw.taskId) ?? stringValue(raw.instanceId)
  if (!taskId) throw new Error(`score result missing taskId and no --task-id override: ${path}`)
  return {
    kind: 'score_result',
    path,
    taskId,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    resolved,
    shapedLabels: [...labels],
    reasonCodes,
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function isRlRewardLabel(value: unknown): value is RlRewardLabel {
  return value === 'resolved'
    || value === 'agent_timeout'
    || value === 'agent_error'
    || value === 'empty_patch'
    || value === 'patch_apply_failed'
    || value === 'test_failed'
    || value === 'harness_error'
    || value === 'infrastructure_error'
}

function sanitizeTaskId(taskId: string): string {
  const cleaned = taskId.replace(/[^A-Za-z0-9._:-]+/g, '_')
  return cleaned.length > 0 ? cleaned : basename(taskId) || 'unknown'
}
