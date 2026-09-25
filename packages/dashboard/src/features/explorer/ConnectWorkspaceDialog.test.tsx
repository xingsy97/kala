import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    Object.defineProperty(navigator, 'platform', { configurable: true, value: 'Linux x86_64' })
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } })
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const rawUrl = String(input)
      const url = rawUrl.replace(/^http:\/\/host\.test:5301/u, '')
      if (url === '/api/executor-installs' && init?.method === 'POST') {
        const input = JSON.parse(String(init.body)) as Record<string, string>
        if (input.platform === 'macos' || input.mode === 'temporary') {
          return response({
            ...base,
            id: 'inst_2',
            ...input,
            command: "curl -fsSL 'http://localhost:3000/install' | RUNLAB_SETUP_CODE='F6E7D8C9B0' RUNLAB_INSTALL_MODE='temporary' sh",
            setupCode: 'F6E7D8C9B0',
          })
        }
        return response(base)
      }
      if (url.endsWith('/events?after=0')) return response({ events: [] })
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
    expect(screen.getByRole('region', { name: 'Installation options' })).toBeTruthy()
    expect(screen.getByTestId('connect-workspace-linux').className).toContain('bg-accent')
    expect(screen.queryByTestId('connect-workspace-windows')).toBeNull()
    expect(screen.getByTestId('connect-workspace-service').className).toContain('bg-background')
    expect(screen.getByTestId('connect-workspace-service').textContent).toContain('Recommended')
    expect(screen.getByTestId('connect-workspace-service').textContent).toContain('Install as service')
    expect(screen.getByTestId('installation-status').querySelector('svg')).toBeTruthy()
    const dialog = screen.getByTestId('connect-workspace-dialog')
    expect(dialog.className).toContain('rounded-t-2xl')
    expect(dialog.className).toContain('sm:rounded-3xl')
    expect(screen.getByText('Workspace setup')).toBeTruthy()
    const terminal = screen.getByTestId('executor-terminal-command')
    expect(terminal.className).toContain('rounded-2xl')
    expect(terminal.className).toContain('bg-muted/35')
    expect(terminal.className).toContain('text-foreground')
    expect(terminal.className).not.toContain('bg-foreground')
    expect(screen.getByTestId('copy-executor-command').className).toContain('w-full')
    expect(terminal.className).not.toContain('ring-1')
    const command = terminal.textContent ?? ''
    expect(command).toContain('/install')
    expect(command).toContain('A1B2C3D4E5')
    expect(command).not.toContain('\n')
    expect(command).not.toMatch(/sudo|systemctl|launchctl|sc\.exe|agent-kernel-executor|ak_install_/i)
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes('executor-invites'))).toBe(false)
  })

  it('supports Linux and macOS, both modes, immediate updates, and copies exactly one line', async () => {
    const write = vi.mocked(navigator.clipboard.writeText)
    render(<ConnectWorkspaceDialog open onOpenChange={() => {}} />)
    await screen.findByText(/curl -fsSL/)
    fireEvent.click(screen.getByTestId('connect-workspace-macos'))
    fireEvent.click(screen.getByTestId('connect-workspace-temporary'))
    await waitFor(() => expect(screen.getByText(/F6E7D8C9B0/)).toBeTruthy())
    expect(screen.getByTestId('executor-terminal-command').textContent).toContain("RUNLAB_INSTALL_MODE='temporary'")
    expect(vi.mocked(fetch).mock.calls.some(([url, init]) => String(url) === '/api/executor-installs' && init?.method === 'POST' && String(init.body).includes('temporary'))).toBe(true)
    expect(vi.mocked(fetch).mock.calls.some(([url, init]) => String(url) === '/api/executor-installs/inst_1' && init?.method === 'DELETE')).toBe(true)
    fireEvent.click(screen.getByTestId('copy-executor-command'))
    await waitFor(() => expect(write).toHaveBeenCalledOnce())
    expect(write.mock.calls[0]![0]).not.toMatch(/[\r\n]/u)
    expect(screen.getByTestId('connect-workspace-macos')).toBeTruthy()
  })

  it('does not advertise or request Windows installation on a Windows browser', async () => {
    Object.defineProperty(navigator, 'platform', { configurable: true, value: 'Win32' })
    render(<ConnectWorkspaceDialog open onOpenChange={() => {}} />)
    await screen.findByText(/curl -fsSL/)
    expect(screen.queryByTestId('connect-workspace-windows')).toBeNull()
    expect(screen.getByTestId('connect-workspace-linux').getAttribute('aria-pressed')).toBe('true')
    const createCall = vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === 'POST')
    expect(String(createCall?.[1]?.body)).toContain('"platform":"linux"')
  })

  it('immediately shows the target run mode, keeps the previous command visible, and prevents copying while refreshing', async () => {
    render(<ConnectWorkspaceDialog open onOpenChange={() => {}} />)
    await screen.findByText(/curl -fsSL/)

    fireEvent.click(screen.getByTestId('connect-workspace-temporary'))

    const terminal = screen.getByTestId('executor-terminal-command')
    expect(terminal.getAttribute('data-mode')).toBe('temporary')
    expect(terminal.getAttribute('aria-busy')).toBe('true')
    expect(screen.getByTestId('executor-command-transition')).toBeTruthy()
    expect(screen.getByTestId('copy-executor-command').hasAttribute('disabled')).toBe(true)
    expect(terminal.textContent).toContain('A1B2C3D4E5')

    await waitFor(() => expect(screen.getByText(/F6E7D8C9B0/)).toBeTruthy())
    expect(terminal.getAttribute('aria-busy')).toBe('false')
    expect(screen.queryByTestId('executor-command-transition')).toBeNull()
    expect(screen.getByTestId('copy-executor-command').hasAttribute('disabled')).toBe(false)
  })

  it('uses the active host endpoint for install APIs when provided', async () => {
    render(<ConnectWorkspaceDialog open host="http://host.test:5301" onOpenChange={() => {}} />)
    await screen.findByText(/curl -fsSL/)
    expect(vi.mocked(fetch).mock.calls.some(([url, init]) => String(url) === 'http://host.test:5301/api/executor-installs' && init?.method === 'POST')).toBe(true)
  })

  it('closes when the backdrop is clicked', async () => {
    const onOpenChange = vi.fn()
    render(<ConnectWorkspaceDialog open onOpenChange={onOpenChange} />)
    await screen.findByText(/curl -fsSL/)
    fireEvent.pointerDown(screen.getByTestId('dialog-overlay'))
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  })

  it('stops polling without invalidating the copied setup command when closed', async () => {
    const view = render(<ConnectWorkspaceDialog open onOpenChange={() => {}} />)
    await screen.findByText(/curl -fsSL/)
    view.rerender(<ConnectWorkspaceDialog open={false} onOpenChange={() => {}} />)
    const count = vi.mocked(fetch).mock.calls.length
    await vi.advanceTimersByTimeAsync(5_000)
    expect(vi.mocked(fetch).mock.calls).toHaveLength(count)
    expect(vi.mocked(fetch).mock.calls.some(([url, init]) => String(url) === '/api/executor-installs/inst_1' && init?.method === 'DELETE')).toBe(false)
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
