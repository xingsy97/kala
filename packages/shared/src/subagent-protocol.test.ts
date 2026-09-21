import { describe, expect, it } from 'vitest'

import { ServerSubAgentStartedEventSchema } from './schema/dashboard-outbound.js'

describe('sub-agent lifecycle protocol', () => {
  const base = {
    parentSessionId: 'parent-1',
    parentCallId: 'call-1',
    childSessionId: 'child-1',
    prompt: 'internal detailed prompt',
    startedAt: '2026-09-19T05:00:00.000Z',
  }

  it('carries an explicit readable intention to the Dashboard', () => {
    expect(ServerSubAgentStartedEventSchema.parse({
      ...base,
      intention: 'Inspect the lifecycle projection for missing metadata.',
    }).intention).toBe('Inspect the lifecycle projection for missing metadata.')
  })

  it('accepts historical start events without intention', () => {
    expect(ServerSubAgentStartedEventSchema.parse(base)).not.toHaveProperty('intention')
  })
})
