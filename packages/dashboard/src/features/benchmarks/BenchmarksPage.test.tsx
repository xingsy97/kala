import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import '../../i18n/index.js'
import { BenchmarksPage } from './BenchmarksPage.js'

const runsResponse = {
  runs: [
    {
      runId: 'run-tb-1',
      kind: 'terminal-bench',
      label: 'run-tb-1',
      dataset: 'terminal-bench',
      model: 'gpt-x',
      selectedCount: 3,
      status: 'complete',
      createdAt: '2026-07-01T00:00:00Z',
      updatedAt: '2026-07-01T01:00:00Z',
      totalInstances: 3,
      resolved: 2,
    },
    {
      runId: 'run-sw-1',
      kind: 'swe-bench',
      label: 'run-sw-1',
      dataset: 'princeton',
      model: 'gpt-x',
      selectedCount: 5,
      status: 'pending',
      createdAt: '2026-07-02T00:00:00Z',
      updatedAt: '2026-07-02T00:00:00Z',
    },
  ],
}

describe('BenchmarksPage', () => {
  const fetchMock = vi.fn<typeof fetch>()

  beforeEach(() => {
    fetchMock.mockReset()
    // Default: return runs list, then fallback empty manifest for any other calls
    fetchMock.mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url
      if (url.includes('/enhancement/action')) {
        return new Response(JSON.stringify(runsResponse), { status: 200 })
      }
      if (url.includes('/artifacts/manifest')) {
        return new Response(JSON.stringify({ schemaVersion: 1, generatedAt: '', rootDir: '', entries: [], summary: { entryCount: 0, totalBytes: 0, hashedCount: 0, hashSkippedCount: 0, kinds: {} } }), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
      Element.prototype.scrollIntoView = () => {}
    }
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('loads runs and renders three columns', async () => {
    render(<BenchmarksPage />)
    await waitFor(() => {
      expect(screen.getByTestId('benchmarks-run-row-run-tb-1')).toBeTruthy()
    })
    expect(screen.getByTestId('benchmarks-page')).toBeTruthy()
    expect(screen.getByTestId('benchmarks-run-list')).toBeTruthy()
    expect(screen.getByTestId('benchmarks-detail-empty')).toBeTruthy()
    expect(screen.getByTestId('benchmarks-launcher')).toBeTruthy()
    // Grouped by kind
    expect(screen.getByTestId('benchmarks-run-group-terminal-bench')).toBeTruthy()
    expect(screen.getByTestId('benchmarks-run-group-swe-bench')).toBeTruthy()
  })

  it('selecting a run updates the detail panel with score', async () => {
    render(<BenchmarksPage />)
    await waitFor(() => {
      expect(screen.getByTestId('benchmarks-run-row-run-tb-1')).toBeTruthy()
    })
    fireEvent.click(screen.getByTestId('benchmarks-run-row-run-tb-1'))
    expect(screen.getByTestId('benchmarks-detail-panel')).toBeTruthy()
    expect(screen.getByTestId('benchmarks-detail-resolved-metric').textContent).toContain('2')
    expect(screen.getByTestId('benchmarks-detail-accuracy').textContent).toContain('66.7')
  })

  it('launcher swebench opens wizard-only modal and terminal-bench opens its wizard', async () => {
    render(<BenchmarksPage />)
    await waitFor(() => expect(screen.getByTestId('benchmarks-launcher')).toBeTruthy())
    fireEvent.click(screen.getByTestId('benchmarks-launcher-swebench'))
    await waitFor(() => expect(screen.getByTestId('run-benchmark-wizard-modal')).toBeTruthy())
    // Modal should contain the wizard (via toggle) but NOT the full eval inline panel
    expect(screen.getByTestId('run-benchmark-wizard-modal').querySelector('[data-testid="run-benchmark-wizard-toggle"]')).toBeTruthy()
    expect(screen.getByTestId('run-benchmark-wizard-modal').querySelector('[data-testid="eval-inline-panel"]')).toBeNull()
    fireEvent.click(screen.getByTestId('benchmarks-launcher-terminal-bench'))
    await waitFor(() => expect(screen.getByTestId('terminalbench-wizard')).toBeTruthy())
  })

  it('renders inline eval workspace and badcases sub-view', async () => {
    render(<BenchmarksPage />)
    await waitFor(() => expect(screen.getByTestId('eval-workspace-section')).toBeTruthy())
    await waitFor(() => expect(screen.getByTestId('eval-inline-panel')).toBeTruthy())
    expect(screen.getByTestId('benchmarks-badcases-panel')).toBeTruthy()
  })

  it('does not leak absolute paths into the DOM', async () => {
    const { container } = render(<BenchmarksPage />)
    await waitFor(() => expect(screen.getByTestId('benchmarks-run-row-run-tb-1')).toBeTruthy())
    const html = container.innerHTML
    expect(html).not.toMatch(/\/home\//)
    expect(html).not.toMatch(/\/tmp\//)
    expect(html).not.toMatch(/\.jsonl/)
  })
})
