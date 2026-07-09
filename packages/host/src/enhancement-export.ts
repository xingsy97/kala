import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

import type { Message } from '@agent-kernel/kernel'
import {
  createArtifactStore,
  createRolloutSidecar,
  exportSessionSpans,
  type ArtifactRef,
  type RolloutSidecar,
} from '@agent-kernel/shared/enhancement'

import { readSessionLog } from './store/log.js'

export type ExportSessionTraceInput = {
  rootDir: string
  sessionLogPath: string
  runId?: string
  evalInstanceId?: string
  workspaceRoot?: string
}

export type ExportSessionTraceResult = {
  traceArtifact: ArtifactRef
  llmArtifacts: readonly ArtifactRef[]
  sessionId: string
}

export type RolloutSegment = {
  segmentId: string
  source: 'system' | 'user' | 'assistant' | 'tool' | 'effect' | 'compaction'
  eventSeq?: number
  role?: Message['role']
  lossMask: 0 | 1
  estimatedTokens: number
  tokenIdsCaptured: false
  summary: string
}

export type RolloutSegmentsArtifact = {
  schemaVersion: 1
  sessionId: string
  tokenIdsCaptured: false
  lossMaskPolicy: string
  segments: readonly RolloutSegment[]
  warnings: readonly string[]
}

export type ExportRolloutAdapterInput = {
  rootDir: string
  sidecarPath: string
  frameworkTarget?: RolloutSidecar['framework_target']
}

export type RolloutAdapterExport =
  | {
      schemaVersion: 1
      status: 'ready'
      frameworkTarget: 'slime'
      rolloutId: string
      taskId: string
      eventLogRef: string
      traceRef?: string
      tokenSegmentsRef?: string
      rewardRef?: string
      model?: string
      weightVersion?: string
      entrypoint: 'custom_rollout_manifest'
      notes: readonly string[]
    }
  | {
      schemaVersion: 1
      status: 'ready'
      frameworkTarget: 'verl'
      rolloutId: string
      prompt_ids: readonly number[]
      response_ids: readonly number[]
      response_mask: readonly number[]
      metadata: Record<string, unknown>
    }
  | {
      schemaVersion: 1
      status: 'blocked'
      frameworkTarget: RolloutSidecar['framework_target']
      rolloutId: string
      reason: string
      requiredArtifacts: readonly string[]
      availableArtifacts: Record<string, unknown>
    }

export async function exportSessionTraceArtifacts(
  input: ExportSessionTraceInput,
): Promise<ExportSessionTraceResult> {
  const parsed = await readSessionLog(input.sessionLogPath)
  await mkdir(input.rootDir, { recursive: true })
  const store = createArtifactStore(input.rootDir, {
    ...(input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : {}),
  })
  const spans = exportSessionSpans({
    header: parsed.header,
    events: parsed.events,
    runId: input.runId,
    evalInstanceId: input.evalInstanceId,
  })
  const sessionId = parsed.header.sessionId
  const traceArtifact = await store.writeJson(
    'trace',
    `traces/${sessionId}.openinference.json`,
    { spans },
  )
  const llmArtifacts: ArtifactRef[] = []
  for (const entry of parsed.events) {
    if (!entry.llmTrace) continue
    llmArtifacts.push(await store.writeJson(
      'llm_request',
      `llm/${sessionId}/${entry.seq}.request.json`,
      entry.llmTrace.request,
    ))
    if (entry.llmTrace.response) {
      llmArtifacts.push(await store.writeJson(
        'llm_response',
        `llm/${sessionId}/${entry.seq}.response.json`,
        entry.llmTrace.response,
      ))
    }
  }
  return { traceArtifact, llmArtifacts, sessionId }
}

export async function exportRolloutSegments(input: ExportSessionTraceInput): Promise<{
  artifact: ArtifactRef
  segments: RolloutSegmentsArtifact
  sessionId: string
}> {
  const parsed = await readSessionLog(input.sessionLogPath)
  await mkdir(input.rootDir, { recursive: true })
  const store = createArtifactStore(input.rootDir, {
    ...(input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : {}),
  })
  const segments = createRolloutSegmentsArtifact(parsed.header.sessionId, parsed.header.initialState.messages, parsed.events)
  const artifact = await store.writeJson(
    'rl_token_segments',
    `rl-token-segments/${parsed.header.sessionId}.json`,
    segments,
  )
  return { artifact, segments, sessionId: parsed.header.sessionId }
}

export type ExportRolloutSidecarInput = ExportSessionTraceInput & {
  taskId: string
  frameworkTarget: RolloutSidecar['framework_target']
  model?: string
  weightVersion?: string
  rewardPath?: string
  tokenSegmentsPath?: string
  metadata?: Record<string, unknown>
}

export async function exportRolloutSidecar(
input: ExportRolloutSidecarInput,
): Promise<{ sidecar: RolloutSidecar; sidecarPath: string; traceArtifact: ArtifactRef }> {
  const trace = await exportSessionTraceArtifacts(input)
  const generatedSegments = input.tokenSegmentsPath ? undefined : await exportRolloutSegments(input)
  const sidecar = createRolloutSidecar({
    sessionId: trace.sessionId,
    taskId: input.taskId,
    frameworkTarget: input.frameworkTarget,
    eventLogRef: input.sessionLogPath,
    traceRef: trace.traceArtifact.uri,
    ...((input.tokenSegmentsPath ?? generatedSegments?.artifact.uri)
      ? { tokenSegmentsRef: input.tokenSegmentsPath ?? generatedSegments?.artifact.uri }
      : {}),
    ...(input.rewardPath ? { rewardRef: input.rewardPath } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.weightVersion ? { weightVersion: input.weightVersion } : {}),
    metadata: {
      sessionLogFile: basename(input.sessionLogPath),
      llmArtifactCount: trace.llmArtifacts.length,
      tokenIdsCaptured: input.tokenSegmentsPath ? 'external' : false,
      generatedSegmentCount: generatedSegments?.segments.segments.length ?? null,
      ...(input.metadata ?? {}),
    },
  })
  const sidecarPath = join(input.rootDir, 'rollouts', `${sidecar.rollout_id}.json`)
  await mkdir(join(input.rootDir, 'rollouts'), { recursive: true })
  await writeFile(sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`, 'utf8')
  return { sidecar, sidecarPath, traceArtifact: trace.traceArtifact }
}

export async function exportRolloutFrameworkAdapter(input: ExportRolloutAdapterInput): Promise<{
  adapter: RolloutAdapterExport
  adapterPath: string
}> {
  const sidecar = JSON.parse(await readFile(input.sidecarPath, 'utf8')) as RolloutSidecar
  const frameworkTarget = input.frameworkTarget ?? sidecar.framework_target
  const adapter = await createRolloutAdapterExport(input.rootDir, sidecar, frameworkTarget)
  const adapterPath = join(input.rootDir, 'rl-adapters', frameworkTarget, `${sidecar.rollout_id}.json`)
  await mkdir(join(input.rootDir, 'rl-adapters', frameworkTarget), { recursive: true })
  await writeFile(adapterPath, `${JSON.stringify(adapter, null, 2)}\n`, 'utf8')
  return { adapter, adapterPath }
}

async function createRolloutAdapterExport(
  rootDir: string,
  sidecar: RolloutSidecar,
  frameworkTarget: RolloutSidecar['framework_target'],
): Promise<RolloutAdapterExport> {
  if (frameworkTarget === 'slime') {
    return {
      schemaVersion: 1,
      status: 'ready',
      frameworkTarget,
      rolloutId: sidecar.rollout_id,
      taskId: sidecar.task_id,
      eventLogRef: sidecar.event_log_ref,
      ...(sidecar.trace_ref ? { traceRef: sidecar.trace_ref } : {}),
      ...(sidecar.token_segments_ref ? { tokenSegmentsRef: sidecar.token_segments_ref } : {}),
      ...(sidecar.reward_ref ? { rewardRef: sidecar.reward_ref } : {}),
      ...(sidecar.model ? { model: sidecar.model } : {}),
      ...(sidecar.weight_version ? { weightVersion: sidecar.weight_version } : {}),
      entrypoint: 'custom_rollout_manifest',
      notes: [
        'Use this as slime custom data-generation input; it indexes replay, trace, token segments, and reward artifacts.',
        'It is not a tensor dataset and does not synthesize token ids.',
      ],
    }
  }
  if (frameworkTarget === 'verl') {
    const tokenArtifact = sidecar.token_segments_ref ? await readTokenArtifact(rootDir, sidecar.token_segments_ref) : undefined
    const promptIds = numberArray(tokenArtifact, 'prompt_ids') ?? numberArray(tokenArtifact, 'promptIds')
    const responseIds = numberArray(tokenArtifact, 'response_ids') ?? numberArray(tokenArtifact, 'responseIds')
    const responseMask = numberArray(tokenArtifact, 'response_mask') ?? numberArray(tokenArtifact, 'responseMask')
    if (tokenArtifact && tokenArtifact.tokenIdsCaptured === true && promptIds && responseIds && responseMask) {
      return {
        schemaVersion: 1,
        status: 'ready',
        frameworkTarget,
        rolloutId: sidecar.rollout_id,
        prompt_ids: promptIds,
        response_ids: responseIds,
        response_mask: responseMask,
        metadata: {
          taskId: sidecar.task_id,
          sessionId: sidecar.session_id,
          eventLogRef: sidecar.event_log_ref,
          traceRef: sidecar.trace_ref ?? null,
          rewardRef: sidecar.reward_ref ?? null,
          model: sidecar.model ?? null,
          weightVersion: sidecar.weight_version ?? null,
        },
      }
    }
    return blockedAdapter(sidecar, frameworkTarget, 'verl AgentLoopOutput requires generation-time token ids and response masks', tokenArtifact)
  }
  return blockedAdapter(sidecar, frameworkTarget, `adapter target ${frameworkTarget} is not implemented`, undefined)
}

async function readTokenArtifact(rootDir: string, ref: string): Promise<Record<string, unknown> | undefined> {
  const path = ref.startsWith('/') ? ref : join(rootDir, ref)
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
}

function numberArray(record: Record<string, unknown> | undefined, key: string): readonly number[] | undefined {
  const value = record?.[key]
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'number' && Number.isInteger(item))) return undefined
  return value
}

function blockedAdapter(
  sidecar: RolloutSidecar,
  frameworkTarget: RolloutSidecar['framework_target'],
  reason: string,
  tokenArtifact: Record<string, unknown> | undefined,
): RolloutAdapterExport {
  return {
    schemaVersion: 1,
    status: 'blocked',
    frameworkTarget,
    rolloutId: sidecar.rollout_id,
    reason,
    requiredArtifacts: ['generation-time token ids', 'response mask', 'reward metadata'],
    availableArtifacts: {
      eventLogRef: sidecar.event_log_ref,
      traceRef: sidecar.trace_ref ?? null,
      tokenSegmentsRef: sidecar.token_segments_ref ?? null,
      tokenIdsCaptured: tokenArtifact?.tokenIdsCaptured ?? sidecar.metadata.tokenIdsCaptured ?? null,
      rewardRef: sidecar.reward_ref ?? null,
    },
  }
}

function createRolloutSegmentsArtifact(
  sessionId: string,
  initialMessages: readonly Message[],
  events: Awaited<ReturnType<typeof readSessionLog>>['events'],
): RolloutSegmentsArtifact {
  const segments: RolloutSegment[] = []
  let index = 0
  const pushMessage = (message: Message, eventSeq: number | undefined, sourceOverride?: RolloutSegment['source']): void => {
    const source = sourceOverride ?? message.role
    const summary = summarizeMessage(message)
    segments.push({
      segmentId: `seg_${String(++index).padStart(5, '0')}`,
      source,
      ...(eventSeq !== undefined ? { eventSeq } : {}),
      role: message.role,
      lossMask: source === 'assistant' ? 1 : 0,
      estimatedTokens: estimateTokens(summary),
      tokenIdsCaptured: false,
      summary,
    })
  }
  for (const message of initialMessages) pushMessage(message, undefined)
  for (const entry of events) {
    if (entry.event.kind === 'user_message') {
      pushMessage({ role: 'user', content: [...(entry.event.content ?? [{ type: 'text', text: entry.event.text ?? '' }])] }, entry.seq)
    } else if (entry.event.kind === 'llm_response') {
      pushMessage(entry.event.message, entry.seq)
    } else if (entry.event.kind === 'tool_result') {
      const summary = String(entry.event.content ?? '').slice(0, 240)
      segments.push({
        segmentId: `seg_${String(++index).padStart(5, '0')}`,
        source: 'tool',
        eventSeq: entry.seq,
        lossMask: 0,
        estimatedTokens: estimateTokens(summary),
        tokenIdsCaptured: false,
        summary: `${entry.event.ok ? 'ok' : 'error'} tool_result ${entry.event.callId}: ${summary}`,
      })
    } else if (entry.event.kind === 'compact_replaced') {
      const summary = `compact replaced ${entry.event.replacedCount} messages; preserveFrom=${entry.event.preserveFrom}`
      segments.push({
        segmentId: `seg_${String(++index).padStart(5, '0')}`,
        source: 'compaction',
        eventSeq: entry.seq,
        lossMask: 0,
        estimatedTokens: estimateTokens(summary),
        tokenIdsCaptured: false,
        summary,
      })
    }
    for (const effect of entry.effects) {
      if (effect.kind !== 'call_tool') continue
      const summary = `call_tool ${effect.name} ${JSON.stringify(effect.input).slice(0, 200)}`
      segments.push({
        segmentId: `seg_${String(++index).padStart(5, '0')}`,
        source: 'effect',
        eventSeq: entry.seq,
        lossMask: 0,
        estimatedTokens: estimateTokens(summary),
        tokenIdsCaptured: false,
        summary,
      })
    }
  }
  return {
    schemaVersion: 1,
    sessionId,
    tokenIdsCaptured: false,
    lossMaskPolicy: 'assistant message segments use lossMask=1; system/user/tool/effect/compaction segments use lossMask=0; token ids are not synthesized.',
    segments,
    warnings: ['token ids were not captured at generation time; this artifact is a segment index, not a training tensor dataset'],
  }
}

function summarizeMessage(message: Message): string {
  return `${message.role}: ${message.content.map((content) => {
    if (content.type === 'text') return content.text
    if (content.type === 'tool_call') return `tool_call ${content.name} ${JSON.stringify(content.input)}`
    if (content.type === 'tool_result') return `tool_result ${content.callId} ${content.content}`
    return content.type
  }).join(' ')}`.slice(0, 500)
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4))
}
