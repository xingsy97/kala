import { createHash, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { AgentConfig, Effect, Message, ToolSchema } from '@agent-kernel/kernel'

import type { EventEntry, HeaderEntry, LLMTrace } from './log.js'

export type ArtifactKind =
  | 'llm_request'
  | 'llm_response'
  | 'message_assembly'
  | 'router_decision'
  | 'tool_catalog'
  | 'trace'
  | 'eval_score'
  | 'eval_judge'
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

export type EvalScoreResult = {
  scorer: string
  passed: boolean
  label?: EvalFailureLabel
  score: number
  metrics: Record<string, number | string | boolean>
  artifactRefs: readonly ArtifactRef[]
  explanation?: string
}

export type ModelJudgeTraceArtifact = {
  schemaVersion: 1
  scorer: string
  judgeModel: string
  inputRef?: string
  prompt: string
  response: unknown
  parsed: {
    score: number
    passed: boolean
    label?: EvalFailureLabel
    explanation?: string
  }
  metadata: Record<string, unknown>
}

export function createModelJudgeTraceArtifact(input: {
  scorer: string
  judgeModel: string
  inputRef?: string
  prompt: string
  response: unknown
  score: number
  threshold?: number
  label?: EvalFailureLabel
  explanation?: string
  metadata?: Record<string, unknown>
}): ModelJudgeTraceArtifact {
  const threshold = boundedUnitValue(input.threshold ?? 0.5, 'judge threshold')
  const score = boundedUnitValue(input.score, 'judge score')
  return {
    schemaVersion: 1,
    scorer: input.scorer,
    judgeModel: input.judgeModel,
    ...(input.inputRef ? { inputRef: input.inputRef } : {}),
    prompt: input.prompt,
    response: input.response,
    parsed: {
      score,
      passed: score >= threshold,
      ...(input.label ? { label: input.label } : {}),
      ...(input.explanation ? { explanation: input.explanation } : {}),
    },
    metadata: {
      threshold,
      ...(input.metadata ?? {}),
    },
  }
}

function boundedUnitValue(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${name} must be a number between 0 and 1`)
  return value
}

export type EvalScoreSummary = {
  instanceId?: string
  resolved: boolean
  failureLabel: EvalFailureLabel
  score: number
  results: readonly EvalScoreResult[]
}

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

export type EvalRunSummary = {
  experimentId: string
  dataset: string
  split?: string
  model: string
  trialCount: number
  completed: number
  failed: number
  timedOut: number
  resolved: number
  unresolved: number
  emptyPatch: number
  failureCounts: Record<string, number>
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

export function summarizeEvalRun(
  experiment: EvalExperiment,
  trials: readonly EvalTrial[],
): EvalRunSummary {
  const failureCounts: Record<string, number> = {}
  let completed = 0
  let failed = 0
  let timedOut = 0
  let resolved = 0
  let emptyPatch = 0
  for (const trial of trials) {
    if (trial.status === 'completed') completed += 1
    if (trial.status === 'failed') failed += 1
    if (trial.status === 'timed_out') timedOut += 1
    if (trial.resolved === true) resolved += 1
    if (trial.failureLabel) {
      failureCounts[trial.failureLabel] = (failureCounts[trial.failureLabel] ?? 0) + 1
      if (trial.failureLabel === 'empty_patch') emptyPatch += 1
    }
  }
  const unresolved = trials.filter((trial) => trial.resolved === false).length
  return {
    experimentId: experiment.experimentId,
    dataset: experiment.dataset,
    ...(experiment.split ? { split: experiment.split } : {}),
    model: experiment.model,
    trialCount: trials.length,
    completed,
    failed,
    timedOut,
    resolved,
    unresolved,
    emptyPatch,
    failureCounts,
    metrics: {
      passRate: trials.length > 0 ? resolved / trials.length : 0,
    },
  }
}

export function summarizeEvalScores(
  results: readonly EvalScoreResult[],
  instanceId?: string,
): EvalScoreSummary {
  const failed = results.find((result) => !result.passed)
  const resolved = !failed && results.length > 0
  const failureLabel = resolved ? 'resolved' : failed?.label ?? 'agent_error'
  return {
    ...(instanceId ? { instanceId } : {}),
    resolved,
    failureLabel,
    score: resolved ? 1 : 0,
    results,
  }
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

export type MessageAssemblyArtifact = {
  sessionId: string
  eventSeq?: number
  provider?: string
  model?: string
  messageCount: number
  toolCount: number
  estimatedTokens: number
  parts: Array<{
    name: 'system' | 'user' | 'assistant' | 'tool' | 'tools' | 'images' | 'thinking' | 'memory'
    messages: number
    chars: number
    estimatedTokens: number
  }>
  stages: readonly MessageAssemblyStage[]
}

export function createMessageAssemblyArtifact(input: {
  sessionId: string
  eventSeq?: number
  provider?: string
  model?: string
  messages: readonly Message[]
  tools: readonly ToolSchema[]
  stages?: readonly MessageAssemblyStage[]
}): MessageAssemblyArtifact {
  const buckets = new Map<MessageAssemblyArtifact['parts'][number]['name'], {
    messages: number
    chars: number
  }>()
  const memoryCallIds = new Set<string>()
  for (const message of input.messages) {
    for (const content of message.content) {
      if (content.type === 'tool_call' && content.name === 'memory') memoryCallIds.add(content.callId)
    }
  }
  for (const message of input.messages) {
    const existing = buckets.get(message.role) ?? { messages: 0, chars: 0 }
    existing.messages += 1
    existing.chars += estimateMessageChars([message])
    buckets.set(message.role, existing)
    for (const content of message.content) {
      const key = content.type === 'image' ? 'images' : content.type === 'thinking' ? 'thinking' : undefined
      if (!key) continue
      const bucket = buckets.get(key) ?? { messages: 0, chars: 0 }
      bucket.chars += estimateContentChars(content)
      buckets.set(key, bucket)
    }
    const memoryChars = estimateMemoryContributionChars(message, memoryCallIds)
    if (memoryChars > 0) {
      const bucket = buckets.get('memory') ?? { messages: 0, chars: 0 }
      bucket.messages += 1
      bucket.chars += memoryChars
      buckets.set('memory', bucket)
    }
  }
  const toolSchemaChars = input.tools.reduce((sum, tool) => sum + tool.name.length + tool.description.length + JSON.stringify(tool.inputSchema).length, 0)
  buckets.set('tools', { messages: 0, chars: toolSchemaChars })
  const parts = [...buckets.entries()]
    .filter(([, value]) => value.messages > 0 || value.chars > 0)
    .map(([name, value]) => ({
      name,
      messages: value.messages,
      chars: value.chars,
      estimatedTokens: estimateTokensFromChars(value.chars),
    }))
  const estimatedTokens = parts.reduce((sum, part) => sum + part.estimatedTokens, 0)
  return {
    sessionId: input.sessionId,
    ...(input.eventSeq !== undefined ? { eventSeq: input.eventSeq } : {}),
    ...(input.provider ? { provider: input.provider } : {}),
    ...(input.model ? { model: input.model } : {}),
    messageCount: input.messages.length,
    toolCount: input.tools.length,
    estimatedTokens,
    parts,
    stages: input.stages ?? [],
  }
}

function estimateMemoryContributionChars(message: Message, memoryCallIds: ReadonlySet<string>): number {
  let chars = 0
  for (const content of message.content) {
    if (content.type === 'tool_call' && content.name === 'memory') chars += estimateContentChars(content)
    if (content.type === 'tool_result' && memoryCallIds.has(content.callId)) chars += estimateContentChars(content)
  }
  return chars
}

function estimateMessageChars(messages: readonly Message[]): number {
  let chars = 0
  for (const message of messages) {
    chars += message.role.length + 8
    for (const content of message.content) chars += estimateContentChars(content)
  }
  return chars
}

function estimateContentChars(content: Message['content'][number]): number {
  if (content.type === 'text' || content.type === 'thinking') return content.text.length
  if (content.type === 'tool_call') return content.name.length + content.callId.length + JSON.stringify(content.input).length
  if (content.type === 'tool_result') return content.callId.length + content.content.length + 16
  return content.source.kind === 'file_ref'
    ? content.source.path.length + 64
    : Math.round(content.source.data.length / 4)
}

function estimateTokensFromChars(chars: number): number {
  return Math.ceil(chars / 4)
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

export type ToolCatalogArtifact = {
  toolCount: number
  tools: Array<{
    name: string
    requiresApproval: boolean
    kind: 'executor' | 'host' | 'skill_loader' | 'sub_agent' | 'unknown'
    skillBacked: boolean
    descriptionChars: number
    schemaHash: string
  }>
}

export function createRouterDecisionArtifact(input: {
  requestedModel?: string
  selectedModel?: string
  adapterName?: string
  reasonCodes?: readonly string[]
  fallbacks?: readonly string[]
  maxInputTokens?: number
  maxOutputTokens?: number
}): RouterDecisionArtifact {
  const selectedProvider = providerFromAdapter(input.adapterName) ?? inferProvider(input.selectedModel ?? input.requestedModel)
  return {
    ...(selectedProvider ? { selectedProvider } : {}),
    ...(input.selectedModel ?? input.requestedModel ? { selectedModel: input.selectedModel ?? input.requestedModel } : {}),
    reasonCodes: input.reasonCodes ?? [input.requestedModel ? 'session_model_selected' : 'adapter_default_model'],
    fallbacks: input.fallbacks ?? [],
    budget: compactRecord({
      maxInputTokens: input.maxInputTokens,
      maxOutputTokens: input.maxOutputTokens,
    }),
  }
}

export function createToolCatalogArtifact(tools: readonly ToolSchema[]): ToolCatalogArtifact {
  return {
    toolCount: tools.length,
    tools: tools.map((tool) => ({
      name: tool.name,
      requiresApproval: tool.requiresApproval,
      kind: toolKind(tool.name),
      skillBacked: tool.name === 'skill',
      descriptionChars: tool.description.length,
      schemaHash: stableId(JSON.stringify(tool.inputSchema), 16),
    })),
  }
}

function providerFromAdapter(adapterName: string | undefined): string | undefined {
  if (!adapterName) return undefined
  const lower = adapterName.toLowerCase()
  if (lower.includes('anthropic')) return 'anthropic'
  if (lower.includes('openai')) return 'openai'
  if (lower.includes('router(')) return 'router'
  return undefined
}

function toolKind(name: string): ToolCatalogArtifact['tools'][number]['kind'] {
  if (name === 'skill') return 'skill_loader'
  if (name === 'agent') return 'sub_agent'
  if (name === 'memory') return 'host'
  if (name === 'bash' || name === 'bash_output' || name === 'kill_shell' || name === 'read' || name === 'write' || name === 'edit' || name === 'ls' || name === 'glob' || name === 'grep' || name === 'todowrite' || name === 'websearch') return 'executor'
  return 'unknown'
}

export type PricingTable = {
  version: string
  currency: 'USD'
  models: Record<string, {
    inputPerMillion?: number
    outputPerMillion?: number
    cacheReadPerMillion?: number
    cacheCreationPerMillion?: number
  }>
}

export type SessionProfile = {
  sessionId: string
  eventCount: number
  llmCalls: number
  toolCalls: number
  toolErrors: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheReadTokens: number
  totalCacheCreationTokens: number
  estimatedCostUsd?: number
  costStatus: 'estimated' | 'unknown'
  models: readonly string[]
  missingUsageCalls: number
  llmTraceMissingCalls: number
  wallTimeMs?: number
  firstEventAt?: string
  lastEventAt?: string
}

export const DEFAULT_PRICING_TABLE: PricingTable = {
  version: '2026-07-default-placeholder',
  currency: 'USD',
  models: {},
}

export function createSessionProfile(input: {
  header: HeaderEntry
  events: readonly EventEntry[]
  pricing?: PricingTable
}): SessionProfile {
  const pricing = input.pricing ?? DEFAULT_PRICING_TABLE
  const models = new Set<string>()
  let llmCalls = 0
  let toolCalls = 0
  let toolErrors = 0
  let totalInputTokens = 0
  let totalOutputTokens = 0
  let totalCacheReadTokens = 0
  let totalCacheCreationTokens = 0
  let missingUsageCalls = 0
  let llmTraceMissingCalls = 0
  let estimatedCostUsd = 0
  let unknownCost = false
  for (const entry of input.events) {
    for (const effect of entry.effects) {
      if (effect.kind === 'call_tool') toolCalls += 1
    }
    if (entry.event.kind === 'tool_result' && entry.event.ok === false) toolErrors += 1
    if (entry.event.kind !== 'llm_response' && entry.event.kind !== 'llm_error') continue
    llmCalls += 1
    if (entry.model) models.add(entry.model)
    else if (entry.llmTrace?.model) models.add(entry.llmTrace.model)
    if (!entry.llmTrace) llmTraceMissingCalls += 1
    if (!entry.usage) {
      missingUsageCalls += 1
      unknownCost = true
      continue
    }
    totalInputTokens += entry.usage.inputTokens
    totalOutputTokens += entry.usage.outputTokens
    totalCacheReadTokens += entry.usage.cacheReadTokens
    totalCacheCreationTokens += entry.usage.cacheCreationTokens
    const model = entry.model ?? entry.llmTrace?.model
    const price = model ? pricing.models[model] : undefined
    if (!price) {
      unknownCost = true
      continue
    }
    estimatedCostUsd += priceForTokens(entry.usage.inputTokens, price.inputPerMillion)
    estimatedCostUsd += priceForTokens(entry.usage.outputTokens, price.outputPerMillion)
    estimatedCostUsd += priceForTokens(entry.usage.cacheReadTokens, price.cacheReadPerMillion)
    estimatedCostUsd += priceForTokens(entry.usage.cacheCreationTokens, price.cacheCreationPerMillion)
  }
  const firstEventAt = input.events[0]?.ts
  const lastEventAt = input.events[input.events.length - 1]?.ts
  const wallTimeMs = firstEventAt && lastEventAt
    ? Math.max(0, Date.parse(lastEventAt) - Date.parse(firstEventAt))
    : undefined
  return {
    sessionId: input.header.sessionId,
    eventCount: input.events.length,
    llmCalls,
    toolCalls,
    toolErrors,
    totalInputTokens,
    totalOutputTokens,
    totalCacheReadTokens,
    totalCacheCreationTokens,
    ...(unknownCost ? {} : { estimatedCostUsd: roundCost(estimatedCostUsd) }),
    costStatus: unknownCost ? 'unknown' : 'estimated',
    models: [...models].sort(),
    missingUsageCalls,
    llmTraceMissingCalls,
    ...(wallTimeMs !== undefined ? { wallTimeMs } : {}),
    ...(firstEventAt ? { firstEventAt } : {}),
    ...(lastEventAt ? { lastEventAt } : {}),
  }
}

function priceForTokens(tokens: number, perMillion: number | undefined): number {
  return perMillion === undefined ? 0 : (tokens / 1_000_000) * perMillion
}

function roundCost(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
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
