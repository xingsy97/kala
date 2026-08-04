import { afterEach, describe, expect, it, vi } from 'vitest'

import { artifactRequest, artifactUrl, configureArtifactClient } from './artifact-client.js'
import { sessionIdFromArtifact } from './product-artifact-views.js'

describe('artifact client', () => {
  afterEach(() => {
    configureArtifactClient({})
    vi.restoreAllMocks()
  })

  it('uses the configured Host and sends the in-memory bootstrap token', async () => {
    configureArtifactClient({ host: 'https://host.example/root/', token: 'secret' })
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'))

    await artifactRequest('/artifacts/manifest', { cache: 'no-store' })

    expect(artifactUrl('/artifacts/manifest')).toBe('https://host.example/root/artifacts/manifest')
    expect(fetcher).toHaveBeenCalledWith('https://host.example/root/artifacts/manifest', expect.objectContaining({
      credentials: 'include',
      headers: expect.any(Headers),
    }))
    const init = fetcher.mock.calls[0]![1]!
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer secret')
  })

  it('finds safe Session navigation targets in artifact bodies and paths', () => {
    expect(sessionIdFromArtifact({ sessionId: 'session-1' }, 'trace.json')).toBe('session-1')
    expect(sessionIdFromArtifact({ session_id: 'session-2' }, 'trace.json')).toBe('session-2')
    expect(sessionIdFromArtifact({}, 'sessions/session-3/trace.json')).toBe('session-3')
  })
})
