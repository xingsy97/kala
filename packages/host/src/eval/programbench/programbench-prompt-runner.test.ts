import { afterEach, describe, expect, it, vi } from 'vitest'

import { budgetedLlmAdapter, createInactivityWatchdog, createPromptBudgetGate } from '../../../bin/run-agent-runlab-prompt.js'
import type { LLMAdapter } from '../llm/adapter.js'

describe('ProgramBench Agent RunLab prompt runner budget adapter', () => {
  it('returns a local terminal assistant response instead of calling the provider after budget exhaustion', async () => {
    let calls = 0
    const inner: LLMAdapter = {
      name: 'inner',
      async call() {
        calls += 1
        return {
          message: { role: 'assistant', content: [{ type: 'text', text: 'provider called' }] },
          finishReason: 'end_turn',
        }
      },
    }

    const wrapped = budgetedLlmAdapter(inner, () => true)
    const response = await wrapped.call({ messages: [], tools: [] })

    expect(calls).toBe(0)
    expect(response).toMatchObject({
      message: { role: 'assistant', content: [] },
      finishReason: 'agent_runlab_prompt_turn_limit',
    })
  })

  it('delegates while budget remains available', async () => {
    let calls = 0
    const inner: LLMAdapter = {
      name: 'inner',
      async call() {
        calls += 1
        return {
          message: { role: 'assistant', content: [{ type: 'text', text: 'provider called' }] },
          finishReason: 'end_turn',
        }
      },
    }

    const wrapped = budgetedLlmAdapter(inner, () => false)
    const response = await wrapped.call({ messages: [], tools: [] })

    expect(calls).toBe(1)
    expect(response.message.content).toEqual([{ type: 'text', text: 'provider called' }])
  })
})

describe('ProgramBench Agent RunLab prompt runner prompt budget gate', () => {
  it('exhausts only the active prompt budget and resets for a continuation prompt', () => {
    const budget = createPromptBudgetGate(2)

    budget.start(0, 2)
    expect(budget.recordResponse(1)).toBe(false)
    expect(budget.isExhausted()).toBe(false)
    expect(budget.recordResponse(2)).toBe(true)
    expect(budget.isExhausted()).toBe(true)

    budget.start(2, 1)
    expect(budget.isExhausted()).toBe(false)
    expect(budget.maxTurns()).toBe(1)
    expect(budget.recordResponse(3)).toBe(true)
    expect(budget.isExhausted()).toBe(true)
  })

  it('reports the budget-hit edge only once per prompt', () => {
    const budget = createPromptBudgetGate(1)

    budget.start(4, 1)
    expect(budget.recordResponse(5)).toBe(true)
    expect(budget.recordResponse(6)).toBe(false)
  })
})

describe('ProgramBench Agent RunLab prompt runner inactivity watchdog', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('rejects and calls the timeout hook when no loop events arrive', async () => {
    vi.useFakeTimers()
    let timedOut = 0
    const watchdog = createInactivityWatchdog(1000, () => {
      timedOut += 1
    })

    const pending = watchdog.wrap(new Promise<void>(() => {}))
    const assertion = expect(pending).rejects.toThrow(/inactive for 1000ms/)
    await vi.advanceTimersByTimeAsync(1000)

    await assertion
    expect(timedOut).toBe(1)
  })

  it('extends the inactivity window on loop events', async () => {
    vi.useFakeTimers()
    let timedOut = 0
    const watchdog = createInactivityWatchdog(1000, () => {
      timedOut += 1
    })

    const pending = watchdog.wrap(new Promise<void>(() => {}))
    const assertion = expect(pending).rejects.toThrow(/inactive for 1000ms/)
    await vi.advanceTimersByTimeAsync(700)
    watchdog.beat()
    await vi.advanceTimersByTimeAsync(700)
    expect(timedOut).toBe(0)
    await vi.advanceTimersByTimeAsync(300)

    await assertion
    expect(timedOut).toBe(1)
  })
})
