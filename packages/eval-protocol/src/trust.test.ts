import { createPublicKey, generateKeyPairSync, sign } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { ArtifactManifestSchema, SigningKeyRegistrySchema, StaticSigningKeyRegistry, canonicalJson, sha256Hex, verifyArtifactManifestSignature, verifyKeyReferencedSignature, verifyTrialEvidenceSignature } from './index.js'

const AT = '2026-08-03T00:00:00.000Z'
const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function keys(scope: 'artifact_manifest' | 'trial_result', status: 'active' | 'rotated' | 'revoked' = 'active') {
  const { privateKey } = generateKeyPairSync('ed25519')
  const keyReference = 'external-key'
  const key = {
    keyReference, algorithm: 'ed25519' as const,
    publicKeySpkiBase64: createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).toString('base64'),
    scopes: [scope], status, validFrom: '2026-01-01T00:00:00.000Z',
    ...(status === 'rotated' ? { rotatedToKeyReference: 'replacement-key' } : {}),
    ...(status === 'revoked' ? { revokedAt: '2026-07-01T00:00:00.000Z' } : {}),
  }
  const replacement = { ...key, keyReference: 'replacement-key', status: 'active' as const, scopes: [scope], rotatedToKeyReference: undefined }
  const registry = new StaticSigningKeyRegistry({ schemaVersion: 1, keys: status === 'rotated' ? [key, replacement] : [key] })
  return { privateKey, keyReference, registry }
}

function signature(privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'], keyReference: string, digest: string) {
  return { algorithm: 'ed25519' as const, keyReference, valueBase64: sign(null, Buffer.from(digest, 'hex'), privateKey).toString('base64') }
}

describe('external signing key trust', () => {
  it('verifies artifact manifests by keyReference and rejects wrong scope or revocation', async () => {
    const base = { schemaVersion: 1 as const, runId: 'run', trialId: 'trial', leaseId: 'lease', generatedAt: AT, entries: [] }
    const manifestHash = await sha256Hex(canonicalJson(base))
    const trusted = keys('artifact_manifest')
    const manifest = ArtifactManifestSchema.parse({ ...base, manifestHash, signature: signature(trusted.privateKey, trusted.keyReference, manifestHash) })
    await expect(verifyArtifactManifestSignature(manifest, trusted.registry, AT)).resolves.toEqual(manifest)
    await expect(verifyArtifactManifestSignature(manifest, keys('trial_result').registry, AT)).rejects.toThrow('scope')
    await expect(verifyArtifactManifestSignature(manifest, keys('artifact_manifest', 'revoked').registry, AT)).rejects.toThrow('revoked')
  })

  it('verifies trial result signatures independently from artifact signatures', async () => {
    const fixture = JSON.parse(await readFile(join(root, 'fixtures', 'canonical-trial-result-v1.json'), 'utf8')) as Record<string, unknown>
    const artifactManifest = fixture.artifactManifest as Record<string, unknown>
    const { manifestHash: _oldManifestHash, signature: _oldManifestSignature, ...manifestUnsigned } = artifactManifest
    fixture.artifactManifest = { ...manifestUnsigned, manifestHash: await sha256Hex(canonicalJson(manifestUnsigned)) }
    const { resultHash: _oldResultHash, signature: _oldResultSignature, ...resultUnsigned } = fixture
    const resultHash = await sha256Hex(canonicalJson(resultUnsigned))
    const trusted = keys('trial_result')
    const evidence = { ...resultUnsigned, resultHash, signature: signature(trusted.privateKey, trusted.keyReference, resultHash) }
    await expect(verifyTrialEvidenceSignature(evidence, trusted.registry, AT)).resolves.toMatchObject({ resultHash })
  })

  it('rejects forged, self-signed, expired, and not-yet-valid signatures', async () => {
    const payload = new Uint8Array([1, 2, 3])
    const trusted = keys('trial_result')
    const attacker = keys('trial_result')
    const forged = sign(null, payload, attacker.privateKey).toString('base64')
    await expect(verifyKeyReferencedSignature({ keyReference: trusted.keyReference, algorithm: 'ed25519', valueBase64: forged, payload, scope: 'trial_result', registry: trusted.registry, verificationTime: AT })).rejects.toThrow('verification failed')
    await expect(verifyKeyReferencedSignature({ keyReference: attacker.keyReference, algorithm: 'ed25519', valueBase64: forged, payload, scope: 'trial_result', registry: { resolve: () => undefined }, verificationTime: AT })).rejects.toThrow('untrusted')

    const resolved = trusted.registry.resolve(trusted.keyReference)!
    const signatureValue = sign(null, payload, trusted.privateKey).toString('base64')
    const expired = new StaticSigningKeyRegistry({ schemaVersion: 1, keys: [{ ...resolved, validUntil: '2026-02-01T00:00:00.000Z' }] })
    await expect(verifyKeyReferencedSignature({ keyReference: trusted.keyReference, algorithm: 'ed25519', valueBase64: signatureValue, payload, scope: 'trial_result', registry: expired, verificationTime: AT })).rejects.toThrow('expired')
    await expect(verifyKeyReferencedSignature({ keyReference: trusted.keyReference, algorithm: 'ed25519', valueBase64: signatureValue, payload, scope: 'trial_result', registry: trusted.registry, verificationTime: '2025-01-01T00:00:00.000Z' })).rejects.toThrow('not yet valid')
  })

  it('models rotation and rejects invalid or duplicate registry relationships', async () => {
    const rotated = keys('artifact_manifest', 'rotated')
    expect(rotated.registry.resolve('external-key')).toMatchObject({ status: 'rotated', rotatedToKeyReference: 'replacement-key' })
    const base = { schemaVersion: 1 as const, runId: 'run', trialId: 'trial', leaseId: 'lease', generatedAt: AT, entries: [] }
    const manifestHash = await sha256Hex(canonicalJson(base))
    await expect(verifyArtifactManifestSignature({ ...base, manifestHash, signature: signature(rotated.privateKey, rotated.keyReference, manifestHash) }, rotated.registry, AT)).rejects.toThrow('rotated')
    const invalid = { keyReference: 'old', algorithm: 'ed25519', publicKeySpkiBase64: 'key', scopes: ['artifact_manifest'], status: 'rotated', validFrom: AT, rotatedToKeyReference: 'missing' }
    expect(SigningKeyRegistrySchema.safeParse({ schemaVersion: 1, keys: [invalid] }).success).toBe(false)
    expect(SigningKeyRegistrySchema.safeParse({ schemaVersion: 1, keys: [{ ...invalid, status: 'active', rotatedToKeyReference: undefined }, { ...invalid, status: 'active', rotatedToKeyReference: undefined }] }).success).toBe(false)
  })
})
