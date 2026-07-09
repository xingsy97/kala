import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { Message } from '@agent-kernel/kernel'

import { NestedTranscript } from './NestedTranscript.js'

describe('NestedTranscript', () => {
  it('collapses mixed tool activity split across nested messages', () => {
    render(
      <NestedTranscript
        messages={[
          { role: 'user', content: [{ type: 'text', text: 'do many edits' }] },
          {
            role: 'assistant',
            content: [{ type: 'tool_call', callId: 'c1', name: 'bash', input: { command: 'pwd' } }],
          },
          { role: 'tool', content: [{ type: 'tool_result', callId: 'c1', ok: true, content: 'ok' }] },
          {
            role: 'assistant',
            content: [{ type: 'tool_call', callId: 'c2', name: 'edit', input: { path: '/repo/a.md' } }],
          },
          { role: 'tool', content: [{ type: 'tool_result', callId: 'c2', ok: false, content: 'missing' }] },
          {
            role: 'assistant',
            content: [{ type: 'tool_call', callId: 'c3', name: 'read', input: { path: '/repo/b.md' } }],
          },
          { role: 'tool', content: [{ type: 'tool_result', callId: 'c3', ok: true, content: 'file' }] },
        ] satisfies Message[]}
      />,
    )

    expect(screen.getByTestId('nested-tool-group-c1')).toBeTruthy()
    expect(screen.getByText('Tool activity')).toBeTruthy()
    expect(screen.getByText('3 ops')).toBeTruthy()
    expect(screen.getByText(/bash 1, edit 1, read 1/)).toBeTruthy()
    expect(screen.queryByText('Tool')).toBeNull()
    expect(screen.queryByText(/path=\/repo\/a\.md/)).toBeNull()

    fireEvent.click(screen.getByText('Tool activity'))

    expect(screen.getByText(/pwd/)).toBeTruthy()
    expect(screen.getByText(/\/repo\/a\.md/)).toBeTruthy()
    expect(screen.getByText(/\/repo\/b\.md/)).toBeTruthy()
  })

  it('does not collapse nested tool activity across assistant text', () => {
    render(
      <NestedTranscript
        messages={[
          {
            role: 'assistant',
            content: [{ type: 'tool_call', callId: 'c1', name: 'bash', input: { command: 'pwd' } }],
          },
          { role: 'tool', content: [{ type: 'tool_result', callId: 'c1', ok: true, content: 'ok' }] },
          { role: 'assistant', content: [{ type: 'text', text: 'checking next' }] },
          {
            role: 'assistant',
            content: [{ type: 'tool_call', callId: 'c2', name: 'edit', input: { path: '/repo/a.md' } }],
          },
        ] satisfies Message[]}
      />,
    )

    expect(screen.queryByText('Tool activity')).toBeNull()
    expect(screen.getByText('checking next')).toBeTruthy()
    expect(screen.getByText(/pwd/)).toBeTruthy()
    expect(screen.getByText(/\/repo\/a\.md/)).toBeTruthy()
  })
})
