/**
 * Tests for the compaction extension's robustness paths — the ones the
 * doc calls out as must-be-observable-and-bounded: circuit breaker,
 * PTL retry ladder, empty-summary rejection, reducer-rejection detection,
 * tool_result batch back-off, unknown-context fallback, and preflight
 * emergency truncation.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createConfig } from '@agent-kernel/kernel'
import type { AgentConfig, AgentEvent, Message } from '@agent-kernel/kernel'

import { SessionStore } from '../store/session.js'
import { readSessionLog } from '../store/log.js'
import { runHostLoop } from '../loop.js'
import type { LoopBroadcast, ToolDispatcher } from '../loop.js'
import type { LLMAdapter, LLMCallParams } from '../llm/adapter.js'
import { resetCompactRuntime } from './compaction.js'

function silentBroadcast(): LoopBroadcast {
  return { onEvent() {}, onApprovalRequired() {}, onError() {} }
}

function nullTools(overrides: Partial<ToolDispatcher> = {}): ToolDispatcher {
  return {
    callTool: async () => ({ ok: true, content: 'ok' }),
    cancelPending: () => {},
    ...overrides,
  }
}

const READ = {
  name: 'read',
  description: 'read',
  inputSchema: { type: 'object' },
  requiresApproval: false,
} as const

type CompactSkippedEvent = Extract<AgentEvent, { kind: 'compact_skipped' }>
type CompactReplacedEvent = Extract<AgentEvent, { kind: 'compact_replaced' }>
type CompactRejectedEvent = Extract<AgentEvent, { kind: 'compact_rejected' }>

async function readSkipEvents(logPath: string): Promise<CompactSkippedEvent[]> {
  const parsed = await readSessionLog(logPath)
  return parsed.events
    .filter((e) => e.event.kind === 'compact_skipped')
    .map((e) => e.event as CompactSkippedEvent)
}

async function readReplacedEvents(logPath: string): Promise<CompactReplacedEvent[]> {
  const parsed = await readSessionLog(logPath)
  return parsed.events
    .filter((e) => e.event.kind === 'compact_replaced')
    .map((e) => e.event as CompactReplacedEvent)
}

async function readRejectedEvents(logPath: string): Promise<CompactRejectedEvent[]> {
  const parsed = await readSessionLog(logPath)
  return parsed.events
    .filter((e) => e.event.kind === 'compact_rejected')
    .map((e) => e.event as CompactRejectedEvent)
}

/** A minimal summary that passes validateCompactionSummary (all required sections present). */
const OK_SUMMARY = `# Compacted Context
## User Intent And Constraints
Do the thing.
## Repository And Runtime State
Repo state.
## Decisions And Rationale
Decided.
## Work Completed
Done.
## Open Work
None.`

function summaryReply(text: string = OK_SUMMARY, extra: Record<string, unknown> = {}) {
  return {
    message: { role: 'assistant' as const, content: [{ type: 'text' as const, text }] },
    usage: { inputTokens: 5, outputTokens: 5 },
    ...extra,
  }
}

function turnReply(text: string = 'ok') {
  return {
    message: { role: 'assistant' as const, content: [{ type: 'text' as const, text }] },
    usage: { inputTokens: 5, outputTokens: 1 },
  }
}

describe('compaction extension', () => {
  let dir: string
  let store: SessionStore
  let config: AgentConfig
  let sessionId: string

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'agent-kernel-compact-'))
    store = new SessionStore(dir)
    config = createConfig({ tools: [READ], systemPrompt: 'sys' })
    const rec = await store.create({ config, sessionId: 'sess-1' })
    sessionId = rec.sessionId
    resetCompactRuntime(sessionId)
  })

  afterEach(() => {
    resetCompactRuntime(sessionId)
    rmSync(dir, { recursive: true, force: true })
  })

  it('summarizer failures increment the counter; three non-manual failures open the breaker', async () => {
    let call = 0
    const llm: LLMAdapter = {
      name: 'fail-mock',
      async call() {
        call += 1
        if (call === 1) return turnReply()
        throw new Error('summarizer boom')
      },
    }
    const loop = runHostLoop({ store, llm, tools: nullTools(), broadcast: silentBroadcast() })
    await loop.dispatch(sessionId, { kind: 'user_message', text: 'hi' })

    // Three failed auto triggers (each is a no-op on error, not a throw).
    for (let i = 0; i < 3; i++) await loop.compact(sessionId, 'auto')

    // 4th auto trigger must be short-circuited by the breaker.
    await loop.compact(sessionId, 'auto')

    const rec = store.get(sessionId)!
    const skips = await readSkipEvents(rec.logPath)
    expect(skips.filter((s) => s.reason === 'summarizer_failed').length).toBe(3)
    expect(skips.filter((s) => s.reason === 'circuit_breaker_open').length).toBeGreaterThanOrEqual(1)
  })

  it('manual bypasses the open breaker and success closes it', async () => {
    let call = 0
    const llm: LLMAdapter = {
      name: 'recover-mock',
      async call() {
        call += 1
        if (call === 1) return turnReply()
        // Fail the first three summarizer calls, then succeed on any later call.
        if (call <= 4) throw new Error('boom')
        return summaryReply()
      },
    }
    const loop = runHostLoop({ store, llm, tools: nullTools(), broadcast: silentBroadcast() })
    await loop.dispatch(sessionId, { kind: 'user_message', text: 'hi' })

    // Open the breaker with 3 auto failures.
    for (let i = 0; i < 3; i++) await loop.compact(sessionId, 'auto')

    // Confirm auto now short-circuits.
    await loop.compact(sessionId, 'auto')
    let rec = store.get(sessionId)!
    let skips = await readSkipEvents(rec.logPath)
    expect(skips.some((s) => s.reason === 'circuit_breaker_open')).toBe(true)

    // Manual: bypasses the breaker; keep trying manual until one succeeds.
    // (Whether an individual failing manual throws or is skipped is
    // implementation detail; we only need one successful compact_replaced.)
    for (let i = 0; i < 5; i++) {
      try {
        await loop.compact(sessionId, 'manual')
      } catch {
        // fall through
      }
      const replaced = await readReplacedEvents(store.get(sessionId)!.logPath)
      if (replaced.length > 0) break
    }
    const replaced = await readReplacedEvents(store.get(sessionId)!.logPath)
    expect(replaced.length).toBeGreaterThanOrEqual(1)

    // Auto should no longer short-circuit with circuit_breaker_open.
    rec = store.get(sessionId)!
    const skipsBefore = (await readSkipEvents(rec.logPath)).length
    await loop.compact(sessionId, 'auto')
    skips = await readSkipEvents(rec.logPath)
    const newSkips = skips.slice(skipsBefore)
    expect(newSkips.every((s) => s.reason !== 'circuit_breaker_open')).toBe(true)
  })

  it('empty summary is rejected: no compact_replaced, empty_summary skip emitted', async () => {
    let call = 0
    const llm: LLMAdapter = {
      name: 'empty-mock',
      async call() {
        call += 1
        if (call === 1) return turnReply()
        return {
          message: { role: 'assistant', content: [{ type: 'text', text: '   \n  ' }] },
          usage: { inputTokens: 5, outputTokens: 0 },
        }
      },
    }
    const loop = runHostLoop({ store, llm, tools: nullTools(), broadcast: silentBroadcast() })
    await loop.dispatch(sessionId, { kind: 'user_message', text: 'hi' })
    const before = store.get(sessionId)!.state.messages.length

    await expect(loop.compact(sessionId)).rejects.toThrow(/empty/i)

    const rec = store.get(sessionId)!
    expect(rec.state.messages.length).toBe(before)
    expect(await readReplacedEvents(rec.logPath)).toHaveLength(0)
    const skips = await readSkipEvents(rec.logPath)
    expect(skips.some((s) => s.reason === 'empty_summary')).toBe(true)
  })

  it('manual compact on empty session emits nothing_to_compact throw', async () => {
    const llm: LLMAdapter = {
      name: 'unused',
      async call() {
        throw new Error('should not be called')
      },
    }
    const loop = runHostLoop({ store, llm, tools: nullTools(), broadcast: silentBroadcast() })
    await expect(loop.compact(sessionId)).rejects.toThrow(/nothing to compact/i)
  })

  it('manual compact can re-compact a prior compact summary', async () => {
    let call = 0
    const llm: LLMAdapter = {
      name: 'recompact-summary-mock',
      async call() {
        call += 1
        if (call === 1) return turnReply()
        if (call === 2) return summaryReply(`${OK_SUMMARY}\n\nFirst pass.`)
        return summaryReply(`${OK_SUMMARY}\n\nSecond pass.`)
      },
    }
    const loop = runHostLoop({ store, llm, tools: nullTools(), broadcast: silentBroadcast() })
    await loop.dispatch(sessionId, { kind: 'user_message', text: 'hi' })
    await loop.compact(sessionId)

    let rec = store.get(sessionId)!
    expect(rec.state.messages.map((m) => m.role)).toEqual(['system', 'system'])
    expect(rec.state.messages[1]?.content).toEqual([{ type: 'text', text: `${OK_SUMMARY}\n\nFirst pass.` }])

    await loop.compact(sessionId)

    rec = store.get(sessionId)!
    expect(rec.state.messages.map((m) => m.role)).toEqual(['system', 'system'])
    expect(rec.state.messages[1]?.content).toEqual([{ type: 'text', text: `${OK_SUMMARY}\n\nSecond pass.` }])
    const replaced = await readReplacedEvents(rec.logPath)
    expect(replaced).toHaveLength(2)
    expect(replaced[1]?.request?.messages.map((m) => m.role)).toEqual(['system', 'system'])
  })

  it('compact_replaced carries a cmp_ attemptId', async () => {
    let call = 0
    const llm: LLMAdapter = {
      name: 'attempt-mock',
      async call() {
        call += 1
        if (call === 1) return turnReply()
        return summaryReply()
      },
    }
    const loop = runHostLoop({ store, llm, tools: nullTools(), broadcast: silentBroadcast() })
    await loop.dispatch(sessionId, { kind: 'user_message', text: 'hi' })
    await loop.compact(sessionId)

    const rec = store.get(sessionId)!
    const replaced = await readReplacedEvents(rec.logPath)
    expect(replaced).toHaveLength(1)
    expect(replaced[0]!.attemptId).toMatch(/^cmp_/)
  })

  it('compact_replaced persists the summarizer LLM trace and model', async () => {
    let call = 0
    const llm: LLMAdapter = {
      name: 'trace-mock',
      async call() {
        call += 1
        if (call === 1) return turnReply()
        return summaryReply(OK_SUMMARY, {
          trace: {
            provider: 'openai',
            model: 'gpt-compact-test',
            request: {
              url: 'https://api.openai.com/v1/chat/completions',
              headers: { authorization: 'Bearer test' },
              body: { model: 'gpt-compact-test', messages: [{ role: 'user', content: 'compact' }] },
            },
            response: { status: 200, metrics: { durationMs: 1234, timeToFirstChunkMs: 210 } },
          },
        })
      },
    }
    const loop = runHostLoop({ store, llm, tools: nullTools(), broadcast: silentBroadcast() })
    await loop.dispatch(sessionId, { kind: 'user_message', text: 'hi' })
    await loop.compact(sessionId)

    const parsed = await readSessionLog(store.get(sessionId)!.logPath)
    const compactEntry = parsed.events.find((e) => e.event.kind === 'compact_replaced')
    expect(compactEntry?.llmTraceArtifact?.path).toContain('llm-traces')
    expect(compactEntry?.model).toBe('gpt-compact-test')
  })

  it('summarizer path passes thinkingBudget: 0 to disable extended thinking', async () => {
    let call = 0
    const seen: LLMCallParams[] = []
    const llm: LLMAdapter = {
      name: 'thinking-mock',
      async call(p) {
        call += 1
        seen.push(p)
        if (call === 1) return turnReply()
        return summaryReply()
      },
    }
    const loop = runHostLoop({ store, llm, tools: nullTools(), broadcast: silentBroadcast() })
    await loop.dispatch(sessionId, { kind: 'user_message', text: 'hi' })
    await loop.compact(sessionId)

    // Second call is the summarizer.
    expect(seen[1]!.thinkingBudget).toBe(0)
  })

  it('PTL retry ladder progresses through rungs and eventually succeeds', async () => {
    // Simulate 2 successive PTL errors, then success. This should exhaust
    // rungs 1 & 2 (progressively tighter tool-result caps) and land on rung 3
    // (head-drop 1). Third summarizer call succeeds.
    let call = 0
    const llm: LLMAdapter = {
      name: 'ptl-mock',
      async call() {
        call += 1
        if (call === 1) return turnReply()
        // Summarizer calls (call 2, 3, ...): first two throw PTL, third OK.
        if (call === 2 || call === 3) throw new Error('prompt is too long for this model')
        return summaryReply()
      },
    }
    const loop = runHostLoop({ store, llm, tools: nullTools(), broadcast: silentBroadcast() })
    await loop.dispatch(sessionId, { kind: 'user_message', text: 'hi' })

    await loop.compact(sessionId) // must NOT throw despite 2 PTL failures

    expect(call).toBeGreaterThanOrEqual(4) // 1 turn + at least 3 summarizer attempts
    const rec = store.get(sessionId)!
    const replaced = await readReplacedEvents(rec.logPath)
    expect(replaced).toHaveLength(1)
  })

  it('PTL ladder exhaustion counts as one failure (not one per rung)', async () => {
    let call = 0
    const llm: LLMAdapter = {
      name: 'ptl-exhaust-mock',
      async call() {
        call += 1
        if (call === 1) return turnReply()
        throw new Error('input exceeds model context window')
      },
    }
    const loop = runHostLoop({ store, llm, tools: nullTools(), broadcast: silentBroadcast() })
    await loop.dispatch(sessionId, { kind: 'user_message', text: 'hi' })

    await loop.compact(sessionId, 'auto')

    // One skip event, not four (one per rung). All 4 ladder attempts were
    // made (call is 5: 1 turn + 4 rungs), but the failure counter got a
    // single increment.
    const rec = store.get(sessionId)!
    const skips = await readSkipEvents(rec.logPath)
    expect(skips.filter((s) => s.reason === 'summarizer_failed')).toHaveLength(1)
    expect(call).toBe(5)
  })

  it('non-PTL error bubbles out of the ladder without retrying', async () => {
    let call = 0
    const llm: LLMAdapter = {
      name: 'non-ptl-mock',
      async call() {
        call += 1
        if (call === 1) return turnReply()
        throw new Error('rate limit hit')
      },
    }
    const loop = runHostLoop({ store, llm, tools: nullTools(), broadcast: silentBroadcast() })
    await loop.dispatch(sessionId, { kind: 'user_message', text: 'hi' })

    await loop.compact(sessionId, 'auto')

    // Only one summarizer call was made because the error was non-PTL.
    expect(call).toBe(2)
  })
})
