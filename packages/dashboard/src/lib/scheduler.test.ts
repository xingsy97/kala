import { afterEach, describe, expect, it, vi } from 'vitest'

import { scheduleBackground, scheduleFrameTask } from './scheduler.js'

describe('scheduleFrameTask', () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

  it('flushes logical state when rendering frames are suspended, regardless of page visibility', () => {
    vi.useFakeTimers()
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => { frames.push(callback); return frames.length }))
    const cancelFrame = vi.fn()
    vi.stubGlobal('cancelAnimationFrame', cancelFrame)
    const run = vi.fn()
    scheduleFrameTask(run)
    vi.advanceTimersByTime(99)
    expect(run).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(run).toHaveBeenCalledOnce()
    expect(cancelFrame).toHaveBeenCalledWith(1)
    frames[0]!(100)
    expect(run).toHaveBeenCalledOnce()
  })

  it('uses normal animation-frame batching without a duplicate timeout flush', () => {
    vi.useFakeTimers()
    let frame: FrameRequestCallback = () => {}
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => { frame = callback; return 1 }))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const run = vi.fn()
    scheduleFrameTask(run)
    frame(16)
    vi.advanceTimersByTime(200)
    expect(run).toHaveBeenCalledOnce()
  })

  it('cancels both channels so session switches cannot flush stale queued state', () => {
    vi.useFakeTimers()
    let frame: FrameRequestCallback = () => {}
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => { frame = callback; return 1 }))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const run = vi.fn()
    scheduleFrameTask(run)()
    vi.advanceTimersByTime(200)
    frame(200)
    expect(run).not.toHaveBeenCalled()
  })
})

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
