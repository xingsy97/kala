import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ServerTerminalOutput } from '@agent-kernel/shared'
import { SessionTerminalPanel } from './SessionTerminalPanel.js'
import type { DashboardSocket } from '../../session.js'

const writeMock = vi.fn()
const clearMock = vi.fn()
const focusMock = vi.fn()
const inputListeners: Array<(data: string) => void> = []

vi.mock('@xterm/xterm', () => ({
  Terminal: class TerminalMock {
    options = { fontSize: 12 }
    cols = 100
    rows = 12
    write = writeMock
    writeln = vi.fn()
    clear = clearMock
    focus = focusMock
    loadAddon(): void {}
    open(): void {}
    dispose(): void {}
    onData(listener: (data: string) => void): { dispose(): void } { inputListeners.push(listener); return { dispose() {} } }
  },
}))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class FitAddonMock { fit(): void {} } }))
vi.mock('@xterm/addon-search', () => ({ SearchAddon: class SearchAddonMock {} }))
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class WebLinksAddonMock {} }))

function makeSocket() {
  const listeners = new Map<string, Set<(payload: never) => void>>()
  const emit = vi.fn((event: string, payload: Record<string, unknown>, ack?: (result: unknown) => void) => {
    if (event === 'terminal:create') ack?.({ ...payload, terminalId: 'term-1', cwd: '/repo' })
    if (event === 'terminal:kill') ack?.({ ...payload, killed: true })
  })
  return {
    socket: {
      emit,
      on: (event: string, listener: (payload: never) => void) => { const set = listeners.get(event) ?? new Set(); set.add(listener); listeners.set(event, set) },
      off: (event: string, listener: (payload: never) => void) => listeners.get(event)?.delete(listener),
    } as unknown as DashboardSocket,
    emit,
    server(event: string, payload: unknown) { listeners.get(event)?.forEach((listener) => listener(payload as never)) },
  }
}

describe('SessionTerminalPanel', () => {
  beforeEach(() => {
    writeMock.mockClear(); clearMock.mockClear(); focusMock.mockClear(); inputListeners.length = 0
    vi.stubGlobal('ResizeObserver', class ResizeObserverMock {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe(): void { this.callback([], this as unknown as ResizeObserver) }
      unobserve(): void {}
      disconnect(): void {}
    })
  })

  it('starts, filters output, sends xterm and touch input, resizes, clears, and does not kill on unmount', async () => {
    const mock = makeSocket()
    const { unmount } = render(<SessionTerminalPanel socket={mock.socket} workspaceId="ws-1" sessionId="sess-1" cwd="/repo" />)
    fireEvent.click(screen.getByRole('button', { name: 'Start' }))
    await waitFor(() => expect(mock.emit).toHaveBeenCalledWith('terminal:create', expect.objectContaining({ workspaceId: 'ws-1', sessionId: 'sess-1' }), expect.any(Function)))
    await waitFor(() => expect(mock.emit).toHaveBeenCalledWith('terminal:resize', expect.objectContaining({ terminalId: 'term-1', cols: 100, rows: 12 })))
    expect(screen.getByTestId('session-terminal-panel').getAttribute('data-terminal-status')).toBe('running')
    expect(screen.getByTestId('terminal-status').querySelector('span')?.className).toContain('bg-emerald-500')
    expect(screen.getByTestId('terminal-viewport').className).toContain('focus-within:ring-1')
    expect(focusMock).toHaveBeenCalled()
    focusMock.mockClear()
    fireEvent.pointerDown(screen.getByTestId('terminal-viewport'))
    expect(focusMock).toHaveBeenCalledOnce()

    mock.server('server:terminal_output', { workspaceId: 'ws-other', sessionId: 'sess-1', terminalId: 'term-1', data: 'wrong' } satisfies ServerTerminalOutput)
    mock.server('server:terminal_output', { workspaceId: 'ws-1', sessionId: 'sess-1', terminalId: 'term-1', data: 'right' } satisfies ServerTerminalOutput)
    expect(writeMock).toHaveBeenCalledWith('right')
    expect(writeMock).not.toHaveBeenCalledWith('wrong')

    inputListeners.at(-1)?.('ls\r')
    fireEvent.click(screen.getByRole('button', { name: 'Ctrl+C' }))
    expect(mock.emit).toHaveBeenCalledWith('terminal:input', expect.objectContaining({ data: 'ls\r', terminalId: 'term-1' }))
    expect(mock.emit).toHaveBeenCalledWith('terminal:input', expect.objectContaining({ data: '\u0003', terminalId: 'term-1' }))

    fireEvent.click(screen.getByRole('button', { name: 'Clear terminal' }))
    expect(clearMock).toHaveBeenCalledOnce()
    unmount()
    expect(mock.emit.mock.calls.filter(([event]) => event === 'terminal:kill')).toHaveLength(0)
  })

  it('shows offline guidance and disables start', () => {
    const mock = makeSocket()
    render(<SessionTerminalPanel socket={mock.socket} workspaceId="ws-1" sessionId="sess-1" online={false} />)
    expect(screen.getByText(/reconnect the workspace executor/i)).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Start' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('auto-starts a temporary terminal and kills it when the modal unmounts', async () => {
    const mock = makeSocket()
    const { unmount } = render(<SessionTerminalPanel socket={mock.socket} workspaceId="ws-1" sessionId="sess-1" cwd="/repo" autoStart destroyOnUnmount />)
    await waitFor(() => expect(mock.emit).toHaveBeenCalledWith('terminal:create', expect.objectContaining({ workspaceId: 'ws-1', sessionId: 'sess-1', cwd: '/repo' }), expect.any(Function)))
    await screen.findByText('Running')
    unmount()
    await waitFor(() => expect(mock.emit).toHaveBeenCalledWith('terminal:kill', expect.objectContaining({ workspaceId: 'ws-1', sessionId: 'sess-1', terminalId: 'term-1' }), expect.any(Function)))
  })

  it('kills explicitly and can restart with a new create request', async () => {
    const mock = makeSocket()
    render(<SessionTerminalPanel socket={mock.socket} workspaceId="ws-1" sessionId="sess-1" />)
    fireEvent.click(screen.getByRole('button', { name: 'Start' }))
    await screen.findByText('Running')
    fireEvent.click(screen.getByRole('button', { name: 'Restart terminal' }))
    await waitFor(() => expect(mock.emit.mock.calls.filter(([event]) => event === 'terminal:create')).toHaveLength(2))
    expect(mock.emit.mock.calls.filter(([event]) => event === 'terminal:kill')).toHaveLength(1)
  })
})
