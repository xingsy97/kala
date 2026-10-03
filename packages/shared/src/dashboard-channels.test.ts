import { describe, expect, it } from 'vitest'
import { schema } from './index.js'

describe('dashboard channel contracts', () => {
  it('accepts bounded channel batches and rejects malformed channels', () => {
    expect(schema.ClientSubscribeChannelsSchema.parse({ requestId: 'r', generation: 2, channels: ['global', 'workspace:w', 'session:s'], cursors: { 'session:s': 4 } }).channels).toHaveLength(3)
    expect(() => schema.ClientSubscribeChannelsSchema.parse({ requestId: 'r', generation: 2, channels: ['bad:x'] })).toThrow()
    expect(() => schema.ClientSubscribeChannelsSchema.parse({ requestId: 'r', generation: -1, channels: [] })).toThrow()
  })

  it('defines deletion as one strict recursive operation', () => {
    expect(schema.ClientDeleteSessionSchema.safeParse({ operationId: 'delete-op', sessionId: 'root-session' }).success).toBe(true)
    expect(schema.ClientDeleteSessionSchema.safeParse({ operationId: 'delete-op', sessionId: 'root-session', cascade: false }).success).toBe(false)
  })

  it('validates incremental Session summary control updates', () => {
    const update = {
      kind: 'session_summary_changed',
      session: {
        sessionId: 'session-1',
        agentRuntime: 'copilot',
        executionMode: 'chat',
        createdAt: '2026-01-01T00:00:00.000Z',
        eventCount: 4,
        status: 'thinking',
      },
    }
    expect(schema.ControlUpdateSchema.parse(update)).toEqual(update)
    expect(schema.ControlUpdateSchema.safeParse({
      kind: 'session_summary_changed',
      session: { sessionId: 'session-1', eventCount: -1 },
    }).success).toBe(false)
  })
})
