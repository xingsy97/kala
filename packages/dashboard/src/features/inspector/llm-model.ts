import { redactLlmTrace, type LLMTrace } from '@agent-kernel/shared'

import type { LlmCall } from '../chat/context-composition.js'
import { providerBodyHasKey } from '../chat/context-composition.js'
import { summarizeContent, summarizeContentForCard } from './timeline-model.js'
import type { ToolCallLifecycle } from './trace-types.js'

/** Pure LLM/trace/tool summarization helpers for the inspector. */

export function describeSystemInjection(call: LlmCall): string {
  const provider = call.trace ? providerFromTrace(call.trace) : 'unknown'
  const firstSystem = call.effect.messages.find((message) => message.role === 'system')
  const hasProviderSystem = call.trace ? providerBodyHasKey(call.trace.request.body, 'system') : false
  if (provider === 'anthropic' && hasProviderSystem) {
    return firstSystem
      ? 'system message or config prompt is folded into Anthropic top-level body.system'
      : 'config prompt is sent as Anthropic top-level body.system'
  }
  if (provider === 'openai') {
    return 'system prompt is sent as an OpenAI-compatible system message when configured'
  }
  if (firstSystem) return 'kernel request includes at least one system message'
  return 'no system prompt visible in captured request data'
}

export function redactedApiRequest(trace: LLMTrace): LLMTrace['request'] {
  return redactLlmTrace(trace).request
}

export function providerArrayLength(body: unknown, key: string): string {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'not present'
  const value = (body as Record<string, unknown>)[key]
  return Array.isArray(value) ? String(value.length) : 'not present'
}

export function llmResponseSummary(call: LlmCall): string {
  if (call.error) return call.error.error
  if (!call.response) return 'pending'
  return summarizeContent(call.response.message.content)
}

export function llmResponseCardSummary(call: LlmCall): string {
  if (call.error) return `error ${call.error.error.length} chars`
  if (!call.response) return 'pending'
  return summarizeContentForCard(call.response.message.content)
}

export function toolResultLabel(call: ToolCallLifecycle): string {
  if (!call.result) return call.rejectedSeq ? 'rejected' : 'pending'
  return `${call.result.ok ? 'ok' : 'error'} · ${call.result.content.length} bytes`
}

export function toolLifecycleSummary(call: ToolCallLifecycle): string {
  const parts: string[] = []
  if (call.requestedSeq) parts.push(`requested #${call.requestedSeq}`)
  if (call.approvedSeq) parts.push(`approved #${call.approvedSeq}`)
  if (call.rejectedSeq) parts.push(`rejected #${call.rejectedSeq}`)
  if (call.resultSeq) parts.push(`result #${call.resultSeq}`)
  return parts.join(' · ') || 'lifecycle not recorded'
}

export function llmCallModel(call: LlmCall): string {
  return modelFromTrace(call.trace) ?? call.model ?? 'model unknown'
}

export function llmCallProvider(call: LlmCall): string {
  if (!call.trace) return providerFromModel(llmCallModel(call)) ?? 'kernel'
  return providerFromTrace(call.trace)
}

export function modelFromTrace(trace: LLMTrace | undefined): string | null {
  if (!trace) return null
  if (typeof trace.model === 'string' && trace.model.length > 0) return trace.model
  const body = trace.request.body
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const model = (body as Record<string, unknown>).model
    if (typeof model === 'string' && model.length > 0) return model
  }
  return null
}

export function providerFromTrace(trace: LLMTrace): string {
  const provider = trace.provider
  if (provider && provider !== 'unknown') return provider
  const model = modelFromTrace(trace)
  const fromModel = providerFromModel(model ?? undefined)
  if (fromModel) return fromModel
  const url = trace.request.url.toLowerCase()
  if (url.includes('anthropic')) return 'anthropic'
  if (url.includes('openai')) return 'openai'
  return 'unknown'
}

export function providerFromModel(model: string | undefined): string | null {
  if (!model) return null
  const normalized = model.toLowerCase()
  if (normalized.includes('claude')) return 'anthropic'
  if (normalized.includes('gpt')) return 'openai'
  return null
}
