import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { EvidenceArchive } from './evidence-archive.js'

describe('canonical evidence archive', () => {
  it('indexes existing standalone lifecycle and closed-loop evidence without mutating it', async () => {
    const archive = new EvidenceArchive(resolve(process.cwd(), '../../docs/evidence/evaluation'))
    await archive.initialize()
    const flagship = archive.runs.get('fresh-fault-scenarios-20260803100157-8557')
    expect(archive.rootAvailable).toBe(true)
    expect(archive.documents.size).toBeGreaterThan(40)
    expect(flagship).toMatchObject({ taskPackId: 'fault-scenarios', state: 'completed', trialCount: 15, passedTrials: 15, failedTrials: 0 })
    expect(flagship?.trials.every((trial) => trial.outcome === 'passed')).toBe(true)
    expect(archive.conclusions.some((item) => item.kind === 'regression' && item.status === 'pass')).toBe(true)
    expect(archive.conclusions.some((item) => item.kind === 'insight' && item.recommendation?.includes('observe the failing command'))).toBe(true)
  })
})
