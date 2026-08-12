import { describe, expect, it, vi } from 'vitest'

import { randomId } from './random-id.js'

describe('randomId', () => {
  it('falls back to a UUID-shaped id when randomUUID is unavailable', () => {
    const original = globalThis.crypto
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { getRandomValues: (bytes: Uint8Array) => { bytes.fill(7); return bytes } } })
    try {
      expect(randomId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u)
    } finally {
      Object.defineProperty(globalThis, 'crypto', { configurable: true, value: original })
    }
  })

  it('uses native randomUUID when available', () => {
    const native = vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000000')
    expect(randomId()).toBe('00000000-0000-4000-8000-000000000000')
    native.mockRestore()
  })
})
