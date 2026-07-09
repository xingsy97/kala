import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ConnectWorkspaceDialog } from './ConnectWorkspaceDialog.js'

describe('ConnectWorkspaceDialog', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { protocol: 'http:', hostname: 'localhost', port: '3000' },
    })
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    })
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/settings') {
        return {
          ok: true,
          json: async () => ({
            providers: [],
            defaultModel: '',
            hooks: [],
            paths: { claudeSettings: '', codexConfig: '', manualModels: '', hooksConfig: '', sessionsDir: '' },
            mcp: { supported: false, note: '' },
            release: { bootstrapBaseUrl: 'http://localhost:3000/release-assets', source: 'local' },
          }),
        } as Response
      }
      return {
        ok: true,
            json: async () => ({ inviteToken: 'ak_invite_test' }),
      } as Response
    }))
  })

  it('shows release bootstrap commands for connecting an executor', async () => {
    render(<ConnectWorkspaceDialog open onOpenChange={() => {}} />)

    await screen.findByText(/Invite ready/i)

    const text = screen.getByTestId('connect-workspace-dialog').textContent ?? ''
    expect(text).toContain('downloads and verifies the executor from this host')
    expect(text).toContain('run.sh')
    expect(text).toContain('HOST_URL=')
    expect(text).toContain('COMPONENT=executor')
    expect(text).toContain('AGENT_KERNEL_RELEASE_BASE_URL=')
    expect(text).toContain('SANDBOX_ROOTS="$HOME"')
    expect(text).not.toContain('SANDBOX_ROOTS="$PWD"')
    expect(text).toContain('EXECUTOR_INVITE=')
    expect(text).toContain('ak_invite_test')
    expect(text).toContain('http://localhost:3000/release-assets')
    expect(text).not.toContain('github.com/')
    expect(text).toContain('Mac/Linux')
    expect(text).not.toContain('WORKSPACE_NAME')
    expect(text).not.toContain('agent-kernel-executor')
    const inviteCreateCall = vi.mocked(fetch).mock.calls.find((call) => String(call[0]) === '/auth/executor-invites')
    expect(inviteCreateCall?.[1]).toMatchObject({ method: 'POST', body: '{}' })
  })

  it('uses the dashboard origin for local release assets', async () => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { protocol: 'http:', hostname: '192.168.1.9', port: '3000' },
    })

    render(<ConnectWorkspaceDialog open onOpenChange={() => {}} />)

    await screen.findByText(/Invite ready/i)

    const text = screen.getByTestId('connect-workspace-dialog').textContent ?? ''
    expect(text).toContain('http://192.168.1.9:3000/release-assets/run.sh')
    expect(text).not.toContain('http://localhost:3000/release-assets/run.sh')
  })

  it('copies the selected wget command', async () => {
    const writeText = vi.mocked(navigator.clipboard.writeText)
    render(<ConnectWorkspaceDialog open onOpenChange={() => {}} />)

    await screen.findByText(/Invite ready/i)
    fireEvent.click(screen.getByTestId('connect-workspace-tab-unix'))
    fireEvent.click(screen.getByTestId('copy-executor-command'))

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))
    expect(writeText.mock.calls[0]?.[0]).toContain('wget -O-')
    expect(writeText.mock.calls[0]?.[0]).toContain('run.sh')
    expect(writeText.mock.calls[0]?.[0]).toContain('COMPONENT=executor')
    expect(writeText.mock.calls[0]?.[0]).toContain('AGENT_KERNEL_RELEASE_BASE_URL=')
    expect(writeText.mock.calls[0]?.[0]).toContain('EXECUTOR_INVITE=')
    expect(writeText.mock.calls[0]?.[0]).not.toContain('WORKSPACE_NAME')
  })

  it('switches command by operating system tab', async () => {
    render(<ConnectWorkspaceDialog open onOpenChange={() => {}} />)

    await screen.findByText(/Invite ready/i)

    fireEvent.click(screen.getByTestId('connect-workspace-tab-windows'))
    const windowsText = screen.getByTestId('connect-workspace-dialog').textContent ?? ''
    expect(windowsText).toContain('iwr')
    expect(windowsText).toContain('agent-kernel-executor.cjs')
    expect(windowsText).toContain('http://localhost:3000/release-assets')
    expect(windowsText).toContain('Get-FileHash')
    expect(windowsText).toContain('$env:HOST_URL=')
    expect(windowsText).toContain('$env:EXECUTOR_INVITE=')
    expect(windowsText).toContain('$env:SANDBOX_ROOTS=$env:USERPROFILE')
    expect(windowsText).not.toContain('(Get-Location).Path')
    expect(windowsText).not.toContain('wget -qO-')
    expect(windowsText).not.toContain('COMPONENT=executor')

    fireEvent.click(screen.getByTestId('connect-workspace-tab-unix'))
    const unixText = screen.getByTestId('connect-workspace-dialog').textContent ?? ''
    expect(unixText).toContain('wget -O-')
    expect(unixText).toContain('run.sh')
    expect(unixText).not.toContain('iwr')
    expect(unixText).not.toContain('curl')
    expect(unixText).not.toContain('run-executor.sh')
  })
})
