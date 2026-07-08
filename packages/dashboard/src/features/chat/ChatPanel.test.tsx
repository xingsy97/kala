import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { createInitialState } from '@agent-kernel/kernel'

import { visibleTranscript } from '../../transcript.js'
import { ChatPanel } from './ChatPanel.js'

describe('ChatPanel', () => {
  it('renders empty state', () => {
    render(<ChatPanel messages={[]} />)
    expect(screen.getByText(/No messages yet/i)).toBeTruthy()
  })

  it('does not render the seed system prompt as a Tool result bubble', () => {
    render(
      <ChatPanel
        messages={[
          {
            role: 'system',
            content: [
              {
                type: 'text',
                text: 'You are a coding agent running via agent-kernel.',
              },
            ],
          },
        ]}
      />,
    )
    expect(screen.queryByText('Tool result')).toBeNull()
    expect(
      screen.queryByText(/You are a coding agent running via agent-kernel\./),
    ).toBeNull()
    expect(screen.getByText(/No messages yet/i)).toBeTruthy()
  })

  it('renders a tool call and its result as one combined row', () => {
    render(
      <ChatPanel
        messages={[
          { role: 'user', content: [{ type: 'text', text: 'hello' }] },
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'about to write' },
              {
                type: 'tool_call',
                callId: 'c1',
                name: 'write',
                input: { path: '/tmp/a' },
              },
            ],
          },
          {
            role: 'tool',
            content: [
              {
                type: 'tool_result',
                callId: 'c1',
                ok: true,
                content: 'wrote 3 bytes',
              },
            ],
          },
        ]}
      />,
    )
    expect(screen.getByText('hello')).toBeTruthy()
    expect(screen.getByText('about to write')).toBeTruthy()
    expect(screen.getByTestId('tool-call-group-c1')).toBeTruthy()
    expect(screen.getAllByText('write')).toHaveLength(1)
    expect(screen.getByText('Succeeded')).toBeTruthy()
    expect(screen.getByText(/ -  wrote 3 bytes/)).toBeTruthy()
    expect(screen.queryByText('Assistant requested tool')).toBeNull()
    expect(screen.queryByText('Tool result')).toBeNull()
    // Body is collapsed by default  -  expanding the grouped row reveals it.
    expect(screen.queryByText('wrote 3 bytes')).toBeNull()
    fireEvent.click(screen.getByTestId('grouped-tool-row-c1'))
    expect(screen.getByText('wrote 3 bytes')).toBeTruthy()
  })

  it('keeps the virtual transcript scroll owner full-width while constraining row content', () => {
    render(
      <ChatPanel
        messages={[
          { role: 'user', content: [{ type: 'text', text: 'hello' }] },
          { role: 'assistant', content: [{ type: 'text', text: 'world' }] },
        ]}
      />,
    )

    const transcript = screen.getByTestId('virtual-transcript')
    expect(transcript.className).not.toContain('max-w-[68rem]')

    const row = screen.getAllByTestId('virtuoso-test-item')[0]
    expect(row?.textContent).toContain('hello')
    const contentWrapper = row?.querySelector('[data-virt-index]')
    expect(contentWrapper?.className).toContain('max-w-[68rem]')
    expect(contentWrapper?.className).toContain('mx-auto')
  })

  it('renders assistant markdown as HTML (headings, code, lists)', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { container } = render(
      <ChatPanel
        messages={[
          {
            role: 'assistant',
            content: [
              {
                type: 'text',
                text:
                  '# Title\n\nInline `code` and:\n\n- item one\n- item two\n\n```js\nconsole.log(1)\n```',
              },
            ],
          },
        ]}
      />,
    )
    expect(container.querySelector('h1')?.textContent).toBe('Title')
    expect(container.querySelectorAll('li').length).toBe(2)
    // inline `code` still renders as <code>; fenced blocks now route through
    // CodeBlock (which paints raw <pre data-testid="code-block-raw"> until
    // shiki resolves  -  under jsdom, shiki never actually loads, so the raw
    // fallback is what we assert).
    expect(container.querySelectorAll('code').length).toBeGreaterThanOrEqual(1)
    expect(container.querySelector('[data-testid="code-block-raw"]')).toBeTruthy()
    expect(container.textContent ?? '').toContain('console.log(1)')
    expect(errorSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('validateDOMNesting'),
      expect.stringContaining('<pre> cannot appear as a descendant of <p>'),
      expect.anything(),
    )
    errorSpy.mockRestore()
  })

  it('leaves user text as literal (no markdown parsing)', () => {
    const { container } = render(
      <ChatPanel
        messages={[
          {
            role: 'user',
            content: [{ type: 'text', text: '# not a heading' }],
          },
        ]}
      />,
    )
    expect(container.querySelector('h1')).toBeNull()
    expect(screen.getByText('# not a heading')).toBeTruthy()
  })

  it('constrains image content to the chat column', () => {
    const { container } = render(
      <ChatPanel
        messages={[
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: { kind: 'base64', mediaType: 'image/png', data: 'iVBORw0KGgo=' },
              },
            ],
          },
        ]}
      />,
    )
    const img = container.querySelector('img')
    expect(img?.className ?? '').toContain('max-w-full')
    expect(img?.className ?? '').toContain('object-contain')
  })

  it('highlights the message matching highlightIndex', () => {
    const { container } = render(
      <ChatPanel
        highlightIndex={1}
        messages={[
          { role: 'user', content: [{ type: 'text', text: 'a' }] },
          { role: 'assistant', content: [{ type: 'text', text: 'b' }] },
        ]}
      />,
    )
    const rows = container.querySelectorAll('[data-message-index]')
    expect(rows[0]!.className).not.toMatch(/bg-amber-50/)
    expect(rows[1]!.className).toMatch(/bg-amber-50/)
  })

  it('renders compact boundaries between transcript messages', () => {
    render(
      <ChatPanel
        items={[
          { kind: 'message', message: { role: 'user', content: [{ type: 'text', text: 'before' }] } },
          {
            kind: 'compact_boundary',
            seq: 7,
            trigger: 'manual',
            replacedCount: 2,
            tokensBefore: 1200,
            tokensAfter: 80,
            summary: 'before summarized',
          },
          { kind: 'message', message: { role: 'user', content: [{ type: 'text', text: 'after' }] } },
        ]}
      />,
    )

    expect(screen.getByTestId('compact-boundary')).toBeTruthy()
    expect(screen.getByText('Context compacted')).toBeTruthy()
    expect(screen.getByText(/Manual compact/)).toBeTruthy()
  })

  it('fires onEditAndRerun with the correct seq when a user message is edited', () => {
    const onEditAndRerun = vi.fn()
    render(
      <ChatPanel
        onEditAndRerun={onEditAndRerun}
        items={[
          {
            kind: 'message',
            seq: 4,
            message: { role: 'user', content: [{ type: 'text', text: 'original text' }] },
          },
          {
            kind: 'message',
            seq: 5,
            message: { role: 'assistant', content: [{ type: 'text', text: 'reply' }] },
          },
        ]}
      />,
    )
    fireEvent.click(screen.getByTestId('edit-message-0'))
    fireEvent.change(screen.getByTestId('edit-message-input-0'), {
      target: { value: 'revised text' },
    })
    fireEvent.click(screen.getByTestId('edit-message-submit-0'))
    expect(onEditAndRerun).toHaveBeenCalledWith(4, 'revised text')
  })

  it('flags a pending tool_call but shows no inline approve/reject buttons (they live in the composer flip)', () => {
    render(
      <ChatPanel
        pendingApprovals={[
          { sessionId: 's', callId: 'c9', name: 'write', input: { path: '/tmp/x' } },
        ]}
        onApprovalDecision={vi.fn()}
        messages={[
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_call',
                callId: 'c9',
                name: 'write',
                input: { path: '/tmp/x' },
              },
            ],
          },
        ]}
      />,
    )
    expect(screen.getByTestId('tool-call-pending-c9')).toBeTruthy()
    expect(screen.getByText('Approval needed')).toBeTruthy()
    expect(screen.getByText(/Approve or reject in the composer area below/i)).toBeTruthy()
    // The decision buttons are rendered by ApprovalCard inside the composer
    // flip container, not inside the tool card itself.
    expect(screen.queryByTestId('approval-approve')).toBeNull()
    expect(screen.queryByTestId('approval-reject')).toBeNull()
  })

  it('leaves non-pending tool_calls as regular collapsed cards', () => {
    render(
      <ChatPanel
        messages={[
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_call',
                callId: 'c10',
                name: 'bash',
                input: { command: 'echo hi' },
              },
            ],
          },
        ]}
      />,
    )
    expect(screen.queryByTestId('tool-call-pending-c10')).toBeNull()
    expect(screen.queryByTestId('approval-approve')).toBeNull()
    expect(screen.getByTestId('tool-call-group-c10')).toBeTruthy()
    expect(screen.getByText('Running')).toBeTruthy()
  })

  it('summarizes mixed grouped tool lifecycle statuses without extra protocol data', () => {
    render(
      <ChatPanel
        pendingApprovals={[{ sessionId: 's', callId: 'c2', name: 'bash', input: { command: 'sleep 1' } }]}
        messages={[
          {
            role: 'assistant',
            content: [
              { type: 'tool_call', callId: 'c1', name: 'bash', input: { command: 'echo ok' } },
              { type: 'tool_call', callId: 'c2', name: 'bash', input: { command: 'sleep 1' } },
              { type: 'tool_call', callId: 'c3', name: 'bash', input: { command: 'exit 1' } },
            ],
          },
          {
            role: 'tool',
            content: [
              { type: 'tool_result', callId: 'c1', ok: true, content: 'ok' },
              { type: 'tool_result', callId: 'c3', ok: false, content: 'failed' },
            ],
          },
        ]}
      />,
    )

    expect(screen.getByTestId('tool-call-group-c1')).toBeTruthy()
    expect(screen.getByText('Needs approval')).toBeTruthy()
    expect(screen.getByText('Failed')).toBeTruthy()
    expect(screen.getByText('Succeeded')).toBeTruthy()
  })

  it('renders empty state end-to-end for an ephemeral session (system prompt only, no timeline)', () => {
    // Regression: host sends `ephemeralReadyEventFor` on connect for any
    // unknown sessionId (including the random UUID assigned when no session
    // is selected). That state has messages=[systemMessage] + empty timeline.
    // The full pipeline (state  -  visibleTranscript  -  ChatPanel) must render
    // the empty state, NOT a "Tool result" bubble containing the system
    // prompt text.
    const state = createInitialState({
      sessionId: 'ephemeral',
      systemPrompt: 'You are a coding agent running via agent-kernel.',
    })
    const items = visibleTranscript(state.messages, [], '')
    render(<ChatPanel items={items} />)
    expect(screen.getByText(/No messages yet/i)).toBeTruthy()
    expect(screen.queryByText('Tool result')).toBeNull()
    expect(
      screen.queryByText(/You are a coding agent running via agent-kernel\./),
    ).toBeNull()
  })
})
