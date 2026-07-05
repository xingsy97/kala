/**
 * OpenAI Chat Completions adapter.
 *
 * Also works against any OpenAI-compatible endpoint (self-hosted gateways,
 * proxies such as `newapi`) by overriding `baseUrl`. We POST to
 * `${baseUrl}/chat/completions`  -  pass a base_url ending in `/v1` and it
 * lands on the right path.
 *
 * We call fetch directly rather than pulling `openai` so the host stays
 * dependency-light and the request/response mapping lives at the boundary.
 */

import { readFile } from 'node:fs/promises'

import type {
  ImageContent,
  Message,
  MessageContent,
  ToolSchema,
} from '@agent-kernel/kernel'

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
      content: string | OpenAIUserContentBlock[]
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
    prompt_tokens_details?: { cached_tokens?: number }
  }
}

type OpenAIUserContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export function openaiAdapter(opts: OpenAIOptions): LLMAdapter {
  const fetchImpl = opts.fetchImpl ?? fetch
  const model = opts.model ?? DEFAULT_MODEL
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '')
  const url = `${baseUrl}/chat/completions`

  return {
    name: `openai:${model}`,
    async call(params: LLMCallParams): Promise<LLMResponse> {
      const effectiveModel = params.model ?? model
      const body = await buildRequestBody(params, effectiveModel, maxTokens)
      if (params.onTextDelta) {
        body.stream = true
        body.stream_options = { include_usage: true }
        return await callStreaming(
          url,
          opts.apiKey,
          body,
          fetchImpl,
          params.signal,
          params.onTextDelta,
        )
      }
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

/**
 * OpenAI Chat Completions streaming spec: SSE where each `data:` line is a
 * JSON object holding `choices[0].delta`. The stream ends with `data: [DONE]`.
 * Deltas we care about:
 *   - `delta.content`  -  text token
 *   - `delta.tool_calls[]`  -  each entry has index + partial function.name /
 *     function.arguments; we accumulate by index and assemble a single
 *     tool_call at end-of-stream.
 * Usage arrives in the final chunk (per `stream_options.include_usage`) with
 * `usage: { prompt_tokens, completion_tokens }` and no delta.
 */
type StreamedToolCall = {
  id: string
  name: string
  argsBuf: string
}

async function callStreaming(
  url: string,
  apiKey: string,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch,
  signal: AbortSignal | undefined,
  onTextDelta: (delta: string) => void,
): Promise<LLMResponse> {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
      accept: 'text/event-stream',
    },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok || !res.body) {
    const detail = await safeText(res)
    throw new OpenAIHTTPError(res.status, detail)
  }

  let textBuf = ''
  const toolCalls = new Map<number, StreamedToolCall>()
  let promptTokens = 0
  let completionTokens = 0
  let cachedTokens = 0

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const payload = line.slice(6)
      if (!payload || payload === '[DONE]') continue
      let evt: {
        choices?: Array<{
          delta?: {
            content?: string
            tool_calls?: Array<{
              index: number
              id?: string
              function?: { name?: string; arguments?: string }
            }>
          }
        }>
        usage?: {
          prompt_tokens?: number
          completion_tokens?: number
          prompt_tokens_details?: { cached_tokens?: number }
        }
      }
      try {
        evt = JSON.parse(payload)
      } catch {
        continue
      }
      const choice = evt.choices?.[0]
      const delta = choice?.delta
      if (delta?.content) {
        textBuf += delta.content
        onTextDelta(delta.content)
      }
      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const existing = toolCalls.get(tc.index) ?? {
            id: '',
            name: '',
            argsBuf: '',
          }
          if (tc.id) existing.id = tc.id
          if (tc.function?.name) existing.name = tc.function.name
          if (tc.function?.arguments) existing.argsBuf += tc.function.arguments
          toolCalls.set(tc.index, existing)
        }
      }
      if (evt.usage) {
        if (typeof evt.usage.prompt_tokens === 'number') {
          promptTokens = evt.usage.prompt_tokens
        }
        if (typeof evt.usage.completion_tokens === 'number') {
          completionTokens = evt.usage.completion_tokens
        }
        const cached = evt.usage.prompt_tokens_details?.cached_tokens
        if (typeof cached === 'number') cachedTokens = cached
      }
    }
  }

  const content: MessageContent[] = []
  if (textBuf.length > 0) content.push({ type: 'text', text: textBuf })
  const indices = [...toolCalls.keys()].sort((a, b) => a - b)
  for (const idx of indices) {
    const tc = toolCalls.get(idx)!
    content.push({
      type: 'tool_call',
      callId: tc.id,
      name: tc.name,
      input: parseArgs(tc.argsBuf),
    })
  }
  const message: Message = { role: 'assistant', content }
  const usage =
    promptTokens > 0 || completionTokens > 0
      ? {
          inputTokens: promptTokens,
          outputTokens: completionTokens,
          cacheReadTokens: cachedTokens,
        }
      : undefined
  return { message, usage }
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

async function buildRequestBody(
  params: LLMCallParams,
  model: string,
  maxTokens: number,
): Promise<Record<string, unknown>> {
  const { messages, tools, systemPrompt } = params
  const openaiMessages: OpenAIMessage[] = []
  if (systemPrompt) {
    openaiMessages.push({ role: 'system', content: systemPrompt })
  }
  for (const msg of messages) {
    openaiMessages.push(...(await toOpenAI(msg)))
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

async function toOpenAI(msg: Message): Promise<OpenAIMessage[]> {
  if (msg.role === 'system') {
    return [{ role: 'system', content: extractText(msg.content) }]
  }
  if (msg.role === 'user') {
    return [{ role: 'user', content: await toOpenAIUserContent(msg.content) }]
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

async function toOpenAIUserContent(
  content: readonly MessageContent[],
): Promise<string | OpenAIUserContentBlock[]> {
  const hasImage = content.some((c) => c.type === 'image')
  if (!hasImage) return extractText(content)
  const blocks: OpenAIUserContentBlock[] = []
  for (const c of content) {
    if (c.type === 'text') {
      blocks.push({ type: 'text', text: c.text })
    } else if (c.type === 'image') {
      blocks.push({
        type: 'image_url',
        image_url: { url: await toDataUrl(c) },
      })
    }
  }
  return blocks
}

async function toDataUrl(content: ImageContent): Promise<string> {
  if (content.source.kind === 'base64') {
    return `data:${content.source.mediaType};base64,${content.source.data}`
  }
  const mediaType = content.source.mediaType ?? guessMediaType(content.source.path)
  const data = (await readFile(content.source.path)).toString('base64')
  return `data:${mediaType};base64,${data}`
}

function guessMediaType(
  path: string,
): 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' {
  const lower = path.toLowerCase()
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.gif')) return 'image/gif'
  return 'image/png'
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
        cacheReadTokens: numOr(
          body.usage.prompt_tokens_details?.cached_tokens,
          0,
        ),
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
