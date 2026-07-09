import { describe, expect, it } from 'vitest'

import { normalizeAnthropicBlocks, normalizeOpenAIToolCalls, parseToolArguments } from './tool-call-normalizer.js'

describe('tool-call-normalizer', () => {
  it('normalizes OpenAI text and tool calls', () => {
    const out = normalizeOpenAIToolCalls({
      rawText: 'calling read',
      rawToolCalls: [{ id: 'call_1', function: { name: 'read', arguments: '{"path":"README.md"}' } }],
      finishReason: 'tool_calls',
    })

    expect(out.content).toEqual([
      { type: 'text', text: 'calling read' },
      { type: 'tool_call', callId: 'call_1', name: 'read', input: { path: 'README.md' } },
    ])
    expect(out.toolCalls).toEqual([{ type: 'tool_call', callId: 'call_1', name: 'read', input: { path: 'README.md' } }])
    expect(out.malformedToolCalls).toEqual([])
  })

  it('records malformed OpenAI arguments while preserving legacy empty-object fallback', () => {
    const out = normalizeOpenAIToolCalls({
      rawToolCalls: [{ id: 'call_1', function: { name: 'write', arguments: '{"path":' } }],
    })

    expect(out.content).toEqual([{ type: 'tool_call', callId: 'call_1', name: 'write', input: {} }])
    expect(out.malformedToolCalls).toEqual([{ provider: 'openai', callId: 'call_1', name: 'write', rawArguments: '{"path":', reason: 'invalid_json' }])
  })

  it('rejects non-object parsed arguments as malformed', () => {
    expect(parseToolArguments('openai', 'call_1', 'read', '[]')).toEqual({
      input: {},
      malformed: { provider: 'openai', callId: 'call_1', name: 'read', rawArguments: '[]', reason: 'non_object_arguments' },
    })
  })

  it('normalizes Anthropic text, thinking, and tool_use blocks', () => {
    const out = normalizeAnthropicBlocks({
      blocks: [
        { type: 'text', text: 'ok' },
        { type: 'thinking', thinking: 'private', signature: 'sig' },
        { type: 'tool_use', id: 'toolu_1', name: 'read', input: { path: 'README.md' } },
      ],
      finishReason: 'tool_use',
    })

    expect(out.content).toEqual([
      { type: 'text', text: 'ok' },
      { type: 'thinking', text: 'private', provider: 'anthropic', signature: 'sig' },
      { type: 'tool_call', callId: 'toolu_1', name: 'read', input: { path: 'README.md' } },
    ])
    expect(out.malformedToolCalls).toEqual([])
  })

  it('flags short text-only max token responses as suspected truncation', () => {
    const out = normalizeOpenAIToolCalls({ rawText: 'write the file with', finishReason: 'max_tokens' })

    expect(out.suspectedTruncation).toBe(true)
  })
})
