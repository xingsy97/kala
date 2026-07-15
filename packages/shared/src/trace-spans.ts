/**
 * Session → OpenInference/OpenTelemetry GenAI span export.
 *
 * The reducer knows nothing about traces. We derive:
 *   - one AGENT root span per session
 *   - one LLM span per llm_response / llm_error
 *   - one TOOL span per tool_result (or MEMORY if it's the memory tool)
 *   - one CHAIN span per successful compaction message replacement, so
 *     summarizer runs are visible alongside main-loop traffic
 *
 * The shape follows the OpenInference semantic conventions so it can be
 * ingested by Phoenix/Arize collectors and the OpenTelemetry Collector's
 * GenAI pipeline.
 */

import { createHash } from 'node:crypto'

import type { Effect } from '@agent-kernel/kernel'
import { MEMORY_TOOL_NAME } from '@agent-kernel/kernel'

import type { EventEntry, HeaderEntry } from './log.js'

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
        'agent_kernel.parent_session_id': input.header.parentSessionId,
        'agent_kernel.parent_cursor': input.header.parentCursor,
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
      continue
    }
    if (entry.event.kind === 'messages_replaced' && entry.event.reason === 'compaction') {
      spans.push(compactSpan(traceId, rootSpanId, entry))
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
      'gen_ai.response.id': trace?.gatewayRequestId,
      'gen_ai.usage.input_tokens': usage?.inputTokens,
      'gen_ai.usage.output_tokens': usage?.outputTokens,
      'gen_ai.usage.cache_creation.input_tokens': usage?.cacheCreationTokens,
      'gen_ai.usage.cache_read.input_tokens': usage?.cacheReadTokens,
      'agent_kernel.event_seq': entry.seq,
      'agent_kernel.model.weight_version': trace?.weightVersion,
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
  const isMemory = toolName === MEMORY_TOOL_NAME
  const kind: EnhancementSpanKind = isMemory ? 'MEMORY' : 'TOOL'
  return {
    traceId,
    spanId: stableId(`span:tool:${entry.seq}:${event?.callId ?? ''}`, 16),
    parentSpanId,
    name: isMemory ? `memory ${toolName}` : `execute_tool ${toolName ?? 'unknown'}`,
    kind,
    startTime: entry.ts,
    endTime: entry.ts,
    status: event?.ok === false ? 'ERROR' : 'OK',
    attributes: compactRecord({
      'openinference.span.kind': kind,
      'gen_ai.operation.name': isMemory ? 'memory_operation' : 'execute_tool',
      'gen_ai.tool.name': toolName,
      'gen_ai.tool.call.id': event?.callId,
      'agent_kernel.event_seq': entry.seq,
      'error.type': event?.ok === false ? 'tool_error' : undefined,
    }),
    events: [],
  }
}

/**
 * CHAIN span for a compaction attempt. All three terminal events
 * messages_replaced(reason=compaction) maps here; the
 * status and attributes carry the outcome so a single query can find every
 * compaction attempt in a trace regardless of whether it succeeded.
 *
 * We deliberately do NOT emit a separate LLM span for the summarizer call —
 * summarizer call is a synthetic one that never yields an `llm_response` event
 * on the main ledger, so there's no seq to bind an LLM span to. If we ever
 * start emitting a `llm_response` for summarizer calls, add the child LLM span
 * here.
 */
function compactSpan(
  traceId: string,
  parentSpanId: string,
  entry: EventEntry,
): EnhancementSpan {
  const kind = entry.event.kind
  const status: EnhancementSpan['status'] = 'OK'
  return {
    traceId,
    spanId: stableId(`span:compact:${entry.seq}`, 16),
    parentSpanId,
    name: `compaction ${kind}`,
    kind: 'CHAIN',
    startTime: entry.ts,
    endTime: entry.ts,
    status,
    attributes: compactRecord({
      'openinference.span.kind': 'CHAIN',
      'gen_ai.operation.name': 'compact_context',
      'agent_kernel.event_seq': entry.seq,
      'agent_kernel.compact.outcome': 'replaced',
      'agent_kernel.message_replace.start': entry.event.kind === 'messages_replaced' ? entry.event.replaceRange.start : undefined,
      'agent_kernel.message_replace.end': entry.event.kind === 'messages_replaced' ? entry.event.replaceRange.end : undefined,
      'agent_kernel.message_replace.count': entry.event.kind === 'messages_replaced' ? entry.event.replacementMessages.length : undefined,
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

export function inferProvider(model: string | undefined): string | undefined {
  if (!model) return undefined
  const lower = model.toLowerCase()
  if (lower.includes('claude')) return 'anthropic'
  if (lower.includes('gpt') || lower.includes('o1') || lower.includes('o3')) return 'openai'
  return undefined
}

export function stableId(input: string, hexLength: number): string {
  return createHash('sha256').update(input).digest('hex').slice(0, hexLength)
}

export function compactRecord(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined && value !== null),
  )
}
