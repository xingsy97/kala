import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

export type EncryptedSecret = { keyId: string; iv: string; ciphertext: string; tag: string }
export type SessionEncryptionKey = { id: string; key: Buffer }

export interface SessionSecretBox {
  encrypt(plaintext: string): EncryptedSecret
  decrypt(secret: EncryptedSecret): string
  needsRotation(secret: EncryptedSecret): boolean
}

export function createSessionSecretBox(activeKeyId: string, keys: readonly SessionEncryptionKey[]): SessionSecretBox {
  const byId = new Map(keys.map((entry) => {
    if (entry.key.byteLength !== 32) throw new Error(`session encryption key ${entry.id} must contain 32 bytes`)
    return [entry.id, entry.key] as const
  }))
  const active = byId.get(activeKeyId)
  if (!active) throw new Error('active session encryption key is missing')
  return {
    encrypt(plaintext) {
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', active, iv)
      const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
      return { keyId: activeKeyId, iv: iv.toString('base64url'), ciphertext: ciphertext.toString('base64url'), tag: cipher.getAuthTag().toString('base64url') }
    },
    decrypt(secret) {
      const key = byId.get(secret.keyId)
      if (!key) throw new Error(`unknown session encryption key: ${secret.keyId}`)
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(secret.iv, 'base64url'))
      decipher.setAuthTag(Buffer.from(secret.tag, 'base64url'))
      return Buffer.concat([decipher.update(Buffer.from(secret.ciphertext, 'base64url')), decipher.final()]).toString('utf8')
    },
    needsRotation(secret) { return secret.keyId !== activeKeyId },
  }
}
