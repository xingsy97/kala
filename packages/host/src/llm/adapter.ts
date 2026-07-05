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

export type LLMCallParams = {
  messages: readonly Message[]
  tools: readonly ToolSchema[]
  systemPrompt?: string
  model?: string
  signal?: AbortSignal
}

export type LLMAdapter = {
  readonly name: string
  call(params: LLMCallParams): Promise<LLMResponse>
}
