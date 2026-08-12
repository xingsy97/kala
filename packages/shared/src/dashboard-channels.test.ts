import { describe, expect, it } from 'vitest'
import { schema } from './index.js'

describe('dashboard channel contracts', () => {
  it('accepts bounded channel batches and rejects malformed channels', () => {
    expect(schema.ClientSubscribeChannelsSchema.parse({ requestId: 'r', generation: 2, channels: ['global', 'workspace:w', 'session:s'], cursors: { 'session:s': 4 } }).channels).toHaveLength(3)
    expect(() => schema.ClientSubscribeChannelsSchema.parse({ requestId: 'r', generation: 2, channels: ['bad:x'] })).toThrow()
    expect(() => schema.ClientSubscribeChannelsSchema.parse({ requestId: 'r', generation: -1, channels: [] })).toThrow()
  })
})
