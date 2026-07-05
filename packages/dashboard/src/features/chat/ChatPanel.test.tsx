import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ChatPanel } from './ChatPanel.js'

describe('ChatPanel', () => {
  it('renders empty state', () => {
    render(<ChatPanel messages={[]} />)
    expect(screen.getByText(/No messages yet/i)).toBeTruthy()
  })

  it('renders user + assistant text and a tool_call block', () => {
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
    // Tool call/result headers are explicit enough to understand without opening details.
    expect(screen.getByText('Assistant requested tool')).toBeTruthy()
    expect(screen.getAllByText('write')).toHaveLength(2)
    expect(screen.getAllByText('Tool result')).toHaveLength(2)
    expect(screen.getByText('Succeeded')).toBeTruthy()
    // Body is collapsed by default  -  expanding the tool_result reveals it.
    expect(screen.queryByText('wrote 3 bytes')).toBeNull()
    fireEvent.click(screen.getByTestId('tool-result-toggle-c1'))
    expect(screen.getByText('wrote 3 bytes')).toBeTruthy()
  })

  it('renders assistant markdown as HTML (headings, code, lists)', () => {
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
    // inline `code`  -  <code>, and fenced block  -  <pre><code>
    const codes = container.querySelectorAll('code')
    expect(codes.length).toBeGreaterThanOrEqual(2)
    expect(container.textContent ?? '').toContain('console.log(1)')
    expect(container.querySelector('[data-radix-scroll-area-viewport]')).toBeTruthy()
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

  it('renders inline approval controls on the pending tool_call', () => {
    const onApprovalDecision = vi.fn()
    render(
      <ChatPanel
        pendingApprovals={[
          { sessionId: 's', callId: 'c9', name: 'write', input: { path: '/tmp/x' } },
        ]}
        onApprovalDecision={onApprovalDecision}
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
    fireEvent.click(screen.getByTestId('approval-approve'))
    expect(onApprovalDecision).toHaveBeenCalledWith('c9', 'approve')
    fireEvent.click(screen.getByTestId('approval-reject'))
    expect(onApprovalDecision).toHaveBeenCalledWith('c9', 'reject')
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
    expect(screen.getByText('Assistant requested tool')).toBeTruthy()
  })
})
