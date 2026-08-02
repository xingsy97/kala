import { describe, expect, it } from 'vitest'
import { readPairingJson } from './pairing-response.js'

describe('readPairingJson', () => {
  it('explains Cloudflare or proxy sign-in HTML without leaking a JSON parser stack', async () => {
    const response = new Response('<!DOCTYPE html><title>Sign in</title>', { status: 302, headers: { 'content-type': 'text/html', location: 'https://access.example/login' } })
    await expect(readPairingJson(response, 'start pairing', 'https://runlab.example/auth/executor-pairings')).rejects.toThrow('Allow unauthenticated access to /auth/executor-pairings')
  })

  it('accepts a JSON pairing response', async () => {
    const response = new Response(JSON.stringify({ id: 'pair_1', code: '123456' }), { status: 200, headers: { 'content-type': 'application/json' } })
    await expect(readPairingJson(response, 'start pairing', 'https://runlab.example/auth/executor-pairings')).resolves.toEqual({ id: 'pair_1', code: '123456' })
  })
})
