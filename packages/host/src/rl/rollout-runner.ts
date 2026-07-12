import { randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { AgentConfig, AgentEvent, AgentState, Effect, ToolSchema } from '@agent-kernel/kernel'
import {
  AgentRlRolloutResultSchema,
  createArtifactStore,
  deriveEvalMemoryPolicy,
  type AgentRlRolloutResult,
  type AgentRlTask,
  type ArtifactRef,
  type RolloutReadiness,
} from '@agent-kernel/shared/enhancement'

import type { LLMAdapter } from '../llm/adapter.js'
import type { LoopBroadcast, ToolDispatcher } from '../loop-types.js'
import { runHostLoop } from '../loop.js'
import { SessionStore } from '../store/session.js'
import { buildTrajectory, validateSlimeSampleReadiness } from './trajectory-builder.js'
import { validateTokenCapture } from './token-capture.js'
import { defaultWorkspaceForTask, runCommandVerifier } from './verifier.js'

export type RunRlRolloutInput = {
  rootDir: string
  task: AgentRlTask
  llm: LLMAdapter
  tools?: ToolDispatcher
  config?: Partial<AgentConfig>
  rolloutId?: string
  sessionId?: string
  maxTurns?: number
  timeoutMs?: number
  requireLogprobs?: boolean
}

export type RunRlRolloutOutput = {
  artifact: ArtifactRef
  result: AgentRlRolloutResult
}

export async function runRlRollout(input: RunRlRolloutInput): Promise<RunRlRolloutOutput> {
  const startedAt = new Date()
  const rolloutId = input.rolloutId ?? `rollout_${randomUUID()}`
  const sessionId = input.sessionId ?? `rl_${randomUUID()}`
  const timeoutMs = input.timeoutMs ?? 60_000
  const workspace = defaultWorkspaceForTask(input.rootDir, rolloutId, input.task)
  await mkdir(workspace, { recursive: true })
  const store = createArtifactStore(input.rootDir)
  const taskRef = await store.writeJson('rl_task_pool', `rl-tasks/${sanitize(rolloutId)}.json`, input.task)
  const sessionStore = new SessionStore(join(input.rootDir, 'sessions'))
  const events: Array<{ seq: number; event: AgentEvent; effects: readonly Effect[]; state: AgentState }> = []
  const broadcast: LoopBroadcast = {
    onEvent(_sid, seq, event, effects, state) {
      events.push({ seq, event, effects, state })
    },
    onApprovalRequired() {},
    onError(_sid, message) {
      events.push({ seq: -1, event: { kind: 'llm_error', error: message }, effects: [], state: sessionStore.get(sessionId)?.state as AgentState })
    },
  }
  const record = await sessionStore.create({
    sessionId,
    config: {
      tools: input.config?.tools ?? [],
      ...(input.config?.systemPrompt ? { systemPrompt: input.config.systemPrompt } : {}),
      ...(input.config?.contextLimit ? { contextLimit: input.config.contextLimit } : {}),
    },
    initialCwd: workspace,
    initialApprovalMode: 'allow_all',
    memoryPolicy: deriveEvalMemoryPolicy({ benchmarkIsolation: true }),
  })
  const loop = runHostLoop({
    store: sessionStore,
    llm: input.llm,
    tools: input.tools ?? noToolDispatcher(),
    broadcast,
    artifactRootDir: input.rootDir,
  })
  let status: AgentRlRolloutResult['status'] = 'completed'
  let blockedReason: string | undefined
  try {
    await withTimeout(loop.dispatch(sessionId, { kind: 'user_message', text: input.task.prompt }), timeoutMs)
  } catch (error) {
    status = error instanceof TimeoutError ? 'timeout' : 'failed'
    blockedReason = error instanceof Error ? error.message : String(error)
    if (status === 'timeout') loop.cancelStream(sessionId)
  }
  const eventLogRef = await fileArtifactRef('trace', record.logPath)
  const tokenCaptureRefs = await collectTokenCaptureRefs(input.rootDir, rolloutId)
  let rewardRef: ArtifactRef | undefined
  let trajectoryRef: ArtifactRef | undefined
  let sampleValidationRef: ArtifactRef | undefined
  let readiness: RolloutReadiness = tokenCaptureRefs.length > 0 ? 'token-captured' : 'live-rollout-complete'
  if (status === 'completed') {
    try {
      const reward = await runCommandVerifier({ rootDir: input.rootDir, rolloutId, task: input.task, cwd: workspace })
      rewardRef = reward.artifact
      readiness = 'reward-verified'
      if (tokenCaptureRefs.length > 0) {
        const trajectory = await buildTrajectory({
          rootDir: input.rootDir,
          rolloutId,
          taskId: input.task.taskId,
          sessionId,
          tokenCapturePaths: tokenCaptureRefs.map((ref) => join(input.rootDir, ref.uri)),
          rewardPath: join(input.rootDir, rewardRef.uri),
        })
        trajectoryRef = trajectory.artifact
        const validation = await validateSlimeSampleReadiness({
          rootDir: input.rootDir,
          trajectoryPath: join(input.rootDir, trajectoryRef.uri),
          rewardPath: join(input.rootDir, rewardRef.uri),
          requireLogprobs: input.requireLogprobs,
        })
        sampleValidationRef = validation.artifact
        readiness = validation.validation.readiness
        if (validation.validation.status !== 'ready') {
          status = 'blocked'
          blockedReason = validation.validation.blockedReason
        }
      } else {
        status = 'blocked'
        readiness = 'blocked'
        blockedReason = 'no policy token capture artifacts were produced'
      }
    } catch (error) {
      status = 'blocked'
      readiness = 'blocked'
      blockedReason = error instanceof Error ? error.message : String(error)
    }
  } else {
    readiness = 'blocked'
  }
  const completedAt = new Date()
  const result: AgentRlRolloutResult = {
    schemaVersion: 'agent.rl.rollout_result.v1',
    rolloutId,
    taskId: input.task.taskId,
    sessionId,
    status,
    readiness,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    durationMs: completedAt.getTime() - startedAt.getTime(),
    taskRef,
    eventLogRef,
    tokenCaptureRefs,
    ...(rewardRef ? { rewardRef } : {}),
    ...(trajectoryRef ? { trajectoryRef } : {}),
    ...(sampleValidationRef ? { sampleValidationRef } : {}),
    ...(blockedReason ? { blockedReason } : {}),
    metadata: {
      eventCount: events.length,
      workspace,
      finalStatus: sessionStore.get(sessionId)?.state.status ?? 'unknown',
    },
  }
  AgentRlRolloutResultSchema.parse(result)
  const artifact = await store.writeJson('rl_rollout_result', `rl-rollouts/${sanitize(rolloutId)}.json`, result)
  return { artifact, result }
}

async function collectTokenCaptureRefs(rootDir: string, rolloutId: string): Promise<ArtifactRef[]> {
  const { readdir } = await import('node:fs/promises')
  const dir = join(rootDir, 'rl-token-captures', sanitize(rolloutId))
  let files: string[]
  try {
    files = (await readdir(dir)).filter((file) => file.endsWith('.json')).sort()
  } catch {
    return []
  }
  const refs: ArtifactRef[] = []
  for (const file of files) {
    const abs = join(dir, file)
    const raw = JSON.parse(await readFile(abs, 'utf8')) as unknown
    const validation = validateTokenCapture(raw)
    if (validation.status === 'ready') refs.push(await fileArtifactRef('rl_token_capture', abs, rootDir))
  }
  return refs
}

async function fileArtifactRef(kind: ArtifactRef['kind'], path: string, rootDir?: string): Promise<ArtifactRef> {
  const { stat } = await import('node:fs/promises')
  const { createHash } = await import('node:crypto')
  const bytes = await readFile(path)
  const info = await stat(path)
  const uri = rootDir && path.startsWith(rootDir + '/') ? path.slice(rootDir.length + 1) : path
  return {
    kind,
    uri,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: info.size,
    redaction: { redacted: false, rules: [], truncated: false },
    mediaType: 'application/json',
  }
}

function noToolDispatcher(): ToolDispatcher {
  return {
    async callTool(_sessionId, eff) {
      return { ok: false, content: `tool execution disabled for RL smoke runner: ${eff.name}` }
    },
    cancelPending() {},
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(`rollout timed out after ${timeoutMs}ms`)), timeoutMs)
    promise.then(resolve, reject).finally(() => clearTimeout(timer))
  })
}

class TimeoutError extends Error {}

function sanitize(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._:-]+/g, '_')
  return cleaned.length > 0 ? cleaned : 'unknown'
}

export function textOnlyTool(name: string): ToolSchema {
  return {
    name,
    description: name,
    inputSchema: { type: 'object', additionalProperties: true },
    requiresApproval: false,
  }
}
