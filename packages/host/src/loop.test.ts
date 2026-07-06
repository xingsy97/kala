import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
import { discoverSkills } from './skills.js'

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

const AGENT = {
  name: 'agent',
  description: 'spawn agent',
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

  it('records the active model on LLM response entries and broadcasts', async () => {
    const llm = scriptedLlm([
      {
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'model captured' }],
        },
        usage: { inputTokens: 7, outputTokens: 4 },
      },
    ])
    const seenEvents: Array<{ event: string; model?: string }> = []
    const loop = runHostLoop({
      store,
      llm,
      tools: nullTools(),
      broadcast: {
        ...silentBroadcast(),
        onEvent(_sessionId, _seq, event, _effects, _state, _llmTrace, model) {
          seenEvents.push({ event: event.kind, model })
        },
      },
      models: { get: () => 'claude-sonnet-4-6' },
    })

    await loop.dispatch(sessionId, { kind: 'user_message', text: 'hi' })

    const parsed = await readSessionLog(store.get(sessionId)!.logPath)
    const response = parsed.events.find((entry) => entry.event.kind === 'llm_response')
    expect(response?.model).toBe('claude-sonnet-4-6')
    expect(seenEvents).toContainEqual({ event: 'llm_response', model: 'claude-sonnet-4-6' })
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

  it('handles the skill builtin in host without dispatching to executor', async () => {
    const skillsRoot = join(dir, '.agents', 'skills')
    const skillDir = join(skillsRoot, 'demo-skill')
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      [
        '---',
        'name: demo-skill',
        'description: Use for testing host-side skill loading.',
        '---',
        '',
        'DEMO SKILL BODY',
      ].join('\n'),
      'utf8',
    )
    const skills = await discoverSkills([skillsRoot])
    const skillConfig = createConfig({
      tools: [
        READ,
        {
          name: 'skill',
          description: 'skill loader',
          inputSchema: { type: 'object' },
          requiresApproval: false,
        },
      ],
      systemPrompt: 'sys',
    })
    const skillRecord = await store.create({ config: skillConfig, sessionId: 'sess-skill' })
    let executorCalls = 0
    const llm = scriptedLlm([
      {
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_call',
              callId: 'skill-1',
              name: 'skill',
              input: { name: 'demo-skill' },
            },
          ],
        },
      },
      {
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'skill loaded' }],
        },
      },
    ])
    const loop = runHostLoop({
      store,
      llm,
      tools: nullTools({
        callTool: async () => {
          executorCalls++
          return { ok: false, content: 'should not dispatch' }
        },
      }),
      broadcast: silentBroadcast(),
      skills,
    })

    await loop.dispatch(skillRecord.sessionId, { kind: 'user_message', text: 'load skill' })

    expect(executorCalls).toBe(0)
    const toolMessage = store
      .get(skillRecord.sessionId)!
      .state.messages.find((m) => m.role === 'tool')
    expect(toolMessage?.content[0]).toMatchObject({
      type: 'tool_result',
      callId: 'skill-1',
      ok: true,
    })
    expect(
      toolMessage?.content[0]?.type === 'tool_result'
        ? toolMessage.content[0].content
        : '',
    ).toContain('DEMO SKILL BODY')
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

  it('serializes concurrent dispatches for one session', async () => {
    const llm = scriptedLlm([
      {
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'first' }],
        },
      },
      {
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'second' }],
        },
      },
    ])
    const loop = runHostLoop({
      store,
      llm,
      tools: nullTools(),
      broadcast: silentBroadcast(),
    })

    await Promise.all([
      loop.dispatch(sessionId, { kind: 'user_message', text: 'one' }),
      loop.dispatch(sessionId, { kind: 'user_message', text: 'two' }),
    ])

    const rec = store.get(sessionId)!
    expect(rec.state.status).toBe('done')
    expect(rec.state.cursor).toBe(4)
    const parsed = await readSessionLog(rec.logPath)
    expect(parsed.events.map((e) => e.seq)).toEqual([1, 2, 3, 4])
    expect(parsed.events.map((e) => e.event.kind)).toEqual([
      'user_message',
      'llm_response',
      'user_message',
      'llm_response',
    ])
  })

  it('does not let broadcast failures break persisted loop progress', async () => {
    const llm = scriptedLlm([
      {
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'still persisted' }],
        },
      },
    ])
    const loop = runHostLoop({
      store,
      llm,
      tools: nullTools(),
      broadcast: {
        ...silentBroadcast(),
        onEvent() {
          throw new Error('socket layer failed')
        },
      },
    })

    await loop.dispatch(sessionId, { kind: 'user_message', text: 'hi' })

    const rec = store.get(sessionId)!
    expect(rec.state.status).toBe('done')
    const parsed = await readSessionLog(rec.logPath)
    expect(parsed.events).toHaveLength(2)
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

  it('manual compact() summarizes and replaces messages', async () => {
    // Pre-seed a session that has already run one turn so state.messages is
    // non-trivial. Then a manual `/compact` should send those messages to
    // the LLM with the summarizer system prompt, receive a text reply, and
    // emit a compact_replaced event that shrinks the message list.
    const llmCalls: Array<{ sys?: string; msgs: number; model?: string }> = []
    const llm: LLMAdapter = {
      name: 'compact-mock',
      async call(p) {
        llmCalls.push({ sys: p.systemPrompt, msgs: p.messages.length, model: p.model })
        // First call = turn's user_message  -  assistant text reply.
        // Second call = summarizer  -  summary text.
        if (llmCalls.length === 1) {
          return {
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'ok' }],
            },
            usage: { inputTokens: 10, outputTokens: 2 },
          }
        }
        return {
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'SUMMARY-OF-CONVO' }],
          },
          usage: { inputTokens: 8, outputTokens: 3 },
        }
      },
    }
    const loop = runHostLoop({
      store,
      llm,
      tools: nullTools(),
      broadcast: silentBroadcast(),
      models: { get: () => 'compact-model' },
    })

    await loop.dispatch(sessionId, { kind: 'user_message', text: 'hi' })
    const beforeCount = store.get(sessionId)!.state.messages.length
    expect(beforeCount).toBeGreaterThan(1)

    await loop.compact(sessionId)

    const rec = store.get(sessionId)!
    // system prompt (1) + summary (1) = 2 messages.
    expect(rec.state.messages).toHaveLength(2)
    expect(rec.state.messages[0]!.role).toBe('system')
    const last = rec.state.messages[1]!
    expect(last.role).toBe('system')
    expect(last.content[0]).toEqual({ type: 'text', text: 'SUMMARY-OF-CONVO' })
    // Summarizer call carried the fixed prompt.
    expect(llmCalls[1]!.sys).toMatch(/summarizer/i)
    expect(llmCalls[1]!.model).toBe('compact-model')
    // usage.inputTokens is reset to the compacted-message estimate.
    expect(rec.state.usage.inputTokens).toBeLessThan(10)
    const parsed = await readSessionLog(rec.logPath)
    const compact = parsed.events.find((e) => e.event.kind === 'compact_replaced')
      ?.event as Extract<import('@agent-kernel/kernel').AgentEvent, { kind: 'compact_replaced' }> | undefined
    expect(compact?.trigger).toBe('manual')
    expect(compact?.request?.model).toBe('compact-model')
    expect(compact?.request?.systemPrompt).toMatch(/summarizer/i)
    expect(compact?.request?.messages).toHaveLength(beforeCount)
    expect(compact?.responseUsage).toEqual({ inputTokens: 8, outputTokens: 3 })
  })

  it('manual compact() rejects empty sessions before calling the summarizer', async () => {
    let llmCalls = 0
    const llm: LLMAdapter = {
      name: 'compact-counter',
      async call() {
        llmCalls += 1
        return {
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'unused' }],
          },
        }
      },
    }
    const loop = runHostLoop({
      store,
      llm,
      tools: nullTools(),
      broadcast: silentBroadcast(),
    })

    await expect(loop.compact(sessionId)).rejects.toThrow('nothing to compact yet')
    expect(llmCalls).toBe(0)
  })

  it('manual compact() rejects busy sessions before calling the summarizer', async () => {
    let release: (() => void) | undefined
    const llm: LLMAdapter = {
      name: 'blocked-turn',
      async call() {
        return await new Promise<LLMResponse>((resolve) => {
          release = () =>
            resolve({
              message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'done' }],
              },
            })
        })
      },
    }
    const loop = runHostLoop({
      store,
      llm,
      tools: nullTools(),
      broadcast: silentBroadcast(),
    })

    const turn = loop.dispatch(sessionId, { kind: 'user_message', text: 'hi' })
    await new Promise<void>((resolve, reject) => {
      const start = Date.now()
      const tick = (): void => {
        if (store.get(sessionId)?.state.status === 'thinking') return resolve()
        if (Date.now() - start > 1000) return reject(new Error('never thinking'))
        setTimeout(tick, 10)
      }
      tick()
    })

    await expect(loop.compact(sessionId)).rejects.toThrow(
      'cannot compact while the session is busy',
    )
    release?.()
    await turn
  })

  it('auto-fires compact when context pressure hits hard tier', async () => {
    // Build a session whose contextLimit is tiny so a single assistant reply
    // pushes inputTokens/contextLimit past the hard threshold. The loop's
    // post-dispatch hook must observe the hard pressure and self-fire compact.
    const tightConfig = createConfig({
      tools: [],
      systemPrompt: 'sys',
      contextLimit: 100,
      softThreshold: 0.5,
      hardThreshold: 0.9,
    })
    const rec = await store.create({ config: tightConfig, sessionId: 'sess-hp' })
    const sid = rec.sessionId

    const llmCalls: Array<{ sys?: string }> = []
    const llm: LLMAdapter = {
      name: 'pressure-mock',
      async call(p) {
        llmCalls.push({ sys: p.systemPrompt })
        // Turn 1: assistant text reply. Reports 95 input tokens = 95% of
        // the 100-token limit  -  hard tier.
        if (llmCalls.length === 1) {
          return {
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'done' }],
            },
            usage: { inputTokens: 95, outputTokens: 5 },
          }
        }
        // Turn 2 = the auto-compact's summarizer call.
        return {
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'auto-summary' }],
          },
        }
      },
    }
    const loop = runHostLoop({
      store,
      llm,
      tools: nullTools(),
      broadcast: silentBroadcast(),
    })

    await loop.dispatch(sid, { kind: 'user_message', text: 'x' })

    // Two LLM calls: the turn itself, then the auto-compact summarizer.
    expect(llmCalls).toHaveLength(2)
    expect(llmCalls[1]!.sys).toMatch(/summarizer/i)
    const after = store.get(sid)!
    // After compact: system prompt + summary = 2 messages.
    expect(after.state.messages).toHaveLength(2)
    expect(after.state.messages[1]!.content[0]).toEqual({
      type: 'text',
      text: 'auto-summary',
    })
    // Pressure recomputed on the reduced input tokens  -  back to 'none'.
    expect(after.state.contextPressureLevel).toBe('none')
  })

  it('pipes streaming text deltas through the broadcast', async () => {
    // Adapter fake that yields three text chunks synchronously, then returns
    // the assembled assistant message. Mirrors what the real anthropic /
    // openai adapters do when `onTextDelta` is present.
    const chunks = ['hel', 'lo ', 'world']
    const llm: LLMAdapter = {
      name: 'streaming-fake',
      async call({ onTextDelta }) {
        if (onTextDelta) for (const c of chunks) onTextDelta(c)
        return {
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: chunks.join('') }],
          },
          usage: { inputTokens: 1, outputTokens: 3 },
        }
      },
    }
    const deltas: string[] = []
    const appendedKinds: string[] = []
    const broadcast: LoopBroadcast = {
      onEvent: (_sid, _seq, event) => {
        appendedKinds.push(event.kind)
      },
      onApprovalRequired: () => {},
      onError: () => {},
      onUsageChanged: () => {},
      onTokenDelta: (_sid, t) => {
        deltas.push(t)
      },
    }
    const loop = runHostLoop({ store, llm, tools: nullTools(), broadcast })
    await loop.dispatch(sessionId, { kind: 'user_message', text: 'hi' })

    expect(deltas).toEqual(chunks)
    // Exactly one llm_response landed in the log  -  deltas are UI-only.
    const parsed = await readSessionLog(store.get(sessionId)!.logPath)
    const llmResponses = parsed.events.filter(
      (e) => e.event.kind === 'llm_response',
    )
    expect(llmResponses).toHaveLength(1)
    if (llmResponses[0]!.event.kind === 'llm_response') {
      expect(llmResponses[0]!.event.message.content[0]).toEqual({
        type: 'text',
        text: 'hello world',
      })
    }
    // Sanity: an event:appended fires for the user + the final response, but
    // NOT one per delta.
    expect(appendedKinds).toEqual(['user_message', 'llm_response'])
    // ...state should have used deltas without extra usage records:
    void state
  })

  it('cancelStream aborts an in-flight streaming LLM call', async () => {
    // The adapter observes the AbortSignal and rejects with an AbortError,
    // matching how fetch(signal) rejects. The loop must convert that into a
    // finalised `llm_response` with a `[cancelled]` suffix so the FSM
    // doesn't hang in `thinking`.
    let seenSignal: AbortSignal | undefined
    let listenerReady: (() => void) | undefined
    const listenerReadyPromise = new Promise<void>((r) => {
      listenerReady = r
    })
    const llm: LLMAdapter = {
      name: 'abortable',
      async call({ onTextDelta, signal }) {
        seenSignal = signal
        onTextDelta?.('partial ')
        return await new Promise<LLMResponse>((_resolve, reject) => {
          if (signal) {
            signal.addEventListener('abort', () => {
              const err = new Error('aborted')
              err.name = 'AbortError'
              reject(err)
            })
          }
          listenerReady!()
        })
      },
    }
    const broadcast: LoopBroadcast = {
      onEvent: () => {},
      onApprovalRequired: () => {},
      onError: () => {},
      onUsageChanged: () => {},
      onTokenDelta: () => {},
    }
    const loop = runHostLoop({ store, llm, tools: nullTools(), broadcast })
    const done = loop.dispatch(sessionId, { kind: 'user_message', text: 'hi' })
    await listenerReadyPromise
    loop.cancelStream(sessionId)
    await done

    expect(seenSignal).toBeDefined()
    const parsed = await readSessionLog(store.get(sessionId)!.logPath)
    const last = parsed.events[parsed.events.length - 1]!
    expect(last.event.kind).toBe('llm_response')
    if (last.event.kind === 'llm_response') {
      const text = last.event.message.content
        .filter((c) => c.type === 'text')
        .map((c) => (c as { type: 'text'; text: string }).text)
        .join('')
      expect(text).toMatch(/\[cancelled\]$/)
      expect(text).toMatch(/^partial /)
    }
  })

  it('handles agent tool calls inside the host and records a child session', async () => {
    const parentConfig = createConfig({ tools: [AGENT], systemPrompt: 'sys' })
    const parent = await store.create({
      config: parentConfig,
      sessionId: 'sess-agent-parent',
      workspaceId: 'ws-agent',
    })
    const llm = scriptedLlm([
      {
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_call',
              callId: 'agent-1',
              name: 'agent',
              input: { prompt: 'answer the question' },
            },
          ],
        },
      },
      {
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '42' }],
        },
      },
      {
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'parent done' }],
        },
      },
    ])
    const loop = runHostLoop({
      store,
      llm,
      tools: nullTools({
        callTool: async () => {
          throw new Error('agent should not dispatch to executor')
        },
      }),
      broadcast: silentBroadcast(),
    })

    await loop.dispatch(parent.sessionId, { kind: 'user_message', text: 'go' })

    const parentLog = await readSessionLog(parent.logPath)
    const toolResult = parentLog.events.find(
      (e) => e.event.kind === 'tool_result' && e.event.callId === 'agent-1',
    )
    expect(toolResult?.event).toMatchObject({
      kind: 'tool_result',
      ok: true,
      content: '42',
    })

    const children = store
      .list()
      .filter((r) => r.parentSessionId === parent.sessionId)
    expect(children).toHaveLength(1)
    expect(children[0]!.workspaceId).toBe('ws-agent')
    const childLog = await readSessionLog(children[0]!.logPath)
    expect(childLog.header.parentSessionId).toBe(parent.sessionId)
    expect(children[0]!.state.status).toBe('done')
  })

  it('spawned sub-agents run with allow_all regardless of parent approval mode (ADR 0014)', async () => {
    // Regression: parents in `auto`/`ask` used to hand their mode down to the
    // child. But sub-agents are headless  -  no dashboard is subscribed to the
    // child session, so a RequestApprovalEffect would deadlock forever and
    // the parent would see `tool_result: ok=false, "agent ended with status
    // awaiting_approval"`. See docs/adr/0014-subagent-approval-mode.md.
    const parentConfig = createConfig({ tools: [AGENT], systemPrompt: 'sys' })
    const parent = await store.create({
      config: parentConfig,
      sessionId: 'sess-approval-parent',
      workspaceId: 'ws-approval',
      initialApprovalMode: 'auto',
    })
    expect(parent.state.approvalMode).toBe('auto')

    const llm = scriptedLlm([
      {
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_call',
              callId: 'agent-approval',
              name: 'agent',
              input: { prompt: 'do a thing' },
            },
          ],
        },
      },
      {
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'child done' }],
        },
      },
      {
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'parent done' }],
        },
      },
    ])
    const loop = runHostLoop({
      store,
      llm,
      tools: nullTools(),
      broadcast: silentBroadcast(),
    })

    await loop.dispatch(parent.sessionId, { kind: 'user_message', text: 'go' })

    const children = store
      .list()
      .filter((r) => r.parentSessionId === parent.sessionId)
    expect(children).toHaveLength(1)
    expect(children[0]!.state.approvalMode).toBe('allow_all')
    // Parent's own mode is untouched.
    expect(store.get(parent.sessionId)!.state.approvalMode).toBe('auto')
  })

  it('pre_tool_use hook blocks the tool call when it fails', async () => {
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
          content: [{ type: 'text', text: 'ok' }],
        },
      },
    ])
    let executorCalled = false
    const tools = nullTools({
      callTool: async () => {
        executorCalled = true
        return { ok: true, content: 'nope' }
      },
    })
    const loop = runHostLoop({
      store,
      llm,
      tools,
      broadcast: silentBroadcast(),
      hooks: [{ event: 'pre_tool_use', command: '_ignored' }],
      hookRunner: {
        run: async () => ({
          ok: false,
          exitCode: 3,
          stdout: 'denied by policy',
          stderr: '',
        }),
      },
    })

    await loop.dispatch(sessionId, { kind: 'user_message', text: 'read x' })

    expect(executorCalled).toBe(false)
    const rec = store.get(sessionId)!
    const parsed = await readSessionLog(rec.logPath)
    const toolResult = parsed.events.find((e) => e.event.kind === 'tool_result')
    expect(toolResult?.event).toMatchObject({
      kind: 'tool_result',
      ok: false,
    })
    const content =
      toolResult?.event.kind === 'tool_result' ? toolResult.event.content : ''
    expect(content).toContain('blocked by pre_tool_use hook')
    expect(content).toContain('denied by policy')
  })

  it('post_tool_use hook fires after a successful tool call', async () => {
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
          content: [{ type: 'text', text: 'ok' }],
        },
      },
    ])
    const tools = nullTools({
      callTool: async () => ({ ok: true, content: 'hello file' }),
    })
    let postSeen = false
    const loop = runHostLoop({
      store,
      llm,
      tools,
      broadcast: silentBroadcast(),
      hooks: [{ event: 'post_tool_use', command: '_ignored' }],
      hookRunner: {
        run: async (_hook, payload) => {
          if (payload.event === 'post_tool_use') {
            postSeen = true
            expect(payload.toolResult).toEqual({ ok: true, content: 'hello file' })
          }
          return { ok: true, exitCode: 0, stdout: '', stderr: '' }
        },
      },
    })

    await loop.dispatch(sessionId, { kind: 'user_message', text: 'read x' })

    expect(postSeen).toBe(true)
    const rec = store.get(sessionId)!
    expect(rec.state.status).toBe('done')
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
