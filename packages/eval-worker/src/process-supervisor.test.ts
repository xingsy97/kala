import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, it, vi } from 'vitest'

import { supervise } from './process-supervisor.js'

describe('supervise', () => {
  it('returns on the absolute deadline even when the operation ignores AbortSignal', async () => {
    const started = Date.now()
    const onCancel = vi.fn(async () => undefined)
    const result = await supervise({
      timeoutMs: 20,
      cancellationGraceMs: 10,
      operation: async () => await new Promise<never>(() => undefined),
      onCancel,
    })
    expect(result.status).toBe('timeout')
    expect(Date.now() - started).toBeLessThan(250)
    expect(onCancel).toHaveBeenCalledOnce()
  })

  it('classifies external abort as cancellation', async () => {
    const controller = new AbortController()
    const resultPromise = supervise({
      timeoutMs: 1_000,
      cancellationGraceMs: 10,
      signal: controller.signal,
      operation: async (signal) => {
        await delay(1_000, undefined, { signal })
        return 'unreachable'
      },
    })
    controller.abort(new Error('operator cancelled'))
    await expect(resultPromise).resolves.toMatchObject({ status: 'cancelled' })
  })
})
