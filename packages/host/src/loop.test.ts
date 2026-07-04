import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createConfig, createInitialState } from '@agent-kernel/kernel'
import type { AgentConfig, AgentState } from '@agent-kernel/kernel'

import { SessionStore } from './store/session.js'
import { readSessionLog } from './store/log.js'
import { runHostLoop } from './loop.js'
import type { LoopBroadcast, ToolDispatcher } from './loop.js'
import type { LLMAdapter, LLMResponse } from './llm/adapter.js'

function silentBroadcast(): LoopBroadcast {
  return {
    onEvent() {},
    onApprovalRequired() {},
    onError() {},
    onUsageChanged() {},
  }
}

function nullTools(overrides: Partial<ToolDispatcher> = {}): ToolDispatcher {
  return {
    callTool: async () => ({ ok: true, content: 'ok' }),
    cancelPending: () => {},
    ...overrides,
  }
}

function scriptedLlm(responses: LLMResponse[]): LLMAdapter {
  let i = 0
  return {
    name: 'scripted',
    async call() {
      const r = responses[i++]
      if (!r) throw new Error('scriptedLlm exhausted')
      return r
    },
  }
}

const READ = {
  name: 'read',
  description: 'read',
  inputSchema: { type: 'object' },
  requiresApproval: false,
} as const

describe('host loop', () => {
  let dir: string
  let store: SessionStore
  let config: AgentConfig
  let sessionId: string
  let state: AgentState

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'agent-kernel-host-'))
    store = new SessionStore(dir)
    config = createConfig({ tools: [READ], systemPrompt: 'sys' })
    const record = await store.create({ config, sessionId: 'sess-1' })
    sessionId = record.sessionId
    state = record.state
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('runs a plain-answer turn to done and writes the log', async () => {
    const llm = scriptedLlm([
      {
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'hi back' }],
        },
        usage: { inputTokens: 5, outputTokens: 3 },
      },
    ])
    const loop = runHostLoop({
      store,
      llm,
      tools: nullTools(),
      broadcast: silentBroadcast(),
    })

    await loop.dispatch(sessionId, { kind: 'user_message', text: 'hi' })

    const rec = store.get(sessionId)!
    expect(rec.state.status).toBe('done')
    expect(rec.state.cursor).toBe(2)
    expect(rec.state.usage.inputTokens).toBe(5)

    const parsed = await readSessionLog(rec.logPath)
    expect(parsed.header.sessionId).toBe(sessionId)
    expect(parsed.events).toHaveLength(2)
    expect(parsed.events[0]?.event.kind).toBe('user_message')
    expect(parsed.events[1]?.event.kind).toBe('llm_response')
    void state
  })

  it('drives a tool call round-trip', async () => {
    const llm = scriptedLlm([
      {
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_call',
              callId: 'c1',
              name: 'read',
              input: { path: '/tmp/x' },
            },
          ],
        },
      },
      {
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'file contents seen' }],
        },
      },
    ])
    let seen: string | undefined
    const tools = nullTools({
      callTool: async (_sid, eff) => {
        seen = eff.name
        return { ok: true, content: 'hello file' }
      },
    })
    const loop = runHostLoop({ store, llm, tools, broadcast: silentBroadcast() })

    await loop.dispatch(sessionId, { kind: 'user_message', text: 'read x' })

    expect(seen).toBe('read')
    const rec = store.get(sessionId)!
    expect(rec.state.status).toBe('done')
    // user + llm(tool) + tool_result + llm(text)
    expect(rec.state.cursor).toBe(4)
  })

  it('translates LLM throw into llm_error event', async () => {
    const llm: LLMAdapter = {
      name: 'boom',
      async call() {
        throw new Error('rate limited')
      },
    }
    let sawError: string | undefined
    const broadcast: LoopBroadcast = {
      ...silentBroadcast(),
      onError(_sid, msg) {
        sawError = msg
      },
    }
    const loop = runHostLoop({
      store,
      llm,
      tools: nullTools(),
      broadcast,
    })

    await loop.dispatch(sessionId, { kind: 'user_message', text: 'hi' })

    const rec = store.get(sessionId)!
    expect(rec.state.status).toBe('error')
    expect(rec.state.error).toBe('rate limited')
    expect(sawError).toBe('rate limited')
  })

  it('persistent log round-trips through load', async () => {
    const llm = scriptedLlm([
      {
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'hi' }],
        },
      },
    ])
    const loop = runHostLoop({
      store,
      llm,
      tools: nullTools(),
      broadcast: silentBroadcast(),
    })
    await loop.dispatch(sessionId, { kind: 'user_message', text: 'hi' })

    const fresh = new SessionStore(dir)
    const reloaded = await fresh.load(sessionId)
    expect(reloaded.state.status).toBe('done')
    expect(reloaded.state.cursor).toBe(2)
  })

  it('propagates cancel to the executor via cancelPending (SPEC  - Non-goals: Host cancels IO)', async () => {
    // Scenario: LLM asked for a tool call, executor is chewing on it, user
    // hits cancel. Before this fix the kernel drops pendingCalls but the
    // executor kept running because `cancelPending` was never invoked  - 
    // wire-protocol  - 5.2 was silently ignored. Now dispatch must call
    // cancelPending exactly once with the session id.
    let toolPromiseResolve: ((r: { ok: boolean; content: string }) => void) | undefined
    let toolCalled: (() => void) | undefined
    const toolCallSeen = new Promise<void>((r) => {
      toolCalled = r
    })
    const cancels: string[] = []
    const tools: ToolDispatcher = {
      callTool: (_sid, _eff) =>
        new Promise((r) => {
          toolPromiseResolve = r
          // Signal that the loop actually reached callTool. Awaiting this
          // in the test avoids brittle setImmediate/setTimeout guesses
          // about how many microtasks the loop needs to reach the
          // pending-tool point.
          toolCalled?.()
        }),
      cancelPending: (sid) => {
        cancels.push(sid)
        // Simulate the executor honouring cancel by acking with a synthetic
        // failure. The registry would normally do this after the executor
        // replies; we short-circuit here so the loop's outstanding
        // dispatchOne (for tool_result) can resolve.
        toolPromiseResolve?.({ ok: false, content: 'cancelled' })
      },
    }
    const llm = scriptedLlm([
      {
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_call',
              callId: 'c-cancel',
              name: 'read',
              input: { path: '/tmp/x' },
            },
          ],
        },
      },
    ])
    const loop = runHostLoop({
      store,
      llm,
      tools,
      broadcast: silentBroadcast(),
    })

    // Kick off the tool-call turn. Don't await  -  the executor is
    // "processing" indefinitely until cancel arrives.
    const dispatchP = loop.dispatch(sessionId, {
      kind: 'user_message',
      text: 'read x',
    })
    // Wait until the loop is definitely blocked inside callTool.
    await toolCallSeen

    // Now the user cancels. Loop must call cancelPending on the executor.
    await loop.dispatch(sessionId, { kind: 'cancel' })
    await dispatchP

    expect(cancels).toEqual([sessionId])
    // Kernel is done, not executing_tools any more.
    const rec = store.get(sessionId)!
    expect(rec.state.status).toBe('done')
    expect(rec.state.pendingCalls).toEqual([])
  })

  it('cancel with no pending tool is still safe (no-op cancelPending)', async () => {
    // Cancel from idle (no tool call ever dispatched): kernel is a noop,
    // executor has nothing to interrupt, but cancelPending is still
    // invoked  -  the spec's contract is "cancel means stop everything
    // now" and we want it to be idempotent-shaped. The important
    // guarantee is that the loop doesn't crash when there's nothing
    // in flight.
    const cancels: string[] = []
    const tools: ToolDispatcher = {
      callTool: async () => ({ ok: true, content: 'unused' }),
      cancelPending: (sid) => {
        cancels.push(sid)
      },
    }
    const loop = runHostLoop({
      store,
      llm: scriptedLlm([]),
      tools,
      broadcast: silentBroadcast(),
    })
    await loop.dispatch(sessionId, { kind: 'cancel' })
    expect(cancels).toEqual([sessionId])
    const rec = store.get(sessionId)!
    // cancel from idle  -  transitions[idle].cancel = noop, so state stays
    // idle with cursor advanced by one.
    expect(rec.state.status).toBe('idle')
  })
})

describe('SessionStore', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agent-kernel-store-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('creates a new session with header on disk', async () => {
    const store = new SessionStore(dir)
    const cfg = createConfig({ tools: [] })
    const rec = await store.create({ config: cfg, sessionId: 'abc' })
    const parsed = await readSessionLog(rec.logPath)
    expect(parsed.header.sessionId).toBe('abc')
    expect(parsed.header.formatVersion).toBe(1)
    expect(parsed.events).toHaveLength(0)
  })

  it('fold matches live loop after replay', async () => {
    const store = new SessionStore(dir)
    const cfg = createConfig({ tools: [READ] })
    const rec = await store.create({ config: cfg, sessionId: 'zzz' })
    void createInitialState

    const llm = scriptedLlm([
      {
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'yep' }],
        },
      },
    ])
    const loop = runHostLoop({
      store,
      llm,
      tools: nullTools(),
      broadcast: silentBroadcast(),
    })
    await loop.dispatch(rec.sessionId, { kind: 'user_message', text: 'x' })

    const other = new SessionStore(dir)
    const loaded = await other.load('zzz')
    expect(loaded.state).toEqual(store.get('zzz')?.state)
  })
})
