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
    {
      path: 'runs/swebench/run1/trials/local__repo-1.json',
      kind: 'eval_trial',
      mediaType: 'application/json',
      bytes: 512,
      mtime: '2026-07-09T00:00:00.000Z',
      sha256: 'trialabcdef',
    },
    {
      path: 'runs/eval/compare/eval-comparison.json',
      kind: 'eval_comparison',
      mediaType: 'application/json',
      bytes: 300,
      mtime: '2026-07-09T00:00:00.000Z',
      sha256: 'fedcba654321',
    },
    {
      path: 'runs/profile/session/profile.json',
      kind: 'profile',
      mediaType: 'application/json',
      bytes: 420,
      mtime: '2026-07-09T00:00:00.000Z',
      sha256: 'profileabcdef',
    },
  ],
  summary: {
    entryCount: 6,
    totalBytes: 5712,
    hashedCount: 5,
    hashSkippedCount: 1,
    kinds: { llm_request: 1, log: 1, eval_summary: 1, eval_trial: 1, eval_comparison: 1, profile: 1 },
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
    expect(screen.getByText('5/6')).toBeTruthy()
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
      .mockResolvedValueOnce(new Response(JSON.stringify({
        path: 'runs/eval/compare/eval-comparison.json',
        mediaType: 'application/json',
        body: {
          baseline: { experimentId: 'base', resolved: 1, failed: 1, timedOut: 0 },
          candidate: { experimentId: 'candidate', resolved: 2, failed: 0, timedOut: 0 },
          deltas: { resolved: 1, failed: -1, timedOut: 0, passRate: 0.5 },
          failureDeltas: { empty_patch: -1 },
        },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        path: 'runs/swebench/run1/trials/local__repo-1.json',
        mediaType: 'application/json',
        body: {
          trialId: 'run1:local__repo-1',
          experimentId: 'run1',
          instanceId: 'local__repo-1',
          status: 'completed',
          resolved: true,
          artifacts: [
            { kind: 'diff', uri: 'artifacts/local__repo-1/final.diff', bytes: 42, mediaType: 'text/x-diff' },
          ],
          metrics: { durationMs: 1250, patchBytes: 42 },
        },
      }), { status: 200 }))

    render(<ArtifactExplorerDialog open onOpenChange={() => {}} />)
    await screen.findByText('llm/s1/1.request.json')

    fireEvent.click(screen.getByRole('button', { name: /eval runs/i }))

    await screen.findByText('run1')
    expect(screen.getByText('local')).toBeTruthy()
    expect(screen.getByText('agent-test')).toBeTruthy()
    expect(screen.getByText('50%')).toBeTruthy()
    expect(await screen.findByText('base')).toBeTruthy()
    expect(screen.getByText('candidate')).toBeTruthy()
    expect(screen.getByText('+50%')).toBeTruthy()
    await waitFor(() => expect(screen.getAllByText('local__repo-1').length).toBeGreaterThanOrEqual(1))
    expect(screen.getAllByText('resolved').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('artifacts/local__repo-1/final.diff')).toBeTruthy()
    expect(fetchMock).toHaveBeenCalledWith(
      '/artifacts/content?path=runs%2Fswebench%2Frun1%2Fsummary.json',
      { cache: 'no-store' },
    )
    expect(fetchMock).toHaveBeenCalledWith(
      '/artifacts/content?path=runs%2Feval%2Fcompare%2Feval-comparison.json',
      { cache: 'no-store' },
    )
    expect(fetchMock).toHaveBeenCalledWith(
      '/artifacts/content?path=runs%2Fswebench%2Frun1%2Ftrials%2Flocal__repo-1.json',
      { cache: 'no-store' },
    )
  })

  it('loads session profile artifacts in the Profiles tab', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify(manifest), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        path: 'runs/profile/session/profile.json',
        mediaType: 'application/json',
        body: {
          sessionId: 's1',
          llmCalls: 2,
          toolCalls: 3,
          llmTraceMissingCalls: 1,
          totalInputTokens: 1234,
          totalOutputTokens: 567,
          costStatus: 'estimated',
          estimatedCostUsd: 0.0123,
          models: ['gpt-test'],
        },
      }), { status: 200 }))

    render(<ArtifactExplorerDialog open onOpenChange={() => {}} />)
    await screen.findByText('llm/s1/1.request.json')

    fireEvent.click(screen.getByRole('button', { name: /profiles/i }))

    await screen.findByText('s1')
    expect(screen.getAllByText('2').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('1,234')).toBeTruthy()
    expect(screen.getAllByText('$0.0123').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('gpt-test')).toBeTruthy()
    expect(fetchMock).toHaveBeenCalledWith(
      '/artifacts/content?path=runs%2Fprofile%2Fsession%2Fprofile.json',
      { cache: 'no-store' },
    )
  })

  it('surfaces endpoint errors', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'artifact capture is not configured' }), { status: 404 }))

    render(<ArtifactExplorerDialog open onOpenChange={() => {}} />)

    await screen.findByText(/artifact capture is not configured/i)
  })
})
