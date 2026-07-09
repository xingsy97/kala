import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { AttachedExecutor } from '@agent-kernel/shared'

import { WorkspacePicker } from './WorkspacePicker.js'

const wsA: AttachedExecutor = {
  executorId: 'ex-a',
  workspaceId: 'ws-a',
  workspaceName: 'mbp',
  tools: [],
  runtime: 'node',
  runtimeVersion: 'v22',
  os: 'darwin',
  ipAddresses: ['192.0.2.1'],
  attachedAt: '2026-07-05T10:00:00.000Z',
}

const wsB: AttachedExecutor = {
  executorId: 'ex-b',
  workspaceId: 'ws-b',
  workspaceName: 'linux-box',
  tools: [],
  runtime: 'node',
  runtimeVersion: 'v22',
  os: 'linux',
  ipAddresses: ['192.0.2.2'],
  attachedAt: '2026-07-05T10:00:00.000Z',
}

describe('WorkspacePicker', () => {
  it('renders nothing when closed', () => {
    const { container } = render(
      <WorkspacePicker
        open={false}
        workspaces={[wsA, wsB]}
        onPick={() => {}}
        onCancel={() => {}}
      />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('renders one button per online workspace', () => {
    render(
      <WorkspacePicker
        open
        workspaces={[wsA, wsB]}
        onPick={() => {}}
        onCancel={() => {}}
      />,
    )
    expect(screen.getByTestId('workspace-pick-ws-a')).toBeTruthy()
    expect(screen.getByTestId('workspace-pick-ws-b')).toBeTruthy()
    expect(screen.getByText('mbp')).toBeTruthy()
    expect(screen.getByText('linux-box')).toBeTruthy()
  })

  it('fires onPick with workspaceId + workspaceName on click', () => {
    const onPick = vi.fn()
    render(
      <WorkspacePicker
        open
        workspaces={[wsA, wsB]}
        onPick={onPick}
        onCancel={() => {}}
      />,
    )
    fireEvent.click(screen.getByTestId('workspace-pick-ws-b'))
    expect(onPick).toHaveBeenCalledWith('ws-b', 'linux-box')
  })

  it('fires onCancel when the cancel button is clicked', () => {
    const onCancel = vi.fn()
    render(
      <WorkspacePicker
        open
        workspaces={[wsA]}
        onPick={() => {}}
        onCancel={onCancel}
      />,
    )
    fireEvent.click(screen.getByTestId('workspace-picker-cancel'))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('fires onCancel when the overlay is clicked', () => {
    const onCancel = vi.fn()
    render(
      <WorkspacePicker
        open
        workspaces={[wsA]}
        onPick={() => {}}
        onCancel={onCancel}
      />,
    )
    fireEvent.click(screen.getByTestId('workspace-picker-overlay'))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('fires onCancel on Escape key', () => {
    const onCancel = vi.fn()
    render(
      <WorkspacePicker
        open
        workspaces={[wsA]}
        onPick={() => {}}
        onCancel={onCancel}
      />,
    )
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})
