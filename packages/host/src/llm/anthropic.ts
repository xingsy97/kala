/**
 * Anthropic Messages API adapter.
 *
 * We hit the HTTP API directly with fetch (Node ≥18) rather than pulling the
 * `@anthropic-ai/sdk` package, because:
 *   - one dependency saved
 *   - the request shape is stable enough to hand-roll
 *   - it makes the mapping between our `Message` and Anthropic's schema
 *     explicit at the boundary
 */

import type { Message, MessageContent, ToolSchema } from '@agent-kernel/kernel'

import type { LLMAdapter, LLMCallParams, LLMResponse } from './adapter.js'

export type AnthropicOptions = {
  apiKey: string
  model?: string
  maxTokens?: number
  apiUrl?: string
  fetchImpl?: typeof fetch
}

const DEFAULT_MODEL = 'claude-sonnet-4-6'
const DEFAULT_MAX_TOKENS = 4096
const DEFAULT_URL = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_VERSION = '2023-06-01'

type AnthropicBlock =
  | { type: 'text'; text: string }
  | {
      type: 'tool_use'
      id: string
      name: string
      input: Record<string, unknown>
    }
  | {
      type: 'tool_result'
      tool_use_id: string
      content: string
      is_error?: boolean
    }

type AnthropicMessage = {
  role: 'user' | 'assistant'
  content: AnthropicBlock[]
}

type AnthropicResponseBody = {
  id: string
  role: 'assistant'
  content: AnthropicBlock[]
  stop_reason?: string
  usage?: {
    input_tokens: number
    output_tokens: number
  }
}

export function anthropicAdapter(opts: AnthropicOptions): LLMAdapter {
  const fetchImpl = opts.fetchImpl ?? fetch
  const model = opts.model ?? DEFAULT_MODEL
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS
  const apiUrl = opts.apiUrl ?? DEFAULT_URL

  return {
    name: `anthropic:${model}`,
    async call(params: LLMCallParams): Promise<LLMResponse> {
      const effectiveModel = params.model ?? model
      const body = buildRequestBody(params, effectiveModel, maxTokens)
      const res = await fetchImpl(apiUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': opts.apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify(body),
        signal: params.signal,
      })
      if (!res.ok) {
        const detail = await safeText(res)
        throw new AnthropicHTTPError(res.status, detail)
      }
      const json = (await res.json()) as AnthropicResponseBody
      return parseResponse(json)
    },
  }
}

export class AnthropicHTTPError extends Error {
  constructor(
    readonly status: number,
    readonly bodyText: string,
  ) {
    super(`Anthropic HTTP ${status}: ${bodyText.slice(0, 200)}`)
    this.name = 'AnthropicHTTPError'
  }
}

function buildRequestBody(
  params: LLMCallParams,
  model: string,
  maxTokens: number,
): Record<string, unknown> {
  const { messages, tools, systemPrompt } = params
  const resolvedSystem = systemPrompt ?? extractSystem(messages)
  const anthropicMessages = messages
    .filter((m) => m.role !== 'system')
    .map(toAnthropic)
  const body: Record<string, unknown> = {
    model,
    max_tokens: maxTokens,
    messages: anthropicMessages,
  }
  if (resolvedSystem) body.system = resolvedSystem
  if (tools.length > 0) body.tools = tools.map(toAnthropicTool)
  return body
}

function extractSystem(messages: readonly Message[]): string | undefined {
  const sys = messages.find((m) => m.role === 'system')
  if (!sys) return undefined
  return sys.content
    .map((c) => (c.type === 'text' ? c.text : ''))
    .join('')
}

function toAnthropic(msg: Message): AnthropicMessage {
  if (msg.role === 'tool') {
    return {
      role: 'user',
      content: msg.content.map(toAnthropicBlock),
    }
  }
  if (msg.role === 'assistant' || msg.role === 'user') {
    return {
      role: msg.role,
      content: msg.content.map(toAnthropicBlock),
    }
  }
  throw new Error(`Unexpected message role: ${msg.role}`)
}

function toAnthropicBlock(content: MessageContent): AnthropicBlock {
  switch (content.type) {
    case 'text':
      return { type: 'text', text: content.text }
    case 'tool_call':
      return {
        type: 'tool_use',
        id: content.callId,
        name: content.name,
        input: content.input,
      }
    case 'tool_result':
      return {
        type: 'tool_result',
        tool_use_id: content.callId,
        content: content.content,
        is_error: !content.ok,
      }
  }
}

function toAnthropicTool(tool: ToolSchema): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  }
}

function parseResponse(body: AnthropicResponseBody): LLMResponse {
  const content = body.content.map(fromAnthropicBlock).filter(
    (c): c is MessageContent => c !== null,
  )
  const message: Message = { role: 'assistant', content }
  // Defensively coerce usage fields — Anthropic proxies (and older API
  // versions) occasionally omit `input_tokens`/`output_tokens`. Passing
  // undefined into the kernel's usage accumulator would produce NaN.
  const usage = body.usage
    ? {
        inputTokens: numOr(body.usage.input_tokens, 0),
        outputTokens: numOr(body.usage.output_tokens, 0),
      }
    : undefined
  return { message, usage }
}

function numOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

function fromAnthropicBlock(block: AnthropicBlock): MessageContent | null {
  if (block.type === 'text') return { type: 'text', text: block.text }
  if (block.type === 'tool_use') {
    return {
      type: 'tool_call',
      callId: block.id,
      name: block.name,
      input: block.input,
    }
  }
  return null
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text()
  } catch {
    return ''
  }
}
