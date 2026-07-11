import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ConnectWorkspaceDialog } from './ConnectWorkspaceDialog.js'

describe('ConnectWorkspaceDialog', () => {
  beforeEach(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ inviteToken: 'ak_invite_test', expiresAt: '2026-07-11T00:10:00.000Z' }),
    }))
  })

  it('shows release bootstrap commands for connecting an executor', async () => {
    render(<ConnectWorkspaceDialog open onOpenChange={() => {}} />)

    await screen.findByText(/Invite expires at/i)

    const text = screen.getByTestId('connect-workspace-dialog').textContent ?? ''
    expect(text).toContain('run.sh')
    expect(text).toContain('HOST_URL=')
    expect(text).toContain('COMPONENT=executor')
    expect(text).toContain('SANDBOX_ROOTS="$PWD"')
    expect(text).toContain('EXECUTOR_INVITE=')
    expect(text).toContain('ak_invite_test')
    expect(text).toContain('releases/latest/download')
    expect(text).toContain('Mac/Linux')
    expect(text).not.toContain('WORKSPACE_NAME')
    expect(text).not.toContain('agent-kernel-executor')
  })

  it('copies the selected wget command', async () => {
    const writeText = vi.mocked(navigator.clipboard.writeText)
    render(<ConnectWorkspaceDialog open onOpenChange={() => {}} />)

    await screen.findByText(/Invite expires at/i)
    fireEvent.click(screen.getByTestId('connect-workspace-tab-unix'))
    fireEvent.click(screen.getByTestId('copy-executor-command'))

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))
    expect(writeText.mock.calls[0]?.[0]).toContain('wget -qO-')
    expect(writeText.mock.calls[0]?.[0]).toContain('run.sh')
    expect(writeText.mock.calls[0]?.[0]).toContain('COMPONENT=executor')
    expect(writeText.mock.calls[0]?.[0]).toContain('EXECUTOR_INVITE=')
    expect(writeText.mock.calls[0]?.[0]).not.toContain('WORKSPACE_NAME')
  })

  it('switches command by operating system tab', async () => {
    render(<ConnectWorkspaceDialog open onOpenChange={() => {}} />)

    await screen.findByText(/Invite expires at/i)

    fireEvent.click(screen.getByTestId('connect-workspace-tab-windows'))
    const windowsText = screen.getByTestId('connect-workspace-dialog').textContent ?? ''
    expect(windowsText).toContain('iwr')
    expect(windowsText).toContain('agent-kernel-executor.cjs')
    expect(windowsText).toContain('Get-FileHash')
    expect(windowsText).toContain('$env:HOST_URL=')
    expect(windowsText).toContain('$env:EXECUTOR_INVITE=')
    expect(windowsText).toContain('$env:SANDBOX_ROOTS=')
    expect(windowsText).not.toContain('wget -qO-')
    expect(windowsText).not.toContain('COMPONENT=executor')

    fireEvent.click(screen.getByTestId('connect-workspace-tab-unix'))
    const unixText = screen.getByTestId('connect-workspace-dialog').textContent ?? ''
    expect(unixText).toContain('wget -qO-')
    expect(unixText).toContain('run.sh')
    expect(unixText).not.toContain('iwr')
    expect(unixText).not.toContain('curl')
    expect(unixText).not.toContain('run-executor.sh')
  })
})
