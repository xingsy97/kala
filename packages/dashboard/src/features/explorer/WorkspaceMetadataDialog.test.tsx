import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AttachedExecutor, SessionSummary } from '@agent-kernel/shared'

import { WorkspaceMetadataDialog } from './WorkspaceMetadataDialog.js'

const executor: AttachedExecutor = {
  executorId: 'ex-1',
  workspaceId: 'ws-1',
  workspaceName: 'my-mbp',
  tools: [],
  runtime: 'node',
  runtimeVersion: 'v22',
  os: 'darwin',
  attachedAt: '2026-07-05T10:00:00.000Z',
}

const session: SessionSummary = {
  sessionId: 'sess-1',
  workspaceId: 'ws-1',
  workspaceName: 'my-mbp',
  createdAt: '2026-07-05T10:00:00.000Z',
  eventCount: 0,
}

describe('WorkspaceMetadataDialog', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('submits a workspace display-name rename', () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ identities: [] }), { status: 200 })))
    const onRename = vi.fn()
    render(
      <WorkspaceMetadataDialog
        open
        onOpenChange={() => {}}
        workspaceId="ws-1"
        executor={executor}
        sessions={[session]}
        onRename={onRename}
      />,
    )

    const input = screen.getByTestId('workspace-metadata-name-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'primary dev box' } })
    fireEvent.click(screen.getByTestId('workspace-metadata-rename-button'))

    expect(onRename).toHaveBeenCalledWith('primary dev box')
  })

  it('shows and revokes a saved executor identity', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith('/auth/executor-identities') && init?.method === 'DELETE') {
        return new Response(JSON.stringify({ ok: true, workspaceId: 'ws-1', revoked: true }), { status: 200 })
      }
      return new Response(JSON.stringify({
        identities: [{ workspaceId: 'ws-1', createdAt: '2026-07-05T10:00:00.000Z', lastSeenAt: '2026-07-05T10:30:00.000Z' }],
      }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    render(
      <WorkspaceMetadataDialog
        open
        onOpenChange={() => {}}
        workspaceId="ws-1"
        executor={executor}
        sessions={[session]}
      />,
    )

    await screen.findByText(/This workspace has a saved reconnect identity/i)
    fireEvent.click(screen.getByTestId('workspace-revoke-identity-button'))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/auth/executor-identities?workspaceId=ws-1', { method: 'DELETE' })
    })
    await waitFor(() => {
      expect(screen.getByText(/No saved reconnect identity/i)).toBeTruthy()
    })
  })
})
