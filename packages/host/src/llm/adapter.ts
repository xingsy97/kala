/**
 * LLMAdapter interface. Each provider implements this and Host swaps them in
 * per session (via config). Adapters translate `Message[]`  -  provider request/
 * response and normalize errors.
 *
 * Kept intentionally minimal  -  provider quirks live inside the adapter, not
 * in the host loop or the kernel.
 */

import type { Message, ToolSchema, UsageDelta } from '@agent-kernel/kernel'

export type LLMResponse = {
  message: Message
  usage?: UsageDelta
}

/**
 * Streaming hook. Adapters that support server-sent events invoke `onTextDelta`
 * as text tokens arrive. Kernel/event-log stay authoritative: the final
 * `LLMResponse.message` is what actually feeds `llm_response`. Deltas are
 * UI-only  -  a fine-grained UX signal that lets the dashboard render tokens
 * incrementally.
 *
 * Adapters that don't implement streaming simply never call `onTextDelta`;
 * the host still gets the final message and emits it as a single implicit
 * chunk.
 */
export type LLMCallParams = {
  messages: readonly Message[]
  tools: readonly ToolSchema[]
  systemPrompt?: string
  model?: string
  signal?: AbortSignal
  onTextDelta?: (delta: string) => void
}

export type LLMAdapter = {
  readonly name: string
  call(params: LLMCallParams): Promise<LLMResponse>
}
