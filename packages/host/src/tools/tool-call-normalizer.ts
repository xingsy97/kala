import type { MessageContent, ToolCallContent } from '@agent-kernel/kernel'

export type MalformedToolCall = {
  provider: string
  callId: string
  name: string
  rawArguments: string
  reason: 'invalid_json' | 'non_object_arguments' | 'missing_name' | 'missing_call_id'
}

export type NormalizedToolCall = ToolCallContent

export type NormalizedAssistantOutput = {
  content: MessageContent[]
  toolCalls: NormalizedToolCall[]
  malformedToolCalls: MalformedToolCall[]
  suspectedTruncation: boolean
}

export function normalizeOpenAIToolCalls(input: {
  rawText?: string | null
  rawToolCalls?: readonly {
    id?: string
    function?: { name?: string; arguments?: string }
  }[]
  finishReason?: string
}): NormalizedAssistantOutput {
  const content: MessageContent[] = []
  if (input.rawText && input.rawText.length > 0) content.push({ type: 'text', text: input.rawText })
  const malformedToolCalls: MalformedToolCall[] = []
  const toolCalls: ToolCallContent[] = []
  for (const tc of input.rawToolCalls ?? []) {
    const callId = tc.id ?? ''
    const name = tc.function?.name ?? ''
    const rawArguments = tc.function?.arguments ?? ''
    const malformed = baseMalformed('openai', callId, name, rawArguments)
    if (malformed) {
      malformedToolCalls.push(malformed)
      toolCalls.push({ type: 'tool_call', callId, name, input: {} })
      continue
    }
    const parsed = parseToolArguments('openai', callId, name, rawArguments)
    if (parsed.malformed) malformedToolCalls.push(parsed.malformed)
    toolCalls.push({ type: 'tool_call', callId, name, input: parsed.input })
  }
  content.push(...toolCalls)
  return {
    content,
    toolCalls,
    malformedToolCalls,
    suspectedTruncation: isSuspectedToolTruncation({ text: input.rawText ?? '', toolCalls, finishReason: input.finishReason }),
  }
}

export function normalizeAnthropicBlocks(input: {
  blocks: readonly {
    type: string
    text?: string
    id?: string
    name?: string
    input?: unknown
    thinking?: string
    signature?: string
  }[]
  finishReason?: string
}): NormalizedAssistantOutput {
  const content: MessageContent[] = []
  const toolCalls: ToolCallContent[] = []
  const malformedToolCalls: MalformedToolCall[] = []
  for (const block of input.blocks) {
    if (block.type === 'text') {
      content.push({ type: 'text', text: block.text ?? '' })
      continue
    }
    if (block.type === 'tool_use') {
      const callId = block.id ?? ''
      const name = block.name ?? ''
      const malformed = baseMalformed('anthropic', callId, name, JSON.stringify(block.input ?? {}))
      if (malformed) malformedToolCalls.push(malformed)
      const toolCall: ToolCallContent = {
        type: 'tool_call',
        callId,
        name,
        input: objectOrEmpty(block.input),
      }
      toolCalls.push(toolCall)
      content.push(toolCall)
      continue
    }
    if (block.type === 'thinking') {
      content.push({ type: 'thinking', text: block.thinking ?? '', provider: 'anthropic', ...(block.signature ? { signature: block.signature } : {}) })
    }
  }
  const text = content.map((item) => (item.type === 'text' ? item.text : '')).join('')
  return {
    content,
    toolCalls,
    malformedToolCalls,
    suspectedTruncation: isSuspectedToolTruncation({ text, toolCalls, finishReason: input.finishReason }),
  }
}

export function parseToolArguments(provider: string, callId: string, name: string, rawArguments: string): {
  input: Record<string, unknown>
  malformed?: MalformedToolCall
} {
  if (!rawArguments) return { input: {} }
  try {
    const parsed = JSON.parse(rawArguments) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { input: parsed as Record<string, unknown> }
    return { input: {}, malformed: { provider, callId, name, rawArguments, reason: 'non_object_arguments' } }
  } catch {
    return { input: {}, malformed: { provider, callId, name, rawArguments, reason: 'invalid_json' } }
  }
}

function baseMalformed(provider: string, callId: string, name: string, rawArguments: string): MalformedToolCall | undefined {
  if (!callId) return { provider, callId, name, rawArguments, reason: 'missing_call_id' }
  if (!name) return { provider, callId, name, rawArguments, reason: 'missing_name' }
  return undefined
}

function objectOrEmpty(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function isSuspectedToolTruncation(input: { text: string; toolCalls: readonly ToolCallContent[]; finishReason?: string }): boolean {
  if (input.finishReason !== 'max_tokens' && input.finishReason !== 'length') return false
  if (input.toolCalls.length > 0) return false
  return input.text.trim().length > 0 && input.text.length < 512
}
