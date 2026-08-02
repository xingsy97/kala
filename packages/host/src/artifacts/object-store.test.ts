import { describe, expect, it } from 'vitest'
import { S3ArtifactObjectStore, tenantObjectKey } from './object-store.js'

describe('artifact object store', () => {
  it('always prefixes keys with organization identity and rejects traversal', () => {
    expect(tenantObjectKey('org_acme', 'sessions/s1/out.txt')).toBe('organizations/org_acme/sessions/s1/out.txt')
    expect(() => tenantObjectKey('org_acme', '../org_other/x')).toThrow('invalid artifact key')
  })
  it('enforces quota and bounded SigV4 signed URLs', async () => {
    const store = new S3ArtifactObjectStore({ endpoint: 'https://minio.test', region: 'us-east-1', bucket: 'artifacts', accessKeyId: 'key', secretAccessKey: 'secret', maxObjectBytes: 4 })
    await expect(store.put({ organizationId: 'org_acme', key: 'a', contentType: 'text/plain', body: new Uint8Array(5) })).rejects.toThrow('quota')
    await expect(store.signedGetUrl('org_acme', 'a', 3601)).rejects.toThrow('TTL')
    const url = await store.signedGetUrl('org_acme', 'a', 60)
    expect(url.pathname).toBe('/artifacts/organizations/org_acme/a')
    expect(url.searchParams.has('X-Amz-Signature')).toBe(true)
  })
})
