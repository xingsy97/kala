import { generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { ed25519Verifier } from './update-runtime.js'

describe('managed update trust root', () => {
  it('accepts only manifests signed by the pinned Ed25519 key', async () => {
    const trusted = generateKeyPairSync('ed25519')
    const other = generateKeyPairSync('ed25519')
    const payload = JSON.stringify({ release: '1.2.3' })
    const verifier = ed25519Verifier(trusted.publicKey.export({ type: 'spki', format: 'pem' }).toString())
    const good = sign(null, Buffer.from(payload), trusted.privateKey).toString('base64')
    const bad = sign(null, Buffer.from(payload), other.privateKey).toString('base64')
    expect(await verifier.verify(payload, good)).toBe(true)
    expect(await verifier.verify(payload, bad)).toBe(false)
  })
})
