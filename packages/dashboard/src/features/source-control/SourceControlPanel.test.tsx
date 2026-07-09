import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { WorkspaceExecResponse } from '@agent-kernel/shared/workspace-exec'

import { SourceControlPanel } from './SourceControlPanel.js'

vi.mock('@monaco-editor/react', () => ({
  DiffEditor: ({ original, modified, options }: { original?: string; modified?: string; options?: { renderSideBySide?: boolean } }) => (
    <div data-testid="mock-diff-editor" data-side-by-side={String(options?.renderSideBySide)}>{original}::{modified}</div>
  ),
}))

/**
 * Reference porcelain output for the mocked repo. Files are separated by
 * NUL to match `git status --porcelain=v1 -z --branch`.
 */
const PORCELAIN = '## main\0 M src/z.ts\0 M src/app.ts\0?? new.txt\0'
const REPO_ROOT = '/repo'

describe('SourceControlPanel', () => {
  it('renders grouped git changes and opens a read-only diff dialog', async () => {
    const socket = makeWorkspaceExecSocket({
      onExec: (argv) => {
        if (argv[0] === 'git' && argv[1] === 'rev-parse') {
          return { stdout: REPO_ROOT, stderr: '', exitCode: 0, durationMs: 1 }
        }
        if (argv[0] === 'git' && argv[1] === 'status') {
          return { stdout: PORCELAIN, stderr: '', exitCode: 0, durationMs: 1 }
        }
        if (argv[0] === 'git' && argv[1] === 'show' && argv[2] === ':src/app.ts') {
          return { stdout: 'old', stderr: '', exitCode: 0, durationMs: 1 }
        }
        return { stdout: '', stderr: '', exitCode: 0, durationMs: 1 }
      },
      onReadBinary: (path) => {
        if (path === `${REPO_ROOT}/src/app.ts`) {
          return { base64: btoa('new'), mime: 'text/plain', size: 3 }
        }
        return { base64: '', mime: 'application/octet-stream', size: 0, error: { code: 'ENOENT' as const, message: 'not found' } }
      },
    })

    render(<SourceControlPanel socket={socket.asDashboardSocket()} workspaceId="ws-1" sessionId="s-1" cwd="/repo/packages/app" />)

    expect(await screen.findByText('main')).toBeTruthy()
    expect(screen.getByText('Changes')).toBeTruthy()
    expect(screen.getByText('Untracked')).toBeTruthy()
    expect(screen.getAllByTestId('source-control-file').map((node) => node.textContent)).toEqual(['Msrc/z.ts', 'Msrc/app.ts', '?new.txt'])
    fireEvent.click(screen.getByTestId('source-control-order-by-path'))
    expect(screen.getAllByTestId('source-control-file').map((node) => node.textContent)).toEqual(['Msrc/app.ts', 'Msrc/z.ts', '?new.txt'])
    fireEvent.click(screen.getByText('src/app.ts'))

    await waitFor(() => expect(screen.getByTestId('mock-diff-editor').textContent).toContain('old::new'))
    expect(screen.getByTestId('mock-diff-editor').getAttribute('data-side-by-side')).toBe('true')
    fireEvent.click(screen.getByTestId('source-control-diff-inline'))
    expect(screen.getByTestId('mock-diff-editor').getAttribute('data-side-by-side')).toBe('false')
    // Both git status and git show reach the executor through workspace:exec.
    const execCalls = socket.emitMock.mock.calls.filter(([event]) => event === 'workspace:exec')
    expect(execCalls.length).toBeGreaterThanOrEqual(3)
    expect(execCalls.some(([, payload]) => JSON.stringify((payload as { argv: string[] }).argv).includes('status'))).toBe(true)
    expect(execCalls.some(([, payload]) => JSON.stringify((payload as { argv: string[] }).argv).includes('show'))).toBe(true)
  })
})

type ExecStub = Partial<Omit<WorkspaceExecResponse, 'requestId'>>

function makeWorkspaceExecSocket(input: {
  onExec: (argv: readonly string[]) => ExecStub
  onReadBinary?: (path: string) => { base64: string; mime: string; size: number; error?: { code: 'ENOENT' | 'EACCES' | 'EINVAL' | 'EIO'; message: string } }
}) {
  const emitMock = vi.fn((event: string, payload: Record<string, unknown>, ack?: (payload: unknown) => void) => {
    if (event === 'workspace:exec') {
      const argv = (payload as { argv: readonly string[] }).argv
      const stub = input.onExec(argv)
      queueMicrotask(() => ack?.({
        requestId: (payload as { requestId: string }).requestId,
        stdout: stub.stdout ?? '',
        stderr: stub.stderr ?? '',
        exitCode: stub.exitCode ?? 0,
        durationMs: stub.durationMs ?? 0,
        ...(stub.error ? { error: stub.error } : {}),
      }))
    }
    if (event === 'workspace:read_binary') {
      const path = (payload as { path: string }).path
      const stub = input.onReadBinary?.(path) ?? { base64: '', mime: 'application/octet-stream', size: 0 }
      queueMicrotask(() => ack?.({
        requestId: (payload as { requestId: string }).requestId,
        base64: stub.base64,
        mime: stub.mime,
        size: stub.size,
        ...(stub.error ? { error: stub.error } : {}),
      }))
    }
    return undefined
  })
  return {
    emitMock,
    asDashboardSocket() {
      return { emit: emitMock } as never
    },
  }
}
