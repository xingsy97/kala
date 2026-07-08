import { describe, expect, it } from 'vitest'

import { anthropicAdapter } from './anthropic.js'

type FetchArgs = { url: string; init: RequestInit }

function mockFetch(
  bodyJson: unknown,
  opts: { status?: number; sink?: FetchArgs[] } = {},
): typeof fetch {
  const status = opts.status ?? 200
  const sink = opts.sink
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    sink?.push({ url: String(input), init: init ?? {} })
    return new Response(JSON.stringify(bodyJson), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
}

function mockSseFetch(chunks: readonly string[], opts: { sink?: FetchArgs[] } = {}): typeof fetch {
  const encoder = new TextEncoder()
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    opts.sink?.push({ url: String(input), init: init ?? {} })
    return new Response(new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
        controller.close()
      },
    }), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  }) as unknown as typeof fetch
}

const READ_TOOL = {
  name: 'read',
  description: 'read a file',
  inputSchema: { type: 'object' as const, properties: {} },
  requiresApproval: false,
} as const

const EDIT_TOOL = {
  name: 'edit',
  description: 'edit a file',
  inputSchema: { type: 'object' as const, properties: {} },
  requiresApproval: true,
} as const

const OK_RESPONSE = {
  id: 'x',
  role: 'assistant' as const,
  content: [{ type: 'text' as const, text: 'ok' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 1, output_tokens: 1 },
}

describe('anthropicAdapter  -  prompt caching', () => {
  it('marks system prompt with cache_control by default', async () => {
    const sink: FetchArgs[] = []
    const llm = anthropicAdapter({
      apiKey: 'k',
      fetchImpl: mockFetch(OK_RESPONSE, { sink }),
    })
    await llm.call({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      tools: [],
      systemPrompt: 'be helpful',
    })
    const body = JSON.parse(String(sink[0].init.body))
    expect(body.system).toEqual([
      { type: 'text', text: 'be helpful', cache_control: { type: 'ephemeral' } },
    ])
  })

  it('marks the last tool with cache_control (stable schema prefix)', async () => {
    const sink: FetchArgs[] = []
    const llm = anthropicAdapter({
      apiKey: 'k',
      fetchImpl: mockFetch(OK_RESPONSE, { sink }),
    })
    await llm.call({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
      tools: [READ_TOOL, EDIT_TOOL],
    })
    const body = JSON.parse(String(sink[0].init.body))
    expect(body.tools[0].cache_control).toBeUndefined()
    expect(body.tools[1].cache_control).toEqual({ type: 'ephemeral' })
  })

  it('rotates cache breakpoint onto the last user block', async () => {
    const sink: FetchArgs[] = []
    const llm = anthropicAdapter({
      apiKey: 'k',
      fetchImpl: mockFetch(OK_RESPONSE, { sink }),
    })
    await llm.call({
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'first' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
        { role: 'user', content: [{ type: 'text', text: 'second' }] },
      ],
      tools: [],
    })
    const body = JSON.parse(String(sink[0].init.body))
    // First user turn keeps a plain text block; the marker sits on the
    // latest user turn so the growing conversation prefix caches.
    expect(body.messages[0].content[0].cache_control).toBeUndefined()
    expect(body.messages[2].content[0]).toEqual({
      type: 'text',
      text: 'second',
      cache_control: { type: 'ephemeral' },
    })
  })

  it('omits cache_control everywhere when cache:false', async () => {
    const sink: FetchArgs[] = []
    const llm = anthropicAdapter({
      apiKey: 'k',
      cache: false,
      fetchImpl: mockFetch(OK_RESPONSE, { sink }),
    })
    await llm.call({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      tools: [READ_TOOL],
      systemPrompt: 'sys',
    })
    const body = JSON.parse(String(sink[0].init.body))
    expect(body.system).toBe('sys')
    expect(body.tools[0].cache_control).toBeUndefined()
    expect(body.messages[0].content[0].cache_control).toBeUndefined()
  })

  it('surfaces cache_creation_input_tokens and cache_read_input_tokens in usage', async () => {
    const llm = anthropicAdapter({
      apiKey: 'k',
      fetchImpl: mockFetch({
        id: 'x',
        role: 'assistant',
        content: [{ type: 'text', text: 'cached' }],
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 50,
          output_tokens: 12,
          cache_creation_input_tokens: 800,
          cache_read_input_tokens: 1024,
        },
      }),
    })
    const res = await llm.call({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }],
      tools: [],
    })
    expect(res.usage).toEqual({
      inputTokens: 50,
      outputTokens: 12,
      cacheCreationTokens: 800,
      cacheReadTokens: 1024,
    })
  })

  it('coerces missing cache fields to 0 (never NaN)', async () => {
    const llm = anthropicAdapter({
      apiKey: 'k',
      fetchImpl: mockFetch({
        id: 'x',
        role: 'assistant',
        content: [{ type: 'text', text: 'no cache' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 5, output_tokens: 2 },
      }),
    })
    const res = await llm.call({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }],
      tools: [],
    })
    expect(res.usage).toEqual({
      inputTokens: 5,
      outputTokens: 2,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    })
  })

  it('records streaming duration and time to first chunk in trace metrics', async () => {
    const deltas: string[] = []
    const llm = anthropicAdapter({
      apiKey: 'k',
      fetchImpl: mockSseFetch([
        'data: {"type":"message_start","message":{"usage":{"input_tokens":3,"output_tokens":0}}}\n\n',
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hel"}}\n\n',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"lo"}}\n\n',
        'data: {"type":"message_delta","usage":{"output_tokens":2}}\n\n',
        'data: {"type":"message_stop"}\n\n',
      ]),
    })

    const res = await llm.call({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
      tools: [],
      onTextDelta: (delta) => deltas.push(delta),
    })

    expect(deltas).toEqual(['hel', 'lo'])
    expect(res.message.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(res.trace?.response?.metrics?.durationMs).toEqual(expect.any(Number))
    expect(res.trace?.response?.metrics?.timeToFirstChunkMs).toEqual(expect.any(Number))
  })
})
