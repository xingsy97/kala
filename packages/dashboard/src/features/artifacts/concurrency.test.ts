import { describe, expect, it } from 'vitest'

import { mapWithConcurrency } from './concurrency.js'

describe('mapWithConcurrency', () => {
  it('preserves input order while limiting concurrent work', async () => {
    let active = 0
    let maxActive = 0
    const resolvers: Array<() => void> = []
    const resultPromise = mapWithConcurrency([1, 2, 3, 4], 2, async (value) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise<void>((resolve) => resolvers.push(resolve))
      active -= 1
      return value * 10
    })
    await Promise.resolve()
    expect(active).toBe(2)
    resolvers.shift()?.()
    await Promise.resolve()
    resolvers.shift()?.()
    await Promise.resolve()
    resolvers.shift()?.()
    await Promise.resolve()
    resolvers.shift()?.()

    await expect(resultPromise).resolves.toEqual([10, 20, 30, 40])
    expect(maxActive).toBe(2)
  })
})
