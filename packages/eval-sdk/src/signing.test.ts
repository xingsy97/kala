import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { RotatingEd25519Signer } from './signing.js'
import { rotatingBearerToken, resolveCredentialProvider } from './credentials.js'

describe('rotating service credentials', () => {
  it('reads bearer tokens on every request and rejects malformed rotations', async () => {
    let token = 'token-one'
    const getToken = resolveCredentialProvider(rotatingBearerToken(async () => token))
    await expect(getToken()).resolves.toBe('token-one')
    token = 'token-two'
    await expect(getToken()).resolves.toBe('token-two')
    token = 'bad token'
    await expect(getToken()).rejects.toThrow('no whitespace')
  })

  it('reloads Ed25519 PKCS#8 keys without exposing private material', async () => {
    let pem = privatePem()
    const first = pem
    const signer = new RotatingEd25519Signer('service-key', async () => pem)
    await signer.validate()
    const one = await signer.signSha256('a'.repeat(64))
    pem = privatePem()
    const two = await signer.signSha256('a'.repeat(64))
    expect(one.keyReference).toBe('service-key')
    expect(two.valueBase64).not.toBe(one.valueBase64)
    expect(JSON.stringify([one, two])).not.toContain(first)
    pem = 'not a key'
    await expect(signer.signSha256('a'.repeat(64))).rejects.toThrow('PKCS#8 PEM')
  })
})

function privatePem(): string {
  return generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
}
