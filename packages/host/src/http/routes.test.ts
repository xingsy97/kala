import { createServer, type ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'

import { attachJsonRoutes } from './routes.js'

describe('HTTP route ownership', () => {
  it('does not touch Engine.IO response headers', () => {
    const server = createServer()
    attachJsonRoutes(server, {})
    const listener = server.listeners('request')[0]
    expect(listener).toBeTypeOf('function')
    const setHeader = vi.fn(() => { throw new Error('headers already sent') })
    expect(() => listener?.(
      { url: '/socket.io/?EIO=4&transport=polling', headers: { origin: 'https://browser.example.test' } },
      { setHeader } as unknown as ServerResponse,
    )).not.toThrow()
    expect(setHeader).not.toHaveBeenCalled()
  })
})
