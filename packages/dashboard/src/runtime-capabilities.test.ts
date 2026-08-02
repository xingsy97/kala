import { describe, expect, it, vi } from 'vitest'

import { loadRuntimeDeployment } from './runtime-capabilities.js'

describe('loadRuntimeDeployment', () => {
  it('accepts a valid authoritative payload', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      mode: 'saas',
      capabilities: { agent: true, workspace: true, benchmarks: false, evaluations: false },
    }), { status: 200 }))
    await expect(loadRuntimeDeployment('http://host', undefined, fetcher)).resolves.toEqual({
      mode: 'saas', loaded: true,
      capabilities: { agent: true, workspace: true, benchmarks: false, evaluations: false },
    })
  })

  it.each([
    ['network failure', vi.fn().mockRejectedValue(new Error('offline')), 'offline'],
    ['HTTP failure', vi.fn().mockResolvedValue(new Response('{}', { status: 503 })), 'Runtime capabilities request failed (503)'],
    ['malformed body', vi.fn().mockResolvedValue(new Response(JSON.stringify({ mode: 'standalone', capabilities: { benchmarks: true } }), { status: 200 })), undefined],
  ])('fails closed on %s instead of inferring Standalone', async (_label, fetcher, error) => {
    const result = await loadRuntimeDeployment('http://host', undefined, fetcher)
    expect(result).toEqual({
      mode: null,
      loaded: true,
      capabilities: { agent: true, workspace: true, benchmarks: false, evaluations: false },
      ...(error ? { error } : {}),
    })
  })

  it('classifies an unauthenticated hosted response before protected clients start', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('{}', { status: 401 }))
    await expect(loadRuntimeDeployment('http://host', undefined, fetcher)).resolves.toEqual({
      mode: 'saas', loaded: true, unauthorized: true,
      capabilities: { agent: true, workspace: true, benchmarks: false, evaluations: false },
    })
  })
})
