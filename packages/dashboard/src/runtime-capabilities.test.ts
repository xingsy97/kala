import { describe, expect, it, vi } from 'vitest'

import { loadRuntimeDeployment } from './runtime-capabilities.js'

describe('loadRuntimeDeployment', () => {
  it('accepts a valid authoritative payload', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      product: 'private-cloud',
      deployment: { schemaVersion: 1, architecture: 'platform', tenancy: 'multi-tenant', runtimeProfile: 'agent' },
      capabilities: { agent: true, workspace: true, operations: true, artifacts: true, pipeline: true },
    }), { status: 200 }))
    await expect(loadRuntimeDeployment('http://host', undefined, fetcher)).resolves.toEqual({
      product: 'private-cloud', deployment: { schemaVersion: 1, architecture: 'platform', tenancy: 'multi-tenant', runtimeProfile: 'agent' }, loaded: true,
      capabilities: { agent: true, workspace: true, operations: true, artifacts: true, pipeline: true },
    })
  })

  it.each([
    ['network failure', vi.fn().mockRejectedValue(new Error('offline')), 'offline'],
    ['HTTP failure', vi.fn().mockResolvedValue(new Response('{}', { status: 503 })), 'Runtime capabilities request failed (503)'],
    ['malformed body', vi.fn().mockResolvedValue(new Response(JSON.stringify({ product: 'dedicated', capabilities: { agent: true } }), { status: 200 })), undefined],
  ])('fails closed on %s instead of inferring Dedicated', async (_label, fetcher, error) => {
    const result = await loadRuntimeDeployment('http://host', undefined, fetcher)
    expect(result).toEqual({
      product: null, deployment: null,
      loaded: true,
      capabilities: { agent: true, workspace: true, operations: false, artifacts: false, pipeline: false },
      ...(error ? { error } : {}),
    })
  })

  it('classifies an unauthenticated Platform response before protected clients start', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('{}', { status: 401 }))
    await expect(loadRuntimeDeployment('http://host', undefined, fetcher)).resolves.toEqual({
      product: 'private-cloud', deployment: null, loaded: true, unauthorized: true,
      capabilities: { agent: true, workspace: true, operations: false, artifacts: false, pipeline: false },
    })
  })
})
