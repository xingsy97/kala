import { describe, expect, it } from 'vitest'

import type { Message } from '@agent-kernel/kernel'

import { OpenAIHTTPError, openaiAdapter } from './openai.js'

type FetchArgs = { url: string; init: RequestInit }

function mockFetch(
  bodyJson: unknown,
  opts: { status?: number; sink?: FetchArgs[]; headers?: Record<string, string> } = {},
): typeof fetch {
  const status = opts.status ?? 200
  const sink = opts.sink
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    sink?.push({ url: String(input), init: init ?? {} })
    return new Response(JSON.stringify(bodyJson), {
      status,
      headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
    })
  }) as unknown as typeof fetch
}

function mockSseFetch(
  chunks: readonly string[],
  opts: { sink?: FetchArgs[]; headers?: Record<string, string> } = {},
): typeof fetch {
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
      headers: { 'content-type': 'text/event-stream', ...(opts.headers ?? {}) },
    })
  }) as unknown as typeof fetch
}

const READ_TOOL = {
  name: 'read',
  description: 'read a file',
  inputSchema: { type: 'object' as const, properties: {} },
  requiresApproval: false,
} as const

describe('openaiAdapter', () => {
  it('parses a text-only completion and reports usage', async () => {
    const sink: FetchArgs[] = []
    const llm = openaiAdapter({
      apiKey: 'test-redacted-api-key',
      model: 'gpt-4o',
      fetchImpl: mockFetch(
        {
          id: 'x',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'hi there' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 12, completion_tokens: 4 },
        },
        { sink },
      ),
    })

    const res = await llm.call({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      tools: [],
    })

    expect(res.message.role).toBe('assistant')
    expect(res.message.content).toEqual([{ type: 'text', text: 'hi there' }])
    expect(res.finishReason).toBe('stop')
    expect(res.trace?.response?.finishReason).toBe('stop')
    expect(res.usage).toEqual({ inputTokens: 12, outputTokens: 4, cacheReadTokens: 0 })
    expect(sink[0].url).toBe('https://api.openai.com/v1/chat/completions')
    const body = JSON.parse(String(sink[0].init.body))
    expect(body.model).toBe('gpt-4o')
    expect(body.tools).toBeUndefined()
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }])
  })

  it('honors baseUrl override (openai-compatible gateways)', async () => {
    const sink: FetchArgs[] = []
    const llm = openaiAdapter({
      apiKey: 'k',
      baseUrl: 'https://api.example.test/v1',
      fetchImpl: mockFetch(
        {
          id: 'x',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'ok' },
            },
          ],
        },
        { sink },
      ),
    })
    await llm.call({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
      tools: [],
    })
    expect(sink[0].url).toBe('https://api.example.test/v1/chat/completions')
    const headers = new Headers(sink[0].init.headers)
    expect(headers.get('authorization')).toBe('Bearer k')
  })

  it('emits tools + tool_choice when tools are provided', async () => {
    const sink: FetchArgs[] = []
    const llm = openaiAdapter({
      apiKey: 'k',
      fetchImpl: mockFetch(
        {
          id: 'x',
          choices: [
            { index: 0, message: { role: 'assistant', content: 'done' } },
          ],
        },
        { sink },
      ),
    })
    await llm.call({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
      tools: [READ_TOOL],
      systemPrompt: 'be terse',
    })
    const body = JSON.parse(String(sink[0].init.body))
    expect(body.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'read',
          description: 'read a file',
          parameters: { type: 'object', properties: {} },
        },
      },
    ])
    expect(body.tool_choice).toBe('auto')
    expect(body.messages[0]).toEqual({ role: 'system', content: 'be terse' })
  })

  it('parses assistant tool_calls into ToolCallContent', async () => {
    const llm = openaiAdapter({
      apiKey: 'k',
      fetchImpl: mockFetch({
        id: 'x',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: {
                    name: 'read',
                    arguments: '{"path":"README.md"}',
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      }),
    })
    const res = await llm.call({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'read it' }] }],
      tools: [READ_TOOL],
    })
    expect(res.message.content).toEqual([
      {
        type: 'tool_call',
        callId: 'call_1',
        name: 'read',
        input: { path: 'README.md' },
      },
    ])
    expect(res.finishReason).toBe('tool_calls')
    expect(res.trace?.response?.finishReason).toBe('tool_calls')
  })

  it('round-trips a full assistant→tool→user cycle to OpenAI shape', async () => {
    const sink: FetchArgs[] = []
    const llm = openaiAdapter({
      apiKey: 'k',
      fetchImpl: mockFetch(
        {
          id: 'x',
          choices: [
            { index: 0, message: { role: 'assistant', content: 'thanks' } },
          ],
        },
        { sink },
      ),
    })
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'read readme' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'ok, calling read' },
          {
            type: 'tool_call',
            callId: 'call_1',
            name: 'read',
            input: { path: 'README.md' },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool_result',
            callId: 'call_1',
            ok: true,
            content: '# hi',
          },
        ],
      },
    ]
    await llm.call({ messages, tools: [READ_TOOL] })
    const body = JSON.parse(String(sink[0].init.body))
    expect(body.messages).toEqual([
      { role: 'user', content: 'read readme' },
      {
        role: 'assistant',
        content: 'ok, calling read',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'read', arguments: '{"path":"README.md"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '# hi' },
    ])
  })

  it('maps user image content to OpenAI image_url blocks', async () => {
    const sink: FetchArgs[] = []
    const llm = openaiAdapter({
      apiKey: 'k',
      fetchImpl: mockFetch(
        {
          id: 'x',
          choices: [
            { index: 0, message: { role: 'assistant', content: 'seen' } },
          ],
        },
        { sink },
      ),
    })

    await llm.call({
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'text only' }] },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'look' },
            {
              type: 'image',
              source: {
                kind: 'base64',
                mediaType: 'image/png',
                data: 'aGVsbG8=',
              },
            },
          ],
        },
      ],
      tools: [],
    })

    const body = JSON.parse(String(sink[0].init.body))
    expect(body.messages).toEqual([
      { role: 'user', content: 'text only' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          {
            type: 'image_url',
            image_url: { url: 'data:image/png;base64,aGVsbG8=' },
          },
        ],
      },
    ])
  })

  it('surfaces HTTP errors with body text', async () => {
    const llm = openaiAdapter({
      apiKey: 'k',
      fetchImpl: mockFetch({ error: 'bad key' }, { status: 401 }),
    })
    await expect(
      llm.call({
        messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
        tools: [],
      }),
    ).rejects.toBeInstanceOf(OpenAIHTTPError)
  })

  it('tolerates malformed tool_call arguments (returns empty object)', async () => {
    const llm = openaiAdapter({
      apiKey: 'k',
      fetchImpl: mockFetch({
        id: 'x',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'read', arguments: 'not-json' },
                },
              ],
            },
          },
        ],
      }),
    })
    const res = await llm.call({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
      tools: [READ_TOOL],
    })
    const call = res.message.content[0]
    expect(call.type).toBe('tool_call')
    if (call.type === 'tool_call') {
      expect(call.input).toEqual({})
    }
  })

  it('coerces missing/malformed usage fields to 0 (never NaN)', async () => {
    // Reproduces the failure mode where an OpenAI-compatible gateway returns
    // `usage: {}` (or omits individual fields). Passing `undefined` through
    // to the kernel's usage accumulator would produce NaN, silently bricking
    // the session-long token counter.
    const llm = openaiAdapter({
      apiKey: 'k',
      fetchImpl: mockFetch({
        id: 'x',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'hi' },
          },
        ],
        usage: {},
      }),
    })
    const res = await llm.call({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
      tools: [],
    })
    expect(res.usage).toBeDefined()
    expect(res.usage!.inputTokens).toBe(0)
    expect(res.usage!.outputTokens).toBe(0)
    expect(Number.isFinite(res.usage!.inputTokens)).toBe(true)
    expect(Number.isFinite(res.usage!.outputTokens)).toBe(true)
  })

  it('coerces non-numeric usage fields to 0', async () => {
    const llm = openaiAdapter({
      apiKey: 'k',
      fetchImpl: mockFetch({
        id: 'x',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'hi' },
          },
        ],
        usage: { prompt_tokens: 'lots' as unknown as number, completion_tokens: null as unknown as number },
      }),
    })
    const res = await llm.call({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
      tools: [],
    })
    expect(res.usage).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 })
  })

  it('surfaces cached_tokens from prompt_tokens_details', async () => {
    const llm = openaiAdapter({
      apiKey: 'k',
      fetchImpl: mockFetch({
        id: 'x',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'hi' },
          },
        ],
        usage: {
          prompt_tokens: 1200,
          completion_tokens: 8,
          prompt_tokens_details: { cached_tokens: 1024 },
        },
      }),
    })
    const res = await llm.call({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
      tools: [],
    })
    expect(res.usage).toEqual({
      inputTokens: 1200,
      outputTokens: 8,
      cacheReadTokens: 1024,
    })
  })

  it('records streaming duration and time to first chunk in trace metrics', async () => {
    const deltas: string[] = []
    const llm = openaiAdapter({
      apiKey: 'k',
      fetchImpl: mockSseFetch([
        'data: {"choices":[{"delta":{"content":"hel"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
        'data: {"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n',
        'data: [DONE]\n\n',
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

  it('captures x-request-id header and optional weight version on non-streaming calls', async () => {
    const llm = openaiAdapter({
      apiKey: 'test-redacted-api-key',
      weightVersion: 'sglang-policy@abcd',
      fetchImpl: mockFetch(
        {
          id: 'chatcmpl_body_1',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        },
        { headers: { 'x-request-id': 'req_xyz' } },
      ),
    })
    const res = await llm.call({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      tools: [],
    })
    expect(res.trace?.gatewayRequestId).toBe('req_xyz')
    expect(res.trace?.weightVersion).toBe('sglang-policy@abcd')
  })

  it('falls back to response body id when no request-id header is present', async () => {
    const llm = openaiAdapter({
      apiKey: 'test-redacted-api-key',
      fetchImpl: mockFetch({
        id: 'chatcmpl_body_2',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    })
    const res = await llm.call({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      tools: [],
    })
    expect(res.trace?.gatewayRequestId).toBe('chatcmpl_body_2')
    expect(res.trace?.weightVersion).toBeUndefined()
  })

  it('captures streaming chunk id when no request-id header is present', async () => {
    const llm = openaiAdapter({
      apiKey: 'test-redacted-api-key',
      fetchImpl: mockSseFetch([
        'data: {"id":"chatcmpl_stream_1","choices":[{"delta":{"content":"ok"}}]}\n\n',
        'data: {"id":"chatcmpl_stream_1","usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n',
        'data: [DONE]\n\n',
      ]),
    })
    const res = await llm.call({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
      tools: [],
      onTextDelta: () => {},
    })
    expect(res.trace?.gatewayRequestId).toBe('chatcmpl_stream_1')
  })
})
