import { beforeEach, describe, expect, it, vi } from 'vitest'

import { executeShellDraft, formatShellDraft } from './shell-draft.js'
import { workspaceExec } from './workspace-exec.js'

vi.mock('./workspace-exec.js', () => ({
  workspaceExec: vi.fn(),
}))

const mockedWorkspaceExec = vi.mocked(workspaceExec)
const socket = {} as Parameters<typeof executeShellDraft>[0]

describe('shell draft execution', () => {
  beforeEach(() => {
    mockedWorkspaceExec.mockReset()
    mockedWorkspaceExec.mockResolvedValue({
      requestId: 'request-1',
      stdout: 'ready\n',
      stderr: '',
      exitCode: 0,
      durationMs: 12,
    })
  })

  it('passes POSIX commands on stdin instead of exposing them in argv', async () => {
    const result = await executeShellDraft(socket, 'workspace-1', 'printf "secret"', {
      cwd: '/workspace/project',
      os: 'linux',
    })

    expect(mockedWorkspaceExec).toHaveBeenCalledWith(
      socket,
      'workspace-1',
      ['/bin/sh', '-s'],
      expect.objectContaining({
        cwd: '/workspace/project',
        stdin: 'printf "secret"',
      }),
    )
    expect(result).toMatchObject({ command: 'printf "secret"', stdout: 'ready\n', exitCode: 0 })
  })

  it('uses non-interactive PowerShell for Windows workspaces', async () => {
    await executeShellDraft(socket, 'workspace-1', 'Get-Location', { os: 'win32' })

    expect(mockedWorkspaceExec).toHaveBeenCalledWith(
      socket,
      'workspace-1',
      ['powershell.exe', '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '-'],
      expect.objectContaining({ stdin: 'Get-Location' }),
    )
  })

  it('formats the command once and expands fences around embedded backticks', () => {
    const command = 'printf "```"'
    const draft = formatShellDraft({
      command,
      stdout: '```output```',
      stderr: '',
      exitCode: 0,
      durationMs: 4,
    })

    expect(draft.match(/printf "```"/gu)).toHaveLength(1)
    expect(draft).toContain('````shell')
    expect(draft).toContain('````text')
    expect(draft).toContain('Exit code: 0 (4 ms)')
  })
})
