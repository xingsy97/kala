import { z } from 'zod'

import { IdentifierSchema, NonEmptyStringSchema } from './common.js'

export const SigningKeyScopeSchema = z.enum(['artifact_manifest', 'trial_result', 'reproduction_bundle'])
export const SigningKeyStatusSchema = z.enum(['active', 'rotated', 'revoked'])

export const TrustedSigningKeySchema = z.object({
  keyReference: IdentifierSchema,
  algorithm: z.literal('ed25519'),
  publicKeySpkiBase64: NonEmptyStringSchema,
  scopes: z.array(SigningKeyScopeSchema).min(1),
  status: SigningKeyStatusSchema,
  validFrom: z.string().datetime(),
  validUntil: z.string().datetime().optional(),
  rotatedToKeyReference: IdentifierSchema.optional(),
  revokedAt: z.string().datetime().optional(),
}).strict().superRefine((key, ctx) => {
  if (key.validUntil && Date.parse(key.validUntil) <= Date.parse(key.validFrom)) ctx.addIssue({ code: 'custom', path: ['validUntil'], message: 'key validity must end after it starts' })
  if (key.status === 'rotated' && !key.rotatedToKeyReference) ctx.addIssue({ code: 'custom', path: ['rotatedToKeyReference'], message: 'rotated key requires its replacement reference' })
  if (key.status !== 'rotated' && key.rotatedToKeyReference) ctx.addIssue({ code: 'custom', path: ['rotatedToKeyReference'], message: 'only rotated keys may identify a replacement' })
  if (key.status === 'revoked' && !key.revokedAt) ctx.addIssue({ code: 'custom', path: ['revokedAt'], message: 'revoked key requires a revocation time' })
  if (key.status !== 'revoked' && key.revokedAt) ctx.addIssue({ code: 'custom', path: ['revokedAt'], message: 'only revoked keys may have a revocation time' })
})

export const SigningKeyRegistrySchema = z.object({
  schemaVersion: z.literal(1),
  keys: z.array(TrustedSigningKeySchema),
}).strict().superRefine((registry, ctx) => {
  const references = new Set(registry.keys.map((key) => key.keyReference))
  if (references.size !== registry.keys.length) ctx.addIssue({ code: 'custom', path: ['keys'], message: 'key references must be unique' })
  for (const [index, key] of registry.keys.entries()) if (key.rotatedToKeyReference && !references.has(key.rotatedToKeyReference)) ctx.addIssue({ code: 'custom', path: ['keys', index, 'rotatedToKeyReference'], message: 'rotation replacement must exist in the registry' })
})

export type SigningKeyScope = z.infer<typeof SigningKeyScopeSchema>
export type TrustedSigningKey = z.infer<typeof TrustedSigningKeySchema>
export type SigningKeyRegistryDocument = z.infer<typeof SigningKeyRegistrySchema>

export interface SigningKeyRegistry {
  resolve(keyReference: string): TrustedSigningKey | undefined | Promise<TrustedSigningKey | undefined>
}

export class StaticSigningKeyRegistry implements SigningKeyRegistry {
  private readonly keys: ReadonlyMap<string, TrustedSigningKey>

  constructor(input: unknown) {
    const registry = SigningKeyRegistrySchema.parse(input)
    this.keys = new Map(registry.keys.map((key) => [key.keyReference, key]))
  }

  resolve(keyReference: string): TrustedSigningKey | undefined { return this.keys.get(keyReference) }
}

export async function verifyKeyReferencedSignature(input: {
  keyReference: string
  algorithm: 'ed25519'
  valueBase64: string
  payload: Uint8Array
  scope: SigningKeyScope
  registry: SigningKeyRegistry
  verificationTime?: string | Date
}): Promise<TrustedSigningKey> {
  const key = await input.registry.resolve(input.keyReference)
  if (!key) throw new Error('untrusted signing key reference: ' + input.keyReference)
  const trusted = TrustedSigningKeySchema.parse(key)
  if (trusted.keyReference !== input.keyReference) throw new Error('key registry returned a mismatched reference')
  if (trusted.algorithm !== input.algorithm) throw new Error('signing key algorithm mismatch')
  if (!trusted.scopes.includes(input.scope)) throw new Error('signing key is not authorized for scope: ' + input.scope)
  if (trusted.status === 'revoked') throw new Error('signing key is revoked: ' + input.keyReference)
  if (trusted.status === 'rotated') throw new Error('signing key has been rotated: ' + input.keyReference)
  const at = typeof input.verificationTime === 'string' ? Date.parse(input.verificationTime) : (input.verificationTime?.getTime() ?? Date.now())
  if (!Number.isFinite(at)) throw new Error('signature verification time is invalid')
  if (at < Date.parse(trusted.validFrom)) throw new Error('signing key is not yet valid: ' + input.keyReference)
  if (trusted.validUntil && at >= Date.parse(trusted.validUntil)) throw new Error('signing key is expired: ' + input.keyReference)
  const publicKey = await globalThis.crypto.subtle.importKey('spki', arrayBuffer(decodeBase64(trusted.publicKeySpkiBase64)), { name: 'Ed25519' }, false, ['verify'])
  const valid = await globalThis.crypto.subtle.verify({ name: 'Ed25519' }, publicKey, arrayBuffer(decodeBase64(input.valueBase64)), arrayBuffer(input.payload))
  if (!valid) throw new Error('signature verification failed for key: ' + input.keyReference)
  return trusted
}

export function decodeBase64(value: string): Uint8Array {
  try {
    const binary = globalThis.atob(value)
    return Uint8Array.from(binary, (character) => character.charCodeAt(0))
  } catch { throw new Error('signature material is not valid base64') }
}

export function hexBytes(value: string): Uint8Array { return Uint8Array.from(value.match(/.{2}/gu) ?? [], (byte) => Number.parseInt(byte, 16)) }
function arrayBuffer(value: Uint8Array): ArrayBuffer { const output = new Uint8Array(value.byteLength); output.set(value); return output.buffer }
