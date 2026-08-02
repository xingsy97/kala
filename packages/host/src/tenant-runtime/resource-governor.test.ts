import { describe, expect, it } from 'vitest'
import { UnitResourceGovernor } from './resource-governor.js'

describe('UnitResourceGovernor', () => {
  it('isolates concurrency and queue limits by Unit', () => {
    const governor = new UnitResourceGovernor({ maxConcurrentTurns: 1, maxQueuedMessages: 2, maxArtifactBytes: 10 })
    expect(governor.tryStartTurn('a')).toEqual({ ok: true })
    expect(governor.tryStartTurn('a')).toMatchObject({ ok: false, code: 'concurrency_limit' })
    expect(governor.tryStartTurn('b')).toEqual({ ok: true })
    governor.finishTurn('a')
    expect(governor.tryStartTurn('a')).toEqual({ ok: true })
    expect(governor.tryEnqueue('a')).toEqual({ ok: true })
    expect(governor.tryEnqueue('a')).toEqual({ ok: true })
    expect(governor.tryEnqueue('a')).toMatchObject({ ok: false, code: 'queue_limit' })
  })

  it('rejects artifacts before partial accounting and safely releases usage', () => {
    const governor = new UnitResourceGovernor({ maxConcurrentTurns: 1, maxQueuedMessages: 1, maxArtifactBytes: 10 })
    expect(governor.reserveArtifact('a', 8)).toEqual({ ok: true })
    expect(governor.reserveArtifact('a', 3)).toMatchObject({ ok: false, code: 'artifact_quota' })
    expect(governor.snapshot('a').artifactBytes).toBe(8)
    governor.releaseArtifact('a', 20)
    expect(governor.snapshot('a').artifactBytes).toBe(0)
  })
})
