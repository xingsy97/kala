/**
 * OpenAI Chat Completions adapter.
 *
 * Also works against any OpenAI-compatible endpoint (self-hosted gateways,
 * proxies such as `newapi`) by overriding `baseUrl`. We POST to
 * `${baseUrl}/chat/completions` — pass a base_url ending in `/v1` and it
 * lands on the right path.
 *
 * We call fetch directly rather than pulling `openai` so the host stays
 * dependency-light and the request/response mapping lives at the boundary.
 */

import type { Message, MessageContent, ToolSchema } from '@agent-kernel/kernel'

import type { LLMAdapter, LLMCallParams, LLMResponse } from './adapter.js'

export type OpenAIOptions = {
  apiKey: string
  model?: string
  maxTokens?: number
  baseUrl?: string
  fetchImpl?: typeof fetch
}

const DEFAULT_MODEL = 'gpt-4o-mini'
const DEFAULT_MAX_TOKENS = 4096
const DEFAULT_BASE_URL = 'https://api.openai.com/v1'

type OpenAIToolCall = {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string // JSON-encoded object per OpenAI spec
  }
}

type OpenAIMessage =
  | {
      role: 'system' | 'user'
      content: string
    }
  | {
      role: 'assistant'
      content: string | null
      tool_calls?: OpenAIToolCall[]
    }
  | {
      role: 'tool'
      tool_call_id: string
      content: string
    }

type OpenAIResponseBody = {
  id: string
  choices: Array<{
    index: number
    message: {
      role: 'assistant'
      content: string | null
      tool_calls?: OpenAIToolCall[]
    }
    finish_reason?: string
  }>
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens?: number
  }
}

export function openaiAdapter(opts: OpenAIOptions): LLMAdapter {
  const fetchImpl = opts.fetchImpl ?? fetch
  const model = opts.model ?? DEFAULT_MODEL
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '')
  const url = `${baseUrl}/chat/completions`

  return {
    name: `openai:${model}`,
    async call(params: LLMCallParams): Promise<LLMResponse> {
      const body = buildRequestBody(params, model, maxTokens)
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${opts.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: params.signal,
      })
      if (!res.ok) {
        const detail = await safeText(res)
        throw new OpenAIHTTPError(res.status, detail)
      }
      const json = (await res.json()) as OpenAIResponseBody
      return parseResponse(json)
    },
  }
}

export class OpenAIHTTPError extends Error {
  constructor(
    readonly status: number,
    readonly bodyText: string,
  ) {
    super(`OpenAI HTTP ${status}: ${bodyText.slice(0, 200)}`)
    this.name = 'OpenAIHTTPError'
  }
}

function buildRequestBody(
  params: LLMCallParams,
  model: string,
  maxTokens: number,
): Record<string, unknown> {
  const { messages, tools, systemPrompt } = params
  const openaiMessages: OpenAIMessage[] = []
  if (systemPrompt) {
    openaiMessages.push({ role: 'system', content: systemPrompt })
  }
  for (const msg of messages) {
    openaiMessages.push(...toOpenAI(msg))
  }
  const body: Record<string, unknown> = {
    model,
    max_tokens: maxTokens,
    messages: openaiMessages,
  }
  if (tools.length > 0) {
    body.tools = tools.map(toOpenAITool)
    body.tool_choice = 'auto'
  }
  return body
}

function toOpenAI(msg: Message): OpenAIMessage[] {
  if (msg.role === 'system') {
    return [{ role: 'system', content: extractText(msg.content) }]
  }
  if (msg.role === 'user') {
    return [{ role: 'user', content: extractText(msg.content) }]
  }
  if (msg.role === 'tool') {
    // Every tool_result becomes its own `role: "tool"` message. OpenAI
    // rejects tool messages with multiple results bundled in one entry.
    const out: OpenAIMessage[] = []
    for (const c of msg.content) {
      if (c.type === 'tool_result') {
        out.push({
          role: 'tool',
          tool_call_id: c.callId,
          content: c.content,
        })
      }
    }
    return out
  }
  // assistant
  const text = extractText(msg.content)
  const toolCalls = msg.content
    .filter((c): c is Extract<MessageContent, { type: 'tool_call' }> =>
      c.type === 'tool_call',
    )
    .map(
      (c): OpenAIToolCall => ({
        id: c.callId,
        type: 'function',
        function: {
          name: c.name,
          arguments: JSON.stringify(c.input),
        },
      }),
    )
  const assistant: OpenAIMessage = {
    role: 'assistant',
    content: text.length > 0 ? text : null,
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  }
  return [assistant]
}

function extractText(content: readonly MessageContent[]): string {
  return content
    .map((c) => (c.type === 'text' ? c.text : ''))
    .join('')
}

function toOpenAITool(tool: ToolSchema): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }
}

function parseResponse(body: OpenAIResponseBody): LLMResponse {
  const choice = body.choices[0]
  if (!choice) throw new Error('OpenAI response has no choices')
  const raw = choice.message
  const content: MessageContent[] = []
  if (raw.content && raw.content.length > 0) {
    content.push({ type: 'text', text: raw.content })
  }
  if (raw.tool_calls) {
    for (const tc of raw.tool_calls) {
      content.push({
        type: 'tool_call',
        callId: tc.id,
        name: tc.function.name,
        input: parseArgs(tc.function.arguments),
      })
    }
  }
  const message: Message = { role: 'assistant', content }
  // Some OpenAI-compatible gateways return `usage: {}` or omit individual
  // fields. Coerce to numbers so the kernel's usage accumulator never sees
  // undefined + number = NaN. If we can't produce a numeric usage total,
  // drop the usage entirely (kernel treats undefined as "no change").
  const usage = body.usage
    ? {
        inputTokens: numOr(body.usage.prompt_tokens, 0),
        outputTokens: numOr(body.usage.completion_tokens, 0),
      }
    : undefined
  return { message, usage }
}

function numOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

function parseArgs(raw: string): Record<string, unknown> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return {}
  } catch {
    return {}
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text()
  } catch {
    return ''
  }
}
