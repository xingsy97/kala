import { afterEach, describe, expect, it, vi } from 'vitest'

import { scheduleBackground } from './scheduler.js'

describe('scheduleBackground', () => {
  afterEach(() => vi.useRealTimers())

  it('runs with the timeout fallback', async () => {
    const task = scheduleBackground(() => 42)
    await expect(task.promise).resolves.toBe(42)
  })

  it('prevents cancelled fallback work from running', async () => {
    const run = vi.fn(() => 42)
    const task = scheduleBackground(run)
    const rejection = expect(task.promise).rejects.toMatchObject({ name: 'AbortError' })
    task.cancel()
    expect(run).not.toHaveBeenCalled()
    await rejection
  })

  it('waits for work that was already running when cancelled', async () => {
    let release!: () => void
    const barrier = new Promise<void>((resolve) => { release = resolve })
    const task = scheduleBackground(async (signal) => {
      await barrier
      return signal.aborted ? 'cancelled after work settled' : 'completed'
    })
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
    task.cancel()
    let settled = false
    void task.promise.finally(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    release()
    await expect(task.promise).resolves.toBe('cancelled after work settled')
  })

  it('rejects when the scheduled callback throws synchronously', async () => {
    const task = scheduleBackground(() => { throw new Error('background failure') })
    await expect(task.promise).rejects.toThrow('background failure')
  })
})
