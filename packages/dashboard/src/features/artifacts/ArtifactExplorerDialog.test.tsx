import { fireEvent, render, screen, waitFor } from '@testing-library/react'
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
    {
      path: 'runs/swebench/run1/summary.json',
      kind: 'eval_summary',
      mediaType: 'application/json',
      bytes: 256,
      mtime: '2026-07-09T00:00:00.000Z',
      sha256: '123456abcdef',
    },
  ],
  summary: {
    entryCount: 3,
    totalBytes: 4480,
    hashedCount: 2,
    hashSkippedCount: 1,
    kinds: { llm_request: 1, log: 1, eval_summary: 1 },
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
    expect(screen.getByText('2/3')).toBeTruthy()
    expect(screen.getByText('hash skipped')).toBeTruthy()
  })

  it('loads eval summaries from artifact content when the Eval Runs tab is selected', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify(manifest), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        path: 'runs/swebench/run1/summary.json',
        mediaType: 'application/json',
        body: {
          experimentId: 'run1',
          dataset: 'local',
          model: 'agent-test',
          trialCount: 2,
          resolved: 1,
          failed: 1,
          timedOut: 0,
          metrics: { passRate: 0.5 },
        },
      }), { status: 200 }))

    render(<ArtifactExplorerDialog open onOpenChange={() => {}} />)
    await screen.findByText('llm/s1/1.request.json')

    fireEvent.click(screen.getByRole('button', { name: /eval runs/i }))

    await screen.findByText('run1')
    expect(screen.getByText('local')).toBeTruthy()
    expect(screen.getByText('agent-test')).toBeTruthy()
    expect(screen.getByText('50%')).toBeTruthy()
    expect(fetchMock).toHaveBeenCalledWith(
      '/artifacts/content?path=runs%2Fswebench%2Frun1%2Fsummary.json',
      { cache: 'no-store' },
    )
  })

  it('surfaces endpoint errors', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'artifact capture is not configured' }), { status: 404 }))

    render(<ArtifactExplorerDialog open onOpenChange={() => {}} />)

    await screen.findByText(/artifact capture is not configured/i)
  })
})
