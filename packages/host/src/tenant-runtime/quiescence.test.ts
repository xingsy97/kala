import { describe, expect, it, vi } from 'vitest'

import { inspectUnitQuiescence } from './quiescence.js'

describe('Unit quiescence', () => {
  it('observes Session safety without entering drain', () => {
    const beginDrain = vi.fn()
    const drainSnapshot = vi.fn((sessionId: string) => sessionId === 'busy'
      ? { sessionId, status: 'thinking', safe: false, waiting: 'llm', pendingCalls: [], cursor: 3 }
      : { sessionId, status: 'done', safe: true, waiting: 'none', checkpointKind: 'resting', pendingCalls: [], cursor: 4 })
    const snapshot = inspectUnitQuiescence({
      store: { list: () => [{ sessionId: 'busy' }, { sessionId: 'resting' }] },
      loop: { drainSnapshot, beginDrain },
    } as never)

    expect(snapshot).toMatchObject({ safe: false, activeLlmCalls: 1, activeToolCalls: 0 })
    expect(snapshot.unsafeSessions).toEqual([expect.objectContaining({ sessionId: 'busy', waiting: 'llm' })])
    expect(drainSnapshot).toHaveBeenCalledTimes(2)
    expect(beginDrain).not.toHaveBeenCalled()
  })
})
