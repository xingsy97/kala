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
    expect(screen.getByTestId('rl-readiness-panel')).toBeTruthy()
    await waitFor(() => expect(screen.getByTestId('rl-readiness-empty')).toBeTruthy())
    expect(screen.getByTestId('benchmarks-badcases-panel')).toBeTruthy()
  })

  it('renders Agentic RL rollout readiness from artifact manifest', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url
      if (url.includes('/enhancement/action')) return new Response(JSON.stringify(runsResponse), { status: 200 })
      if (url.includes('/artifacts/manifest')) {
        return new Response(JSON.stringify({
          entries: [{ path: 'rl-rollouts/rollout-1.json', kind: 'rl_rollout_result', bytes: 100, mtime: '2026-07-12T00:00:00Z' }],
        }), { status: 200 })
      }
      if (url.includes('/artifacts/content')) {
        return new Response(JSON.stringify({ content: {
          rolloutId: 'rollout-1',
          taskId: 'task-1',
          sessionId: 's1',
          status: 'completed',
          readiness: 'slime-sample-ready',
          tokenCaptureRefs: [{ uri: 'rl-token-captures/rollout-1/c.json' }],
          rewardRef: { uri: 'rl-rewards/rollout-1.json' },
          sampleValidationRef: { uri: 'rl-sample-validations/rollout-1.json' },
        } }), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    })

    render(<BenchmarksPage />)
    await waitFor(() => expect(screen.getByTestId('rl-readiness-row-rollout-1')).toBeTruthy())
    expect(screen.getByTestId('rl-readiness-summary').textContent).toContain('1')
    expect(screen.getByTestId('rl-readiness-row-rollout-1').textContent).toContain('slime-sample-ready')
  })

  it('renders artifact ENOENT as an empty RL readiness state', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url
      if (url.includes('/enhancement/action')) return new Response(JSON.stringify(runsResponse), { status: 200 })
      if (url.includes('/artifacts/manifest')) return new Response(JSON.stringify({ error: "ENOENT: no such file or directory, scandir 'Z:\\private\\artifacts'" }), { status: 500 })
      return new Response('{}', { status: 200 })
    })

    const { container } = render(<BenchmarksPage />)
    await waitFor(() => expect(screen.getByTestId('rl-readiness-empty')).toBeTruthy())
    expect(container.textContent).not.toContain('ENOENT')
    expect(container.textContent).not.toContain('Z:\\private')
  })

  it('redacts private paths from expanded RL artifact details and content errors', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url
      if (url.includes('/enhancement/action')) return new Response(JSON.stringify(runsResponse), { status: 200 })
      if (url.includes('/artifacts/manifest')) {
        return new Response(JSON.stringify({
          entries: [{ path: 'Z:\\private\\artifacts\\rl-rollouts\\private.json', kind: 'rl_rollout_result', bytes: 100, mtime: '2026-07-12T00:00:00Z' }],
        }), { status: 200 })
      }
      if (url.includes('/artifacts/content')) {
        return new Response(JSON.stringify({ content: {
          rolloutId: 'rollout-private',
          taskId: 'task-private',
          status: 'blocked',
          readiness: 'blocked',
          blockedReason: "ENOENT: no such file or directory, scandir 'Z:\\private\\workspace'",
          metadata: { workspace: 'Z:\\tmp\\agent-kernel\\private-workspace' },
          tokenCaptureRefs: [],
        } }), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    })

    const { container } = render(<BenchmarksPage />)
    await waitFor(() => expect(screen.getByTestId('rl-readiness-row-rollout-private')).toBeTruthy())
    fireEvent.click(screen.getByTestId('rl-readiness-row-rollout-private').querySelector('button')!)
    await waitFor(() => expect(screen.getByTestId('rl-readiness-detail')).toBeTruthy())
    expect(container.textContent).not.toContain('Z:\\private')
    expect(container.textContent).not.toContain('Z:\\tmp')
    expect(container.textContent).not.toContain('ENOENT')
    expect(screen.getByTestId('rl-readiness-detail').textContent).toContain('[redacted-path]')
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
    expect(screen.getByTestId('benchmarks-launcher').textContent).toContain('启动新的评测')
    expect(screen.getByTestId('benchmarks-launcher-swebench').textContent).toContain('SWE-bench')
    expect(screen.getByTestId('benchmarks-launcher-terminal-bench').textContent).toContain('Terminal-Bench')

    fireEvent.click(screen.getByTestId('benchmarks-launcher-swebench'))
    await waitFor(() => expect(screen.getByTestId('run-benchmark-wizard-modal')).toBeTruthy())
    expect(screen.getByTestId('run-benchmark-wizard-modal').textContent).toContain('运行评测向导')
    expect(screen.getByTestId('run-benchmark-wizard-modal').textContent).toContain('运行 Benchmark（引导式）')

    await waitFor(() => expect(screen.getByTestId('eval-inline-panel')).toBeTruthy())
    expect(screen.getByTestId('eval-inline-panel').textContent).toContain('评测产物操作')
    expect(screen.getByTestId('rl-readiness-panel').textContent).toContain('Agentic RL readiness')
  })
})
