import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import '../../i18n/index.js'
import { RunTerminalBenchWizard } from './RunTerminalBenchWizard.js'

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('RunTerminalBenchWizard', () => {
  const fetchMock = vi.fn<typeof fetch>()

  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders three steps and starts on choose-tasks', () => {
    render(
      <RunTerminalBenchWizard open onOpenChange={() => {}} onRunRegistered={() => {}} />,
    )
    expect(screen.getByTestId('terminalbench-wizard')).toBeTruthy()
    expect(screen.getByTestId('terminalbench-wizard-step-label-tasks')).toBeTruthy()
    expect(screen.getByTestId('terminalbench-wizard-step-label-agent')).toBeTruthy()
    expect(screen.getByTestId('terminalbench-wizard-step-label-import')).toBeTruthy()
    expect(screen.getByTestId('terminalbench-wizard-runid')).toBeTruthy()
  })

  it('advances tasks -> agent -> import with correct action calls', async () => {
    fetchMock.mockImplementation(async (_url, init) => {
      const body = JSON.parse((init?.body as string) ?? '{}') as { action: string }
      if (body.action === 'terminal-bench-resolve-tasks') {
        return jsonRes({ action: body.action, runId: 'tb-1', taskCount: 2 })
      }
      if (body.action === 'terminal-bench-run-agent') {
        return jsonRes({
          action: body.action,
          runId: 'tb-1',
          total: 2,
          resolved: 2,
          unresolved: 0,
          errored: 0,
          accuracy: 1,
          durationMs: 10,
        })
      }
      if (body.action === 'terminal-bench-read-progress') {
        return jsonRes({
          action: body.action, runId: 'tb-1', status: 'running',
          total: 2, completed: 1, lastUpdatedAt: null,
        })
      }
      if (body.action === 'terminal-bench-import-results') {
        return jsonRes({ action: body.action, runId: 'tb-1', total: 2, resolved: 2, unresolved: 0, errored: 0 })
      }
      return jsonRes({ error: 'unexpected' }, 400)
    })

    const onRunRegistered = vi.fn()
    render(<RunTerminalBenchWizard open onOpenChange={() => {}} onRunRegistered={onRunRegistered} />)
    fireEvent.change(screen.getByTestId('terminalbench-wizard-runid'), { target: { value: 'tb-1' } })
    fireEvent.change(screen.getByTestId('terminalbench-wizard-tasks'), { target: { value: '{"id":"a"}\n{"id":"b"}' } })
    fireEvent.click(screen.getByTestId('terminalbench-wizard-next-tasks'))
    await waitFor(() => expect(screen.getByTestId('terminalbench-wizard-run-agent')).toBeTruthy())

    fireEvent.click(screen.getByTestId('terminalbench-wizard-run-agent'))
    await waitFor(() => expect(screen.getByTestId('terminalbench-wizard-import')).toBeTruthy())

    fireEvent.click(screen.getByTestId('terminalbench-wizard-import'))
    await waitFor(() => expect(onRunRegistered).toHaveBeenCalledWith('tb-1'))

    const actions = fetchMock.mock.calls.map((c) => {
      const body = JSON.parse((c[1] as RequestInit).body as string) as { action: string }
      return body.action
    })
    expect(actions).toContain('terminal-bench-resolve-tasks')
    expect(actions).toContain('terminal-bench-run-agent')
    expect(actions).toContain('terminal-bench-import-results')
  })

  it('surfaces errors from the host', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ error: 'bad tasks' }, 400))
    render(<RunTerminalBenchWizard open onOpenChange={() => {}} onRunRegistered={() => {}} />)
    fireEvent.change(screen.getByTestId('terminalbench-wizard-runid'), { target: { value: 'tb-1' } })
    fireEvent.change(screen.getByTestId('terminalbench-wizard-tasks'), { target: { value: 'x' } })
    fireEvent.click(screen.getByTestId('terminalbench-wizard-next-tasks'))
    await waitFor(() => expect(screen.getByTestId('terminalbench-wizard-error')).toBeTruthy())
  })
})
