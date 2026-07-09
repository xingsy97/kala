import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ConnectWorkspaceDialog } from './ConnectWorkspaceDialog.js'

describe('ConnectWorkspaceDialog', () => {
  beforeEach(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    })
  })

  it('shows release bootstrap commands for connecting an executor', () => {
    render(<ConnectWorkspaceDialog open onOpenChange={() => {}} />)

    const text = screen.getByTestId('connect-workspace-dialog').textContent ?? ''
    expect(text).toContain('run.sh')
    expect(text).toContain('HOST_URL=')
    expect(text).toContain('COMPONENT=executor')
    expect(text).toContain('SANDBOX_ROOTS="$PWD"')
    expect(text).toContain('releases/latest/download')
    expect(text).toContain('Mac/Linux')
    expect(text).not.toContain('WORKSPACE_NAME')
    expect(text).not.toContain('agent-kernel-executor')
  })

  it('copies the selected wget command', async () => {
    const writeText = vi.mocked(navigator.clipboard.writeText)
    render(<ConnectWorkspaceDialog open onOpenChange={() => {}} />)

    fireEvent.click(screen.getByTestId('connect-workspace-tab-unix'))
    fireEvent.click(screen.getByTestId('copy-executor-command'))

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))
    expect(writeText.mock.calls[0]?.[0]).toContain('wget -qO-')
    expect(writeText.mock.calls[0]?.[0]).toContain('run.sh')
    expect(writeText.mock.calls[0]?.[0]).toContain('COMPONENT=executor')
    expect(writeText.mock.calls[0]?.[0]).not.toContain('WORKSPACE_NAME')
  })

  it('switches command by operating system tab', () => {
    render(<ConnectWorkspaceDialog open onOpenChange={() => {}} />)

    fireEvent.click(screen.getByTestId('connect-workspace-tab-windows'))
    const windowsText = screen.getByTestId('connect-workspace-dialog').textContent ?? ''
    expect(windowsText).toContain('wget -qO-')
    expect(windowsText).toContain('run.sh')
    expect(windowsText).not.toContain('powershell')
    expect(windowsText).not.toContain('iwr')
    expect(windowsText).not.toContain('curl')
    expect(windowsText).not.toContain('run-executor.sh')

    fireEvent.click(screen.getByTestId('connect-workspace-tab-unix'))
    const unixText = screen.getByTestId('connect-workspace-dialog').textContent ?? ''
    expect(unixText).toContain('wget -qO-')
    expect(unixText).toContain('run.sh')
    expect(unixText).not.toContain('curl')
    expect(unixText).not.toContain('run-executor.sh')
  })
})
