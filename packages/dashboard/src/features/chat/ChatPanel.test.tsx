import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { createInitialState } from '@agent-kernel/kernel'

import type { TimelineEntry } from '../../session.js'
import { visibleTranscript } from '../../transcript.js'
import { ChatPanel as DashboardChatPanel } from './ChatPanel.js'
import { InlineStatusRow } from './InlineStatusRow.js'

function ChatPanel(props: ComponentProps<typeof DashboardChatPanel>): JSX.Element {
  return <DashboardChatPanel toolCardMode="standard" {...props} />
}

describe('ChatPanel', () => {
  it('renders empty state', () => {
    render(<ChatPanel messages={[]} />)
    expect(screen.getByText(/No messages yet/i)).toBeTruthy()
  })

  it('renders the thinking status row even when the transcript is empty', () => {
    render(
      <ChatPanel
        messages={[]}
        footerSlot={(
          <InlineStatusRow
            state={{ ...createInitialState({}), status: 'thinking' }}
            streamingActive={false}
          />
        )}
      />,
    )

    expect(screen.getByTestId('inline-status-thinking')).toBeTruthy()
  })

  it('renders the thinking row from a fallback status while session state is loading', () => {
    render(
      <ChatPanel
        messages={[]}
        footerSlot={(
          <InlineStatusRow
            state={null}
            fallbackStatus="thinking"
            streamingActive={false}
          />
        )}
      />,
    )

    expect(screen.getByTestId('inline-status-thinking')).toBeTruthy()
  })

  it('keeps the thinking row visible while the transcript skeleton is loading', () => {
    render(
      <ChatPanel
        loading
        messages={[]}
        footerSlot={(
          <InlineStatusRow
            state={{ ...createInitialState({}), status: 'thinking' }}
            streamingActive={false}
          />
        )}
      />,
    )

    expect(screen.getByTestId('inline-status-thinking')).toBeTruthy()
  })

  it('uses the persisted tool execution start time after reload', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-20T12:00:12.500Z'))
    try {
      render(
        <InlineStatusRow
          state={{
            ...createInitialState({}),
            status: 'executing_tools',
            pendingCalls: [{ callId: 'c1', name: 'bash', input: { command: 'sleep 30' }, status: 'dispatched' }],
          }}
          streamingActive={false}
          toolExecutionStartedAt={Date.parse('2026-07-20T12:00:00.000Z')}
        />,
      )

      expect(screen.getByTestId('inline-status-tools').textContent ?? '').toContain('12.5s')
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows a transcript skeleton instead of the empty welcome while loading', () => {
    render(<ChatPanel loading messages={[]} />)

    expect(screen.getByTestId('transcript-loading-state')).toBeTruthy()
    expect(screen.queryByText(/No messages yet/i)).toBeNull()
  })

  it('applies persisted chat display preferences through CSS variables', () => {
    const { container } = render(
      <ChatPanel
        messages={[{ role: 'assistant', content: [{ type: 'text', text: 'hello' }] }]}
        displayPrefs={{ fontSize: 6, contentWidth: 2, sideSpace: 0, lineHeight: 2, mathScale: 4 }}
      />,
    )
    const root = container.querySelector('[style*="--ak-chat-font-size"]') as HTMLElement | null

    expect(root?.style.getPropertyValue('--ak-chat-font-size')).toBe('20px')
    expect(root?.style.getPropertyValue('--ak-chat-content-width')).toBe('84rem')
    expect(root?.style.getPropertyValue('--ak-chat-line-height')).toBe('1.95')
    expect(root?.style.getPropertyValue('--ak-chat-math-scale')).toBe('3em')
  })

  it('opens workspace file links from assistant Markdown', () => {
    const onOpenWorkspaceFile = vi.fn()
    render(
      <ChatPanel
        messages={[{ role: 'assistant', content: [{ type: 'text', text: 'Open [the file](src/app.tsx).' }] }]}
        onOpenWorkspaceFile={onOpenWorkspaceFile}
      />,
    )

    const link = screen.getByRole('link', { name: 'View file: src/app.tsx' })

    expect(link.getAttribute('data-testid')).toBe('workspace-file-link')
    expect(link.getAttribute('title')).toBe('View file: src/app.tsx')
    expect(link.textContent).toContain('the file')

    fireEvent.click(link)

    expect(onOpenWorkspaceFile).toHaveBeenCalledWith({ path: 'src/app.tsx' })
  })

  it('keeps line and column targets on workspace file links', () => {
    const onOpenWorkspaceFile = vi.fn()
    render(
      <ChatPanel
        messages={[{ role: 'assistant', content: [{ type: 'text', text: 'Open [the line](src/app.tsx:12:4).' }] }]}
        onOpenWorkspaceFile={onOpenWorkspaceFile}
      />,
    )

    const link = screen.getByRole('link', { name: 'View file: src/app.tsx:12:4' })

    expect(link.getAttribute('title')).toBe('View file: src/app.tsx:12:4')
    fireEvent.click(link)
    expect(onOpenWorkspaceFile).toHaveBeenCalledWith({ path: 'src/app.tsx', line: 12, column: 4 })
  })

  it('opens dot-relative workspace file links from assistant Markdown', () => {
    const onOpenWorkspaceFile = vi.fn()
    render(
      <ChatPanel
        messages={[{ role: 'assistant', content: [{ type: 'text', text: 'Open [local](./src/app.tsx) and [parent](../README.md).' }] }]}
        onOpenWorkspaceFile={onOpenWorkspaceFile}
      />,
    )

    fireEvent.click(screen.getByRole('link', { name: 'View file: ./src/app.tsx' }))
    fireEvent.click(screen.getByRole('link', { name: 'View file: ../README.md' }))

    expect(onOpenWorkspaceFile).toHaveBeenNthCalledWith(1, { path: './src/app.tsx' })
    expect(onOpenWorkspaceFile).toHaveBeenNthCalledWith(2, { path: '../README.md' })
  })

  it('does not intercept external assistant Markdown links as workspace files', () => {
    const onOpenWorkspaceFile = vi.fn()
    render(
      <ChatPanel
        messages={[{ role: 'assistant', content: [{ type: 'text', text: 'Open [site](https://example.com).' }] }]}
        onOpenWorkspaceFile={onOpenWorkspaceFile}
      />,
    )

    const link = screen.getByRole('link', { name: 'site' })

    expect(link.getAttribute('href')).toBe('https://example.com')
    expect(link.getAttribute('data-testid')).not.toBe('workspace-file-link')
    expect(link.getAttribute('title')).toBeNull()
    const click = new MouseEvent('click', { bubbles: true, cancelable: true })
    link.addEventListener('click', (event) => event.preventDefault(), { once: true })
    link.dispatchEvent(click)
    expect(onOpenWorkspaceFile).not.toHaveBeenCalled()
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
    expect(screen.getByText('write')).toBeTruthy()
    expect(screen.getByText('/tmp/a')).toBeTruthy()
    expect(screen.getByText('Succeeded')).toBeTruthy()
    expect(screen.queryByText('wrote 3 bytes')).toBeNull()
    expect(screen.queryByText(/result wrote 3 bytes/)).toBeNull()
    expect(screen.queryByText('Assistant requested tool')).toBeNull()
    expect(screen.queryByText('Tool result')).toBeNull()
    // Body is collapsed by default; ordinary success output stays in the expanded detail.
    fireEvent.click(screen.getByTestId('grouped-tool-row-c1'))
    expect(screen.getAllByText('wrote 3 bytes').length).toBeGreaterThanOrEqual(1)
  })

  it('uses dots as the default collapsed Tool Card Mode and opens the selected call', () => {
    render(
      <DashboardChatPanel
        messages={[
          {
            role: 'assistant',
            content: [
              { type: 'tool_call', callId: 'dot-1', name: 'read', input: { path: '/repo/a.ts' } },
              { type: 'tool_call', callId: 'dot-2', name: 'bash', input: { command: 'pnpm test' } },
            ],
          },
          {
            role: 'tool',
            content: [
              { type: 'tool_result', callId: 'dot-1', ok: true, content: 'a' },
              { type: 'tool_result', callId: 'dot-2', ok: false, content: 'failed' },
            ],
          },
        ]}
      />,
    )

    expect(screen.getByTestId('tool-card-dots-dot-1')).toBeTruthy()
    expect(screen.getByTestId('tool-card-dot-dot-1').getAttribute('title')).toContain('read · /repo/a.ts · succeeded')
    expect(screen.getByTestId('tool-card-dot-dot-2').getAttribute('title')).toContain('bash · pnpm test · failed')
    fireEvent.click(screen.getByTestId('tool-card-dot-dot-2'))
    expect(screen.getByTestId('tool-call-group-details-dot-1')).toBeTruthy()
  })

  it('retains the textual collapsed card in Standard Tool Card Mode', () => {
    render(
      <ChatPanel
        toolCardMode="standard"
        messages={[
          { role: 'assistant', content: [{ type: 'tool_call', callId: 'std-1', name: 'read', input: { path: '/repo/a.ts' } }] },
          { role: 'tool', content: [{ type: 'tool_result', callId: 'std-1', ok: true, content: 'contents' }] },
        ]}
      />,
    )

    expect(screen.queryByTestId('tool-card-dots-std-1')).toBeNull()
    expect(screen.getByText('/repo/a.ts')).toBeTruthy()
  })

  it('renders bash result metadata as structured fields instead of raw output text', () => {
    const { container } = render(
      <ChatPanel
        messages={[
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_call',
                callId: 'c1',
                name: 'bash',
                input: { cmd: 'true' },
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
                content: '--- exit code: 0, duration: 3ms',
              },
            ],
          },
        ]}
      />,
    )

    expect(screen.queryByText('exit 0 · 3ms')).toBeNull()
    expect(container.textContent).not.toContain('result exit 0')
    fireEvent.click(screen.getByTestId('grouped-tool-row-c1'))
    expect(screen.getByText('exit')).toBeTruthy()
    expect(screen.getByText('0')).toBeTruthy()
    expect(screen.getByText('duration')).toBeTruthy()
    expect(screen.getByText('3ms')).toBeTruthy()
    expect(container.textContent).not.toContain('--- exit code: 0, duration: 3ms')
  })

  it('summarizes read_files without leaking raw file separators into the collapsed row', () => {
    const { container } = render(
      <ChatPanel
        messages={[
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_call',
                callId: 'c1',
                name: 'read_files',
                input: { files: [{ path: '/repo/hello.py' }, { path: '/repo/README.md' }] },
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
                content: '===== /repo/hello.py =====\nprint(1)\n===== /repo/README.md =====\n# Demo',
              },
            ],
          },
        ]}
      />,
    )

    expect(screen.getByText('read_files')).toBeTruthy()
    expect(screen.getByText('/repo/hello.py')).toBeTruthy()
    expect(screen.getByText((_, element) => element?.textContent === '2 files')).toBeTruthy()
    expect(container.textContent).not.toContain('result 2 files')
    expect(container.textContent).not.toContain('=====')
  })

  it('collapses repeated same-name tool activity split across timeline items', () => {
    const timeline: TimelineEntry[] = [
      toolCallEntry(1, 'c1', 'write_file', { path: '/repo/a.txt', content: 'a' }),
      toolResultEntry(2, 'c1', true, JSON.stringify({ files: [{ path: '/repo/a.txt', additions: 1, deletions: 0 }] })),
      toolCallEntry(3, 'c2', 'write_file', { path: '/repo/b.txt', content: 'b' }),
      toolResultEntry(4, 'c2', true, JSON.stringify({ files: [{ path: '/repo/b.txt', additions: 1, deletions: 0 }] })),
      toolCallEntry(5, 'c3', 'write_file', { path: '/repo/c.txt', content: 'c' }),
      toolResultEntry(6, 'c3', true, JSON.stringify({ files: [{ path: '/repo/c.txt', additions: 1, deletions: 0 }] })),
    ]

    render(<ChatPanel items={visibleTranscript([], timeline, '')} />)

    expect(screen.getByTestId('tool-call-group-c1')).toBeTruthy()
    expect(screen.getByText('Tool activity')).toBeTruthy()
    expect(screen.getByText('3 ops')).toBeTruthy()
    expect(screen.getByText(/write_file 3/)).toBeTruthy()
    expect(screen.getByText('3 Succeeded')).toBeTruthy()
    expect(screen.queryByText('Tool result')).toBeNull()
    expect(screen.queryByText('/repo/a.txt')).toBeNull()
  })

  it('collapses repeated same-name tool calls inside one assistant message', () => {
    render(
      <ChatPanel
        messages={[
          {
            role: 'assistant',
            content: [
              { type: 'tool_call', callId: 'c1', name: 'write_file', input: { path: '/repo/a.txt', content: 'a' } },
              { type: 'tool_call', callId: 'c2', name: 'write_file', input: { path: '/repo/b.txt', content: 'b' } },
              { type: 'tool_call', callId: 'c3', name: 'write_file', input: { path: '/repo/c.txt', content: 'c' } },
            ],
          },
          {
            role: 'tool',
            content: [
              { type: 'tool_result', callId: 'c1', ok: true, content: JSON.stringify({ files: [{ path: '/repo/a.txt', additions: 1, deletions: 0 }] }) },
              { type: 'tool_result', callId: 'c2', ok: true, content: JSON.stringify({ files: [{ path: '/repo/b.txt', additions: 1, deletions: 0 }] }) },
              { type: 'tool_result', callId: 'c3', ok: true, content: JSON.stringify({ files: [{ path: '/repo/c.txt', additions: 1, deletions: 0 }] }) },
            ],
          },
        ]}
      />,
    )

    expect(screen.getByText('Tool activity')).toBeTruthy()
    expect(screen.getByText('3 ops')).toBeTruthy()
    expect(screen.getByText(/write_file 3/)).toBeTruthy()
    expect(screen.queryByTestId('grouped-tool-row-c1')).toBeNull()
  })

  it('renders mutation stats as aligned addition and deletion badges', () => {
    render(
      <ChatPanel
        messages={[
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_call',
                callId: 'c1',
                name: 'replace_many_in_file',
                input: { path: '/repo/app.ts', edits: [{ old_string: 'a', new_string: 'b' }] },
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
                content: JSON.stringify({ files: [{ path: '/repo/app.ts', additions: 2, deletions: 1 }] }),
              },
            ],
          },
        ]}
      />,
    )

    expect(screen.getByLabelText('2 additions, 1 deletions')).toBeTruthy()
    expect(screen.getByLabelText('2 additions, 1 deletions').textContent).toContain('+2')
    expect(screen.getByLabelText('2 additions, 1 deletions').textContent).toContain('-1')
  })

  it('formats failed tool errors without duplicated raw prefixes', () => {
    const { container } = render(
      <ChatPanel
        messages={[
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_call',
                callId: 'c1',
                name: 'write_file',
                input: { path: '/tmp/demo_codex/notes.md', content: 'hello' },
              },
            ],
          },
          {
            role: 'tool',
            content: [
              {
                type: 'tool_result',
                callId: 'c1',
                ok: false,
                content: 'ERROR: EACCES: EACCES: outside sandbox: /tmp/demo_codex/notes.md',
              },
            ],
          },
        ]}
      />,
    )

    expect(screen.getByText('EACCES')).toBeTruthy()
    expect(screen.getByText('outside sandbox: /tmp/demo_codex/notes.md')).toBeTruthy()
    expect(container.textContent).not.toContain('ERROR: EACCES: EACCES')

    fireEvent.click(screen.getByTestId('grouped-tool-row-c1'))
    expect(screen.getAllByText('EACCES').length).toBeGreaterThanOrEqual(1)
    expect(container.textContent).not.toContain('ERROR: EACCES: EACCES')
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
    expect(contentWrapper?.className).toContain('ak-chat-container')
    expect(contentWrapper?.className).toContain('mx-auto')
  })

  it('jumps to the bottom on first non-empty mount but not on ordinary appends', () => {
    const scrollToIndex = (globalThis as typeof globalThis & {
      __virtuosoScrollToIndexMock?: ReturnType<typeof vi.fn>
    }).__virtuosoScrollToIndexMock
    scrollToIndex?.mockClear()

    const { rerender } = render(
      <ChatPanel
        messages={[{ role: 'user', content: [{ type: 'text', text: 'one' }] }]}
        pinnedToBottom
        onPinnedChange={() => {}}
        scrollToBottomToken={1}
      />,
    )

    expect(scrollToIndex).toHaveBeenCalledWith({
      index: 0,
      align: 'end',
      behavior: 'auto',
    })

    scrollToIndex?.mockClear()

    rerender(
      <ChatPanel
        messages={[
          { role: 'user', content: [{ type: 'text', text: 'one' }] },
          { role: 'assistant', content: [{ type: 'text', text: 'two' }] },
        ]}
        pinnedToBottom
        onPinnedChange={() => {}}
        scrollToBottomToken={1}
      />,
    )

    expect(scrollToIndex).not.toHaveBeenCalledWith({
      index: 1,
      align: 'end',
      behavior: 'auto',
    })
  })

  it('imperatively jumps only when scrollToBottomToken changes', () => {
    const scrollToIndex = (globalThis as typeof globalThis & {
      __virtuosoScrollToIndexMock?: ReturnType<typeof vi.fn>
    }).__virtuosoScrollToIndexMock
    scrollToIndex?.mockClear()

    const { rerender } = render(
      <ChatPanel
        messages={[{ role: 'user', content: [{ type: 'text', text: 'one' }] }]}
        pinnedToBottom
        onPinnedChange={() => {}}
        scrollToBottomToken={1}
      />,
    )

    scrollToIndex?.mockClear()

    rerender(
      <ChatPanel
        messages={[{ role: 'user', content: [{ type: 'text', text: 'one' }] }]}
        pinnedToBottom
        onPinnedChange={() => {}}
        scrollToBottomToken={2}
      />,
    )

    expect(scrollToIndex).toHaveBeenCalledWith({
      index: 0,
      align: 'end',
      behavior: 'auto',
    })
  })

  it('jumps to the bottom when an initially empty session finishes loading messages', () => {
    const scrollToIndex = (globalThis as typeof globalThis & {
      __virtuosoScrollToIndexMock?: ReturnType<typeof vi.fn>
    }).__virtuosoScrollToIndexMock
    scrollToIndex?.mockClear()

    const { rerender } = render(
      <ChatPanel
        messages={[]}
        pinnedToBottom
        onPinnedChange={() => {}}
        scrollToBottomToken={1}
      />,
    )
    expect(scrollToIndex).not.toHaveBeenCalled()

    rerender(
      <ChatPanel
        messages={[
          { role: 'user', content: [{ type: 'text', text: 'one' }] },
          { role: 'assistant', content: [{ type: 'text', text: 'two' }] },
        ]}
        pinnedToBottom
        onPinnedChange={() => {}}
        scrollToBottomToken={1}
      />,
    )

    expect(scrollToIndex).toHaveBeenCalledWith({
      index: 1,
      align: 'end',
      behavior: 'auto',
    })
  })

  it('shows a floating scroll-to-bottom button only when unpinned', () => {
    const scrollToIndex = (globalThis as typeof globalThis & {
      __virtuosoScrollToIndexMock?: ReturnType<typeof vi.fn>
    }).__virtuosoScrollToIndexMock
    scrollToIndex?.mockClear()
    const onPinnedChange = vi.fn()

    const { rerender } = render(
      <ChatPanel
        messages={[{ role: 'user', content: [{ type: 'text', text: 'one' }] }]}
        pinnedToBottom
        onPinnedChange={onPinnedChange}
      />,
    )
    expect(screen.queryByTestId('scroll-to-bottom')).toBeNull()

    rerender(
      <ChatPanel
        messages={[{ role: 'user', content: [{ type: 'text', text: 'one' }] }]}
        pinnedToBottom={false}
        onPinnedChange={onPinnedChange}
      />,
    )

    fireEvent.click(screen.getByTestId('scroll-to-bottom'))
    expect(scrollToIndex).toHaveBeenCalledWith({
      index: 0,
      align: 'end',
      behavior: 'auto',
    })
    expect(onPinnedChange).toHaveBeenCalledWith(true)
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
    // shiki resolves — under jsdom, shiki never actually loads, so the raw
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

  it('renders assistant TeX math with KaTeX', () => {
    const { container } = render(
      <ChatPanel
        messages={[
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'Inline $x^2$ and block:\n\n$$\\int_0^1 x dx$$' }],
          },
        ]}
      />,
    )

    expect(container.querySelectorAll('.katex').length).toBeGreaterThanOrEqual(2)
    expect(container.textContent ?? '').toContain('x')
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
    const trigger = screen.getByTestId('message-image-preview-trigger')
    expect(trigger.className).toContain('h-28')
    expect(trigger.className).toContain('w-40')
    expect(img?.className ?? '').toContain('h-full')
    expect(img?.className ?? '').toContain('w-full')
    expect(img?.className ?? '').toContain('object-contain')
    expect(img?.className ?? '').not.toContain('border')
    expect(trigger.className).not.toContain('border')
  })

  it('opens image content in a preview modal', () => {
    render(
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

    fireEvent.click(screen.getByTestId('message-image-preview-trigger'))

    expect(screen.getByTestId('message-image-preview-dialog')).toBeTruthy()
    const fullImage = screen.getByTestId('message-image-preview-full') as HTMLImageElement
    expect(fullImage.src).toContain('data:image/png;base64,iVBORw0KGgo=')
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

  it('opens a markdown summary modal from compact boundaries', () => {
    render(
      <ChatPanel
        items={[
          {
            kind: 'compact_boundary',
            seq: 7,
            trigger: 'manual',
            replacedCount: 2,
            tokensBefore: 1200,
            tokensAfter: 80,
            summary: '# Compacted Context\n\n## Open Work\n\n- Finish compact inspector wiring',
          },
        ]}
      />,
    )

    fireEvent.click(screen.getByTestId('compact-boundary-open'))
    const modal = screen.getByTestId('compact-summary-modal')
    expect(modal.textContent ?? '').toContain('Compacted Context')
    expect(modal.textContent ?? '').toContain('Open Work')
    expect(modal.textContent ?? '').toContain('Finish compact inspector wiring')
  })

  it('renders compact operation feedback as a transcript tail item', () => {
    render(
      <ChatPanel
        items={[{ kind: 'message', message: { role: 'user', content: [{ type: 'text', text: 'before compact' }] } }]}
        compactStatus={{ kind: 'running', startedAt: Date.now(), tokensBefore: 1200 }}
      />,
    )

    expect(screen.getByTestId('compact-feedback-transcript-row')).toBeTruthy()
    expect(screen.getByTestId('inline-compact-running')).toBeTruthy()
  })

  it('renders compact empty feedback as a transcript tail item', () => {
    render(
      <ChatPanel
        items={[{ kind: 'message', message: { role: 'user', content: [{ type: 'text', text: 'before compact' }] } }]}
        compactStatus={{ kind: 'empty', message: 'send a message before compacting context' }}
      />,
    )

    expect(screen.getByTestId('compact-feedback-transcript-row')).toBeTruthy()
    expect(screen.getByTestId('inline-compact-empty').textContent ?? '').toContain('send a message')
  })

  it('renders sending user messages inline with the transcript', () => {
    render(
      <ChatPanel
        items={[
          {
            kind: 'pending_user_message',
            id: 'local-1',
            text: 'sending now',
            mode: 'steer',
            status: 'sending',
            createdAt: '2026-07-06T00:00:00.000Z',
          },
        ]}
      />,
    )

    expect(screen.getByTestId('pending-user-message-local-1').textContent ?? '').toContain('sending now')
    expect(screen.getByTestId('pending-user-message-local-1').textContent ?? '').not.toContain('Sending')
    expect(screen.getByTestId('pending-user-message-status-local-1').getAttribute('aria-label')).toBe('Sending')
    expect(screen.queryByText(/Queued #/)).toBeNull()
  })

  it('renders cancelled assistant suffix as a status chip', () => {
    render(
      <ChatPanel
        messages={[
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'Partial response\n\n[cancelled]' }],
          },
        ]}
      />,
    )

    expect(screen.getByText('Partial response')).toBeTruthy()
    expect(screen.queryByText('[cancelled]')).toBeNull()
    expect(screen.getByTestId('assistant-message-cancelled').textContent ?? '').toContain('Response cancelled')
  })

  it('marks only the streaming assistant draft with a cursor class', () => {
    const { container } = render(
      <ChatPanel
        items={[
          {
            kind: 'message',
            message: { role: 'assistant', content: [{ type: 'text', text: 'finished' }] },
          },
          {
            kind: 'message',
            streaming: true,
            message: { role: 'assistant', content: [{ type: 'text', text: 'still generating' }] },
          },
        ]}
      />,
    )

    const textBlocks = container.querySelectorAll('.ak-chat-text')
    expect(textBlocks).toHaveLength(2)
    expect(textBlocks[0]?.classList.contains('ak-streaming-markdown')).toBe(false)
    expect(textBlocks[1]?.classList.contains('ak-streaming-markdown')).toBe(true)
    expect(screen.getByTestId('streaming-cursor').parentElement?.tagName).toBe('P')
  })

  it('does not show assistant message actions while the draft is streaming', () => {
    render(
      <ChatPanel
        items={[
          {
            kind: 'message',
            streaming: true,
            message: { role: 'assistant', content: [{ type: 'text', text: 'still generating' }] },
          },
        ]}
      />,
    )

    expect(screen.queryByTestId('message-actions-start')).toBeNull()
    expect(screen.queryByTestId('copy-message')).toBeNull()
  })

  it('places the streaming cursor inside the last visible markdown element', () => {
    const { rerender } = render(
      <ChatPanel
        items={[
          {
            kind: 'message',
            streaming: true,
            message: { role: 'assistant', content: [{ type: 'text', text: '- first\n- second' }] },
          },
        ]}
      />,
    )

    const listCursor = screen.getByTestId('streaming-cursor')
    expect(screen.getAllByTestId('streaming-cursor')).toHaveLength(1)
    expect(listCursor.parentElement?.tagName).toBe('LI')
    expect(listCursor.parentElement?.textContent).toContain('second')

    rerender(
      <ChatPanel
        items={[
          {
            kind: 'message',
            streaming: true,
            message: { role: 'assistant', content: [{ type: 'text', text: '```ts\nconst x = 1' }] },
          },
        ]}
      />,
    )

    expect(screen.getByTestId('streaming-cursor').parentElement?.tagName).toBe('CODE')
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

  it('renders user message copy and edit actions at the message tail', () => {
    render(
      <ChatPanel
        onEditAndRerun={vi.fn()}
        items={[
          {
            kind: 'message',
            seq: 4,
            message: { role: 'user', content: [{ type: 'text', text: 'copy me' }] },
          },
        ]}
      />,
    )

    const actions = screen.getByTestId('message-actions-end')
    expect(actions.contains(screen.getByTestId('copy-message'))).toBe(true)
    expect(actions.contains(screen.getByTestId('edit-message-0'))).toBe(true)
  })

  it('copies message text from message actions', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    try {
      render(
        <ChatPanel
          messages={[
            { role: 'assistant', content: [{ type: 'text', text: 'assistant answer' }] },
          ]}
        />,
      )

      fireEvent.click(screen.getByTestId('copy-message'))
      await waitFor(() => expect(writeText).toHaveBeenCalledWith('assistant answer'))
      await waitFor(() => expect(screen.getByTestId('copy-message').getAttribute('aria-label')).toBe('Copied'))
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('reruns the preceding user message from assistant try again', () => {
    const onEditAndRerun = vi.fn()
    render(
      <ChatPanel
        onEditAndRerun={onEditAndRerun}
        items={[
          {
            kind: 'message',
            seq: 10,
            message: { role: 'user', content: [{ type: 'text', text: 'original prompt' }] },
          },
          {
            kind: 'message',
            seq: 11,
            message: { role: 'assistant', content: [{ type: 'text', text: 'assistant answer' }] },
          },
        ]}
      />,
    )

    const actions = screen.getByTestId('message-actions-start')
    expect(actions.contains(screen.getAllByTestId('copy-message')[1]!)).toBe(true)
    fireEvent.click(screen.getByTestId('try-again-message-1'))
    expect(onEditAndRerun).toHaveBeenCalledWith(10, 'original prompt')
  })

  it('does not show message actions beside pure tool activity cards', () => {
    render(
      <ChatPanel
        onEditAndRerun={vi.fn()}
        items={[
          {
            kind: 'message',
            seq: 10,
            message: { role: 'user', content: [{ type: 'text', text: 'run tools' }] },
          },
          {
            kind: 'message',
            seq: 11,
            message: {
              role: 'assistant',
              content: [
                { type: 'tool_call', callId: 'c1', name: 'read', input: { path: '/repo/a.ts' } },
                { type: 'tool_call', callId: 'c2', name: 'grep', input: { pattern: 'needle' } },
              ],
            },
          },
        ]}
      />,
    )

    expect(screen.getByTestId('tool-call-group-c1')).toBeTruthy()
    expect(screen.queryByTestId('message-actions-start')).toBeNull()
    expect(screen.queryByTestId('try-again-message-1')).toBeNull()
  })

  it('does not show assistant message actions on mixed text and tool call messages', () => {
    render(
      <ChatPanel
        onEditAndRerun={vi.fn()}
        items={[
          {
            kind: 'message',
            seq: 10,
            message: { role: 'user', content: [{ type: 'text', text: 'inspect file' }] },
          },
          {
            kind: 'message',
            seq: 11,
            message: {
              role: 'assistant',
              content: [
                { type: 'text', text: 'I will inspect it.' },
                { type: 'tool_call', callId: 'c1', name: 'read', input: { path: '/repo/a.ts' } },
              ],
            },
          },
        ]}
      />,
    )

    expect(screen.getByText('I will inspect it.')).toBeTruthy()
    expect(screen.getByTestId('tool-call-group-c1')).toBeTruthy()
    expect(screen.queryByTestId('message-actions-start')).toBeNull()
    expect(screen.queryByTestId('try-again-message-1')).toBeNull()
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
    // Pending-approval cards render collapsed by default — the composer's
    // ApprovalCard is the primary UX for the decision, so we don't duplicate
    // the "approve or reject below" hint inline.
    expect(screen.queryByText(/Approve or reject in the composer area below/i)).toBeNull()
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
    expect(screen.queryByTestId('tool-call-group-details-c10')).toBeNull()
    expect(screen.getByText('Running')).toBeTruthy()

    fireEvent.click(screen.getByTestId('grouped-tool-row-c10'))
    expect(screen.getByTestId('tool-call-group-details-c10')).toBeTruthy()
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
    expect(screen.getByText('1 Needs approval')).toBeTruthy()
    expect(screen.getByText('1 Failed')).toBeTruthy()
    expect(screen.getByText('1 Succeeded')).toBeTruthy()
  })

  it('collapses a long mixed tool activity into one compact block', () => {
    render(
      <ChatPanel
        messages={[
          {
            role: 'assistant',
            content: [
              { type: 'tool_call', callId: 'c1', name: 'read', input: { path: '/repo/a.ts' } },
              { type: 'tool_call', callId: 'c2', name: 'grep', input: { pattern: 'needle', path: '/repo' } },
              { type: 'tool_call', callId: 'c3', name: 'edit', input: { path: '/repo/a.ts' } },
              { type: 'tool_call', callId: 'c4', name: 'bash', input: { command: 'pnpm test' } },
            ],
          },
          {
            role: 'tool',
            content: [
              { type: 'tool_result', callId: 'c1', ok: true, content: 'file contents' },
              { type: 'tool_result', callId: 'c2', ok: true, content: '/repo/a.ts:1:needle' },
              { type: 'tool_result', callId: 'c3', ok: true, content: 'edited' },
              { type: 'tool_result', callId: 'c4', ok: false, content: 'failed' },
            ],
          },
        ]}
      />,
    )

    expect(screen.getByTestId('tool-call-group-c1')).toBeTruthy()
    expect(screen.getByText('Tool activity')).toBeTruthy()
    expect(screen.getByText('4 ops')).toBeTruthy()
    expect(screen.getByText(/read 1, grep 1, edit 1, bash 1/)).toBeTruthy()
    expect(screen.getByText('1 Failed')).toBeTruthy()
    expect(screen.getAllByText(/Failed/i)).toHaveLength(1)
    expect(screen.getByText('3 Succeeded')).toBeTruthy()
    expect(screen.queryByText(/read · \/repo\/a\.ts/)).toBeNull()

    fireEvent.click(screen.getByTestId('tool-call-group-toggle-c1'))

    expect(screen.getByText(/read · \/repo\/a\.ts/)).toBeTruthy()
    expect(screen.getByText(/grep · \/needle\//)).toBeTruthy()
    expect(screen.getByText(/edit · \/repo\/a\.ts/)).toBeTruthy()
    expect(screen.getByText(/bash · pnpm test/)).toBeTruthy()
  })

  it('collapses mixed tool activity split across timeline items', () => {
    const timeline: TimelineEntry[] = [
      toolCallEntry(1, 'c1', 'grep', { pattern: 'foo', path: '/repo' }),
      toolResultEntry(2, 'c1', true, '/repo/a.ts:1:foo'),
      toolCallEntry(3, 'c2', 'read', { path: '/repo/a.ts' }),
      toolResultEntry(4, 'c2', true, 'file a'),
      toolCallEntry(5, 'c3', 'grep', { pattern: 'bar', path: '/repo' }),
      toolResultEntry(6, 'c3', true, '/repo/b.ts:1:bar'),
      toolCallEntry(7, 'c4', 'read', { path: '/repo/b.ts' }),
      toolResultEntry(8, 'c4', false, 'missing file'),
      toolCallEntry(9, 'c5', 'grep', { pattern: 'baz', path: '/repo' }),
      toolResultEntry(10, 'c5', true, '/repo/c.ts:1:baz'),
      toolCallEntry(11, 'c6', 'read', { path: '/repo/c.ts' }),
      toolResultEntry(12, 'c6', true, 'file c'),
    ]

    render(<ChatPanel items={visibleTranscript([], timeline, '')} />)

    expect(screen.getByTestId('tool-call-group-c1')).toBeTruthy()
    expect(screen.getByText('Tool activity')).toBeTruthy()
    expect(screen.getByText('6 ops')).toBeTruthy()
    expect(screen.getByText(/grep 3, read 3/)).toBeTruthy()
    expect(screen.getByText('1 Failed')).toBeTruthy()
    expect(screen.getByText('5 Succeeded')).toBeTruthy()
    expect(screen.queryByText('Tool result')).toBeNull()
  })

  it('auto-reveals only the configured live tail for running mixed tool activity', () => {
    render(
      <ChatPanel
        liveToolActivityTailCount={2}
        messages={[
          {
            role: 'assistant',
            content: [
              { type: 'tool_call', callId: 'c1', name: 'grep', input: { pattern: 'one', path: '/repo' } },
              { type: 'tool_call', callId: 'c2', name: 'read', input: { path: '/repo/two.ts' } },
              { type: 'tool_call', callId: 'c3', name: 'grep', input: { pattern: 'three', path: '/repo' } },
              { type: 'tool_call', callId: 'c4', name: 'read', input: { path: '/repo/four.ts' } },
              { type: 'tool_call', callId: 'c5', name: 'bash', input: { command: 'pnpm test' } },
            ],
          },
          {
            role: 'tool',
            content: [
              { type: 'tool_result', callId: 'c1', ok: true, content: 'one hit' },
              { type: 'tool_result', callId: 'c2', ok: true, content: 'two file' },
            ],
          },
        ]}
      />,
    )

    expect(screen.getByText('Tool activity')).toBeTruthy()
    expect(screen.getByTestId('tool-call-group-details-c1')).toBeTruthy()
    expect(screen.queryByText(/grep · \/one\//)).toBeNull()
    expect(screen.queryByText(/read · \/repo\/two\.ts/)).toBeNull()
    expect(screen.queryByText(/grep · \/three\//)).toBeNull()
    expect(screen.getByText(/read · \/repo\/four\.ts/)).toBeTruthy()
    expect(screen.getByText(/bash · pnpm test/)).toBeTruthy()
  })

  it('keeps collapsed mixed tool activity closed when a tail result arrives', () => {
    const { rerender } = render(
      <ChatPanel
        liveToolActivityTailCount={2}
        messages={[
          {
            role: 'assistant',
            content: [
              { type: 'tool_call', callId: 'c1', name: 'grep', input: { pattern: 'one', path: '/repo' } },
              { type: 'tool_call', callId: 'c2', name: 'read', input: { path: '/repo/two.ts' } },
              { type: 'tool_call', callId: 'c3', name: 'grep', input: { pattern: 'three', path: '/repo' } },
              { type: 'tool_call', callId: 'c4', name: 'read', input: { path: '/repo/four.ts' } },
              { type: 'tool_call', callId: 'c5', name: 'bash', input: { command: 'pnpm test' } },
            ],
          },
          {
            role: 'tool',
            content: [
              { type: 'tool_result', callId: 'c1', ok: true, content: 'one hit' },
              { type: 'tool_result', callId: 'c2', ok: true, content: 'two file' },
            ],
          },
        ]}
      />,
    )

    expect(screen.getByTestId('tool-call-group-details-c1')).toBeTruthy()
    expect(screen.getByText(/bash · pnpm test/)).toBeTruthy()

    rerender(
      <ChatPanel
        liveToolActivityTailCount={2}
        messages={[
          {
            role: 'assistant',
            content: [
              { type: 'tool_call', callId: 'c1', name: 'grep', input: { pattern: 'one', path: '/repo' } },
              { type: 'tool_call', callId: 'c2', name: 'read', input: { path: '/repo/two.ts' } },
              { type: 'tool_call', callId: 'c3', name: 'grep', input: { pattern: 'three', path: '/repo' } },
              { type: 'tool_call', callId: 'c4', name: 'read', input: { path: '/repo/four.ts' } },
              { type: 'tool_call', callId: 'c5', name: 'bash', input: { command: 'pnpm test' } },
            ],
          },
          {
            role: 'tool',
            content: [
              { type: 'tool_result', callId: 'c1', ok: true, content: 'one hit' },
              { type: 'tool_result', callId: 'c2', ok: true, content: 'two file' },
              { type: 'tool_result', callId: 'c3', ok: true, content: 'three hit' },
              { type: 'tool_result', callId: 'c4', ok: true, content: 'four file' },
              { type: 'tool_result', callId: 'c5', ok: true, content: 'passed' },
            ],
          },
        ]}
      />,
    )

    expect(screen.queryByTestId('tool-call-group-details-c1')).toBeNull()
    expect(screen.queryByText(/bash · pnpm test/)).toBeNull()
    expect(screen.getByText('5 Succeeded')).toBeTruthy()
  })

  it('keeps live mixed tool activity fully collapsed when the tail count is zero', () => {
    render(
      <ChatPanel
        liveToolActivityTailCount={0}
        messages={[
          {
            role: 'assistant',
            content: [
              { type: 'tool_call', callId: 'c1', name: 'grep', input: { pattern: 'one', path: '/repo' } },
              { type: 'tool_call', callId: 'c2', name: 'read', input: { path: '/repo/two.ts' } },
              { type: 'tool_call', callId: 'c3', name: 'grep', input: { pattern: 'three', path: '/repo' } },
              { type: 'tool_call', callId: 'c4', name: 'bash', input: { command: 'pnpm test' } },
            ],
          },
        ]}
      />,
    )

    expect(screen.getByText('Tool activity')).toBeTruthy()
    expect(screen.queryByTestId('tool-call-group-details-c1')).toBeNull()
    expect(screen.queryByText(/bash · pnpm test/)).toBeNull()
  })

  it('highlights a collapsed transcript-level tool activity by any consumed message index', () => {
    const timeline: TimelineEntry[] = [
      toolCallEntry(1, 'c1', 'grep', { pattern: 'foo', path: '/repo' }),
      toolResultEntry(2, 'c1', true, 'hit'),
      toolCallEntry(3, 'c2', 'read', { path: '/repo/a.ts' }),
      toolResultEntry(4, 'c2', true, 'file'),
      toolCallEntry(5, 'c3', 'grep', { pattern: 'bar', path: '/repo' }),
      toolResultEntry(6, 'c3', true, 'hit'),
      toolCallEntry(7, 'c4', 'read', { path: '/repo/b.ts' }),
      toolResultEntry(8, 'c4', true, 'file'),
    ]

    const { container } = render(
      <ChatPanel items={visibleTranscript([], timeline, '')} highlightIndex={5} />,
    )

    const activity = container.querySelector('[data-message-index="0"]')
    expect(activity?.className).toMatch(/bg-amber-50/)
  })

  it('does not collapse split tool activity across assistant text', () => {
    const timeline: TimelineEntry[] = [
      toolCallEntry(1, 'c1', 'grep', { pattern: 'foo', path: '/repo' }),
      toolResultEntry(2, 'c1', true, 'hit'),
      toolCallEntry(3, 'c2', 'read', { path: '/repo/a.ts' }),
      toolResultEntry(4, 'c2', true, 'file'),
      {
        seq: 5,
        ts: '2026-07-11T00:00:05.000Z',
        event: { kind: 'llm_response', message: { role: 'assistant', content: [{ type: 'text', text: 'checking next' }] } },
        effects: [],
      },
      toolCallEntry(6, 'c3', 'grep', { pattern: 'bar', path: '/repo' }),
      toolResultEntry(7, 'c3', true, 'hit'),
      toolCallEntry(8, 'c4', 'read', { path: '/repo/b.ts' }),
      toolResultEntry(9, 'c4', true, 'file'),
    ]

    render(<ChatPanel items={visibleTranscript([], timeline, '')} />)

    expect(screen.getAllByText('Tool activity')).toHaveLength(2)
    expect(screen.getByText('checking next')).toBeTruthy()
    expect(screen.getByTestId('tool-call-group-c1')).toBeTruthy()
    expect(screen.getByTestId('tool-call-group-c3')).toBeTruthy()
  })

  it('collapses short mixed tool runs into one activity block', () => {
    render(
      <ChatPanel
        messages={[
          {
            role: 'assistant',
            content: [
              { type: 'tool_call', callId: 'c1', name: 'read', input: { path: '/repo/a.ts' } },
              { type: 'tool_call', callId: 'c2', name: 'bash', input: { command: 'pwd' } },
            ],
          },
        ]}
      />,
    )

    expect(screen.getByText('Tool activity')).toBeTruthy()
    expect(screen.getByTestId('tool-call-group-c1')).toBeTruthy()
    expect(screen.getByText('2 ops')).toBeTruthy()
    expect(screen.getByText(/read 1, bash 1/)).toBeTruthy()
  })

  it('collapses short mixed tool activity split across timeline items', () => {
    const timeline: TimelineEntry[] = [
      toolCallEntry(1, 'c1', 'grep', { pattern: 'foo', path: '/repo' }),
      toolResultEntry(2, 'c1', true, 'hit'),
      toolCallEntry(3, 'c2', 'read', { path: '/repo/a.ts' }),
      toolResultEntry(4, 'c2', true, 'file'),
    ]

    render(<ChatPanel items={visibleTranscript([], timeline, '')} />)

    expect(screen.getByTestId('tool-call-group-c1')).toBeTruthy()
    expect(screen.getByText('Tool activity')).toBeTruthy()
    expect(screen.getByText('2 ops')).toBeTruthy()
    expect(screen.getByText(/grep 1, read 1/)).toBeTruthy()
    expect(screen.queryByText('Tool result')).toBeNull()
  })

  it('renders structured tool results by default with a raw toggle', () => {
    const result = {
      ok: true,
      summary: 'Applied 1 replacement(s) in /home/example/workspace/tmp/demo_codex/config.txt',
      files: [
        {
          path: '/home/example/workspace/tmp/demo_codex/config.txt',
          operation: 'modified',
          additions: 1,
          deletions: 1,
          diff: '--- /home/example/workspace/tmp/demo_codex/config.txt\n+++ /home/example/workspace/tmp/demo_codex/config.txt\n@@ -1,5 +1,5 @@\n env=prod\n-debug=false\n+debug=true\n port=443\n host=localhost\n',
          bytes_before: 45,
          bytes_after: 44,
          replacements: [{ index: 0, count: 1 }],
        },
      ],
    }

    render(
      <ChatPanel
        messages={[
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_call',
                callId: 'c1',
                name: 'replace_in_file',
                input: { path: '/home/example/workspace/tmp/demo_codex/config.txt', old_string: 'debug=false', new_string: 'debug=true' },
              },
            ],
          },
          { role: 'tool', content: [{ type: 'tool_result', callId: 'c1', ok: true, content: JSON.stringify(result) }] },
        ]}
      />,
    )

    fireEvent.click(screen.getByTestId('grouped-tool-row-c1'))

    expect(screen.getByText(result.summary)).toBeTruthy()
    expect(screen.getAllByText('/home/example/workspace/tmp/demo_codex/config.txt').length).toBeGreaterThan(0)
    expect(screen.getByText('-debug=false')).toBeTruthy()
    expect(screen.getByText('+debug=true')).toBeTruthy()
    expect(screen.getByText('1 replacement')).toBeTruthy()
    expect(screen.queryByText(/"files"/)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Raw result' }))

    expect(screen.getByText(/"files"/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Rendered result' })).toBeTruthy()
  })

  it('renders empty state end-to-end for an ephemeral session (system prompt only, no timeline)', () => {
    // Regression: host sends `ephemeralReadyEventFor` on connect for any
    // unknown sessionId (including the random UUID assigned when no session
    // is selected). That state has messages=[systemMessage] + empty timeline.
    // The full pipeline (state → visibleTranscript → ChatPanel) must render
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

function toolCallEntry(
  seq: number,
  callId: string,
  name: string,
  input: Record<string, unknown>,
): TimelineEntry {
  return {
    seq,
    ts: `2026-07-11T00:00:${String(seq).padStart(2, '0')}.000Z`,
    event: {
      kind: 'llm_response',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_call', callId, name, input }],
      },
    },
    effects: [],
  }
}

function toolResultEntry(
  seq: number,
  callId: string,
  ok: boolean,
  content: string,
): TimelineEntry {
  return {
    seq,
    ts: `2026-07-11T00:00:${String(seq).padStart(2, '0')}.000Z`,
    event: { kind: 'tool_result', callId, ok, content },
    effects: [],
  }
}
