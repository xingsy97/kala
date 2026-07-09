import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { GitDiffResult, GitStatusResult } from '@agent-kernel/shared'

import { SourceControlPanel } from './SourceControlPanel.js'

vi.mock('@monaco-editor/react', () => ({
  DiffEditor: ({ original, modified, options }: { original?: string; modified?: string; options?: { renderSideBySide?: boolean } }) => (
    <div data-testid="mock-diff-editor" data-side-by-side={String(options?.renderSideBySide)}>{original}::{modified}</div>
  ),
}))

describe('SourceControlPanel', () => {
  it('renders grouped git changes and opens a read-only diff dialog', async () => {
    const socket = makeGitSocket({
      status: {
        requestId: 'status',
        workspaceId: 'ws-1',
        repo: { root: '/repo', branch: 'main' },
        files: [
          { path: 'src/z.ts', status: 'modified', staged: false, unstaged: true },
          { path: 'src/app.ts', status: 'modified', staged: false, unstaged: true },
          { path: 'new.txt', status: 'untracked', staged: false, unstaged: true },
        ],
      },
      diff: {
        requestId: 'diff',
        workspaceId: 'ws-1',
        oldText: 'old',
        newText: 'new',
        language: 'typescript',
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
    expect(socket.emitMock).toHaveBeenCalledWith('git:status', expect.objectContaining({ workspaceId: 'ws-1', sessionId: 's-1', cwd: '/repo/packages/app' }), expect.any(Function))
    expect(socket.emitMock).toHaveBeenCalledWith('git:diff', expect.objectContaining({ workspaceId: 'ws-1', sessionId: 's-1', cwd: '/repo/packages/app', path: 'src/app.ts' }), expect.any(Function))
  })
})

function makeGitSocket(input: { status: GitStatusResult; diff: GitDiffResult }) {
  const emitMock = vi.fn((event: string, payload: Record<string, unknown>, ack?: (payload: unknown) => void) => {
    if (event === 'git:status') queueMicrotask(() => ack?.({ ...input.status, requestId: payload.requestId }))
    if (event === 'git:diff') queueMicrotask(() => ack?.({ ...input.diff, requestId: payload.requestId }))
    return undefined
  })
  return {
    emitMock,
    asDashboardSocket() {
      return { emit: emitMock } as never
    },
  }
}
