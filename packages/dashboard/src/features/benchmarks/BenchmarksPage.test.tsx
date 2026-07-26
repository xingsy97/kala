import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import '../../i18n/index.js'
import { i18n } from '../../i18n/index.js'
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
    void i18n.changeLanguage('en')
  })

  it('loads experiments and renders a focused two-column explorer', async () => {
    render(<BenchmarksPage />)
    await waitFor(() => {
      expect(screen.getByTestId('benchmarks-run-row-run-tb-1')).toBeTruthy()
    })
    expect(screen.getByTestId('benchmarks-page')).toBeTruthy()
    expect(screen.getByTestId('benchmarks-run-list')).toBeTruthy()
    expect(screen.getByTestId('benchmarks-detail-empty')).toBeTruthy()
    expect(screen.queryByTestId('benchmarks-launcher')).toBeNull()
    expect(screen.getByTestId('benchmarks-page-kind')).toBeTruthy()
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

  it('shows legacy comparison data in the backend comparison tab', async () => {
    const legacy = { ...runsResponse.runs[0], runId: 'legacy:historical-30', label: 'Historical SWE-bench', totalInstances: 30, resolved: 23, comparison: { agentRunLabResolved: 23, claudeCodeResolved: 19 }, badCaseCount: 7 }
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ runs: [legacy] }), { status: 200 }))
    render(<BenchmarksPage />)
    await waitFor(() => expect(screen.getByTestId('benchmarks-run-row-legacy:historical-30')).toBeTruthy())
    fireEvent.click(screen.getByTestId('benchmarks-run-row-legacy:historical-30'))
    expect(screen.getByTestId('benchmarks-detail-comparison').textContent).toContain('23')
    fireEvent.click(screen.getByTestId('benchmarks-detail-tab-backends'))
    expect(screen.getByTestId('benchmarks-detail-backends').textContent).toContain('23 / 30')
    expect(screen.getByTestId('benchmarks-detail-backends').textContent).toContain('19 / 30')
  })

  it('opens the selected benchmark wizard from the single top action', async () => {
    render(<BenchmarksPage />)
    fireEvent.click(screen.getByTestId('benchmarks-page-new-run'))
    await waitFor(() => expect(screen.getByTestId('run-benchmark-wizard-modal')).toBeTruthy())
    // Modal should contain the wizard (via toggle) but NOT the full eval inline panel
    expect(screen.getByTestId('run-benchmark-wizard-modal').querySelector('[data-testid="run-benchmark-wizard-toggle"]')).toBeTruthy()
    expect(screen.getByTestId('run-benchmark-wizard-modal').querySelector('[data-testid="eval-inline-panel"]')).toBeNull()
    fireEvent.change(screen.getByTestId('benchmarks-page-kind'), { target: { value: 'terminal-bench' } })
    fireEvent.click(screen.getByTestId('benchmarks-page-new-run'))
    await waitFor(() => expect(screen.getByTestId('terminalbench-wizard')).toBeTruthy())
  })

  it('does not inline the artifacts eval workspace, RL readiness, or global badcases panels', async () => {
    render(<BenchmarksPage />)
    await waitFor(() => {
      expect(screen.getByTestId('benchmarks-run-row-run-tb-1')).toBeTruthy()
    })
    expect(screen.queryByTestId('eval-workspace-section')).toBeNull()
    expect(screen.queryByTestId('eval-inline-panel')).toBeNull()
    expect(screen.queryByTestId('rl-readiness-panel')).toBeNull()
    expect(screen.queryByTestId('benchmarks-badcases-panel')).toBeNull()
  })

  it('does not leak absolute paths into the DOM', async () => {
    const { container } = render(<BenchmarksPage />)
    await waitFor(() => expect(screen.getByTestId('benchmarks-run-row-run-tb-1')).toBeTruthy())
    const html = container.innerHTML
    expect(html).not.toMatch(/\/home\//)
    expect(html).not.toMatch(/\/tmp\//)
    expect(html).not.toMatch(/\.jsonl/)
  })

  it('renders benchmark-facing UI in Chinese when selected', async () => {
    await i18n.changeLanguage('zh')
    render(<BenchmarksPage />)
    await waitFor(() => expect(screen.getByTestId('benchmarks-page-title').textContent).toContain('评测'))
    expect(screen.getByTestId('benchmarks-page-new-run').textContent).toContain('新建实验')
    expect(screen.getByTestId('benchmarks-page-kind').textContent).toContain('SWE-bench')

    fireEvent.click(screen.getByTestId('benchmarks-page-new-run'))
    await waitFor(() => expect(screen.getByTestId('run-benchmark-wizard-modal')).toBeTruthy())
    expect(screen.getByTestId('run-benchmark-wizard-modal').textContent).toContain('运行评测向导')
    expect(screen.getByTestId('run-benchmark-wizard-modal').textContent).toContain('运行 Benchmark（引导式）')

    expect(screen.queryByTestId('eval-inline-panel')).toBeNull()
    expect(screen.queryByTestId('rl-readiness-panel')).toBeNull()
  })
})
