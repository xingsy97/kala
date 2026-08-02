import { describe, expect, it } from 'vitest'
import { ExecutorFleet } from './executor-fleet.js'

describe('executor fleet', () => {
  it('selects only active compatible executors and honors drain', () => {
    const fleet = new ExecutorFleet()
    fleet.upsert({ id: 'b', poolId: 'pool', labels: ['linux'], status: 'active', version: '1', capabilities: ['shell'] })
    fleet.upsert({ id: 'a', poolId: 'pool', labels: ['linux'], status: 'active', version: '1', capabilities: ['shell'] })
    expect(fleet.select({ poolId: 'pool', labels: ['linux'], requiredCapabilities: ['shell'] })?.id).toBe('a')
    fleet.setMode('a', 'draining')
    expect(fleet.select({ poolId: 'pool', requiredCapabilities: ['shell'] })?.id).toBe('b')
  })
})
