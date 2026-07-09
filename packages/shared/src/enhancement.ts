import { createHash, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { AgentConfig, Effect } from '@agent-kernel/kernel'

import type { EventEntry, HeaderEntry, LLMTrace } from './log.js'

export type ArtifactKind =
  | 'llm_request'
  | 'llm_response'
  | 'trace'
  | 'eval_score'
  | 'diff'
  | 'log'
  | 'rl_token_segments'
  | 'rl_reward'
  | 'metadata'

export type ArtifactRef = {
  kind: ArtifactKind
  uri: string
  sha256: string
  bytes: number
  redaction: RedactionSummary
  mediaType: string
}

export type RedactionSummary = {
  redacted: boolean
  rules: readonly string[]
  truncated: boolean
}

export type RedactionOptions = {
  maxStringLength?: number
  workspaceRoot?: string
}

const DEFAULT_MAX_STRING_LENGTH = 20000
const REDACTED = '[redacted]'
const TRUNCATED = '[truncated]'

export function redactForPersistence(
  value: unknown,
  options: RedactionOptions = {},
): { value: unknown; summary: RedactionSummary } {
  const rules = new Set<string>()
  const maxStringLength = options.maxStringLength ?? DEFAULT_MAX_STRING_LENGTH

  function visit(input: unknown, keyPath: readonly string[]): unknown {
    if (typeof input === 'string') {
      let out = redactString(input, options.workspaceRoot, rules)
      if (out.length > maxStringLength) {
        out = `${out.slice(0, maxStringLength)}\n${TRUNCATED} ${out.length - maxStringLength} chars omitted`
        rules.add('truncate.large_string')
      }
      return out
    }
    if (input === null || typeof input !== 'object') return input
    if (Array.isArray(input)) return input.map((item, i) => visit(item, [...keyPath, String(i)]))

    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(input as Record<string, unknown>)) {
      const lower = key.toLowerCase()
      if (isSecretKey(lower)) {
        out[key] = REDACTED
        rules.add('secret.key')
        continue
      }
      if (lower === 'url' || lower === 'baseurl' || lower === 'apiurl') {
        out[key] = typeof child === 'string' ? redactUrl(child, rules) : child
        continue
      }
      out[key] = visit(child, [...keyPath, key])
    }
    return out
  }

  const next = visit(value, [])
  return {
    value: next,
    summary: {
      redacted: rules.size > 0,
      rules: [...rules].sort(),
      truncated: rules.has('truncate.large_string'),
    },
  }
}

function isSecretKey(lowerKey: string): boolean {
  return (
    lowerKey === 'authorization' ||
    lowerKey === 'x-api-key' ||
    lowerKey === 'api-key' ||
    lowerKey === 'apikey' ||
    lowerKey === 'api_key' ||
    lowerKey === 'token' ||
    lowerKey === 'access_token' ||
    lowerKey === 'refresh_token' ||
    lowerKey === 'password' ||
    lowerKey === 'secret' ||
    lowerKey.endsWith('_key') ||
    lowerKey.endsWith('_token')
  )
}

function redactString(input: string, workspaceRoot: string | undefined, rules: Set<string>): string {
  let out = input
  out = out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, () => {
    rules.add('secret.bearer')
    return `Bearer ${REDACTED}`
  })
  out = out.replace(/sk-[A-Za-z0-9_-]{12,}/g, () => {
    rules.add('secret.openai_key')
    return REDACTED
  })
  out = out.replace(/(ANTHROPIC_API_KEY|OPENAI_API_KEY|API_KEY|TOKEN)=([^\s]+)/g, (_m, name) => {
    rules.add('secret.env')
    return `${name}=${REDACTED}`
  })
  if (workspaceRoot && out.includes(workspaceRoot)) {
    out = out.split(workspaceRoot).join('<workspace>')
    rules.add('path.workspace_root')
  }
  return out
}

function redactUrl(input: string, rules: Set<string>): string {
  try {
    const parsed = new URL(input)
    rules.add('url.base')
    return `<${parsed.protocol}//redacted>${parsed.pathname}${parsed.search ? '?<query-redacted>' : ''}`
  } catch {
    return input
  }
}

export type ArtifactStore = {
  rootDir: string
  writeJson(kind: ArtifactKind, relativePath: string, value: unknown): Promise<ArtifactRef>
  writeText(kind: ArtifactKind, relativePath: string, value: string): Promise<ArtifactRef>
}

export function createArtifactStore(
  rootDir: string,
  options: RedactionOptions = {},
): ArtifactStore {
  return {
    rootDir,
    async writeJson(kind, relativePath, value) {
      const redacted = redactForPersistence(value, options)
      const payload = `${JSON.stringify(redacted.value, null, 2)}\n`
      return await writeArtifact(rootDir, kind, relativePath, payload, 'application/json', redacted.summary)
    },
    async writeText(kind, relativePath, value) {
      const redacted = redactForPersistence(value, options)
      const payload = `${String(redacted.value)}\n`
      return await writeArtifact(rootDir, kind, relativePath, payload, 'text/plain', redacted.summary)
    },
  }
}

async function writeArtifact(
  rootDir: string,
  kind: ArtifactKind,
  relativePath: string,
  payload: string,
  mediaType: string,
  redaction: RedactionSummary,
): Promise<ArtifactRef> {
  const target = join(rootDir, relativePath)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, payload, 'utf8')
  return {
    kind,
    uri: relativePath,
    sha256: createHash('sha256').update(payload).digest('hex'),
    bytes: Buffer.byteLength(payload, 'utf8'),
    redaction,
    mediaType,
  }
}

export type EnhancementSpanKind =
  | 'AGENT'
  | 'CHAIN'
  | 'LLM'
  | 'TOOL'
  | 'PROMPT'
  | 'EVALUATOR'
  | 'RETRIEVER'
  | 'MEMORY'

export type EnhancementSpan = {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  kind: EnhancementSpanKind
  startTime: string
  endTime: string
  status: 'OK' | 'ERROR' | 'UNSET'
  attributes: Record<string, unknown>
  events: Array<{ name: string; time: string; attributes?: Record<string, unknown> }>
}

export function exportSessionSpans(input: {
  header: HeaderEntry
  events: readonly EventEntry[]
  runId?: string
  evalInstanceId?: string
}): EnhancementSpan[] {
  const traceId = stableId(`trace:${input.header.sessionId}:${input.runId ?? ''}`, 32)
  const firstTs = input.events[0]?.ts ?? input.header.ts
  const lastTs = input.events[input.events.length - 1]?.ts ?? firstTs
  const rootSpanId = stableId(`span:${input.header.sessionId}:root`, 16)
  const spans: EnhancementSpan[] = [
    {
      traceId,
      spanId: rootSpanId,
      name: 'agent.invoke',
      kind: 'AGENT',
      startTime: firstTs,
      endTime: lastTs,
      status: input.events.some((entry) => entry.event.kind === 'llm_error') ? 'ERROR' : 'OK',
      attributes: compactRecord({
        'openinference.span.kind': 'AGENT',
        'gen_ai.operation.name': 'invoke_agent',
        'agent_kernel.session_id': input.header.sessionId,
        'agent_kernel.workspace_id': input.header.workspaceId,
        'agent_kernel.run_id': input.runId,
        'agent_kernel.eval.instance_id': input.evalInstanceId,
      }),
      events: [],
    },
  ]

  for (const entry of input.events) {
    if (entry.event.kind === 'llm_response' || entry.event.kind === 'llm_error') {
      spans.push(llmSpan(traceId, rootSpanId, entry))
      continue
    }
    if (entry.event.kind === 'tool_result') {
      const toolName = findToolNameForResult(input.events, entry.event.callId)
      spans.push(toolSpan(traceId, rootSpanId, entry, toolName))
    }
  }
  return spans
}

function llmSpan(traceId: string, parentSpanId: string, entry: EventEntry): EnhancementSpan {
  const trace = entry.llmTrace
  const model = trace?.model ?? entry.model
  const provider = trace?.provider ?? inferProvider(model)
  const error = entry.event.kind === 'llm_error'
  const usage = entry.usage
  return {
    traceId,
    spanId: stableId(`span:llm:${entry.seq}:${model ?? ''}`, 16),
    parentSpanId,
    name: `gen_ai chat ${model ?? 'unknown'}`,
    kind: 'LLM',
    startTime: entry.ts,
    endTime: entry.ts,
    status: error ? 'ERROR' : 'OK',
    attributes: compactRecord({
      'openinference.span.kind': 'LLM',
      'gen_ai.operation.name': 'chat',
      'gen_ai.provider.name': provider,
      'gen_ai.request.model': model,
      'gen_ai.response.model': model,
      'gen_ai.usage.input_tokens': usage?.inputTokens,
      'gen_ai.usage.output_tokens': usage?.outputTokens,
      'gen_ai.usage.cache_creation.input_tokens': usage?.cacheCreationTokens,
      'gen_ai.usage.cache_read.input_tokens': usage?.cacheReadTokens,
      'agent_kernel.event_seq': entry.seq,
      'error.type': error ? 'llm_error' : undefined,
    }),
    events: trace
      ? [{ name: 'agent_kernel.llm_trace_captured', time: entry.ts }]
      : [{ name: 'agent_kernel.llm_trace_missing', time: entry.ts }],
  }
}

function toolSpan(
  traceId: string,
  parentSpanId: string,
  entry: EventEntry,
  toolName: string | undefined,
): EnhancementSpan {
  const event = entry.event.kind === 'tool_result' ? entry.event : undefined
  return {
    traceId,
    spanId: stableId(`span:tool:${entry.seq}:${event?.callId ?? ''}`, 16),
    parentSpanId,
    name: `execute_tool ${toolName ?? 'unknown'}`,
    kind: 'TOOL',
    startTime: entry.ts,
    endTime: entry.ts,
    status: event?.ok === false ? 'ERROR' : 'OK',
    attributes: compactRecord({
      'openinference.span.kind': 'TOOL',
      'gen_ai.operation.name': 'execute_tool',
      'gen_ai.tool.name': toolName,
      'gen_ai.tool.call.id': event?.callId,
      'agent_kernel.event_seq': entry.seq,
      'error.type': event?.ok === false ? 'tool_error' : undefined,
    }),
    events: [],
  }
}

function findToolNameForResult(events: readonly EventEntry[], callId: string): string | undefined {
  for (const entry of events) {
    for (const effect of entry.effects) {
      const candidate = effect as Effect & { callId?: string; name?: string }
      if (candidate.kind === 'call_tool' && candidate.callId === callId) return candidate.name
    }
  }
  return undefined
}

function inferProvider(model: string | undefined): string | undefined {
  if (!model) return undefined
  const lower = model.toLowerCase()
  if (lower.includes('claude')) return 'anthropic'
  if (lower.includes('gpt') || lower.includes('o1') || lower.includes('o3')) return 'openai'
  return undefined
}

function stableId(input: string, hexLength: number): string {
  return createHash('sha256').update(input).digest('hex').slice(0, hexLength)
}

function compactRecord(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined && value !== null),
  )
}

export type EvalFailureLabel =
  | 'resolved'
  | 'agent_timeout'
  | 'agent_error'
  | 'empty_patch'
  | 'patch_apply_failed'
  | 'test_failed'
  | 'harness_error'
  | 'infrastructure_error'

export type EvalExperiment = {
  experimentId: string
  createdAt: string
  dataset: string
  split?: string
  model: string
  config: Record<string, unknown>
}

export type EvalTrial = {
  trialId: string
  experimentId: string
  instanceId: string
  sessionId?: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'timed_out'
  resolved?: boolean
  failureLabel?: EvalFailureLabel
  artifacts: readonly ArtifactRef[]
  metrics: Record<string, number | string | boolean>
}

export function createEvalExperiment(input: {
  dataset: string
  split?: string
  model: string
  config?: Record<string, unknown>
  experimentId?: string
  createdAt?: string
}): EvalExperiment {
  return {
    experimentId: input.experimentId ?? `eval_${randomUUID()}`,
    createdAt: input.createdAt ?? new Date().toISOString(),
    dataset: input.dataset,
    ...(input.split ? { split: input.split } : {}),
    model: input.model,
    config: input.config ?? {},
  }
}

export type SweBenchPrediction = {
  instance_id: string
  model_name_or_path: string
  model_patch: string
}

export function createSweBenchPrediction(input: {
  instanceId: string
  modelNameOrPath: string
  modelPatch: string
}): SweBenchPrediction {
  return {
    instance_id: input.instanceId,
    model_name_or_path: input.modelNameOrPath,
    model_patch: input.modelPatch,
  }
}

export function serializeJsonl(rows: readonly unknown[]): string {
  return rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length > 0 ? '\n' : '')
}

export function buildSweBenchEvaluationCommand(input: {
  datasetName: string
  predictionsPath: string
  maxWorkers?: number
  runId: string
  instanceIds?: readonly string[]
  modal?: boolean
}): readonly string[] {
  const args = [
    'python',
    '-m',
    'swebench.harness.run_evaluation',
    '--dataset_name',
    input.datasetName,
    '--predictions_path',
    input.predictionsPath,
    '--max_workers',
    String(input.maxWorkers ?? 8),
    '--run_id',
    input.runId,
  ]
  if (input.instanceIds?.length) args.push('--instance_ids', ...input.instanceIds)
  if (input.modal) args.push('--modal', 'true')
  return args
}

export type RolloutSidecar = {
  rollout_id: string
  session_id: string
  task_id: string
  framework_target: 'slime' | 'verl' | 'trl' | 'openrlhf' | 'unknown'
  event_log_ref: string
  trace_ref?: string
  token_segments_ref?: string
  reward_ref?: string
  model?: string
  weight_version?: string
  metadata: Record<string, unknown>
}

export function createRolloutSidecar(input: {
  sessionId: string
  taskId: string
  frameworkTarget: RolloutSidecar['framework_target']
  eventLogRef: string
  traceRef?: string
  tokenSegmentsRef?: string
  rewardRef?: string
  model?: string
  weightVersion?: string
  metadata?: Record<string, unknown>
  rolloutId?: string
}): RolloutSidecar {
  return {
    rollout_id: input.rolloutId ?? `rollout_${randomUUID()}`,
    session_id: input.sessionId,
    task_id: input.taskId,
    framework_target: input.frameworkTarget,
    event_log_ref: input.eventLogRef,
    ...(input.traceRef ? { trace_ref: input.traceRef } : {}),
    ...(input.tokenSegmentsRef ? { token_segments_ref: input.tokenSegmentsRef } : {}),
    ...(input.rewardRef ? { reward_ref: input.rewardRef } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.weightVersion ? { weight_version: input.weightVersion } : {}),
    metadata: input.metadata ?? {},
  }
}

export type MessageAssemblyStage = {
  name: string
  inputMessages: number
  outputMessages: number
  estimatedTokens?: number
  droppedItems?: number
  reasonCodes: readonly string[]
  artifactRefs: readonly ArtifactRef[]
}

export type RouterDecisionArtifact = {
  selectedProvider?: string
  selectedModel?: string
  reasonCodes: readonly string[]
  fallbacks: readonly string[]
  budget?: {
    maxInputTokens?: number
    maxOutputTokens?: number
  }
}

export function describeAgentConfig(config: AgentConfig): Record<string, unknown> {
  return compactRecord({
    toolCount: config.tools.length,
    toolNames: config.tools.map((tool) => tool.name),
    contextLimit: config.contextLimit,
    softThreshold: config.softThreshold,
    hardThreshold: config.hardThreshold,
    maxAgentDepth: config.maxAgentDepth,
    thinkingBudget: config.thinkingBudget,
  })
}
