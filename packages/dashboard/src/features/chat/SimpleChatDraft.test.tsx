import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { KERNEL_AGENT_RUNTIME_CAPABILITIES, type AgentRuntimeDescriptor } from '@agent-kernel/shared'
import { AdmissionDeliveryPendingError, admitUserMessage, releaseMessageAttachments, uploadMessageAttachment } from '../../admission-client.js'
import { createSessionWithAck } from '../../session.js'
import { SimpleChatDraft } from './SimpleChatDraft.js'

vi.mock('../../session.js', () => ({ createSessionWithAck: vi.fn() }))
vi.mock('../../admission-client.js', async (original) => ({
  ...await original<typeof import('../../admission-client.js')>(),
  admitUserMessage: vi.fn(),
  uploadMessageAttachment: vi.fn(),
  releaseMessageAttachments: vi.fn(),
}))

const runtimes: AgentRuntimeDescriptor[] = ['kernel', 'copilot'].map((id) => ({
  id: id as 'kernel' | 'copilot', label: id, description: id, available: true, status: 'ready',
  capabilities: KERNEL_AGENT_RUNTIME_CAPABILITIES,
}))
const fileReference = {
  type: 'file' as const, name: 'notes.txt', mediaType: 'text/plain',
  source: { kind: 'host_ref' as const, attachmentId: '00000000-0000-4000-8000-000000000000', bytes: 5, sha256: 'a'.repeat(64) },
}
function draft(onCreated = vi.fn(), connected = true) {
  return {
    onCreated,
    ...render(<SimpleChatDraft
      socket={{ connected } as never} host="http://host" agentRuntimes={runtimes} models={[]}
      preferredModel="provider/model" displayPrefs={{ fontSize: 3, lineHeight: 1, contentWidth: 1, sideSpace: 1 }}
      onCreated={onCreated}
    />),
  }
}
function send(text = 'Hello') {
  fireEvent.change(screen.getByTestId('composer-input'), { target: { value: text } })
  fireEvent.submit(screen.getByTestId('composer-input').closest('form')!)
}

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  vi.mocked(createSessionWithAck).mockReset().mockResolvedValue()
  vi.mocked(admitUserMessage).mockReset().mockResolvedValue({ accepted: true, duplicate: false, operationId: 'accepted', sequence: 1, state: 'committed', routeGeneration: 0 })
  vi.mocked(uploadMessageAttachment).mockReset().mockResolvedValue(fileReference)
  vi.mocked(releaseMessageAttachments).mockReset().mockResolvedValue()
})

describe('SimpleChatDraft', () => {
  it('does not create or upload while opening, typing, choosing a runtime, or attaching a file', async () => {
    draft()
    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: 'unsent' } })
    fireEvent.click(screen.getByTestId('draft-runtime-copilot'))
    fireEvent.change(screen.getByTestId('composer-file-input'), { target: { files: [new File(['hello'], 'notes.txt')] } })
    await screen.findByTestId('attachment-tray')
    expect(createSessionWithAck).not.toHaveBeenCalled()
    expect(uploadMessageAttachment).not.toHaveBeenCalled()
    expect(admitUserMessage).not.toHaveBeenCalled()
  })

  it.each(['kernel', 'copilot'])('materializes %s only on send and never binds a workspace', async (runtime) => {
    localStorage.setItem('ak-agent-runtime', runtime)
    const { onCreated } = draft()
    send()
    await waitFor(() => expect(onCreated).toHaveBeenCalledOnce())
    const creation = vi.mocked(createSessionWithAck).mock.calls[0]![1]
    expect(creation).toMatchObject({ agentRuntime: runtime, tools: ['todowrite', 'todo_graph', 'agent', 'websearch', 'memory'] })
    expect(creation).not.toHaveProperty('workspaceId')
    expect(creation).not.toHaveProperty('cwd')
    expect(admitUserMessage).toHaveBeenCalledWith(expect.objectContaining({ sessionId: creation.sessionId, text: 'Hello', mode: 'steer' }))
    expect(onCreated).toHaveBeenCalledWith(creation.sessionId)
  })

  it('retries a lost creation acknowledgement with the same session and runtime', async () => {
    vi.mocked(createSessionWithAck).mockRejectedValueOnce(new Error('ack timeout'))
    const { onCreated } = draft()
    send()
    await waitFor(() => expect(screen.getByTestId('composer-input')).toHaveProperty('value', 'Hello'))
    expect(onCreated).not.toHaveBeenCalled()
    send()
    await waitFor(() => expect(onCreated).toHaveBeenCalledOnce())
    expect(vi.mocked(createSessionWithAck).mock.calls[1]![1]).toEqual(vi.mocked(createSessionWithAck).mock.calls[0]![1])
    expect(admitUserMessage).toHaveBeenCalledOnce()
  })

  it('locks the first send against double submission and does not select a chat after leaving the draft', async () => {
    let resolve!: () => void
    vi.mocked(createSessionWithAck).mockImplementation(() => new Promise((done) => { resolve = done }))
    const { onCreated, unmount } = draft()
    send()
    send('duplicate')
    expect(createSessionWithAck).toHaveBeenCalledOnce()
    unmount()
    await act(async () => resolve())
    expect(admitUserMessage).toHaveBeenCalledOnce()
    expect(onCreated).not.toHaveBeenCalled()
  })

  it('retries uncertain admission using the same operation and file references without re-uploading', async () => {
    vi.mocked(admitUserMessage).mockRejectedValueOnce(new AdmissionDeliveryPendingError('operation', 3, 'lost response'))
    const { onCreated } = draft()
    fireEvent.change(screen.getByTestId('composer-file-input'), { target: { files: [new File(['hello'], 'notes.txt', { type: 'text/plain' })] } })
    await screen.findByTestId('attachment-tray')
    send()
    await screen.findByTestId('draft-retry-send')
    expect(onCreated).not.toHaveBeenCalled()
    expect(screen.getByTestId('composer-input')).toHaveProperty('value', '')
    expect(releaseMessageAttachments).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('draft-retry-send'))
    await waitFor(() => expect(onCreated).toHaveBeenCalledOnce())
    expect(vi.mocked(admitUserMessage).mock.calls[1]![0]).toEqual(vi.mocked(admitUserMessage).mock.calls[0]![0])
    expect(uploadMessageAttachment).toHaveBeenCalledOnce()
    expect(createSessionWithAck).toHaveBeenCalledOnce()
  })

  it('restores rejected messages and attachments, and reuses the already materialized session', async () => {
    vi.mocked(admitUserMessage).mockRejectedValueOnce(Object.assign(new Error('rejected'), { safeToReleaseAttachments: true }))
    const { onCreated } = draft()
    fireEvent.change(screen.getByTestId('composer-file-input'), { target: { files: [new File(['hello'], 'notes.txt', { type: 'text/plain' })] } })
    await screen.findByTestId('attachment-tray')
    send()
    await waitFor(() => expect(screen.getByTestId('composer-input')).toHaveProperty('value', 'Hello'))
    expect(screen.getByTestId('attachment-tray').textContent).toContain('notes.txt')
    expect(releaseMessageAttachments).toHaveBeenCalledOnce()
    send()
    await waitFor(() => expect(onCreated).toHaveBeenCalledOnce())
    expect(createSessionWithAck).toHaveBeenCalledOnce()
  })

  it('does not send empty or disconnected drafts', () => {
    const { unmount } = draft()
    send('')
    unmount()
    draft(vi.fn(), false)
    expect(screen.queryByTestId('composer-input')).toBeNull()
    expect(createSessionWithAck).not.toHaveBeenCalled()
    expect(admitUserMessage).not.toHaveBeenCalled()
  })
})
