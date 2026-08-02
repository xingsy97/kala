import { describe, expect, it } from 'vitest'
import { validateOutboundEndpoint } from './connection-diagnostics.js'

describe('enterprise executor endpoint', () => {
  it('requires TLS outside loopback', () => {
    expect(validateOutboundEndpoint('wss://runlab.example').protocol).toBe('wss:')
    expect(validateOutboundEndpoint('http://localhost:13001').hostname).toBe('localhost')
    expect(() => validateOutboundEndpoint('http://runlab.example')).toThrow('requires TLS')
  })
})
