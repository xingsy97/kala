import { createHash } from 'node:crypto'

import type { Message, MessageContent, ToolSchema } from '@agent-kernel/kernel'
import type { LLMTrace } from '@agent-kernel/shared'

import type { LLMAdapter, LLMCallParams, LLMResponse } from './adapter.js'
import { writeTokenCaptureArtifact } from '../rl/token-capture.js'

export type PolicyGatewayOptions = {
  baseUrl: string
  artifactRoot: string
  model: string
  tokenizerPath?: string
  chatTemplate?: string
  endpoint?: 'native-generate' | 'chat-completions'
  maxNewTokens?: number
  rolloutId?: string
  sessionId?: string
  routeKey?: string
  weightVersion?: string
  requireLogprobs?: boolean
  fetchImpl?: typeof fetch
}

type ChatCompletionBody = {
  choices?: Array<{
    message?: {
      content?: string | null
      tool_calls?: Array<{
        id: string
        type: 'function'
        function: { name: string; arguments: string }
      }>
    }
    finish_reason?: string
    logprobs?: {
      content?: Array<{
        token?: string
        logprob?: number
        bytes?: number[]
        token_id?: number
        id?: number
      }>
    }
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
  }
  prompt_token_ids?: number[]
  input_ids?: number[]
  meta_info?: {
    prompt_tokens?: number[]
    prompt_token_ids?: number[]
    output_token_ids?: number[]
  }
}

type NativeGenerateBody = {
  text?: string
  output_ids?: number[]
  meta_info?: {
    finish_reason?: string | { type?: string; length?: number }
    prompt_tokens?: number
    completion_tokens?: number
    weight_version?: string
    input_token_logprobs?: Array<[number | null, number, unknown]>
    output_token_logprobs?: Array<[number | null, number, unknown]>
  }
}

export function policyGatewayAdapter(opts: PolicyGatewayOptions): LLMAdapter {
  const fetcher = opts.fetchImpl ?? fetch
  const baseUrl = opts.baseUrl.replace(/\/+$/u, '')
  const endpointMode = opts.endpoint ?? 'native-generate'
  return {
    name: `policy-gateway:${opts.model}`,
    async call(params: LLMCallParams): Promise<LLMResponse> {
      if (endpointMode === 'native-generate') return callNativeGenerate({ opts, params, fetcher, baseUrl })
      return callChatCompletions({ opts, params, fetcher, baseUrl })
    },
  }
}

async function callChatCompletions(input: { opts: PolicyGatewayOptions; params: LLMCallParams; fetcher: typeof fetch; baseUrl: string }): Promise<LLMResponse> {
  const { opts, params, fetcher, baseUrl } = input
  const endpoint = `${baseUrl}/v1/chat/completions`
      const body = await toOpenAICompatibleBody(params, opts.model)
      body.logprobs = true
      body.top_logprobs = 0
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      if (opts.routeKey) headers['X-SMG-Routing-Key'] = opts.routeKey
      const res = await fetcher(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: params.signal,
      })
      const text = await res.text()
      if (!res.ok) throw new Error(`policy gateway HTTP ${res.status}: ${text.slice(0, 300)}`)
      const json = JSON.parse(text) as ChatCompletionBody
      const response = parsePolicyResponse(json)
      const promptIds = extractPromptIds(json, body)
      const outputIds = extractOutputIds(json)
      if (promptIds.length > 0 && outputIds.length > 0) {
        await writeTokenCaptureArtifact({
          rootDir: opts.artifactRoot,
          requireLogprobs: opts.requireLogprobs,
          capture: {
            rolloutId: opts.rolloutId ?? opts.sessionId ?? 'rollout-unknown',
            sessionId: opts.sessionId ?? 'session-unknown',
            callId: `llm_${Date.now()}`,
            provider: 'policy-gateway',
            backend: 'sglang',
            model: params.model ?? opts.model,
            tokenizer: {
              nameOrPath: opts.tokenizerPath ?? opts.model,
              chatTemplateHash: createHash('sha256').update(opts.chatTemplate ?? '').digest('hex'),
            },
            ...(opts.routeKey ? { routeKey: opts.routeKey } : {}),
            ...(opts.weightVersion ? { weightVersion: opts.weightVersion } : {}),
            promptIds,
            outputIds,
            ...(response.outputLogProbs ? { outputLogProbs: response.outputLogProbs } : {}),
            responseMask: outputIds.map(() => 1),
            ...(response.finishReason ? { finishReason: response.finishReason } : {}),
            usage: {
              promptTokens: json.usage?.prompt_tokens ?? promptIds.length,
              completionTokens: json.usage?.completion_tokens ?? outputIds.length,
            },
          },
        })
      } else if (opts.requireLogprobs) {
        throw new Error('policy gateway response did not include token ids required for training')
      }
      const trace: LLMTrace = {
        provider: 'openai',
        model: params.model ?? opts.model,
        request: { url: endpoint, headers, body },
        response: { status: res.status, body: json },
        gatewayRequestId: res.headers.get('x-request-id') ?? undefined,
        ...(opts.weightVersion ? { weightVersion: opts.weightVersion } : {}),
      }
      return { message: response.message, usage: response.usage, trace }
}

async function callNativeGenerate(input: { opts: PolicyGatewayOptions; params: LLMCallParams; fetcher: typeof fetch; baseUrl: string }): Promise<LLMResponse> {
  const { opts, params, fetcher, baseUrl } = input
  if (params.tools.length > 0) {
    throw new Error('policy gateway native-generate endpoint does not support tool schemas; use chat-completions for non-training tool calls')
  }
  const endpoint = `${baseUrl}/generate`
  const prompt = renderNativePrompt(params)
  const body: Record<string, unknown> = {
    text: prompt,
    sampling_params: { temperature: 0, max_new_tokens: opts.maxNewTokens ?? 256 },
    return_logprob: true,
    logprob_start_len: 0,
    top_logprobs_num: 0,
  }
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (opts.routeKey) headers['X-SMG-Routing-Key'] = opts.routeKey
  const res = await fetcher(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: params.signal,
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`policy gateway HTTP ${res.status}: ${text.slice(0, 300)}`)
  const json = JSON.parse(text) as NativeGenerateBody
  const outputText = json.text ?? ''
  const promptIds = extractNativePromptIds(json)
  const outputIds = extractNativeOutputIds(json)
  const outputLogProbs = extractNativeOutputLogProbs(json)
  if (promptIds.length > 0 && outputIds.length > 0) {
    await writeTokenCaptureArtifact({
      rootDir: opts.artifactRoot,
      requireLogprobs: opts.requireLogprobs,
      capture: {
        rolloutId: opts.rolloutId ?? opts.sessionId ?? 'rollout-unknown',
        sessionId: opts.sessionId ?? 'session-unknown',
        callId: `llm_${Date.now()}`,
        provider: 'policy-gateway',
        backend: 'sglang',
        model: params.model ?? opts.model,
        tokenizer: {
          nameOrPath: opts.tokenizerPath ?? opts.model,
          chatTemplateHash: createHash('sha256').update(opts.chatTemplate ?? 'native-generate-v1').digest('hex'),
        },
        ...(opts.routeKey ? { routeKey: opts.routeKey } : {}),
        ...(opts.weightVersion ?? json.meta_info?.weight_version ? { weightVersion: opts.weightVersion ?? json.meta_info?.weight_version } : {}),
        promptIds,
        outputIds,
        ...(outputLogProbs.length > 0 ? { outputLogProbs } : {}),
        responseMask: outputIds.map(() => 1),
        ...(json.meta_info?.finish_reason ? { finishReason: formatNativeFinishReason(json.meta_info.finish_reason) } : {}),
        usage: {
          promptTokens: json.meta_info?.prompt_tokens ?? promptIds.length,
          completionTokens: json.meta_info?.completion_tokens ?? outputIds.length,
        },
      },
    })
  } else if (opts.requireLogprobs) {
    throw new Error('policy gateway native generate response did not include token ids required for training')
  }
  const trace: LLMTrace = {
    provider: 'openai',
    model: params.model ?? opts.model,
    request: { url: endpoint, headers, body },
    response: { status: res.status, body: json },
    gatewayRequestId: res.headers.get('x-request-id') ?? undefined,
    ...(opts.weightVersion ? { weightVersion: opts.weightVersion } : {}),
  }
  return {
    message: { role: 'assistant', content: outputText ? [{ type: 'text', text: outputText }] : [] },
    usage: { inputTokens: json.meta_info?.prompt_tokens ?? promptIds.length, outputTokens: json.meta_info?.completion_tokens ?? outputIds.length },
    trace,
  }
}

async function toOpenAICompatibleBody(params: LLMCallParams, model: string): Promise<Record<string, unknown>> {
  const messages: unknown[] = []
  if (params.systemPrompt) messages.push({ role: 'system', content: params.systemPrompt })
  for (const message of params.messages) messages.push(...toOpenAIMessages(message))
  const body: Record<string, unknown> = { model, messages, max_tokens: 4096 }
  if (params.tools.length > 0) {
    body.tools = params.tools.map(toOpenAITool)
    body.tool_choice = 'auto'
  }
  return body
}

function toOpenAIMessages(message: Message): unknown[] {
  if (message.role === 'tool') {
    return message.content
      .filter((content): content is Extract<MessageContent, { type: 'tool_result' }> => content.type === 'tool_result')
      .map((content) => ({ role: 'tool', tool_call_id: content.callId, content: content.content }))
  }
  if (message.role === 'assistant') {
    const toolCalls = message.content
      .filter((content): content is Extract<MessageContent, { type: 'tool_call' }> => content.type === 'tool_call')
      .map((content) => ({ id: content.callId, type: 'function', function: { name: content.name, arguments: JSON.stringify(content.input) } }))
    return [{ role: 'assistant', content: extractText(message.content) || null, ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}) }]
  }
  return [{ role: message.role, content: extractText(message.content) }]
}

function toOpenAITool(tool: ToolSchema): Record<string, unknown> {
  return { type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } }
}

function parsePolicyResponse(body: ChatCompletionBody): LLMResponse & { outputLogProbs?: number[]; finishReason?: string } {
  const choice = body.choices?.[0]
  if (!choice?.message) throw new Error('policy gateway response has no choice message')
  const content: MessageContent[] = []
  if (choice.message.content) content.push({ type: 'text', text: choice.message.content })
  for (const tool of choice.message.tool_calls ?? []) {
    content.push({ type: 'tool_call', callId: tool.id, name: tool.function.name, input: parseArgs(tool.function.arguments) })
  }
  return {
    message: { role: 'assistant', content },
    usage: body.usage ? { inputTokens: body.usage.prompt_tokens ?? 0, outputTokens: body.usage.completion_tokens ?? 0 } : undefined,
    outputLogProbs: choice.logprobs?.content?.map((item) => item.logprob ?? Number.NaN).filter(Number.isFinite),
    finishReason: choice.finish_reason,
  }
}

function extractPromptIds(body: ChatCompletionBody, _requestBody: Record<string, unknown>): number[] {
  const fromBody = body.prompt_token_ids ?? body.input_ids ?? body.meta_info?.prompt_token_ids ?? body.meta_info?.prompt_tokens
  if (Array.isArray(fromBody) && fromBody.every(isNonNegativeInt)) return fromBody
  return []
}

function extractOutputIds(body: ChatCompletionBody): number[] {
  const fromMeta = body.meta_info?.output_token_ids
  if (Array.isArray(fromMeta) && fromMeta.every(isNonNegativeInt)) return fromMeta
  const items = body.choices?.[0]?.logprobs?.content ?? []
  const ids = items.map((item) => item.token_id ?? item.id).filter(isNonNegativeInt)
  if (ids.length === items.length && ids.length > 0) return ids
  return []
}

function renderNativePrompt(params: LLMCallParams): string {
  const lines: string[] = []
  if (params.systemPrompt) lines.push(`System: ${params.systemPrompt}`)
  for (const message of params.messages) {
    const text = extractText(message.content)
    if (text) lines.push(`${message.role[0]!.toUpperCase()}${message.role.slice(1)}: ${text}`)
  }
  lines.push('Assistant:')
  return lines.join('\n')
}

function extractNativePromptIds(body: NativeGenerateBody): number[] {
  const items = body.meta_info?.input_token_logprobs ?? []
  const ids = items.map((item) => item[1]).filter(isNonNegativeInt)
  return ids.length === items.length ? ids : []
}

function extractNativeOutputIds(body: NativeGenerateBody): number[] {
  if (Array.isArray(body.output_ids) && body.output_ids.every(isNonNegativeInt)) return body.output_ids
  const items = body.meta_info?.output_token_logprobs ?? []
  const ids = items.map((item) => item[1]).filter(isNonNegativeInt)
  return ids.length === items.length ? ids : []
}

function extractNativeOutputLogProbs(body: NativeGenerateBody): number[] {
  const items = body.meta_info?.output_token_logprobs ?? []
  const logprobs = items.map((item) => item[0]).filter((item): item is number => typeof item === 'number' && Number.isFinite(item))
  return logprobs.length === items.length ? logprobs : []
}

function formatNativeFinishReason(value: NonNullable<NativeGenerateBody['meta_info']>['finish_reason']): string {
  return typeof value === 'string' ? value : value?.type ?? 'unknown'
}

function extractText(content: readonly MessageContent[]): string {
  return content.map((item) => (item.type === 'text' ? item.text : '')).join('')
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}
