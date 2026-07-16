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
      const response = parsePolicyResponse(json, params.tools)
      let promptIds = extractPromptIds(json, body)
      let outputIds = extractOutputIds(json)
      if (promptIds.length === 0 || outputIds.length === 0) {
        const renderedPrompt = renderChatPromptForTokenize(params)
        const outputText = reconstructOutputTextFromLogprobs(json) || extractText(response.message.content)
        const [pIds, oIds] = await Promise.all([
          promptIds.length === 0 ? tokenizeViaSglang(fetcher, baseUrl, renderedPrompt, params.signal) : Promise.resolve(promptIds),
          outputIds.length === 0 && outputText ? tokenizeViaSglang(fetcher, baseUrl, outputText, params.signal) : Promise.resolve(outputIds),
        ])
        promptIds = pIds
        outputIds = oIds
      }
      if (promptIds.length > 0 && outputIds.length > 0) {
        const outputLogProbsAligned = response.outputLogProbs && response.outputLogProbs.length === outputIds.length
          ? response.outputLogProbs
          : undefined
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
            ...(outputLogProbsAligned ? { outputLogProbs: outputLogProbsAligned } : {}),
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
        response: { status: res.status, ...(response.finishReason ? { finishReason: response.finishReason } : {}), body: json },
        gatewayRequestId: res.headers.get('x-request-id') ?? undefined,
        ...(opts.weightVersion ? { weightVersion: opts.weightVersion } : {}),
      }
      return { message: response.message, usage: response.usage, ...(response.finishReason ? { finishReason: response.finishReason } : {}), trace }
}

async function callNativeGenerate(input: { opts: PolicyGatewayOptions; params: LLMCallParams; fetcher: typeof fetch; baseUrl: string }): Promise<LLMResponse> {
  const { opts, params, fetcher, baseUrl } = input
  const endpoint = `${baseUrl}/generate`
  const prompt = renderNativePromptWithTools(params)
  const body: Record<string, unknown> = {
    text: prompt,
    sampling_params: {
      temperature: 0,
      max_new_tokens: opts.maxNewTokens ?? 512,
      stop: ['<|im_end|>', '<|endoftext|>'],
    },
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
  const message = buildAssistantMessageFromNativeText(outputText, params.tools)
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
    response: { status: res.status, ...(json.meta_info?.finish_reason ? { finishReason: formatNativeFinishReason(json.meta_info.finish_reason) } : {}), body: json },
    gatewayRequestId: res.headers.get('x-request-id') ?? undefined,
    ...(opts.weightVersion ? { weightVersion: opts.weightVersion } : {}),
  }
  const finishReason = json.meta_info?.finish_reason ? formatNativeFinishReason(json.meta_info.finish_reason) : undefined
  return {
    message,
    usage: { inputTokens: json.meta_info?.prompt_tokens ?? promptIds.length, outputTokens: json.meta_info?.completion_tokens ?? outputIds.length },
    ...(finishReason ? { finishReason } : {}),
    trace,
  }
}

async function toOpenAICompatibleBody(params: LLMCallParams, model: string): Promise<Record<string, unknown>> {
  const messages: unknown[] = []
  if (params.systemPrompt) messages.push({ role: 'system', content: params.systemPrompt })
  for (const message of params.messages) messages.push(...toOpenAIMessages(message))
  const body: Record<string, unknown> = { model, messages, max_tokens: 1024 }
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

function parsePolicyResponse(body: ChatCompletionBody, tools: readonly ToolSchema[] = []): LLMResponse & { outputLogProbs?: number[]; finishReason?: string } {
  const choice = body.choices?.[0]
  if (!choice?.message) throw new Error('policy gateway response has no choice message')
  const content: MessageContent[] = []
  const rawContent = choice.message.content ?? ''
  const parserToolCalls = choice.message.tool_calls ?? []
  let residualText = rawContent
  if (parserToolCalls.length === 0 && rawContent) {
    const toolNames = new Set(tools.map((t) => t.name))
    const lifted = liftJsonToolCallsFromContent(rawContent, toolNames)
    if (lifted.toolCalls.length > 0) {
      residualText = lifted.residualText
      for (const tc of lifted.toolCalls) {
        content.push({ type: 'tool_call', callId: `lifted_${Date.now()}_${content.length}`, name: tc.name, input: tc.arguments })
      }
    }
  }
  if (residualText) content.unshift({ type: 'text', text: residualText })
  for (const tool of parserToolCalls) {
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

function renderNativePromptWithTools(params: LLMCallParams): string {
  const parts: string[] = []
  const systemSegments: string[] = []
  if (params.systemPrompt) systemSegments.push(params.systemPrompt)
  if (params.tools.length > 0) {
    const toolLines = params.tools.map((t) => `- ${t.name}: ${t.description} | schema: ${JSON.stringify(t.inputSchema)}`)
    systemSegments.push(
      [
        '# Tools',
        'You have access to the following tools. To call a tool, emit EXACTLY:',
        '<tool_call>',
        '{"name": "<tool_name>", "arguments": <json_args>}',
        '</tool_call>',
        '',
        'Available tools:',
        ...toolLines,
      ].join('\n'),
    )
  }
  if (systemSegments.length > 0) parts.push(`<|im_start|>system\n${systemSegments.join('\n\n')}<|im_end|>`)
  for (const message of params.messages) {
    if (message.role === 'system') {
      parts.push(`<|im_start|>system\n${extractText(message.content)}<|im_end|>`)
      continue
    }
    if (message.role === 'tool') {
      for (const c of message.content) {
        if (c.type === 'tool_result') {
          parts.push(`<|im_start|>user\n<tool_response>\n${c.content}\n</tool_response><|im_end|>`)
        }
      }
      continue
    }
    if (message.role === 'assistant') {
      const chunks: string[] = []
      for (const c of message.content) {
        if (c.type === 'text' && c.text) chunks.push(c.text)
        else if (c.type === 'tool_call') {
          chunks.push(`<tool_call>\n${JSON.stringify({ name: c.name, arguments: c.input })}\n</tool_call>`)
        }
      }
      parts.push(`<|im_start|>assistant\n${chunks.join('\n')}<|im_end|>`)
      continue
    }
    parts.push(`<|im_start|>${message.role}\n${extractText(message.content)}<|im_end|>`)
  }
  parts.push('<|im_start|>assistant\n')
  return parts.join('\n')
}

function buildAssistantMessageFromNativeText(outputText: string, tools: readonly ToolSchema[]): Message {
  const content: MessageContent[] = []
  const toolNames = new Set(tools.map((t) => t.name))
  const lifted = liftJsonToolCallsFromContent(outputText, toolNames)
  const residual = lifted.residualText.replace(/<\|im_end\|>\s*$/u, '').trim()
  if (residual) content.push({ type: 'text', text: residual })
  for (const tc of lifted.toolCalls) {
    content.push({ type: 'tool_call', callId: `native_${Date.now()}_${content.length}`, name: tc.name, input: tc.arguments })
  }
  return { role: 'assistant', content }
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

function reconstructOutputTextFromLogprobs(body: ChatCompletionBody): string {
  const items = body.choices?.[0]?.logprobs?.content ?? []
  if (items.length === 0) return ''
  const chunks: number[] = []
  for (const item of items) {
    if (Array.isArray(item.bytes)) {
      for (const b of item.bytes) chunks.push(b)
    } else if (typeof item.token === 'string') {
      for (const c of Buffer.from(item.token, 'utf-8')) chunks.push(c)
    }
  }
  return Buffer.from(chunks).toString('utf-8')
}

async function tokenizeViaSglang(fetcher: typeof fetch, baseUrl: string, text: string, signal: AbortSignal | undefined): Promise<number[]> {
  if (!text) return []
  try {
    const res = await fetcher(`${baseUrl}/tokenize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: text }),
      signal,
    })
    if (!res.ok) return []
    const json = await res.json() as { tokens?: number[]; input_ids?: number[]; token_ids?: number[] }
    const ids = json.tokens ?? json.input_ids ?? json.token_ids ?? []
    return Array.isArray(ids) && ids.every(isNonNegativeInt) ? ids : []
  } catch {
    return []
  }
}

function renderChatPromptForTokenize(params: LLMCallParams): string {
  const parts: string[] = []
  if (params.systemPrompt) parts.push(`<|im_start|>system\n${params.systemPrompt}<|im_end|>`)
  for (const message of params.messages) {
    const text = extractText(message.content)
    parts.push(`<|im_start|>${message.role}\n${text}<|im_end|>`)
  }
  parts.push('<|im_start|>assistant\n')
  return parts.join('\n')
}

type LiftedCall = { name: string; arguments: Record<string, unknown> }

export function liftJsonToolCallsFromContent(content: string, toolNames: Set<string>): { toolCalls: LiftedCall[]; residualText: string } {
  const toolCalls: LiftedCall[] = []
  let residual = content
  const patterns: RegExp[] = [
    /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g,
    /```(?:json|tool_call)?\s*(\{[\s\S]*?\})\s*```/g,
  ]
  for (const re of patterns) {
    residual = residual.replace(re, (_full, jsonStr: string) => {
      const parsed = tryParseToolCall(jsonStr, toolNames)
      if (parsed) { toolCalls.push(parsed); return '' }
      return _full
    })
  }
  const bareMatch = extractBareJsonToolCall(residual, toolNames)
  if (bareMatch) {
    toolCalls.push(bareMatch.call)
    residual = residual.slice(0, bareMatch.start) + residual.slice(bareMatch.end)
  }
  return { toolCalls, residualText: residual.trim() }
}

function tryParseToolCall(raw: string, toolNames: Set<string>): LiftedCall | null {
  let obj: unknown
  try { obj = JSON.parse(raw) } catch { return null }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null
  const record = obj as Record<string, unknown>
  const name = typeof record.name === 'string' ? record.name : null
  if (!name) return null
  if (toolNames.size > 0 && !toolNames.has(name)) return null
  const args = record.arguments ?? record.parameters ?? {}
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    return { name, arguments: args as Record<string, unknown> }
  }
  if (typeof args === 'string') {
    try {
      const parsed = JSON.parse(args) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { name, arguments: parsed as Record<string, unknown> }
      }
    } catch { /* ignore */ }
  }
  return { name, arguments: {} }
}

function extractBareJsonToolCall(text: string, toolNames: Set<string>): { call: LiftedCall; start: number; end: number } | null {
  const start = text.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escape = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escape) escape = false
      else if (ch === '\\') escape = true
      else if (ch === '"') inString = false
    } else {
      if (ch === '"') inString = true
      else if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) {
          const candidate = text.slice(start, i + 1)
          const parsed = tryParseToolCall(candidate, toolNames)
          if (parsed) return { call: parsed, start, end: i + 1 }
          return null
        }
      }
    }
  }
  return null
}
