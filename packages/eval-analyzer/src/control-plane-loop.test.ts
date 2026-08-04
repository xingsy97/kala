import { describe, expect, it, vi } from 'vitest'

import { runControlPlaneLoop } from './control-plane-loop.js'

describe('Control Plane executor loop', () => {
  it('survives a transient rolling-restart disconnect and resumes polling', async () => {
    const controller = new AbortController()
    const refused = Object.assign(new Error('connect refused'), { code: 'ECONNREFUSED' })
    const fetchFailure = Object.assign(new TypeError('fetch failed'), { cause: refused })
    const runOnce = vi.fn()
      .mockRejectedValueOnce(fetchFailure)
      .mockImplementationOnce(async () => controller.abort(new Error('test complete')))

    await expect(runControlPlaneLoop({
      signal: controller.signal,
      pollIntervalMs: 1,
      runOnce,
    })).resolves.toBeUndefined()
    expect(runOnce).toHaveBeenCalledTimes(2)
  })

  it('does not hide protocol or application failures', async () => {
    const failure = new Error('invalid canonical analysis job')
    await expect(runControlPlaneLoop({
      pollIntervalMs: 1,
      runOnce: async () => { throw failure },
    })).rejects.toBe(failure)
  })
})
