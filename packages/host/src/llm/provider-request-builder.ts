import { readFile } from 'node:fs/promises'

import type { ImageContent, Message, MessageContent, ToolSchema } from '@agent-kernel/kernel'

import type { LLMCallParams } from './adapter.js'

export type OpenAIToolCall = {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

export type OpenAIUserContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export type OpenAIMessage =
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

export type AnthropicImageSource =
  | {
      type: 'base64'
      media_type: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
      data: string
    }
  | { type: 'url'; url: string }

export type AnthropicCacheControl = { type: 'ephemeral' }

export type AnthropicBlock =
  | { type: 'text'; text: string; cache_control?: AnthropicCacheControl }
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
      cache_control?: AnthropicCacheControl
    }
  | { type: 'image'; source: AnthropicImageSource; cache_control?: AnthropicCacheControl }
  | { type: 'thinking'; thinking: string; signature?: string }

export type AnthropicMessage = {
  role: 'user' | 'assistant'
  content: AnthropicBlock[]
}

export type ProviderRequestPlan = {
  provider: 'openai' | 'anthropic'
  model: string
  body: Record<string, unknown>
  omittedDefaults: readonly string[]
}

export async function buildOpenAIRequestBody(
  params: LLMCallParams,
  model: string,
  maxTokens: number | undefined,
): Promise<ProviderRequestPlan> {
  const { messages, tools, systemPrompt } = params
  const openaiMessages: OpenAIMessage[] = []
  if (systemPrompt) openaiMessages.push({ role: 'system', content: systemPrompt })
  for (const msg of messages) openaiMessages.push(...(await toOpenAI(msg)))
  const body: Record<string, unknown> = { model, messages: openaiMessages }
  const omittedDefaults: string[] = []
  if (maxTokens !== undefined) body.max_tokens = maxTokens
  else omittedDefaults.push('max_tokens')
  if (tools.length > 0) {
    body.tools = tools.map(toOpenAITool)
    body.tool_choice = 'auto'
  }
  return { provider: 'openai', model, body, omittedDefaults }
}

export async function buildAnthropicRequestBody(
  params: LLMCallParams,
  model: string,
  maxTokens: number | undefined,
  cache: boolean,
): Promise<ProviderRequestPlan> {
  const { messages, tools, systemPrompt } = params
  const resolvedSystem = systemPrompt ?? extractSystem(messages)
  const anthropicMessages = await Promise.all(messages.filter((m) => m.role !== 'system').map(toAnthropic))
  const body: Record<string, unknown> = { model, messages: anthropicMessages }
  const omittedDefaults: string[] = []
  if (maxTokens !== undefined) body.max_tokens = maxTokens
  else omittedDefaults.push('max_tokens')
  if (resolvedSystem) {
    body.system = cache
      ? [{ type: 'text', text: resolvedSystem, cache_control: { type: 'ephemeral' } }]
      : resolvedSystem
  }
  if (tools.length > 0) {
    const toolPayload = tools.map(toAnthropicTool)
    if (cache && toolPayload.length > 0) {
      const last = toolPayload[toolPayload.length - 1]!
      toolPayload[toolPayload.length - 1] = { ...last, cache_control: { type: 'ephemeral' } }
    }
    body.tools = toolPayload
  }
  if (cache) markLastUserBlockForCache(anthropicMessages)
  if (typeof params.thinkingBudget === 'number' && params.thinkingBudget > 0) {
    body.thinking = { type: 'enabled', budget_tokens: params.thinkingBudget }
  }
  return { provider: 'anthropic', model, body, omittedDefaults }
}

async function toOpenAI(msg: Message): Promise<OpenAIMessage[]> {
  if (msg.role === 'system') return [{ role: 'system', content: extractText(msg.content) }]
  if (msg.role === 'user') return [{ role: 'user', content: await toOpenAIUserContent(msg.content) }]
  if (msg.role === 'tool') {
    const out: OpenAIMessage[] = []
    for (const c of msg.content) {
      if (c.type === 'tool_result') out.push({ role: 'tool', tool_call_id: c.callId, content: c.content })
    }
    return out
  }
  const text = extractText(msg.content)
  const toolCalls = msg.content
    .filter((c): c is Extract<MessageContent, { type: 'tool_call' }> => c.type === 'tool_call')
    .map((c): OpenAIToolCall => ({
      id: c.callId,
      type: 'function',
      function: { name: c.name, arguments: JSON.stringify(c.input) },
    }))
  return [{ role: 'assistant', content: text.length > 0 ? text : null, ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}) }]
}

async function toOpenAIUserContent(content: readonly MessageContent[]): Promise<string | OpenAIUserContentBlock[]> {
  const hasImage = content.some((c) => c.type === 'image')
  if (!hasImage) return extractText(content)
  const blocks: OpenAIUserContentBlock[] = []
  for (const c of content) {
    if (c.type === 'text') blocks.push({ type: 'text', text: c.text })
    else if (c.type === 'image') blocks.push({ type: 'image_url', image_url: { url: await toDataUrl(c) } })
  }
  return blocks
}

async function toAnthropic(msg: Message): Promise<AnthropicMessage> {
  if (msg.role === 'tool') return { role: 'user', content: await Promise.all(msg.content.map(toAnthropicBlock)) }
  if (msg.role === 'assistant' || msg.role === 'user') return { role: msg.role, content: await Promise.all(msg.content.map(toAnthropicBlock)) }
  throw new Error(`Unexpected message role: ${msg.role}`)
}

async function toAnthropicBlock(content: MessageContent): Promise<AnthropicBlock> {
  switch (content.type) {
    case 'text':
      return { type: 'text', text: content.text }
    case 'tool_call':
      return { type: 'tool_use', id: content.callId, name: content.name, input: content.input }
    case 'tool_result':
      return { type: 'tool_result', tool_use_id: content.callId, content: content.content, is_error: !content.ok }
    case 'image':
      return { type: 'image', source: await toAnthropicImageSource(content) }
    case 'thinking':
      return { type: 'thinking', thinking: content.text, ...(content.signature ? { signature: content.signature } : {}) }
  }
}

function markLastUserBlockForCache(messages: AnthropicMessage[]): void {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!
    if (msg.role !== 'user') continue
    const last = msg.content[msg.content.length - 1]
    if (!last) return
    if (last.type === 'text' || last.type === 'tool_result' || last.type === 'image') last.cache_control = { type: 'ephemeral' }
    return
  }
}

function extractSystem(messages: readonly Message[]): string | undefined {
  const sys = messages.find((m) => m.role === 'system')
  if (!sys) return undefined
  return extractText(sys.content)
}

function extractText(content: readonly MessageContent[]): string {
  return content.map((c) => (c.type === 'text' ? c.text : '')).join('')
}

async function toDataUrl(content: ImageContent): Promise<string> {
  if (content.source.kind === 'base64') return `data:${content.source.mediaType};base64,${content.source.data}`
  const mediaType = content.source.mediaType ?? guessMediaType(content.source.path)
  const data = (await readFile(content.source.path)).toString('base64')
  return `data:${mediaType};base64,${data}`
}

async function toAnthropicImageSource(content: ImageContent): Promise<AnthropicImageSource> {
  if (content.source.kind === 'base64') return { type: 'base64', media_type: content.source.mediaType, data: content.source.data }
  const buf = await readFile(content.source.path)
  return { type: 'base64', media_type: content.source.mediaType ?? guessMediaType(content.source.path), data: buf.toString('base64') }
}

function guessMediaType(path: string): 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' {
  const lower = path.toLowerCase()
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.gif')) return 'image/gif'
  return 'image/png'
}

function toOpenAITool(tool: ToolSchema): Record<string, unknown> {
  return { type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } }
}

function toAnthropicTool(tool: ToolSchema): Record<string, unknown> {
  return { name: tool.name, description: tool.description, input_schema: tool.inputSchema }
}
