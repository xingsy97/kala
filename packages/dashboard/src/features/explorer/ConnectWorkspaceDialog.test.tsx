import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ConnectWorkspaceDialog } from './ConnectWorkspaceDialog.js'

const base = {
  id: 'inst_1', platform: 'linux', mode: 'service', workspaceRoot: '__RUNLAB_CURRENT_DIRECTORY__',
  status: 'created', seq: 0, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', expiresAt: '2026-01-01T00:15:00Z',
  command: "curl -fsSL 'http://localhost:3000/install' | RUNLAB_SETUP_CODE='A1B2C3D4E5' RUNLAB_INSTALL_MODE='service' sh", setupCode: 'A1B2C3D4E5',
}

function response(body: unknown, ok = true): Response {
  return { ok, json: async () => body, text: async () => JSON.stringify(body) } as Response
}

describe('ConnectWorkspaceDialog', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    Object.defineProperty(navigator, 'platform', { configurable: true, value: 'Linux x86_64' })
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } })
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/executor-installs' && init?.method === 'POST') return response(base)
      if (url.endsWith('/events?after=0')) return response({ events: [] })
      if (url === '/api/executor-installs/inst_1' && init?.method === 'PATCH') {
        const patch = JSON.parse(String(init.body)) as Record<string, string>
        const platform = patch.platform ?? 'linux'
        return response({ ...base, ...patch, command: platform === 'windows' ? "$env:RUNLAB_SETUP_CODE='A1B2C3D4E5'; $env:RUNLAB_INSTALL_MODE='temporary'; irm 'http://localhost:3000/install.ps1' | iex" : base.command })
      }
      if (url === '/api/executor-installs/inst_1' && init?.method === 'DELETE') return response({ ok: true })
      if (url.endsWith('/approve')) return response({ ...base, status: 'paired', seq: 4 })
      if (url.endsWith('/reject')) return response({ ...base, status: 'rejected', seq: 4 })
      if (url === '/api/executor-installs/inst_1') return response(base)
      throw new Error(`unexpected request ${init?.method ?? 'GET'} ${url}`)
    }))
  })

  it('defaults to Linux service mode, shows platform icons, and displays one physical command', async () => {
    render(<ConnectWorkspaceDialog open onOpenChange={() => {}} />)
    await screen.findByText(/curl -fsSL/)
    expect(screen.getByTestId('connect-workspace-service').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('connect-workspace-linux').getAttribute('aria-pressed')).toBe('true')
    expect(screen.queryByLabelText(/workspace root/i)).toBeNull()
    expect(screen.queryByText(/no sudo required/i)).toBeNull()
    const command = screen.getByTestId('executor-terminal-command').textContent ?? ''
    expect(command).toContain('/install')
    expect(command).toContain('A1B2C3D4E5')
    expect(command).not.toContain('\n')
    expect(command).not.toMatch(/sudo|systemctl|launchctl|sc\.exe|agent-kernel-executor|ak_install_/i)
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes('executor-invites'))).toBe(false)
  })

  it('supports all three platforms, both modes, debounced updates, and copies exactly one line', async () => {
    const write = vi.mocked(navigator.clipboard.writeText)
    render(<ConnectWorkspaceDialog open onOpenChange={() => {}} />)
    await screen.findByText(/curl -fsSL/)
    fireEvent.click(screen.getByTestId('connect-workspace-windows'))
    fireEvent.click(screen.getByTestId('connect-workspace-temporary'))
    await vi.advanceTimersByTimeAsync(400)
    await waitFor(() => expect(screen.getByText(/install\.ps1/)).toBeTruthy())
    expect(screen.getByTestId('executor-terminal-command').textContent).toContain("RUNLAB_INSTALL_MODE='temporary'")
    fireEvent.click(screen.getByTestId('copy-executor-command'))
    await waitFor(() => expect(write).toHaveBeenCalledOnce())
    expect(write.mock.calls[0]![0]).not.toMatch(/[\r\n]/u)
    expect(screen.getByTestId('connect-workspace-macos')).toBeTruthy()
  })

  it('closes when the backdrop is clicked', async () => {
    const onOpenChange = vi.fn()
    render(<ConnectWorkspaceDialog open onOpenChange={onOpenChange} />)
    await screen.findByText(/curl -fsSL/)
    fireEvent.pointerDown(screen.getByTestId('dialog-overlay'))
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  })

  it('stops polling and deletes the unused installation when closed', async () => {
    const view = render(<ConnectWorkspaceDialog open onOpenChange={() => {}} />)
    await screen.findByText(/curl -fsSL/)
    view.rerender(<ConnectWorkspaceDialog open={false} onOpenChange={() => {}} />)
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url, init]) => String(url) === '/api/executor-installs/inst_1' && init?.method === 'DELETE')).toBe(true))
    const count = vi.mocked(fetch).mock.calls.length
    await vi.advanceTimersByTimeAsync(5_000)
    expect(vi.mocked(fetch).mock.calls).toHaveLength(count)
  })

  it('shows pairing approval and handles clipboard failure', async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/executor-installs' && init?.method === 'POST') return response({ ...base, status: 'pairing_pending', seq: 3, metadata: { pairingCode: '123456' } })
      if (url.endsWith('/approve')) return response({ ...base, status: 'paired', seq: 4 })
      if (url.endsWith('/events?after=3')) return response({ events: [] })
      if (url === '/api/executor-installs/inst_1') return response({ ...base, status: 'pairing_pending', seq: 3 })
      if (init?.method === 'DELETE') return response({ ok: true })
      throw new Error(`unexpected ${url}`)
    })
    vi.mocked(navigator.clipboard.writeText).mockRejectedValueOnce(new Error('clipboard denied'))
    render(<ConnectWorkspaceDialog open onOpenChange={() => {}} />)
    await screen.findByText('123456')
    fireEvent.click(screen.getByTestId('copy-executor-command'))
    await screen.findByText(/clipboard denied/)
    fireEvent.click(screen.getByRole('button', { name: /approve/i }))
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith('/approve'))).toBe(true))
  })
})
