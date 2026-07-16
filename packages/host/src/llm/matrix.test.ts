/**
 * Cross-adapter test matrix: cancel / retry-classifier (HTTP status) / error /
 * streaming with tool_use. Sits alongside the per-adapter test files, which
 * cover happy-path, caching, and provider-specific quirks. This file only
 * fills the axes those files don't.
 *
 * Convention: one describe.each per axis so a new adapter (e.g. gemini) can
 * be onboarded by appending a row to the ADAPTERS table.
 */
import { describe, expect, it } from 'vitest'

import type { LLMAdapter, LLMCallParams } from './adapter.js'
import { anthropicAdapter, AnthropicHTTPError } from './anthropic.js'
import { openaiAdapter, OpenAIHTTPError } from './openai.js'

type Fixture = {
  /** Successful non-streaming body shape for this provider. */
  okBody: unknown
  /** Streaming SSE chunks that produce assistant text "hi". */
  okStreamChunks: readonly string[]
  /** Streaming SSE chunks that emit a tool_use call named `search({q:"x"})`. */
  toolStreamChunks: readonly string[]
  makeAdapter(fetchImpl: typeof fetch): LLMAdapter
  ErrorClass: new (status: number, body: string) => Error
}

// ---------------------------------------------------------------------------
// Provider fixtures — one per adapter. Kept side-by-side so drift between
// them (e.g. a new provider that gains streaming but not a stream-cancel
// path) is obvious.
// ---------------------------------------------------------------------------

const ANTHROPIC: Fixture = {
  okBody: {
    id: 'msg_1',
    role: 'assistant',
    content: [{ type: 'text', text: 'ok' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
  },
  okStreamChunks: [
    'data: {"type":"message_start","message":{"id":"m","usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
    'data: {"type":"message_stop"}\n\n',
  ],
  toolStreamChunks: [
    'data: {"type":"message_start","message":{"id":"m","usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu_1","name":"search","input":{}}}\n\n',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"q\\":\\"x\\"}"}}\n\n',
    'data: {"type":"content_block_stop","index":0}\n\n',
    'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":2}}\n\n',
    'data: {"type":"message_stop"}\n\n',
  ],
  makeAdapter: (fetchImpl) => anthropicAdapter({ apiKey: 'k', fetchImpl }),
  ErrorClass: AnthropicHTTPError,
}

const OPENAI: Fixture = {
  okBody: {
    id: 'cmpl_1',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'ok' },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  },
  okStreamChunks: [
    'data: {"id":"c1","choices":[{"index":0,"delta":{"role":"assistant","content":"hi"}}]}\n\n',
    'data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n',
  ],
  toolStreamChunks: [
    'data: {"id":"c1","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"tc_1","type":"function","function":{"name":"search","arguments":""}}]}}]}\n\n',
    'data: {"id":"c1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"q\\":\\"x\\"}"}}]}}]}\n\n',
    'data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
    'data: [DONE]\n\n',
  ],
  makeAdapter: (fetchImpl) => openaiAdapter({ apiKey: 'k', model: 'gpt-4o', fetchImpl }),
  ErrorClass: OpenAIHTTPError,
}

const ADAPTERS: readonly [string, Fixture][] = [
  ['anthropic', ANTHROPIC],
  ['openai', OPENAI],
]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeErrorFetch(status: number, body = 'boom'): typeof fetch {
  return (async () =>
    new Response(body, {
      status,
      headers: { 'content-type': 'text/plain' },
    })) as unknown as typeof fetch
}

function makeAbortableFetch(): typeof fetch {
  // Honors AbortSignal.aborted: rejects with an AbortError so adapters that
  // pass `signal` through to fetch surface it correctly to the caller.
  return (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const signal = init?.signal
    if (signal?.aborted) {
      const err = new Error('aborted')
      err.name = 'AbortError'
      throw err
    }
    return await new Promise<Response>((_resolve, reject) => {
      signal?.addEventListener('abort', () => {
        const err = new Error('aborted')
        err.name = 'AbortError'
        reject(err)
      })
    })
  }) as unknown as typeof fetch
}

function makeSseFetch(chunks: readonly string[]): typeof fetch {
  const enc = new TextEncoder()
  return (async () =>
    new Response(
      new ReadableStream({
        start(c) {
          for (const chunk of chunks) c.enqueue(enc.encode(chunk))
          c.close()
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )) as unknown as typeof fetch
}

const CALL: LLMCallParams = {
  messages: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }],
  tools: [],
}

// ---------------------------------------------------------------------------
// Cancel axis — AbortSignal is passed through and the adapter rejects.
// ---------------------------------------------------------------------------

describe.each(ADAPTERS)('%s adapter — cancel', (_name, fx) => {
  it('rejects with AbortError when signal aborts mid-request', async () => {
    const llm = fx.makeAdapter(makeAbortableFetch())
    const ctl = new AbortController()
    const pending = llm.call({ ...CALL, signal: ctl.signal }).catch((e: unknown) => e)
    ctl.abort()
    const err = (await pending) as Error
    expect(err.name).toBe('AbortError')
  })

  it('rejects immediately when signal is already aborted', async () => {
    const llm = fx.makeAdapter(makeAbortableFetch())
    const ctl = new AbortController()
    ctl.abort()
    const err = await llm.call({ ...CALL, signal: ctl.signal }).catch((e: unknown) => e)
    expect((err as Error).name).toBe('AbortError')
  })
})

// ---------------------------------------------------------------------------
// Error axis — HTTP failures surface a typed adapter error carrying the
// upstream status. This is the boundary the reliability supervisor uses to
// decide retry vs. terminate. Tests pin the classifier surface, not the
// (higher-layer) retry policy.
// ---------------------------------------------------------------------------

describe.each(ADAPTERS)('%s adapter — error classification', (_name, fx) => {
  for (const status of [400, 401, 429, 500, 503] as const) {
    it(`throws typed adapter error with status ${status}`, async () => {
      const llm = fx.makeAdapter(makeErrorFetch(status, `err-${status}`))
      const err = await llm.call(CALL).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(fx.ErrorClass)
      expect((err as { status: number }).status).toBe(status)
      expect((err as Error).message).toContain(`err-${status}`)
    })
  }
})

// ---------------------------------------------------------------------------
// Streaming axis — tool_use events must produce a `tool_call` content block
// in the returned message. This is the path that drives approval prompts, so
// silent regression here would let tool calls disappear from the UI.
// ---------------------------------------------------------------------------

describe.each(ADAPTERS)('%s adapter — streaming tool_use assembly', (_name, fx) => {
  it('assembles a tool_call from streamed input_json deltas', async () => {
    const llm = fx.makeAdapter(makeSseFetch(fx.toolStreamChunks))
    const res = await llm.call({ ...CALL, onTextDelta: () => {} })
    const calls = res.message.content.filter((c) => c.type === 'tool_call')
    expect(calls.length).toBe(1)
    const call = calls[0] as { type: 'tool_call'; name: string; input: unknown }
    expect(call.name).toBe('search')
    expect(call.input).toEqual({ q: 'x' })
    expect(res.finishReason).toMatch(/tool/)
  })
})

// ---------------------------------------------------------------------------
// Streaming axis — text deltas are delivered incrementally AND the final
// message aggregates them. Existing per-adapter tests cover the anthropic
// text path; this one pins the invariant that streamed text == final text
// for every adapter.
// ---------------------------------------------------------------------------

describe.each(ADAPTERS)('%s adapter — streamed text equals final text', (_name, fx) => {
  it('deltas concatenate to the message text', async () => {
    const deltas: string[] = []
    const llm = fx.makeAdapter(makeSseFetch(fx.okStreamChunks))
    const res = await llm.call({ ...CALL, onTextDelta: (d) => deltas.push(d) })
    const finalText = res.message.content
      .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
      .map((c) => c.text)
      .join('')
    expect(deltas.join('')).toBe(finalText)
    expect(finalText).toBe('hi')
    expect(res.finishReason).toMatch(/^(end_turn|stop)$/)
  })
})
