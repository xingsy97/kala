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

import type {
  Message,
  MessageContent,
} from '@agent-kernel/kernel'
import type { LLMTrace } from '@agent-kernel/shared'

import type { LLMAdapter, LLMCallParams, LLMResponse } from './adapter.js'
import { classifyProviderError, isRetryable } from './provider-health.js'
import { ProviderHTTPError, wrapProviderFetchError } from './provider-error.js'
import { buildAnthropicRequestBody } from './provider-request-builder.js'
import type { AnthropicBlock } from './provider-request-builder.js'
import { normalizeAnthropicBlocks } from '../tools/tool-call-normalizer.js'

export type AnthropicOptions = {
  apiKey: string
  model?: string
  maxTokens?: number
  apiUrl?: string
  fetchImpl?: typeof fetch
  /**
   * Optional model weight version to stamp on every trace. Hosted providers
   * rarely expose one; setting it here lets local/proxy gateways or A/B
   * evaluation configs record which policy checkpoint answered a call.
   */
  weightVersion?: string
  /**
   * Toggle Anthropic prompt caching (attaches `cache_control: ephemeral`
   * markers on the system prompt, last tool, and last non-assistant message).
   * Defaults to true. Set false against gateways that reject the field.
   */
  cache?: boolean
  /**
   * Retry transient non-streaming request failures. Defaults to one retry.
   * Streaming calls are not retried because partial UI deltas may already
   * have been emitted.
   */
  maxRetries?: number
  retryDelayMs?: number
}

const DEFAULT_MODEL = 'claude-sonnet-4-6'
const DEFAULT_URL = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_VERSION = '2023-06-01'

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
  const maxTokens = opts.maxTokens
  const apiUrl = opts.apiUrl ?? DEFAULT_URL
  const cache = opts.cache ?? true
  const weightVersion = opts.weightVersion
  const maxRetries = opts.maxRetries ?? 1
  const retryDelayMs = opts.retryDelayMs ?? 250

  return {
    name: `anthropic:${model}`,
    async call(params: LLMCallParams): Promise<LLMResponse> {
      const effectiveModel = params.model ?? model
      const { body } = await buildAnthropicRequestBody(params, effectiveModel, maxTokens, cache)
      if (params.onTextDelta) {
        body.stream = true
        return await callStreaming(
          apiUrl,
          opts.apiKey,
          body,
          effectiveModel,
          fetchImpl,
          params.signal,
          params.onTextDelta,
          weightVersion,
        )
      }
      const res = await fetchAnthropicWithRetry({
        apiUrl,
        apiKey: opts.apiKey,
        body,
        signal: params.signal,
        fetchImpl,
        maxRetries,
        retryDelayMs,
      })
      if (!res.ok) {
        const detail = await safeText(res)
        throw new AnthropicHTTPError(res.status, detail, apiUrl)
      }
      const json = (await res.json()) as AnthropicResponseBody
      const parsed = parseResponse(json)
      return {
        ...parsed,
        trace: makeAnthropicTrace(apiUrl, effectiveModel, body, {
          status: res.status,
          ...(parsed.finishReason ? { finishReason: parsed.finishReason } : {}),
          body: json,
        }, {
          gatewayRequestId: extractAnthropicRequestId(res.headers, json),
          ...(weightVersion ? { weightVersion } : {}),
        }),
      }
    },
  }
}

async function fetchAnthropicWithRetry(input: {
  apiUrl: string
  apiKey: string
  body: Record<string, unknown>
  signal?: AbortSignal
  fetchImpl: typeof fetch
  maxRetries: number
  retryDelayMs: number
}): Promise<Response> {
  let lastErr: unknown
  const attempts = Math.max(1, input.maxRetries + 1)
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const res = await input.fetchImpl(input.apiUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': input.apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify(input.body),
        signal: input.signal,
      }).catch((err: unknown) => wrapProviderFetchError('Anthropic', input.apiUrl, err))
      if (res.ok || attempt === attempts - 1 || !isRetryable(classifyProviderError({ status: res.status }))) return res
      lastErr = new AnthropicHTTPError(res.status, await safeText(res), input.apiUrl)
    } catch (err) {
      if (isAbortError(err) || attempt === attempts - 1 || !isRetryable(classifyProviderError(err))) throw err
      lastErr = err
    }
    await delay(input.retryDelayMs * (attempt + 1), input.signal)
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError'
}

async function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (ms <= 0) return
  if (signal?.aborted) throw abortError()
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function abortError(): Error {
  const err = new Error('aborted')
  err.name = 'AbortError'
  return err
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
  model: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal | undefined,
  onTextDelta: (delta: string) => void,
  weightVersion: string | undefined,
): Promise<LLMResponse> {
  const startedAt = performance.now()
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
  }).catch((err: unknown) => wrapProviderFetchError('Anthropic', apiUrl, err))
  if (!res.ok || !res.body) {
    const detail = await safeText(res)
    throw new AnthropicHTTPError(res.status, detail, apiUrl)
  }

  const blocks: AnthropicBlock[] = []
  const toolInputBuf: string[] = []
  let inputTokens = 0
  let outputTokens = 0
  let cacheCreationTokens = 0
  let cacheReadTokens = 0
  let streamMessageId: string | undefined
  let finishReason: string | undefined
  const streamEventTypes: string[] = []

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let firstChunkAt: number | undefined

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
      if (typeof evt.type === 'string') streamEventTypes.push(evt.type)
      if (evt.type === 'message_start' && !streamMessageId) {
        const msg = evt.message as { id?: string } | undefined
        if (msg && typeof msg.id === 'string') streamMessageId = msg.id
      }
      handleStreamEvent(
        evt,
        blocks,
        toolInputBuf,
        (text) => {
          firstChunkAt ??= performance.now()
          onTextDelta(text)
        },
        () => {
          firstChunkAt ??= performance.now()
        },
        (u) => {
          inputTokens += u.input
          outputTokens += u.output
          cacheCreationTokens += u.cacheCreation
          cacheReadTokens += u.cacheRead
        },
        (reason) => {
          finishReason = reason
        },
      )
    }
  }

  const content = normalizeAnthropicBlocks({ blocks, finishReason }).content
  const message: Message = { role: 'assistant', content }
  const usage =
    inputTokens > 0 ||
    outputTokens > 0 ||
    cacheCreationTokens > 0 ||
    cacheReadTokens > 0
      ? { inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens }
      : undefined
  return {
    message,
    usage,
    ...(finishReason ? { finishReason } : {}),
    trace: makeAnthropicTrace(apiUrl, model, body, {
      status: res.status,
      ...(finishReason ? { finishReason } : {}),
      streamEventTypes,
      metrics: streamMetrics(startedAt, firstChunkAt),
      body: {
        role: 'assistant',
        content: blocks,
        ...(finishReason ? { stop_reason: finishReason } : {}),
        usage: {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          cache_creation_input_tokens: cacheCreationTokens,
          cache_read_input_tokens: cacheReadTokens,
        },
      },
    }, {
      gatewayRequestId: extractAnthropicRequestId(res.headers, streamMessageId),
      ...(weightVersion ? { weightVersion } : {}),
    }),
  }
}

function streamMetrics(startedAt: number, firstChunkAt: number | undefined): NonNullable<NonNullable<LLMTrace['response']>['metrics']> {
  const finishedAt = performance.now()
  return {
    durationMs: Math.max(0, Math.round(finishedAt - startedAt)),
    ...(firstChunkAt !== undefined ? { timeToFirstChunkMs: Math.max(0, Math.round(firstChunkAt - startedAt)) } : {}),
  }
}

function makeAnthropicTrace(
  apiUrl: string,
  model: string,
  body: Record<string, unknown>,
  response: NonNullable<LLMTrace['response']>,
  meta?: { gatewayRequestId?: string; weightVersion?: string },
): LLMTrace {
  return {
    provider: 'anthropic',
    model,
    request: {
      url: apiUrl,
      headers: {
        'content-type': 'application/json',
        'anthropic-version': ANTHROPIC_VERSION,
        'x-api-key': 'test-redacted-api-key',
      },
      body,
    },
    response,
    ...(meta?.gatewayRequestId ? { gatewayRequestId: meta.gatewayRequestId } : {}),
    ...(meta?.weightVersion ? { weightVersion: meta.weightVersion } : {}),
  }
}

/**
 * Prefer the HTTP `request-id` header (Anthropic returns one on both
 * streaming and non-streaming responses). Fall back to the message body's
 * `id` for non-streaming responses, or to a captured `message_start.id` for
 * streaming responses. Undefined when nothing was returned (e.g. offline
 * fixtures).
 */
function extractAnthropicRequestId(
  headers: Headers,
  bodyOrStreamId: AnthropicResponseBody | string | undefined,
): string | undefined {
  const header = headers.get('request-id') ?? headers.get('x-request-id')
  if (header) return header
  if (typeof bodyOrStreamId === 'string') return bodyOrStreamId || undefined
  return bodyOrStreamId?.id
}

function handleStreamEvent(
  evt: Record<string, unknown>,
  blocks: AnthropicBlock[],
  toolBuf: string[],
  onText: (t: string) => void,
  onFirstNonTextChunk: () => void,
  onUsage: (u: {
    input: number
    output: number
    cacheCreation: number
    cacheRead: number
  }) => void,
  onFinishReason: (reason: string) => void,
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
      onFirstNonTextChunk()
      toolBuf[idx] = (toolBuf[idx] ?? '') + ((delta.partial_json as string) ?? '')
    } else if (dtype === 'thinking_delta' && target.type === 'thinking') {
      onFirstNonTextChunk()
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
    const delta = (evt.delta as Record<string, unknown> | undefined) ?? {}
    const finishReason =
      typeof delta.stop_reason === 'string'
        ? delta.stop_reason
        : typeof evt.stop_reason === 'string'
          ? evt.stop_reason
          : undefined
    if (finishReason) onFinishReason(finishReason)
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

export class AnthropicHTTPError extends ProviderHTTPError {
  constructor(
    readonly status: number,
    readonly bodyText: string,
    readonly endpoint = 'Anthropic endpoint',
  ) {
    super({ provider: 'Anthropic', endpoint, status, bodyText })
    this.name = 'AnthropicHTTPError'
  }
}

function parseResponse(body: AnthropicResponseBody): LLMResponse {
  const content = normalizeAnthropicBlocks({ blocks: body.content, finishReason: body.stop_reason }).content
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
  return {
    message,
    usage,
    ...(body.stop_reason ? { finishReason: body.stop_reason } : {}),
  }
}

function numOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text()
  } catch {
    return ''
  }
}
