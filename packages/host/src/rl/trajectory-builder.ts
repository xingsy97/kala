import { mkdir, readFile } from 'node:fs/promises'

import {
  AgentRewardArtifactSchema,
  AgentTrainingTrajectorySchema,
  createArtifactStore,
  SlimeSampleValidationSchema,
  type AgentRewardArtifact,
  type AgentTrainingTrajectory,
  type ArtifactRef,
  type PolicyTokenCapture,
  type SlimeSampleValidation,
} from '@agent-kernel/shared/enhancement'

import { loadTokenCapture, validateTokenCapture } from './token-capture.js'

export async function buildTrajectory(input: {
  rootDir: string
  rolloutId: string
  taskId: string
  sessionId: string
  tokenCapturePaths: readonly string[]
  rewardPath?: string
}): Promise<{ artifact: ArtifactRef; trajectory: AgentTrainingTrajectory }> {
  if (input.tokenCapturePaths.length === 0) throw new Error('trajectory requires at least one token capture')
  await mkdir(input.rootDir, { recursive: true })
  const captures: Array<{ capture: PolicyTokenCapture; ref: ArtifactRef }> = []
  for (const path of input.tokenCapturePaths) {
    const capture = await loadTokenCapture(path)
    const validation = validateTokenCapture(capture)
    if (validation.status !== 'ready') throw new Error(validation.blockedReason ?? `invalid capture: ${path}`)
    captures.push({ capture, ref: await fileArtifactRef('rl_token_capture', path, input.rootDir) })
  }
  const rewardRef = input.rewardPath ? await fileArtifactRef('rl_reward', input.rewardPath, input.rootDir) : undefined
  const trajectory: AgentTrainingTrajectory = {
    schemaVersion: 'agent.training_trajectory.v1',
    rolloutId: input.rolloutId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    turns: captures.map(({ capture, ref }, index) => ({
      turnIndex: index,
      callId: capture.callId,
      promptTokenCount: capture.promptIds.length,
      responseTokenCount: capture.outputIds.length,
      tokenCaptureRef: ref,
      lossMaskStart: 0,
      lossMaskEnd: capture.responseMask.length,
      role: 'assistant_policy_output',
    })),
    ...(rewardRef ? { rewardRef } : {}),
    readiness: rewardRef ? 'reward-verified' : 'token-captured',
  }
  AgentTrainingTrajectorySchema.parse(trajectory)
  const store = createArtifactStore(input.rootDir)
  const artifact = await store.writeJson('rl_trajectory', `rl-trajectories/${sanitize(input.rolloutId)}.json`, trajectory)
  return { artifact, trajectory }
}

export async function validateSlimeSampleReadiness(input: {
  rootDir: string
  trajectoryPath: string
  rewardPath: string
  requireLogprobs?: boolean
}): Promise<{ artifact: ArtifactRef; validation: SlimeSampleValidation }> {
  const trajectoryRaw = JSON.parse(await readFile(input.trajectoryPath, 'utf8')) as unknown
  const trajectory = AgentTrainingTrajectorySchema.parse(trajectoryRaw)
  const rewardRaw = JSON.parse(await readFile(input.rewardPath, 'utf8')) as unknown
  const reward = AgentRewardArtifactSchema.parse(rewardRaw)
  const captures = await Promise.all(trajectory.turns.map((turn) => loadTokenCapture(resolveArtifactPath(input.rootDir, turn.tokenCaptureRef.uri))))
  const tokens = captures.flatMap((capture) => [...capture.promptIds, ...capture.outputIds])
  const responseLength = captures.reduce((sum, capture) => sum + capture.outputIds.length, 0)
  const lossMask = captures.flatMap((capture) => capture.responseMask)
  const logprobs = captures.flatMap((capture) => capture.outputLogProbs ?? [])
  const checks = {
    tokensNonEmpty: tokens.length > 0,
    responseLengthPositive: responseLength > 0,
    lossMaskAligned: lossMask.length === responseLength,
    ...(input.requireLogprobs ? { logprobsAligned: logprobs.length === responseLength } : {}),
    rewardPresent: Number.isFinite(reward.reward),
    trainableTokenPresent: lossMask.some((item) => item === 1),
  }
  const failed = Object.entries(checks).filter(([, ok]) => ok !== true).map(([key]) => key)
  const validation: SlimeSampleValidation = {
    schemaVersion: 'agent.slime_sample_validation.v1',
    rolloutId: trajectory.rolloutId,
    taskId: trajectory.taskId,
    status: failed.length === 0 ? 'ready' : 'blocked',
    readiness: failed.length === 0 ? 'slime-sample-ready' : 'blocked',
    checks,
    ...(failed.length > 0 ? { blockedReason: `failed checks: ${failed.join(', ')}` } : {}),
    metadata: {
      trajectoryPath: input.trajectoryPath,
      rewardPath: input.rewardPath,
      tokenCaptureCount: captures.length,
      reward: reward.reward,
    },
  }
  SlimeSampleValidationSchema.parse(validation)
  const store = createArtifactStore(input.rootDir)
  const artifact = await store.writeJson('rl_sample_validation', `rl-sample-validations/${sanitize(trajectory.rolloutId)}.json`, validation)
  return { artifact, validation }
}

async function fileArtifactRef(kind: ArtifactRef['kind'], path: string, rootDir?: string): Promise<ArtifactRef> {
  const { stat } = await import('node:fs/promises')
  const { createHash } = await import('node:crypto')
  const bytes = await readFile(path)
  const info = await stat(path)
  const uri = rootDir && path.startsWith(`${rootDir}/`) ? path.slice(rootDir.length + 1) : path
  return {
    kind,
    uri,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: info.size,
    redaction: { redacted: false, rules: [], truncated: false },
    mediaType: 'application/json',
  }
}

function resolveArtifactPath(rootDir: string, uri: string): string {
  return uri.startsWith('/') ? uri : `${rootDir}/${uri}`
}

function sanitize(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._:-]+/g, '_')
  return cleaned.length > 0 ? cleaned : 'unknown'
}
