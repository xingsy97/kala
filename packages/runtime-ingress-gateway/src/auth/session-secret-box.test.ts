import { describe, expect, it } from 'vitest'
import { createSessionSecretBox } from './session-secret-box.js'

const oldKey = Buffer.alloc(32, 1)
const newKey = Buffer.alloc(32, 2)

describe('SessionSecretBox', () => {
  it('round-trips with random IVs and marks old keys for rotation', () => {
    const oldBox = createSessionSecretBox('old', [{ id: 'old', key: oldKey }])
    const encrypted = oldBox.encrypt('refresh-secret')
    const active = createSessionSecretBox('new', [{ id: 'old', key: oldKey }, { id: 'new', key: newKey }])
    expect(active.decrypt(encrypted)).toBe('refresh-secret')
    expect(active.needsRotation(encrypted)).toBe(true)
    const first = active.encrypt('refresh-secret'), second = active.encrypt('refresh-secret')
    expect(first.ciphertext).not.toBe(second.ciphertext)
    expect(active.needsRotation(first)).toBe(false)
  })

  it('rejects tampering and unknown key IDs', () => {
    const box = createSessionSecretBox('new', [{ id: 'new', key: newKey }])
    const encrypted = box.encrypt('refresh-secret')
    expect(() => box.decrypt({ ...encrypted, ciphertext: `${encrypted.ciphertext}A` })).toThrow()
    expect(() => box.decrypt({ ...encrypted, keyId: 'missing' })).toThrow('unknown session encryption key')
  })
})
