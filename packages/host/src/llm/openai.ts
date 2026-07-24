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

import type {
  Message,
  MessageContent,
} from '@agent-kernel/kernel'
import type { LLMTrace } from '@agent-kernel/shared'

import type { LLMAdapter, LLMCallParams, LLMResponse } from './adapter.js'
import { ProviderHTTPError, wrapProviderFetchError } from './provider-error.js'
import { buildOpenAIRequestBody } from './provider-request-builder.js'
import type { OpenAIToolCall } from './provider-request-builder.js'
import { parseSseJson, readSseStream } from './streaming/sse.js'
import { normalizeOpenAIToolCalls, parseToolArguments } from '../tools/tool-call-normalizer.js'

export type OpenAIOptions = {
  apiKey: string
  model?: string
  maxTokens?: number
  baseUrl?: string
  fetchImpl?: typeof fetch
  /**
   * Optional model weight version to stamp on every trace. Local gateways
   * (SGLang, vLLM) or A/B configs can set this so rollout capture and eval
   * comparisons can pin generations to a specific policy checkpoint.
   */
  weightVersion?: string
}

const DEFAULT_MODEL = 'gpt-4o-mini'
const DEFAULT_BASE_URL = 'https://api.openai.com/v1'

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

export function openaiAdapter(opts: OpenAIOptions): LLMAdapter {
  const fetchImpl = opts.fetchImpl ?? fetch
  const model = opts.model ?? DEFAULT_MODEL
  const maxTokens = opts.maxTokens
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '')
  const url = `${baseUrl}/chat/completions`
  const weightVersion = opts.weightVersion

  return {
    name: `openai:${model}`,
    async call(params: LLMCallParams): Promise<LLMResponse> {
      const effectiveModel = params.model ?? model
      const { body } = await buildOpenAIRequestBody(params, effectiveModel, maxTokens)
      if (params.onTextDelta) {
        body.stream = true
        body.stream_options = { include_usage: true }
        return await callStreaming(
          url,
          opts.apiKey,
          body,
          effectiveModel,
          fetchImpl,
          params.signal,
          params.onTextDelta,
          weightVersion,
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
      }).catch((err: unknown) => wrapProviderFetchError('OpenAI', url, err))
      if (!res.ok) {
        const detail = await safeText(res)
        throw new OpenAIHTTPError(res.status, detail, url)
      }
      const json = (await res.json()) as OpenAIResponseBody
      const parsed = parseResponse(json)
      return {
        ...parsed,
        trace: makeOpenAITrace(url, effectiveModel, body, {
          status: res.status,
          ...(parsed.finishReason ? { finishReason: parsed.finishReason } : {}),
          body: json,
        }, {
          gatewayRequestId: extractOpenAIRequestId(res.headers, json),
          ...(weightVersion ? { weightVersion } : {}),
        }),
      }
    },
  }
}

/**
 * OpenAI Chat Completions streaming spec: SSE where each `data:` line is a
 * JSON object holding `choices[0].delta`. The stream ends with `data: [DONE]`.
 * Deltas we care about:
 *   - `delta.content` → text token
 *   - `delta.tool_calls[]` → each entry has index + partial function.name /
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
  model: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal | undefined,
  onTextDelta: (delta: string) => void,
  weightVersion: string | undefined,
): Promise<LLMResponse> {
  const startedAt = performance.now()
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
      accept: 'text/event-stream',
    },
    body: JSON.stringify(body),
    signal,
  }).catch((err: unknown) => wrapProviderFetchError('OpenAI', url, err))
  if (!res.ok || !res.body) {
    const detail = await safeText(res)
    throw new OpenAIHTTPError(res.status, detail, url)
  }

  let textBuf = ''
  const toolCalls = new Map<number, StreamedToolCall>()
  let promptTokens = 0
  let completionTokens = 0
  let cachedTokens = 0
  let streamChatId: string | undefined
  let finishReason: string | undefined
  const streamEventTypes: string[] = []
  let firstChunkAt: number | undefined

  await readSseStream(res.body, ({ data: payload }) => {
    if (payload === '[DONE]') return
    const evt = parseSseJson<{
        id?: string
        choices?: Array<{
          finish_reason?: string
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
      }>(payload)
    if (!evt) return
    streamEventTypes.push('chat.completion.chunk')
    if (!streamChatId && typeof evt.id === 'string' && evt.id) streamChatId = evt.id
    const choice = evt.choices?.[0]
    if (typeof choice?.finish_reason === 'string') finishReason = choice.finish_reason
    const delta = choice?.delta
    if (delta?.content) {
      firstChunkAt ??= performance.now()
      textBuf += delta.content
      onTextDelta(delta.content)
    }
    if (delta?.tool_calls) {
      firstChunkAt ??= performance.now()
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
  })

  const content: MessageContent[] = []
  if (textBuf.length > 0) content.push({ type: 'text', text: textBuf })
  const indices = [...toolCalls.keys()].sort((a, b) => a - b)
  for (const idx of indices) {
    const tc = toolCalls.get(idx)!
    const parsed = parseToolArguments('openai', tc.id, tc.name, tc.argsBuf)
    content.push({
      type: 'tool_call',
      callId: tc.id,
      name: tc.name,
      input: parsed.input,
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
  return {
    message,
    usage,
    ...(finishReason ? { finishReason } : {}),
    trace: makeOpenAITrace(url, model, body, {
      status: res.status,
      ...(finishReason ? { finishReason } : {}),
      streamEventTypes,
      metrics: streamMetrics(startedAt, firstChunkAt),
      body: {
        role: 'assistant',
        content: textBuf.length > 0 ? textBuf : null,
        tool_calls: indices.map((idx) => {
          const tc = toolCalls.get(idx)!
          return {
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: tc.argsBuf },
          }
        }),
      },
    }, {
      gatewayRequestId: extractOpenAIRequestId(res.headers, streamChatId),
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

function makeOpenAITrace(
  url: string,
  model: string,
  body: Record<string, unknown>,
  response: NonNullable<LLMTrace['response']>,
  meta?: { gatewayRequestId?: string; weightVersion?: string },
): LLMTrace {
  return {
    provider: 'openai',
    model,
    request: {
      url,
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer test-redacted-api-key',
      },
      body,
    },
    response,
    ...(meta?.gatewayRequestId ? { gatewayRequestId: meta.gatewayRequestId } : {}),
    ...(meta?.weightVersion ? { weightVersion: meta.weightVersion } : {}),
  }
}

/**
 * OpenAI returns `x-request-id`; OpenAI-compatible gateways (SGLang, vLLM,
 * newapi) may return the same header or `openai-request-id`. Fall back to the
 * response body / streaming chunk `id`. Undefined when nothing was returned.
 */
function extractOpenAIRequestId(
  headers: Headers,
  bodyOrStreamId: OpenAIResponseBody | string | undefined,
): string | undefined {
  const header =
    headers.get('x-request-id') ??
    headers.get('openai-request-id') ??
    headers.get('request-id')
  if (header) return header
  if (typeof bodyOrStreamId === 'string') return bodyOrStreamId || undefined
  return bodyOrStreamId?.id
}

export class OpenAIHTTPError extends ProviderHTTPError {
  constructor(
    readonly status: number,
    readonly bodyText: string,
    readonly endpoint = 'OpenAI-compatible endpoint',
  ) {
    super({ provider: 'OpenAI', endpoint, status, bodyText })
    this.name = 'OpenAIHTTPError'
  }
}

function parseResponse(body: OpenAIResponseBody): LLMResponse {
  const choice = body.choices[0]
  if (!choice) throw new Error('OpenAI response has no choices')
  const raw = choice.message
  const normalized = normalizeOpenAIToolCalls({ rawText: raw.content, rawToolCalls: raw.tool_calls, finishReason: choice.finish_reason })
  const content = normalized.content
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
  return {
    message,
    usage,
    ...(choice.finish_reason ? { finishReason: choice.finish_reason } : {}),
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
