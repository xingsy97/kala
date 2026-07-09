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

import { readFile } from 'node:fs/promises'

import type {
  ImageContent,
  Message,
  MessageContent,
  ToolSchema,
} from '@agent-kernel/kernel'

import type { LLMAdapter, LLMCallParams, LLMResponse } from './adapter.js'

export type AnthropicOptions = {
  apiKey: string
  model?: string
  maxTokens?: number
  apiUrl?: string
  fetchImpl?: typeof fetch
  /**
   * Toggle Anthropic prompt caching (attaches `cache_control: ephemeral`
   * markers on the system prompt, last tool, and last non-assistant message).
   * Defaults to true. Set false against gateways that reject the field.
   */
  cache?: boolean
}

const DEFAULT_MODEL = 'claude-sonnet-4-6'
const DEFAULT_MAX_TOKENS = 4096
const DEFAULT_URL = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_VERSION = '2023-06-01'

type AnthropicImageSource =
  | {
      type: 'base64'
      media_type: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
      data: string
    }
  | { type: 'url'; url: string }

type CacheControl = { type: 'ephemeral' }

type AnthropicBlock =
  | { type: 'text'; text: string; cache_control?: CacheControl }
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
      cache_control?: CacheControl
    }
  | { type: 'image'; source: AnthropicImageSource; cache_control?: CacheControl }
  | { type: 'thinking'; thinking: string; signature?: string }

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
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  }
}

export function anthropicAdapter(opts: AnthropicOptions): LLMAdapter {
  const fetchImpl = opts.fetchImpl ?? fetch
  const model = opts.model ?? DEFAULT_MODEL
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS
  const apiUrl = opts.apiUrl ?? DEFAULT_URL
  const cache = opts.cache ?? true

  return {
    name: `anthropic:${model}`,
    async call(params: LLMCallParams): Promise<LLMResponse> {
      const effectiveModel = params.model ?? model
      const body = await buildRequestBody(params, effectiveModel, maxTokens, cache)
      if (params.onTextDelta) {
        body.stream = true
        return await callStreaming(
          apiUrl,
          opts.apiKey,
          body,
          fetchImpl,
          params.signal,
          params.onTextDelta,
        )
      }
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

/**
 * Anthropic Messages Streaming spec: SSE where each `event:` line names an
 * event type and the following `data:` line is JSON. The events we care about:
 *   - `content_block_start` with block.type === 'text' → starts a text block
 *   - `content_block_delta` with delta.type === 'text_delta' → text token
 *   - `content_block_stop` → end of a block
 *   - `message_delta` → carries stop_reason and final usage
 *   - `message_stop` → end of stream
 * Non-text blocks (`tool_use`, thinking) accumulate their JSON via
 * `input_json_delta` events; we assemble them into a final tool_call.
 */
async function callStreaming(
  apiUrl: string,
  apiKey: string,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch,
  signal: AbortSignal | undefined,
  onTextDelta: (delta: string) => void,
): Promise<LLMResponse> {
  const res = await fetchImpl(apiUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      accept: 'text/event-stream',
    },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok || !res.body) {
    const detail = await safeText(res)
    throw new AnthropicHTTPError(res.status, detail)
  }

  const blocks: AnthropicBlock[] = []
  const toolInputBuf: string[] = []
  let inputTokens = 0
  let outputTokens = 0
  let cacheCreationTokens = 0
  let cacheReadTokens = 0

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
      if (!payload) continue
      let evt: Record<string, unknown>
      try {
        evt = JSON.parse(payload) as Record<string, unknown>
      } catch {
        continue
      }
      handleStreamEvent(
        evt,
        blocks,
        toolInputBuf,
        (text) => onTextDelta(text),
        (u) => {
          inputTokens += u.input
          outputTokens += u.output
          cacheCreationTokens += u.cacheCreation
          cacheReadTokens += u.cacheRead
        },
      )
    }
  }

  const content = blocks
    .map(fromAnthropicBlock)
    .filter((c): c is MessageContent => c !== null)
  const message: Message = { role: 'assistant', content }
  const usage =
    inputTokens > 0 ||
    outputTokens > 0 ||
    cacheCreationTokens > 0 ||
    cacheReadTokens > 0
      ? { inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens }
      : undefined
  return { message, usage }
}

function handleStreamEvent(
  evt: Record<string, unknown>,
  blocks: AnthropicBlock[],
  toolBuf: string[],
  onText: (t: string) => void,
  onUsage: (u: {
    input: number
    output: number
    cacheCreation: number
    cacheRead: number
  }) => void,
): void {
  const kind = evt.type as string | undefined
  if (kind === 'content_block_start') {
    const idx = (evt.index as number) ?? blocks.length
    const block = (evt.content_block as AnthropicBlock) ?? { type: 'text', text: '' }
    blocks[idx] = block
    toolBuf[idx] = ''
    return
  }
  if (kind === 'content_block_delta') {
    const idx = evt.index as number
    const delta = (evt.delta as Record<string, unknown>) ?? {}
    const dtype = delta.type as string | undefined
    const target = blocks[idx]
    if (!target) return
    if (dtype === 'text_delta' && target.type === 'text') {
      const t = (delta.text as string) ?? ''
      target.text += t
      if (t) onText(t)
    } else if (dtype === 'input_json_delta' && target.type === 'tool_use') {
      toolBuf[idx] = (toolBuf[idx] ?? '') + ((delta.partial_json as string) ?? '')
    } else if (dtype === 'thinking_delta' && target.type === 'thinking') {
      target.thinking += (delta.thinking as string) ?? ''
    } else if (dtype === 'signature_delta' && target.type === 'thinking') {
      target.signature = ((target.signature ?? '') +
        ((delta.signature as string) ?? '')) || undefined
    }
    return
  }
  if (kind === 'content_block_stop') {
    const idx = evt.index as number
    const target = blocks[idx]
    if (target?.type === 'tool_use') {
      try {
        target.input = JSON.parse(toolBuf[idx] ?? '{}') as Record<string, unknown>
      } catch {
        target.input = {}
      }
    }
    return
  }
  if (kind === 'message_start') {
    const msg =
      (evt.message as {
        usage?: {
          input_tokens: number
          output_tokens: number
          cache_creation_input_tokens?: number
          cache_read_input_tokens?: number
        }
      }) ?? {}
    if (msg.usage) {
      onUsage({
        input: msg.usage.input_tokens ?? 0,
        output: msg.usage.output_tokens ?? 0,
        cacheCreation: msg.usage.cache_creation_input_tokens ?? 0,
        cacheRead: msg.usage.cache_read_input_tokens ?? 0,
      })
    }
    return
  }
  if (kind === 'message_delta') {
    const usage = (evt.usage as { output_tokens?: number }) ?? {}
    if (typeof usage.output_tokens === 'number') {
      // message_delta usage.output_tokens is the running total, not a delta.
      // Anthropic reports cumulative output_tokens here; we already captured
      // input on message_start, and content_block_delta events don't include
      // usage. Overwrite by treating this as final output.
      onUsage({
        input: 0,
        output: usage.output_tokens,
        cacheCreation: 0,
        cacheRead: 0,
      })
    }
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

async function buildRequestBody(
  params: LLMCallParams,
  model: string,
  maxTokens: number,
  cache: boolean,
): Promise<Record<string, unknown>> {
  const { messages, tools, systemPrompt } = params
  const resolvedSystem = systemPrompt ?? extractSystem(messages)
  const anthropicMessages = await Promise.all(
    messages.filter((m) => m.role !== 'system').map(toAnthropic),
  )
  const body: Record<string, unknown> = {
    model,
    max_tokens: maxTokens,
    messages: anthropicMessages,
  }
  if (resolvedSystem) {
    body.system = cache
      ? [{ type: 'text', text: resolvedSystem, cache_control: { type: 'ephemeral' } }]
      : resolvedSystem
  }
  if (tools.length > 0) {
    const toolPayload = tools.map(toAnthropicTool)
    if (cache && toolPayload.length > 0) {
      const last = toolPayload[toolPayload.length - 1]!
      toolPayload[toolPayload.length - 1] = {
        ...last,
        cache_control: { type: 'ephemeral' },
      }
    }
    body.tools = toolPayload
  }
  if (cache) markLastUserBlockForCache(anthropicMessages)
  if (typeof params.thinkingBudget === 'number' && params.thinkingBudget > 0) {
    body.thinking = {
      type: 'enabled',
      budget_tokens: params.thinkingBudget,
    }
  }
  return body
}

/**
 * Rotating cache breakpoint on the growing conversation: attach cache_control
 * to the last block of the last non-assistant message. On the next turn the
 * previous breakpoint stops matching but Anthropic falls back to the earlier
 * system+tools breakpoints, and the new one covers the just-appended turn.
 */
function markLastUserBlockForCache(messages: AnthropicMessage[]): void {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!
    if (msg.role !== 'user') continue
    const last = msg.content[msg.content.length - 1]
    if (!last) return
    if (
      last.type === 'text' ||
      last.type === 'tool_result' ||
      last.type === 'image'
    ) {
      last.cache_control = { type: 'ephemeral' }
    }
    return
  }
}

function extractSystem(messages: readonly Message[]): string | undefined {
  const sys = messages.find((m) => m.role === 'system')
  if (!sys) return undefined
  return sys.content
    .map((c) => (c.type === 'text' ? c.text : ''))
    .join('')
}

async function toAnthropic(msg: Message): Promise<AnthropicMessage> {
  if (msg.role === 'tool') {
    return {
      role: 'user',
      content: await Promise.all(msg.content.map(toAnthropicBlock)),
    }
  }
  if (msg.role === 'assistant' || msg.role === 'user') {
    return {
      role: msg.role,
      content: await Promise.all(msg.content.map(toAnthropicBlock)),
    }
  }
  throw new Error(`Unexpected message role: ${msg.role}`)
}

async function toAnthropicBlock(content: MessageContent): Promise<AnthropicBlock> {
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
    case 'image':
      return { type: 'image', source: await toAnthropicImageSource(content) }
    case 'thinking':
      return {
        type: 'thinking',
        thinking: content.text,
        ...(content.signature ? { signature: content.signature } : {}),
      }
  }
}

async function toAnthropicImageSource(
  content: ImageContent,
): Promise<AnthropicImageSource> {
  if (content.source.kind === 'base64') {
    return {
      type: 'base64',
      media_type: content.source.mediaType,
      data: content.source.data,
    }
  }
  const buf = await readFile(content.source.path)
  return {
    type: 'base64',
    media_type: content.source.mediaType ?? guessMediaType(content.source.path),
    data: buf.toString('base64'),
  }
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
        cacheCreationTokens: numOr(body.usage.cache_creation_input_tokens, 0),
        cacheReadTokens: numOr(body.usage.cache_read_input_tokens, 0),
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
  if (block.type === 'thinking') {
    return {
      type: 'thinking',
      text: block.thinking,
      ...(block.signature ? { signature: block.signature } : {}),
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
