import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { KERNEL_AGENT_RUNTIME_CAPABILITIES, type AgentRuntimeDescriptor } from '@agent-kernel/shared'
import { releaseMessageAttachments, uploadMessageAttachment } from '../../admission-client.js'
import { createSessionWithAck } from '../../session.js'
import { SimpleChatDraft } from './SimpleChatDraft.js'

vi.mock('../../session.js', () => ({ createSessionWithAck: vi.fn() }))
vi.mock('../../admission-client.js', async (original) => ({
  ...await original<typeof import('../../admission-client.js')>(),
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
  vi.mocked(uploadMessageAttachment).mockReset().mockResolvedValue(fileReference)
  vi.mocked(releaseMessageAttachments).mockReset().mockResolvedValue()
})

describe('SimpleChatDraft', () => {
  it('defaults new workspace-free chats to Copilot when the user has no runtime preference', async () => {
    const { onCreated } = draft()
    const selected = screen.getByTestId('draft-runtime-copilot')
    const unselected = screen.getByTestId('draft-runtime-kernel')
    expect(selected.getAttribute('aria-checked')).toBe('true')
    expect(selected.className).toContain('ring-2')
    expect(selected.className).toContain('border-primary/65')
    expect(selected.querySelector('.lucide-check')).toBeTruthy()
    expect(unselected.getAttribute('aria-checked')).toBe('false')
    expect(unselected.querySelector('.lucide-check')).toBeNull()
    send()
    await waitFor(() => expect(onCreated).toHaveBeenCalledOnce())
    expect(vi.mocked(createSessionWithAck).mock.calls[0]![1]).toMatchObject({ agentRuntime: 'copilot' })
    expect(vi.mocked(createSessionWithAck).mock.calls[0]![1]).not.toHaveProperty('selectedModel')
  })

  it('does not create or upload while opening, typing, choosing a runtime, or attaching a file', async () => {
    draft()
    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: 'unsent' } })
    fireEvent.click(screen.getByTestId('draft-runtime-copilot'))
    fireEvent.change(screen.getByTestId('composer-file-input'), { target: { files: [new File(['hello'], 'notes.txt')] } })
    await screen.findByTestId('attachment-tray')
    expect(createSessionWithAck).not.toHaveBeenCalled()
    expect(uploadMessageAttachment).not.toHaveBeenCalled()
  })

  it.each(['kernel', 'copilot'])('materializes %s only on send and never binds a workspace', async (runtime) => {
    localStorage.setItem('ak-agent-runtime', runtime)
    const { onCreated } = draft()
    send()
    await waitFor(() => expect(onCreated).toHaveBeenCalledOnce())
    const creation = vi.mocked(createSessionWithAck).mock.calls[0]![1]
    expect(creation).toMatchObject({ agentRuntime: runtime, tools: ['todo_graph', 'agent', 'websearch', 'memory'] })
    expect(creation).not.toHaveProperty('workspaceId')
    expect(creation).not.toHaveProperty('cwd')
    expect(onCreated).toHaveBeenCalledWith(
      creation.sessionId,
      expect.objectContaining({ operationId: expect.any(String), text: 'Hello' }),
    )
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
    expect(onCreated).not.toHaveBeenCalled()
  })

  it('hands the first message and uploaded references to the ordinary Session pipeline', async () => {
    const { onCreated } = draft()
    fireEvent.change(screen.getByTestId('composer-file-input'), { target: { files: [new File(['hello'], 'notes.txt', { type: 'text/plain' })] } })
    await screen.findByTestId('attachment-tray')
    send()
    await waitFor(() => expect(onCreated).toHaveBeenCalledOnce())
    expect(onCreated.mock.calls[0]?.[1]).toMatchObject({
      text: 'Hello',
      content: [
        { type: 'text', text: 'Hello' },
        fileReference,
      ],
    })
    expect(uploadMessageAttachment).toHaveBeenCalledOnce()
    expect(createSessionWithAck).toHaveBeenCalledOnce()
    expect(releaseMessageAttachments).not.toHaveBeenCalled()
  })

  it('does not send empty or disconnected drafts', () => {
    const { unmount } = draft()
    send('')
    unmount()
    draft(vi.fn(), false)
    expect(screen.queryByTestId('composer-input')).toBeNull()
    expect(createSessionWithAck).not.toHaveBeenCalled()
  })
})
