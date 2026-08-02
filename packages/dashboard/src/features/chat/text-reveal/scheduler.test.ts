import { describe, expect, it } from 'vitest'

import {
  shouldCommitStreamFrame,
  streamCommitInterval,
  streamReleaseCount,
} from './scheduler.js'

describe('stream scheduler', () => {
  it('targets about 30fps normally and 15fps while catching up', () => {
    expect(streamCommitInterval(20)).toBe(33)
    expect(streamCommitInterval(1_000)).toBe(66)
  })

  it('catches up with larger chunks instead of more commits', () => {
    expect(streamReleaseCount(20, 3)).toBe(3)
    expect(streamReleaseCount(300, 3)).toBe(24)
    expect(streamReleaseCount(900, 3)).toBe(64)
    expect(streamReleaseCount(2_500, 3)).toBe(200)
  })

  it('never commits visual frames while hidden', () => {
    expect(shouldCommitStreamFrame({
      now: 10_000,
      lastCommitAt: 0,
      backlog: 50,
      visible: false,
    })).toBe(false)
  })

  it('respects the interval for the current backlog', () => {
    expect(shouldCommitStreamFrame({ now: 32, lastCommitAt: 0, backlog: 10, visible: true })).toBe(false)
    expect(shouldCommitStreamFrame({ now: 33, lastCommitAt: 0, backlog: 10, visible: true })).toBe(true)
    expect(shouldCommitStreamFrame({ now: 65, lastCommitAt: 0, backlog: 900, visible: true })).toBe(false)
    expect(shouldCommitStreamFrame({ now: 66, lastCommitAt: 0, backlog: 900, visible: true })).toBe(true)
  })
})
