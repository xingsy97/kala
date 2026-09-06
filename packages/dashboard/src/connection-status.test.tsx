import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ConnectionStatus } from './app.js'

function socketWithRtt(hostRttMs = 12, executorRttMs: number | null = 34) {
  let now = 0
  vi.spyOn(performance, 'now').mockImplementation(() => {
    now += hostRttMs
    return now
  })
  return {
    connected: true,
    timeout: vi.fn(() => ({
      emit: (event: string, _arg: unknown, callback: (...args: unknown[]) => void) => {
        if (event === 'client:connection_ping') callback(null)
        if (event === 'client:executor_ping') callback(null, { rttMs: executorRttMs ?? undefined })
      },
    })),
  }
}

function socketWithRttSeries(hostRtts: readonly number[], executorRtts: readonly number[]) {
  let performanceNow = 0
  let hostIndex = 0
  let executorIndex = 0
  vi.spyOn(performance, 'now').mockImplementation(() => performanceNow)
  return {
    connected: true,
    timeout: vi.fn(() => ({
      emit: (event: string, _arg: unknown, callback: (...args: unknown[]) => void) => {
        if (event === 'client:connection_ping') {
          const next = hostRtts[Math.min(hostIndex, hostRtts.length - 1)] ?? 0
          hostIndex += 1
          performanceNow += next
          callback(null)
        }
        if (event === 'client:executor_ping') {
          const next = executorRtts[Math.min(executorIndex, executorRtts.length - 1)] ?? 0
          executorIndex += 1
          callback(null, { rttMs: next })
        }
      },
    })),
  }
}

function timedOutSocket() {
  return {
    connected: true,
    timeout: vi.fn(() => ({
      emit: (_event: string, _arg: unknown, callback: (...args: unknown[]) => void) => callback(new Error('timeout')),
    })),
  }
}

describe('ConnectionStatus', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('presents the complete Device to Service to Executor RTT as the headline', async () => {
    const socket = socketWithRtt()
    render(<ConnectionStatus socket={socket as never} status="ready" transport="websocket" cursor={9} workspaceId="w1" executorConnected onResync={() => {}} />)

    await waitFor(() => expect(screen.getByTestId('connection-headline-latency').textContent).toBe('46 ms'))
    fireEvent.click(screen.getByTestId('connection-status'))
    const path = within(screen.getByTestId('connection-path'))
    expect(screen.getByTestId('connection-segment-device-service').getAttribute('title')).toContain('Device → Service')
    expect(screen.getByTestId('connection-segment-service-executor').getAttribute('title')).toContain('Service → Executor')
    expect(path.getByText('Device')).toBeTruthy()
    expect(path.getByText('Service')).toBeTruthy()
    expect(path.getByText('Executor')).toBeTruthy()
    expect(screen.getByText('12 ms')).toBeTruthy()
    expect(screen.getByText('34 ms')).toBeTruthy()
    expect(screen.queryByText(/cursor/i)).toBeNull()
  })

  it('does not present a partial segment as complete latency while Executor measurement is unavailable', async () => {
    const socket = socketWithRtt(12, null)
    render(<ConnectionStatus socket={socket as never} status="ready" transport="websocket" cursor={9} workspaceId="w1" executorConnected onResync={() => {}} />)

    await waitFor(() => expect(screen.getByTestId('connection-headline-latency').textContent).toBe('—'))
  })

  it('distinguishes offline from an unknown or timed-out latency', () => {
    render(<ConnectionStatus socket={null} status="disconnected" cursor={0} workspaceId="w1" executorConnected={false} onResync={() => {}} />)

    expect(screen.getByTestId('connection-headline-latency').textContent).toBe('—')
    fireEvent.click(screen.getByTestId('connection-status'))
    expect(screen.getByText('Offline')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Measure again' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('marks the overall connection as failed when both latency probes time out', async () => {
    render(<ConnectionStatus socket={timedOutSocket() as never} status="ready" transport="websocket" cursor={9} workspaceId="w1" executorConnected onResync={() => {}} />)

    await waitFor(() => expect(screen.getByTestId('connection-status').getAttribute('data-status')).toBe('error'))
    expect(screen.getByText('Connection issue')).toBeTruthy()
    expect(screen.getByTestId('connection-headline-latency').textContent).toBe('—')

    fireEvent.click(screen.getByTestId('connection-status'))
    expect(screen.getAllByText('Timed out')).toHaveLength(2)
    expect(screen.getAllByText('Connection issue').length).toBeGreaterThanOrEqual(2)
  })

  it('keeps a rolling 10 minute curve instead of only the latest measurement', async () => {
    let wallClock = 0
    vi.spyOn(Date, 'now').mockImplementation(() => wallClock)
    const socket = socketWithRtt(10, 20)

    render(<ConnectionStatus socket={socket as never} status="ready" transport="websocket" cursor={9} workspaceId="w1" executorConnected onResync={() => {}} />)

    await waitFor(() => expect(screen.getByTestId('connection-headline-latency').textContent).toBe('30 ms'))
    fireEvent.click(screen.getByTestId('connection-status'))
    await waitFor(() => expect(screen.getByTestId('connection-health-curve').getAttribute('data-sample-count')).toBe('2'))
    expect(screen.getByText('Last 10 minutes')).toBeTruthy()

    wallClock = 9 * 60 * 1000
    fireEvent.click(screen.getByRole('button', { name: 'Measure again' }))
    await waitFor(() => expect(screen.getByTestId('connection-health-curve').getAttribute('data-sample-count')).toBe('3'))

    wallClock = 20 * 60 * 1000
    fireEvent.click(screen.getByRole('button', { name: 'Measure again' }))
    await waitFor(() => expect(screen.getByTestId('connection-health-curve').getAttribute('data-sample-count')).toBe('1'))
  })

  it('normalizes host and executor curves independently', async () => {
    let wallClock = 0
    vi.spyOn(Date, 'now').mockImplementation(() => wallClock)
    const socket = socketWithRttSeries([100, 200, 300], [1000, 2000, 3000])

    render(<ConnectionStatus socket={socket as never} status="ready" transport="websocket" cursor={9} workspaceId="w1" executorConnected onResync={() => {}} />)

    await waitFor(() => expect(screen.getByTestId('connection-headline-latency').textContent).toBe('1100 ms'))
    fireEvent.click(screen.getByTestId('connection-status'))
    await waitFor(() => expect(screen.getByTestId('connection-health-curve').getAttribute('data-sample-count')).toBe('2'))

    wallClock = 30_000
    fireEvent.click(screen.getByRole('button', { name: 'Measure again' }))
    await waitFor(() => expect(screen.getByTestId('connection-health-curve').getAttribute('data-sample-count')).toBe('3'))

    expect(screen.getByTestId('connection-health-host-line').getAttribute('points')).toBe(screen.getByTestId('connection-health-executor-line').getAttribute('points'))
  })

  it('uses the full chart width before the 10 minute window is full', async () => {
    let wallClock = 0
    vi.spyOn(Date, 'now').mockImplementation(() => wallClock)
    const socket = socketWithRttSeries([100, 200], [1000, 2000])

    render(<ConnectionStatus socket={socket as never} status="ready" transport="websocket" cursor={9} workspaceId="w1" executorConnected onResync={() => {}} />)

    await waitFor(() => expect(screen.getByTestId('connection-headline-latency').textContent).toBe('1100 ms'))
    fireEvent.click(screen.getByTestId('connection-status'))
    wallClock = 30_000
    fireEvent.click(screen.getByRole('button', { name: 'Measure again' }))

    await waitFor(() => expect(screen.getByTestId('connection-health-host-line').getAttribute('points')).toContain('320.0,'))
  })

  it('exposes per-sample hover details with time and latency', async () => {
    let wallClock = Date.UTC(2026, 8, 6, 16, 25, 0)
    vi.spyOn(Date, 'now').mockImplementation(() => wallClock)
    const socket = socketWithRtt(89, 85)

    render(<ConnectionStatus socket={socket as never} status="ready" transport="websocket" cursor={9} workspaceId="w1" executorConnected onResync={() => {}} />)

    await waitFor(() => expect(screen.getByTestId('connection-headline-latency').textContent).toBe('174 ms'))
    fireEvent.click(screen.getByTestId('connection-status'))

    await waitFor(() => {
      const titles = Array.from(document.querySelectorAll('[data-testid="connection-health-sample-hit"] title')).map((node) => node.textContent ?? '')
      expect(titles.some((title) => title.includes('Host: 89 ms') && title.includes('Executor: 85 ms'))).toBe(true)
    })
  })
})
