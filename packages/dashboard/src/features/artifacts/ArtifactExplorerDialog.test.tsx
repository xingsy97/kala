import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ArtifactExplorerDialog, type ArtifactManifest } from './ArtifactExplorerDialog.js'

const manifest: ArtifactManifest = {
  schemaVersion: 1,
  generatedAt: '2026-07-09T00:00:00.000Z',
  rootDir: '/tmp/artifacts',
  entries: [
    {
      path: 'llm/s1/1.request.json',
      kind: 'llm_request',
      mediaType: 'application/json',
      bytes: 128,
      mtime: '2026-07-09T00:00:00.000Z',
      sha256: 'abcdef1234567890',
    },
    {
      path: 'large.log',
      kind: 'log',
      mediaType: 'text/plain',
      bytes: 4096,
      mtime: '2026-07-09T00:00:00.000Z',
      hashSkippedReason: 'file exceeds maxHashBytes',
    },
  ],
  summary: {
    entryCount: 2,
    totalBytes: 4224,
    hashedCount: 1,
    hashSkippedCount: 1,
    kinds: { llm_request: 1, log: 1 },
  },
}

describe('ArtifactExplorerDialog', () => {
  const fetchMock = vi.fn<typeof fetch>()

  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('loads and renders the artifact manifest summary and entries', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(manifest), { status: 200 }))

    render(<ArtifactExplorerDialog open onOpenChange={() => {}} />)

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/artifacts/manifest', { cache: 'no-store' })
    })
    await screen.findByText('llm/s1/1.request.json')
    expect(screen.getByText('large.log')).toBeTruthy()
    expect(screen.getByText('2')).toBeTruthy()
    expect(screen.getByText('hash skipped')).toBeTruthy()
  })

  it('surfaces endpoint errors', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'artifact capture is not configured' }), { status: 404 }))

    render(<ArtifactExplorerDialog open onOpenChange={() => {}} />)

    await screen.findByText(/artifact capture is not configured/i)
  })
})
