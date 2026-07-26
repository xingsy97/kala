import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import '../../i18n/index.js'
import { BadCasesTab } from './BadCasesTab.js'

const listResponse = {
  runId: 'run-1',
  counts: {
    'patch-apply-failure': 1,
    'test-timeout': 0,
    'agent-error': 0,
    'infra-error': 0,
    'verifier-failure': 1,
    'unresolved-other': 0,
  },
  cases: [
    {
      instanceId: 'inst-a',
      failureCategory: 'patch-apply-failure',
      traceHead: ['head-line-a'],
      traceTail: ['tail-line-a'],
      toolCallErrors: ['tool-err-a'],
      verifierReason: 'diff did not apply',
    },
    {
      instanceId: 'inst-b',
      failureCategory: 'verifier-failure',
      traceHead: [],
      traceTail: [],
      toolCallErrors: [],
    },
  ],
}

describe('BadCasesTab', () => {
  const fetchMock = vi.fn<typeof fetch>()

  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('loads cases grouped by failure category', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(listResponse), { status: 200 }))
    render(<BadCasesTab initialRunId="run-1" />)
    fireEvent.click(screen.getByTestId('badcases-load'))
    await waitFor(() => {
      expect(screen.getByTestId('badcases-group-patch-apply-failure')).toBeTruthy()
      expect(screen.getByTestId('badcases-group-verifier-failure')).toBeTruthy()
    })
    expect(screen.getByTestId('badcases-row-inst-a')).toBeTruthy()
    expect(screen.getByTestId('badcases-row-inst-b')).toBeTruthy()
  })

  it('acts as a master-detail explorer with searchable readable details', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(listResponse), { status: 200 }))
    render(<BadCasesTab initialRunId="run-1" />)
    fireEvent.click(screen.getByTestId('badcases-load'))
    await waitFor(() => expect(screen.getByTestId('badcases-explorer')).toBeTruthy())
    expect(screen.getByTestId('badcases-detail').textContent).toContain('What happened')
    expect(screen.getByTestId('badcases-detail').textContent).toContain('What the agent changed')
    expect(screen.getByTestId('badcases-detail').textContent).toContain('Why the official check still failed')
    expect(screen.getByTestId('badcases-detail').textContent).toContain('diff did not apply')
    expect(screen.getByTestId('badcases-detail').textContent).toContain('head-line-a')
    expect(screen.getByText('Technical evidence (for engineers)').closest('details')?.open).toBe(false)
    fireEvent.click(screen.getByTestId('badcases-row-inst-b').querySelector('button')!)
    expect(screen.getByTestId('badcases-detail').textContent).toContain('inst-b')
    fireEvent.change(screen.getByTestId('badcases-search'), { target: { value: 'diff did not apply' } })
    expect(screen.getByTestId('badcases-row-inst-a')).toBeTruthy()
    expect(screen.queryByTestId('badcases-row-inst-b')).toBeNull()
  })

  it('sends annotate request when label changes', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(listResponse), { status: 200 }))
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ updatedAt: '2026-07-11T00:00:00Z' }), { status: 200 }))
    render(<BadCasesTab initialRunId="run-1" />)
    fireEvent.click(screen.getByTestId('badcases-load'))
    await waitFor(() => screen.getByTestId('badcases-label-inst-a'))
    fireEvent.change(screen.getByTestId('badcases-label-inst-a'), { target: { value: 'model-limitation' } })
    await waitFor(() => {
      const call = fetchMock.mock.calls[1]!
      expect(call[0]).toBe('/enhancement/action')
      const body = JSON.parse(String((call[1] as RequestInit).body)) as Record<string, unknown>
      expect(body).toMatchObject({ action: 'badcase-annotate', runId: 'run-1', instanceId: 'inst-a', label: 'model-limitation' })
    })
  })

  it('exports selected cases as JSONL blob download', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(listResponse), { status: 200 }))
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      format: 'sft', count: 1, content: '{"instruction":"Fix inst-a"}\n',
    }), { status: 200 }))
    const createObjectURL = vi.fn(() => 'blob:mock')
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL })
    render(<BadCasesTab initialRunId="run-1" />)
    fireEvent.click(screen.getByTestId('badcases-load'))
    await waitFor(() => screen.getByTestId('badcases-check-inst-a'))
    fireEvent.click(screen.getByTestId('badcases-check-inst-a'))
    fireEvent.click(screen.getByTestId('badcases-export-open'))
    fireEvent.click(screen.getByTestId('badcases-export'))
    await waitFor(() => {
      expect(createObjectURL).toHaveBeenCalled()
    })
    const exportCall = fetchMock.mock.calls[1]!
    const body = JSON.parse(String((exportCall[1] as RequestInit).body)) as Record<string, unknown>
    expect(body).toMatchObject({ action: 'badcase-export', runId: 'run-1', format: 'sft', instanceIds: ['inst-a'] })
  })

  it('shows error banner on failed load', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'nope' }), { status: 500 }))
    render(<BadCasesTab initialRunId="run-1" />)
    fireEvent.click(screen.getByTestId('badcases-load'))
    await waitFor(() => {
      expect(screen.getByTestId('badcases-error')).toBeTruthy()
    })
  })

  it('exports rollouts via blob download with target and status filter', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      target: 'verl', rolloutCount: 3, content: '{"rolloutId":"a"}\n{"rolloutId":"b"}\n{"rolloutId":"c"}\n',
    }), { status: 200 }))
    const createObjectURL = vi.fn(() => 'blob:mock')
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL })
    render(<BadCasesTab initialRunId="run-9" />)
    fireEvent.click(screen.getByTestId('badcases-export-open'))
    fireEvent.change(screen.getByTestId('rollouts-status-filter'), { target: { value: 'completed, resolved' } })
    fireEvent.click(screen.getByTestId('rollouts-export-button'))
    await waitFor(() => {
      expect(createObjectURL).toHaveBeenCalled()
      expect(screen.getByTestId('rollouts-export-done')).toBeTruthy()
    })
    const call = fetchMock.mock.calls[0]!
    expect(call[0]).toBe('/enhancement/action')
    const body = JSON.parse(String((call[1] as RequestInit).body)) as Record<string, unknown>
    expect(body).toMatchObject({
      action: 'rollout-export',
      runId: 'run-9',
      target: 'verl',
      includeStatuses: ['completed', 'resolved'],
    })
  })
})
