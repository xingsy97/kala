import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { createInitialState } from '@agent-kernel/kernel'

import type { TimelineEntry } from '../../session.js'
import { visibleTranscript } from '../../transcript.js'
import { AssistantMarkdown, ChatPanel as DashboardChatPanel, splitMarkdownBlocks } from './ChatPanel.js'
import { InlineStatusRow, useElapsedSeconds } from './InlineStatusRow.js'

function ChatPanel(props: ComponentProps<typeof DashboardChatPanel>): JSX.Element {
  return <DashboardChatPanel toolCardMode="standard" {...props} />
}

describe('ChatPanel', () => {
  it('orders message actions before timing and keeps call counts in expanded details', () => {
    const summary = {
      turnId: 'turn-1', status: 'completed' as const, startedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:01:42Z', wallDurationMs: 102000, estimated: false,
      queueDurationMs: 2000, activeDurationMs: 76000, approvalWaitMs: 24000,
      llm: { wallDurationMs: 31000, requestCount: 3, firstTokenMs: 4200 },
      tools: { wallDurationMs: 45000, aggregateDurationMs: 87000, callCount: 12, peakConcurrency: 4, partial: false },
      compactionDurationMs: 0, retryDurationMs: 0, recoveryDurationMs: 0,
    }
    const items = [
      { kind: 'message' as const, seq: 1, message: { role: 'user' as const, content: [{ type: 'text' as const, text: 'Do it.' }] } },
      { kind: 'message' as const, seq: 2, message: { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'Done.' }] }, turnTiming: summary },
    ]
    render(<DashboardChatPanel items={items} messages={[]} onEditAndRerun={vi.fn()} />)
    const footer = screen.getByTestId('turn-timing-turn-1')
    expect(footer.parentElement?.getAttribute('data-testid')).toBe('assistant-message-footer')
    expect(footer.textContent).toContain('Completed · 1m 42s')
    expect(footer.textContent).not.toContain('12 Tools')
    expect(footer.textContent).not.toContain('3 model calls')
    const messageFooter = screen.getByTestId('assistant-message-footer')
    expect(Array.from(messageFooter.children)).toEqual([screen.getByTestId('message-actions-start'), footer])
    expect(Array.from(screen.getByTestId('message-actions-start').children)).toEqual([
      screen.getAllByTestId('copy-message')[1],
      screen.getByTestId('try-again-message-1'),
    ])
    fireEvent.click(footer.querySelector('button')!)
    const details = screen.getByTestId('turn-timing-details-turn-1')
    expect(details.textContent).toContain('Activity')
    expect(details.textContent).toContain('Model time31s')
    expect(details.textContent).toContain('Tool time45s')
    expect(details.textContent).toContain('Calls')
    expect(details.textContent).toContain('Model calls3')
    expect(details.textContent).toContain('Tool calls12')
    expect(details.textContent).not.toContain('12 Tools')
    expect(details.textContent).not.toContain('Tool wall')
    const technical = screen.getByTestId('turn-timing-technical-turn-1')
    expect(technical.hasAttribute('open')).toBe(false)
    expect(technical.textContent).toContain('Aggregate tool time1m 27s')
    expect(technical.textContent).toContain('Peak concurrency4')
  })

  it('shows a readable placeholder for legacy local markdown images instead of a broken browser image', () => {
    render(<AssistantMarkdown text={'Design: ![activity card](/tmp/activity-card.png)'} />)
    expect(screen.getByTestId('local-image-unavailable').textContent).toContain('Image unavailable: activity card')
    expect(document.querySelector('img[src="/tmp/activity-card.png"]')).toBeNull()
  })

  it('keeps unsafe assistant markdown protocols out of rendered links', () => {
    const { container } = render(<AssistantMarkdown text={'[unsafe](javascript:alert(1)) [safe](https://example.com)'} />)
    const links = container.querySelectorAll('a')
    expect(links[0]?.getAttribute('href')).not.toContain('javascript:')
    expect(links[1]?.getAttribute('href')).toBe('https://example.com')
  })

  it('uses the shared markdown typography layer for mixed markdown blocks', () => {
    const { container } = render(<AssistantMarkdown text={[
      'Paragraph text.',
      '',
      '1. First numbered item.',
      '2. Second numbered item with `inline code`.',
      '',
      '- Bullet item.',
      '',
      '> Quoted text.',
      '',
      '| Name | Value |',
      '| --- | --- |',
      '| Alpha | 1 |',
    ].join('\n')} />)

    const bodies = Array.from(container.querySelectorAll('.ak-markdown-body'))
    const orderedList = container.querySelector('ol')
    const unorderedList = container.querySelector('ul')
    expect(bodies.length).toBeGreaterThan(0)
    expect(bodies.some((body) => body.className.includes('[&_ol]:list-decimal'))).toBe(true)
    expect(bodies.some((body) => body.className.includes('[&_ul]:list-disc'))).toBe(true)
    expect(orderedList).toBeTruthy()
    expect(unorderedList).toBeTruthy()
    expect(orderedList?.querySelector('li')?.textContent).toContain('First numbered item')
    expect(container.querySelector('table')?.textContent).toContain('Alpha')
  })

  it('renders empty state', () => {
    render(<ChatPanel messages={[]} />)
    expect(screen.getByText(/No messages yet/i)).toBeTruthy()
  })

  it('renders durable queued rows instead of the empty welcome state', () => {
    render(
      <ChatPanel
        messages={[]}
        items={[
          {
            kind: 'pending_user_message',
            seq: Number.MAX_SAFE_INTEGER,
            id: 'queued-1',
            text: 'queued while session is empty',
            status: 'queued',
          },
        ]}
      />,
    )

    expect(screen.getByText('queued while session is empty')).toBeTruthy()
    expect(screen.queryByText(/No messages yet/i)).toBeNull()
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
    expect(screen.getByTestId('inline-status-thinking').closest('.ak-chat-container')).toBeTruthy()
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

  it('suppresses planning status until authoritative conversation history is loaded', () => {
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

    expect(screen.queryByTestId('inline-status-thinking')).toBeNull()
    expect(screen.getByTestId('transcript-history-loading-indicator').textContent).toContain('Loading conversation history')
    expect(screen.getByTestId('transcript-history-loading-indicator').querySelector('.ak-session-status-spinner')).toBeTruthy()
    expect(screen.getByTestId('transcript-history-loading-indicator').querySelector('.animate-spin')).toBeNull()
    expect(screen.getByTestId('transcript-loading-state').querySelectorAll('.rounded-full')).toHaveLength(1)
    expect(screen.getByTestId('transcript-loading-state').querySelectorAll('.h-16')).toHaveLength(0)
  })

  it('shows the current running Intention in the persistent activity badge', () => {
    render(
      <InlineStatusRow
        state={{ ...createInitialState({}), status: 'executing_tools', pendingCalls: [{ callId: 'c1', name: 'read', input: {}, status: 'dispatched' }] }}
        streamingActive={false}
        progress={{ phase: 'tools', label: 'Diagnose why Tool activity copy is duplicated across live surfaces.', intention: 'Diagnose why Tool activity copy is duplicated across live surfaces.', callId: 'c1', outcome: 'running' }}
      />,
    )
    expect(screen.getByTestId('inline-status-label').textContent).toContain('Diagnose why Tool activity copy is duplicated across live surfaces.')
    expect(screen.queryByTestId('inline-status-intention')).toBeNull()
  })

  it('shows a live elapsed timer on the running tool card alongside the intention badge', () => {
    render(
      <DashboardChatPanel
        toolCardMode="full"
        toolExecutionStartedAt={Date.parse('2026-07-20T12:00:00.000Z')}
        messages={[
          {
            role: 'assistant',
            content: [
              { type: 'tool_call', callId: 'c1', name: 'bash', input: { command: 'sleep 30' } },
            ],
          },
        ]}
      />,
    )

    // The running tool is shown by its own transcript card, which now carries
    // the live elapsed timer (spinning wrench / pulsing RUNNING badge live
    // alongside it). There must be no second, redundant inline status card.
    expect(screen.getByTestId('tool-call-group-c1')).toBeTruthy()
    const elapsed = screen.getByTestId('tool-running-elapsed')
    expect(elapsed.textContent ?? '').toMatch(/↳ \d+\.\d+s/)
    expect(screen.queryByTestId('inline-status-tools')).toBeNull()
  })

  it('useElapsedSeconds counts from the persisted start time, not mount time', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-20T12:00:12.500Z'))
    try {
      function Probe(): JSX.Element {
        const s = useElapsedSeconds(true, Date.parse('2026-07-20T12:00:00.000Z'))
        return <span data-testid="probe">{s.toFixed(1)}s</span>
      }
      render(<Probe />)
      expect(screen.getByTestId('probe').textContent).toBe('12.5s')
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows one compact history indicator instead of fake message cards while loading', () => {
    render(<ChatPanel loading messages={[]} />)

    const loading = screen.getByTestId('transcript-loading-state')
    expect(screen.getByTestId('transcript-history-loading-indicator').textContent).toContain('Loading conversation history')
    expect(loading.className).toContain('min-h-20')
    expect(loading.querySelectorAll('.h-16')).toHaveLength(0)
    expect(loading.querySelectorAll('.h-7.w-7.rounded-full')).toHaveLength(0)
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

    expect(root?.style.getPropertyValue('--ak-chat-font-size')).toBe('1.25rem')
    expect(root?.style.getPropertyValue('--ak-chat-content-width')).toBe('104rem')
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
                input: { path: '/tmp/a', _intent: 'Create the requested output file.' },
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
    expect(screen.getByText('Succeeded')).toBeTruthy()
    expect(screen.queryByText('wrote 3 bytes')).toBeNull()
    expect(screen.queryByText(/result wrote 3 bytes/)).toBeNull()
    expect(screen.queryByText('Assistant requested tool')).toBeNull()
    expect(screen.queryByText('Tool result')).toBeNull()
    expect(screen.queryByText('Operation details')).toBeNull()
    expect(screen.getByText('Create the requested output file.')).toBeTruthy()
    expect(screen.queryByText('_intent')).toBeNull()
    // Body is collapsed by default; ordinary success output stays in the expanded detail.
    fireEvent.click(screen.getByTestId('grouped-tool-row-c1'))
    expect(screen.getAllByText('wrote 3 bytes').length).toBeGreaterThanOrEqual(1)
    const request = screen.getByTestId('tool-call-technical-details-c1')
    expect(request.hasAttribute('open')).toBe(true)
    expect(request.textContent).toContain('request')
    expect(request.textContent).toContain('/tmp/a')
    expect(request.textContent).not.toContain('_intent')
  })

  it('previews intent and tool summary on hover or click without expanding the group', () => {
    render(
      <DashboardChatPanel
        messages={[
          {
            role: 'assistant',
            content: [
              { type: 'tool_call', callId: 'dot-1', name: 'read', input: { path: '/repo/a.ts' }, intent: 'Inspect the implementation before changing it.' },
              { type: 'tool_call', callId: 'dot-2', name: 'bash', input: { command: 'pnpm test' }, intent: 'Run the focused tests to verify current behavior.' },
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
    expect(screen.getByTestId('tool-card-dots-dot-1').className).toContain('grid-cols-')
    expect(screen.getByTestId('tool-card-dots-intent-dot-1').className).toContain('col-start-2')
    expect(screen.getByTestId('tool-card-dots-intent-dot-1').className).not.toContain('truncate')
    expect(screen.queryByText('Tool activity')).toBeNull()
    expect(screen.queryByText('2')).toBeNull()
    expect(screen.getByLabelText('Assistant')).toBeTruthy()
    expect(screen.getByTestId('tool-card-dots-dot-1').className).not.toMatch(/bg-muted/)
    expect(screen.getAllByTestId('tool-activity-connector')).toHaveLength(1)
    const connector = screen.getByTestId('tool-activity-connector')
    expect(connector.className).toContain('absolute')
    expect(connector.style.left).toBe(connector.style.right)
    expect(screen.getByTestId('tool-activity-direction')).toBeTruthy()
    expect(screen.getByTestId('tool-card-dot-dot-1').getAttribute('title')).toBe('Inspect the implementation before changing it.')
    expect(screen.getByTestId('tool-card-dot-dot-2').getAttribute('title')).toBe('Run the focused tests to verify current behavior.')
    expect(screen.getByTestId('tool-card-dot-dot-1').getAttribute('title')).not.toContain('/repo/a.ts')
    expect(screen.getByTestId('tool-card-dot-dot-2').getAttribute('title')).not.toContain('pnpm test')
    expect(screen.getByTestId('tool-card-dot-dot-1').querySelector('[data-shape="read"]')).toBeTruthy()
    expect(screen.getByTestId('tool-card-dot-dot-2').querySelector('[data-shape="shell"]')).toBeTruthy()

    const firstDot = screen.getByTestId('tool-card-dot-dot-1')
    const secondDot = screen.getByTestId('tool-card-dot-dot-2')
    fireEvent.mouseEnter(firstDot)
    const hoverCard = screen.getByTestId('tool-card-preview-layer-dot-1')
    expect(screen.getByTestId('tool-call-detail-intent-dot-1').textContent).toBe('Inspect the implementation before changing it.')
    expect(hoverCard.className).toContain('fixed')
    expect(hoverCard.style.width).toBe('384px')
    expect(hoverCard.getAttribute('data-placement')).toMatch(/^anchor-(?:above|below)$/)
    expect(hoverCard.textContent).toContain('/repo/a.ts')
    expect(hoverCard.textContent).toContain('a')
    expect(screen.queryByTestId('tool-call-group-details-dot-1')).toBeNull()
    fireEvent.mouseLeave(firstDot)
    expect(screen.queryByTestId('tool-card-preview-layer-dot-1')).toBeNull()

    fireEvent.click(secondDot)
    expect(secondDot.getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('tool-call-detail-intent-dot-2').textContent).toBe('Run the focused tests to verify current behavior.')
    const pinnedCard = screen.getByTestId('tool-card-preview-layer-dot-2')
    const toolNameChip = pinnedCard.querySelector('[data-testid="tool-name-chip"]')
    expect(toolNameChip?.textContent).toBe('Shell')
    expect(toolNameChip?.getAttribute('title')).toBe('Shell')
    expect(toolNameChip?.getAttribute('data-tool-name')).toBe('bash')
    expect(toolNameChip?.className).toContain('max-w-full')
    expect(toolNameChip?.className).not.toContain('max-w-[45%]')
    expect(toolNameChip?.parentElement?.className).toContain('flex-1')
    expect(pinnedCard.textContent).toContain('failed')
    expect(pinnedCard.textContent).toContain('result')
    const technicalDetails = screen.getByTestId('tool-call-technical-details-dot-2')
    expect(technicalDetails.hasAttribute('open')).toBe(true)
    expect(technicalDetails.textContent).toContain('request')
    expect(technicalDetails.textContent).not.toContain('Technical details')
    expect(pinnedCard.className).toContain('pointer-events-auto')
    expect(screen.getByTestId('tool-card-preview-close')).toBeTruthy()
    const previewScroll = screen.getByTestId('tool-card-preview-scroll-dot-2')
    expect(previewScroll.className).toContain('overflow-y-auto')
    fireEvent.wheel(previewScroll, { deltaY: 120 })
    expect(screen.getByTestId('tool-card-preview-layer-dot-2')).toBeTruthy()
    expect(screen.queryByTestId('tool-call-group-details-dot-1')).toBeNull()

    fireEvent.mouseEnter(firstDot)
    expect(screen.getByTestId('tool-card-preview-layer-dot-2')).toBeTruthy()
    expect(screen.queryByTestId('tool-card-preview-layer-dot-1')).toBeNull()
    fireEvent.mouseLeave(firstDot)
    expect(screen.getByTestId('tool-card-preview-layer-dot-2')).toBeTruthy()

    fireEvent.click(secondDot)
    expect(secondDot.getAttribute('aria-pressed')).toBe('false')
    expect(screen.queryByTestId('tool-card-preview-layer-dot-2')).toBeNull()

    fireEvent.click(screen.getByTestId('tool-activity-direction'))
    expect(screen.getByTestId('tool-call-group-details-dot-1')).toBeTruthy()
  })

  it('uses semantic icons for file mutations', () => {
    render(<DashboardChatPanel messages={[{ role: 'assistant', content: [{ type: 'tool_call', callId: 'shape-write', name: 'write_file', input: { path: '/repo/a.ts', content: 'x' } }] }, { role: 'tool', content: [{ type: 'tool_result', callId: 'shape-write', ok: true, content: 'ok' }] }]} />)
    expect(screen.getByTestId('tool-card-dot-shape-write').querySelector('[data-shape="write"]')).toBeTruthy()
  })

  it('uses a visible middle omission marker for long tool activity rails', () => {
    const calls = Array.from({ length: 24 }, (_, index) => ({ type: 'tool_call' as const, callId: `many-${index}`, name: index % 2 === 0 ? 'read' : 'grep', input: index % 2 === 0 ? { path: `/repo/${index}.ts` } : { pattern: `${index}` } }))
    const results = calls.map((call) => ({ type: 'tool_result' as const, callId: call.callId, ok: true, content: 'ok' }))
    render(<DashboardChatPanel messages={[{ role: 'assistant', content: calls }, { role: 'tool', content: results }]} />)

    const omission = screen.getByTestId('tool-activity-omission')
    expect(omission.textContent).toMatch(/^\+\d+$/)
    const omittedCount = Number(omission.textContent?.slice(1))
    expect(omittedCount).toBeGreaterThan(0)
    expect(omission.getAttribute('aria-label')).toContain(`${omittedCount} omitted tool calls`)
    expect(omission.className).toContain('z-20')
    expect(omission.className).toContain('bg-background')
    expect(omission.className).toContain('shadow-[0_0_0_4px_hsl(var(--background))]')
    expect(screen.getByTestId('tool-card-dot-many-0')).toBeTruthy()
    expect(screen.getByTestId('tool-card-dot-many-23')).toBeTruthy()
    expect(screen.queryByTestId('tool-card-dot-many-12')).toBeNull()
    fireEvent.click(omission)
    expect(screen.getByTestId('tool-call-group-details-many-0')).toBeTruthy()
  })

  it('keeps a running dot animated without auto-opening its hover preview', () => {
    render(
      <DashboardChatPanel
        messages={[
          {
            role: 'assistant',
            content: [
              { type: 'tool_call', callId: 'done', name: 'read', input: { path: '/repo/a.ts' } },
              { type: 'tool_call', callId: 'running', name: 'bash', input: { command: 'pnpm test' } },
            ],
          },
          {
            role: 'tool',
            content: [
              { type: 'tool_result', callId: 'done', ok: true, content: 'a' },
            ],
          },
        ]}
      />,
    )

    const runningDot = screen.getByTestId('tool-card-dot-running')
    expect(runningDot.querySelector('.animate-ping')).toBeTruthy()
    expect(screen.queryByTestId('tool-card-preview-layer-running')).toBeNull()
    expect(screen.queryByTestId('tool-call-group-details-done')).toBeNull()

    fireEvent.mouseEnter(runningDot)
    expect(screen.getByTestId('tool-card-preview-layer-running')).toBeTruthy()
    fireEvent.mouseLeave(runningDot)
    expect(screen.queryByTestId('tool-card-preview-layer-running')).toBeNull()

    const doneDot = screen.getByTestId('tool-card-dot-done')
    fireEvent.click(doneDot)
    expect(screen.getByTestId('tool-card-preview-layer-done')).toBeTruthy()
    fireEvent.click(doneDot)
    expect(screen.queryByTestId('tool-card-preview-layer-done')).toBeNull()
    expect(screen.queryByTestId('tool-card-preview-layer-running')).toBeNull()
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

  it('keeps assistant continuation text aligned while showing one branded avatar', () => {
    render(
      <ChatPanel
        messages={[
          { role: 'assistant', content: [{ type: 'text', text: 'first assistant' }] },
          { role: 'assistant', content: [{ type: 'text', text: 'continued assistant' }] },
          { role: 'user', content: [{ type: 'text', text: 'first user' }] },
          { role: 'user', content: [{ type: 'text', text: 'continued user' }] },
        ]}
      />,
    )

    const rails = screen.getAllByTestId('message-avatar-rail')
    expect(rails).toHaveLength(2)
    expect(rails.map((rail) => rail.getAttribute('data-avatar-visible'))).toEqual(['true', 'false'])
    expect(rails[0]?.querySelector('.lucide-sparkles')).toBeTruthy()
    expect(rails[0]?.textContent).not.toContain('AK')
    expect(screen.queryByTestId('message-grip-rail')).toBeNull()
  })

  it('jumps to the bottom on first non-empty mount but not on ordinary appends', () => {
    const scrollToIndex = (globalThis as typeof globalThis & {
      __virtuosoScrollToIndexMock?: ReturnType<typeof vi.fn>
    }).__virtuosoScrollToIndexMock
    const scrollTo = (globalThis as typeof globalThis & { __virtuosoScrollToMock?: ReturnType<typeof vi.fn> }).__virtuosoScrollToMock
    scrollToIndex?.mockClear()

    const { rerender } = render(
      <ChatPanel
        messages={[{ role: 'user', content: [{ type: 'text', text: 'one' }] }]}
        pinnedToBottom
        onPinnedChange={() => {}}
        scrollToBottomToken={1}
      />,
    )

    expect(scrollTo).toHaveBeenCalledWith({ top: Number.MAX_SAFE_INTEGER, behavior: 'auto' })

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
    const scrollTo = (globalThis as typeof globalThis & { __virtuosoScrollToMock?: ReturnType<typeof vi.fn> }).__virtuosoScrollToMock
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

    expect(scrollTo).toHaveBeenCalledWith({ top: Number.MAX_SAFE_INTEGER, behavior: 'auto' })
  })

  it('jumps to the bottom when an initially empty session finishes loading messages', () => {
    const scrollToIndex = (globalThis as typeof globalThis & {
      __virtuosoScrollToIndexMock?: ReturnType<typeof vi.fn>
    }).__virtuosoScrollToIndexMock
    const scrollTo = (globalThis as typeof globalThis & { __virtuosoScrollToMock?: ReturnType<typeof vi.fn> }).__virtuosoScrollToMock
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

    expect(scrollTo).toHaveBeenCalledWith({ top: Number.MAX_SAFE_INTEGER, behavior: 'auto' })
  })

  it('shows a floating scroll-to-bottom button only when unpinned', () => {
    const scrollToIndex = (globalThis as typeof globalThis & {
      __virtuosoScrollToIndexMock?: ReturnType<typeof vi.fn>
    }).__virtuosoScrollToIndexMock
    const scrollTo = (globalThis as typeof globalThis & { __virtuosoScrollToMock?: ReturnType<typeof vi.fn> }).__virtuosoScrollToMock
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
    expect(scrollTo).toHaveBeenCalledWith({ top: Number.MAX_SAFE_INTEGER, behavior: 'auto' })
    expect(onPinnedChange).toHaveBeenCalledWith(true)
  })

  it('jumps between user-message anchors from the real viewport and supports repeated clicks', () => {
    const bridge = globalThis as typeof globalThis & {
      __virtuosoScrollToIndexMock?: ReturnType<typeof vi.fn>
    }
    bridge.__virtuosoScrollToIndexMock?.mockClear()
    const onPinnedChange = vi.fn()
    render(
      <ChatPanel
        pinnedToBottom={false}
        onPinnedChange={onPinnedChange}
        messages={[
          { role: 'user', content: [{ type: 'text', text: 'first question' }] },
          { role: 'assistant', content: [{ type: 'text', text: 'first answer' }] },
          { role: 'user', content: [{ type: 'text', text: 'second question' }] },
          { role: 'assistant', content: [{ type: 'text', text: 'second answer' }] },
          { role: 'user', content: [{ type: 'text', text: 'third question' }] },
        ]}
      />,
    )

    const scroller = screen.getByTestId('virtuoso-scroller')
    const rows = [...scroller.querySelectorAll<HTMLElement>('[data-virt-index]')]
    Object.defineProperty(scroller, 'getBoundingClientRect', { configurable: true, value: () => ({ top: 100, bottom: 500, left: 0, right: 800, width: 800, height: 400, x: 0, y: 100, toJSON() {} }) })
    rows.forEach((row, index) => Object.defineProperty(row, 'getBoundingClientRect', { configurable: true, value: () => ({ top: 20 + index * 100, bottom: 100 + index * 100, left: 0, right: 800, width: 800, height: 80, x: 0, y: 20 + index * 100, toJSON() {} }) }))
    fireEvent.scroll(scroller)
    fireEvent.click(screen.getByTestId('previous-user-message'))
    expect(bridge.__virtuosoScrollToIndexMock).toHaveBeenLastCalledWith({ index: 0, align: 'start', behavior: 'auto' })
    fireEvent.click(screen.getByTestId('next-user-message'))
    expect(bridge.__virtuosoScrollToIndexMock).toHaveBeenLastCalledWith({ index: 2, align: 'start', behavior: 'auto' })
    fireEvent.click(screen.getByTestId('next-user-message'))
    expect(bridge.__virtuosoScrollToIndexMock).toHaveBeenLastCalledWith({ index: 4, align: 'start', behavior: 'auto' })
    expect(onPinnedChange).toHaveBeenCalledWith(false)
  })

  it('pins the user prompt that owns the currently viewed response', async () => {
    const bridge = globalThis as typeof globalThis & {
      __virtuosoScrollToIndexMock?: ReturnType<typeof vi.fn>
    }
    bridge.__virtuosoScrollToIndexMock?.mockClear()
    const onPinnedChange = vi.fn()
    render(
      <ChatPanel
        pinnedToBottom={false}
        onPinnedChange={onPinnedChange}
        topRightAccessory={<button type="button" data-testid="pinned-row-inspector">Inspector</button>}
        messages={[
          { role: 'user', content: [{ type: 'text', text: 'first question\nwith enough detail to span the compact prompt preview' }] },
          { role: 'assistant', content: [{ type: 'text', text: 'first answer' }] },
          { role: 'user', content: [{ type: 'text', text: 'second question' }] },
          { role: 'assistant', content: [{ type: 'text', text: 'second answer' }] },
        ]}
      />,
    )

    const scroller = screen.getByTestId('virtuoso-scroller')
    const rows = [...scroller.querySelectorAll<HTMLElement>('[data-virt-index]')]
    Object.defineProperty(scroller, 'getBoundingClientRect', { configurable: true, value: () => ({ top: 100, bottom: 500, left: 0, right: 800, width: 800, height: 400, x: 0, y: 100, toJSON() {} }) })
    rows.forEach((row, index) => Object.defineProperty(row, 'getBoundingClientRect', { configurable: true, value: () => ({ top: index === 0 ? -80 : 100 + (index - 1) * 100, bottom: index === 0 ? 0 : 180 + (index - 1) * 100, left: 0, right: 800, width: 800, height: 80, x: 0, y: index === 0 ? -80 : 100 + (index - 1) * 100, toJSON() {} }) }))
    fireEvent.scroll(scroller)

    const sticky = await screen.findByTestId('sticky-user-prompt')
    const overlayRow = screen.getByTestId('chat-top-overlay-row')
    const inspector = screen.getByTestId('pinned-row-inspector')
    expect(overlayRow.contains(sticky)).toBe(true)
    expect(overlayRow.contains(inspector)).toBe(true)
    expect(sticky.contains(inspector)).toBe(false)
    expect(sticky.textContent).not.toContain('Current prompt')
    expect(sticky.textContent).toContain('first question')
    expect(sticky.textContent).not.toContain('second question')
    expect(sticky.querySelector('.line-clamp-2')).toBeTruthy()
    expect(sticky.querySelector('.sm\\:line-clamp-3')).toBeTruthy()
    const buttonClass = within(sticky).getByRole('button').className
    expect(buttonClass).toContain('ak-sticky-user-prompt-surface')
    expect(buttonClass).toContain('grid-cols-[auto_minmax(0,1fr)_auto]')
    expect(buttonClass).toContain('items-center')
    expect(sticky.querySelector('.text-\\[0\\.9375rem\\]')).toBeTruthy()
    expect(sticky.querySelector('.lucide-user-round')).toBeTruthy()
    expect(sticky.querySelector('.lucide-pen-line')).toBeNull()

    fireEvent.click(within(sticky).getByRole('button'))
    expect(bridge.__virtuosoScrollToIndexMock).toHaveBeenLastCalledWith({ index: 0, align: 'start', behavior: 'auto' })
    expect(onPinnedChange).toHaveBeenCalledWith(false)
  })

  it('switches the pinned prompt as the reader scrolls into another turn', async () => {
    render(
      <ChatPanel
        pinnedToBottom={false}
        onPinnedChange={() => {}}
        messages={[
          { role: 'user', content: [{ type: 'text', text: 'first question' }] },
          { role: 'assistant', content: [{ type: 'text', text: 'first answer' }] },
          { role: 'user', content: [{ type: 'text', text: 'second question' }] },
          { role: 'assistant', content: [{ type: 'text', text: 'second answer' }] },
        ]}
      />,
    )

    const scroller = screen.getByTestId('virtuoso-scroller')
    const rows = [...scroller.querySelectorAll<HTMLElement>('[data-virt-index]')]
    Object.defineProperty(scroller, 'getBoundingClientRect', { configurable: true, value: () => ({ top: 100, bottom: 500, left: 0, right: 800, width: 800, height: 400, x: 0, y: 100, toJSON() {} }) })
    rows.forEach((row, index) => Object.defineProperty(row, 'getBoundingClientRect', { configurable: true, value: () => ({ top: index === 3 ? 100 : -300 + index * 40, bottom: index === 3 ? 180 : -260 + index * 40, left: 0, right: 800, width: 800, height: 80, x: 0, y: index === 3 ? 100 : -300 + index * 40, toJSON() {} }) }))
    fireEvent.scroll(scroller)

    const sticky = await screen.findByTestId('sticky-user-prompt')
    expect(sticky.textContent).toContain('second question')
    expect(sticky.textContent).not.toContain('first question')
  })

  it('summarizes image and file-only prompts in the sticky preview', async () => {
    render(
      <ChatPanel
        pinnedToBottom={false}
        onPinnedChange={() => {}}
        messages={[
          {
            role: 'user',
            content: [
              { type: 'image', source: { kind: 'base64', mediaType: 'image/png', data: 'iVBORw0KGgo=' } },
              { type: 'image', source: { kind: 'base64', mediaType: 'image/png', data: 'iVBORw0KGgo=' } },
              { type: 'file', name: 'report.csv', mediaType: 'text/csv', data: 'YSxi' },
              { type: 'file', name: 'notes.md', mediaType: 'text/markdown', data: 'IyA=' },
              { type: 'file', name: 'extra.log', mediaType: 'text/plain', data: 'bG9n' },
            ],
          },
          { role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
        ]}
      />,
    )

    const scroller = screen.getByTestId('virtuoso-scroller')
    const rows = [...scroller.querySelectorAll<HTMLElement>('[data-virt-index]')]
    Object.defineProperty(scroller, 'getBoundingClientRect', { configurable: true, value: () => ({ top: 100, bottom: 500, left: 0, right: 800, width: 800, height: 400, x: 0, y: 100, toJSON() {} }) })
    rows.forEach((row, index) => Object.defineProperty(row, 'getBoundingClientRect', { configurable: true, value: () => ({ top: index === 0 ? -80 : 100, bottom: index === 0 ? 0 : 180, left: 0, right: 800, width: 800, height: 80, x: 0, y: index === 0 ? -80 : 100, toJSON() {} }) }))
    fireEvent.scroll(scroller)

    const sticky = await screen.findByTestId('sticky-user-prompt')
    expect(sticky.textContent).toContain('Prompt contains attachments')
    expect(sticky.textContent).toContain('2 images')
    expect(sticky.textContent).toContain('report.csv')
    expect(sticky.textContent).toContain('notes.md')
    expect(sticky.textContent).toContain('+1 file')
  })

  it('does not duplicate the prompt while the user message row is still visible first', () => {
    render(
      <ChatPanel
        pinnedToBottom={false}
        onPinnedChange={() => {}}
        messages={[
          { role: 'user', content: [{ type: 'text', text: 'visible user prompt' }] },
          { role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
        ]}
      />,
    )

    const scroller = screen.getByTestId('virtuoso-scroller')
    const rows = [...scroller.querySelectorAll<HTMLElement>('[data-virt-index]')]
    Object.defineProperty(scroller, 'getBoundingClientRect', { configurable: true, value: () => ({ top: 100, bottom: 500, left: 0, right: 800, width: 800, height: 400, x: 0, y: 100, toJSON() {} }) })
    rows.forEach((row, index) => Object.defineProperty(row, 'getBoundingClientRect', { configurable: true, value: () => ({ top: index === 0 ? 80 : 180, bottom: index === 0 ? 180 : 260, left: 0, right: 800, width: 800, height: 80, x: 0, y: index === 0 ? 80 : 180, toJSON() {} }) }))
    fireEvent.scroll(scroller)
    expect(screen.queryByTestId('sticky-user-prompt')).toBeNull()
  })

  it('hides the pinned prompt while transcript search is open', () => {
    render(
      <ChatPanel
        searchOpen
        pinnedToBottom={false}
        onPinnedChange={() => {}}
        messages={[
          { role: 'user', content: [{ type: 'text', text: 'search should own the top edge' }] },
          { role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
        ]}
      />,
    )

    const scroller = screen.getByTestId('virtuoso-scroller')
    const rows = [...scroller.querySelectorAll<HTMLElement>('[data-virt-index]')]
    Object.defineProperty(scroller, 'getBoundingClientRect', { configurable: true, value: () => ({ top: 100, bottom: 500, left: 0, right: 800, width: 800, height: 400, x: 0, y: 100, toJSON() {} }) })
    rows.forEach((row, index) => Object.defineProperty(row, 'getBoundingClientRect', { configurable: true, value: () => ({ top: index === 0 ? -80 : 100, bottom: index === 0 ? 0 : 180, left: 0, right: 800, width: 800, height: 80, x: 0, y: index === 0 ? -80 : 100, toJSON() {} }) }))
    fireEvent.scroll(scroller)
    expect(screen.getByTestId('transcript-search')).toBeTruthy()
    expect(screen.queryByTestId('sticky-user-prompt')).toBeNull()
  })

  it('disables user-message navigation at transcript boundaries', () => {
    render(
      <ChatPanel
        messages={[
          { role: 'user', content: [{ type: 'text', text: 'first question' }] },
          { role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
          { role: 'user', content: [{ type: 'text', text: 'last question' }] },
        ]}
      />,
    )

    const scroller = screen.getByTestId('virtuoso-scroller')
    const rows = [...scroller.querySelectorAll<HTMLElement>('[data-virt-index]')]
    Object.defineProperty(scroller, 'getBoundingClientRect', { configurable: true, value: () => ({ top: 100, bottom: 500, left: 0, right: 800, width: 800, height: 400, x: 0, y: 100, toJSON() {} }) })
    rows.forEach((row, index) => Object.defineProperty(row, 'getBoundingClientRect', { configurable: true, value: () => ({ top: 100 + index * 100, bottom: 180 + index * 100, left: 0, right: 800, width: 800, height: 80, x: 0, y: 100 + index * 100, toJSON() {} }) }))
    fireEvent.scroll(scroller)
    expect(screen.getByTestId('previous-user-message').hasAttribute('disabled')).toBe(true)
    expect(screen.getByTestId('next-user-message').hasAttribute('disabled')).toBe(false)
    fireEvent.click(screen.getByTestId('next-user-message'))
    expect(screen.getByTestId('previous-user-message').hasAttribute('disabled')).toBe(false)
    expect(screen.getByTestId('next-user-message').hasAttribute('disabled')).toBe(true)
  })

  it('renders session artifacts as previewable images', () => {
    render(<ChatPanel sessionId="session-1" messages={[{ role: 'assistant', content: [{ type: 'text', text: '![Concept](artifact://artifact-1)' }] }]} />)
    const button = screen.getByTestId('artifact-markdown-image')
    const image = button.querySelector('img')
    expect(image?.getAttribute('src')).toBe('/session-artifacts/artifact-1?sessionId=session-1')
    fireEvent.click(button)
    expect(screen.getAllByAltText('Concept')).toHaveLength(2)
    const dialog = screen.getByTestId('artifact-image-preview-dialog')
    expect(dialog.className).toContain('w-screen')
    expect(dialog.className).toContain('--ak-viewport-h')
    expect(dialog.className).toContain('grid-rows-[auto_minmax(0,1fr)]')
    expect(screen.getByTestId('artifact-image-preview-close').className).toContain('h-11 w-11')
    expect(screen.getByTestId('readonly-image-preview-controls')).toBeTruthy()
    expect(screen.getByTestId('artifact-image-preview-full')).toBeTruthy()
  })

  it('renders Host-referenced image attachments from the session-scoped durable endpoint', () => {
    render(<ChatPanel sessionId="session-1" messages={[{
      role: 'user',
      content: [{
        type: 'file', name: 'pasted-image-1.png', mediaType: 'image/png',
        source: { kind: 'host_ref', attachmentId: 'image-attachment-1', sha256: 'a'.repeat(64), bytes: 8 },
      }],
    }]} />)
    const preview = screen.getByTestId('message-image-preview-trigger')
    expect(preview.querySelector('img')?.getAttribute('src')).toBe('/runtime/attachments/image-attachment-1?sessionId=session-1')
  })

  it('loads Host-referenced images with the configured bearer token', async () => {
    const originalFetch = globalThis.fetch
    const originalCreateObjectURL = URL.createObjectURL
    const originalRevokeObjectURL = URL.revokeObjectURL
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Blob(['png'], { type: 'image/png' }), { status: 200 }))
    globalThis.fetch = fetchMock
    URL.createObjectURL = vi.fn(() => 'blob:durable-image')
    URL.revokeObjectURL = vi.fn()
    try {
      const rendered = render(<ChatPanel
        sessionId="session-1"
        attachmentHost="https://host.example/"
        attachmentToken="image-token"
        messages={[{
          role: 'user',
          content: [{
            type: 'file', name: 'pasted-image-1.png', mediaType: 'image/png',
            source: { kind: 'host_ref', attachmentId: 'image attachment', sha256: 'a'.repeat(64), bytes: 3 },
          }],
        }]}
      />)
      expect(screen.getByTestId('message-image-preview-loading')).toBeTruthy()
      await waitFor(() => expect(screen.getByTestId('message-image-preview-trigger').querySelector('img')?.getAttribute('src')).toBe('blob:durable-image'))
      expect(fetchMock).toHaveBeenCalledWith(
        'https://host.example/runtime/attachments/image%20attachment?sessionId=session-1',
        expect.objectContaining({ credentials: 'include', headers: { authorization: 'Bearer image-token' } }),
      )
      rendered.unmount()
      expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:durable-image')
    } finally {
      globalThis.fetch = originalFetch
      URL.createObjectURL = originalCreateObjectURL
      URL.revokeObjectURL = originalRevokeObjectURL
    }
  })

  it('asks for confirmation before rendering an SVG session artifact', () => {
    render(<ChatPanel sessionId="session-1" messages={[{ role: 'assistant', content: [{ type: 'text', text: '![Diagram](artifact://artifact-svg?mediaType=image%2Fsvg%2Bxml)' }] }]} />)
    expect(screen.getByTestId('svg-image-warning').textContent).toContain('SVG files can contain embedded content')
    expect(screen.queryByTestId('artifact-markdown-image')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))

    const button = screen.getByTestId('artifact-markdown-image')
    expect(button.querySelector('img')?.getAttribute('src')).toBe('/session-artifacts/artifact-svg?sessionId=session-1&allowSvg=1')
    fireEvent.click(button)
    expect(screen.getByTestId('artifact-image-preview-dialog')).toBeTruthy()
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

  it('renders generic file attachments as named transcript cards', () => {
    render(
      <ChatPanel
        messages={[{
          role: 'user',
          content: [{
            type: 'file',
            name: 'report.csv',
            mediaType: 'text/csv',
            data: 'YSxiCjEsMgo=',
          }],
        }]}
      />,
    )

    const attachment = screen.getByTestId('message-file-attachment')
    expect(attachment.textContent).toContain('report.csv')
    expect(attachment.textContent).toContain('text/csv')
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

    const dialog = screen.getByTestId('message-image-preview-dialog')
    expect(dialog.className).toContain('w-screen')
    expect(dialog.className).toContain('rounded-none')
    expect(dialog.className).toContain('sm:max-w-[80rem]')
    expect(dialog.className).toContain('sm:h-[min(94dvh,64rem)]')
    expect(screen.getByTestId('message-image-preview-close').className).toContain('h-11')
    expect(screen.getByTestId('readonly-image-preview-controls')).toBeTruthy()
    const fullImage = screen.getByTestId('message-image-preview-full') as HTMLImageElement
    expect(fullImage.src).toContain('data:image/png;base64,iVBORw0KGgo=')
    expect(fullImage.className).toContain('max-w-none')
    expect(fullImage.className).not.toContain('100dvh')
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

  it('does not render compacted unpaired tool calls as live work', () => {
    render(
      <ChatPanel
        activeToolCallIds={[]}
        items={[
          {
            kind: 'message',
            seq: 5,
            message: {
              role: 'assistant',
              content: [{ type: 'tool_call', callId: 'old-grep', name: 'grep', input: { pattern: 'contextSnapshot' } }],
            },
          },
          {
            kind: 'compact_boundary',
            seq: 7,
            trigger: 'manual',
            replacedCount: 2,
            tokensBefore: 851_800,
            tokensAfter: 71_600,
            summary: 'summary',
          },
          {
            kind: 'message',
            seq: 8,
            message: { role: 'assistant', content: [{ type: 'text', text: 'continued after compact' }] },
          },
        ]}
      />,
    )

    const group = screen.getByTestId('tool-call-group-old-grep')
    expect(group.textContent).toContain('Orphaned')
    expect(group.textContent).not.toContain('Running')
    expect(group.querySelector('.animate-ping')).toBeNull()
    expect(screen.getByText('continued after compact')).toBeTruthy()
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

  it('renders interrupted assistant responses as a dedicated state', () => {
    render(<ChatPanel messages={[{ role: 'assistant', content: [{ type: 'text', text: 'Partial response\n\n[interrupted]' }] }]} />)

    expect(screen.getByText('Partial response')).toBeTruthy()
    expect(screen.queryByText('[interrupted]')).toBeNull()
    expect(screen.getByTestId('assistant-message-interrupted').textContent).toContain('Response interrupted before completion')
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
    // The actively-streaming prose tail now renders through the persistent
    // per-character fade tail (plain text, outside ReactMarkdown) so its fade
    // spans don't remount every token. The cursor sits at the end of that tail.
    const cursorParent = screen.getByTestId('streaming-cursor').parentElement
    expect(cursorParent?.classList.contains('ak-streaming-tail')).toBe(true)
    expect(cursorParent?.textContent).toContain('still generating')
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
    // Actively-streaming list tail renders as the plain-text fade tail; the
    // cursor sits at its end with the latest text.
    expect(listCursor.parentElement?.classList.contains('ak-streaming-tail')).toBe(true)
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

  it('shows settled intent as history but suppresses the running intent owned by the badge', () => {
    const message = { role: 'assistant' as const, content: [{ type: 'tool_call' as const, callId: 'intent-card', name: 'read', input: { path: '/repo/a.ts' }, intent: 'Inspect the current implementation before editing it.' }] }
    const { rerender } = render(<DashboardChatPanel messages={[message]} activeToolCallIds={[]} />)
    expect(screen.getByTestId('tool-card-dots-intent-intent-card').textContent).toBe('Inspect the current implementation before editing it.')

    rerender(<DashboardChatPanel messages={[message]} activeToolCallIds={['intent-card']} badgeIntentionCallId="intent-card" />)
    expect(screen.queryByTestId('tool-card-dots-intent-intent-card')).toBeNull()
    fireEvent.mouseEnter(screen.getByTestId('tool-card-dot-intent-card'))
    expect(screen.getByTestId('tool-call-detail-intent-intent-card').textContent).toBe('Inspect the current implementation before editing it.')
    expect(screen.queryByTestId('tool-card-dots-intent-intent-card')).toBeNull()
  })

  it('lets inspection text replace the settled group summary and restores it after hover', () => {
    const messages = [{ role: 'assistant' as const, content: [
      { type: 'tool_call' as const, callId: 'history-1', name: 'read', input: {}, intent: 'Identify the original state projection defect.' },
      { type: 'tool_call' as const, callId: 'history-2', name: 'grep', input: {}, intent: 'Confirm the final historical summary remains useful after execution.' },
    ] }]
    render(<DashboardChatPanel messages={messages} activeToolCallIds={[]} />)
    expect(screen.getByTestId('tool-card-dots-intent-history-1').textContent).toBe('Confirm the final historical summary remains useful after execution.')
    fireEvent.mouseEnter(screen.getByTestId('tool-card-dot-history-1'))
    expect(screen.getByTestId('tool-card-dots-intent-history-1').textContent).toBe('Identify the original state projection defect.')
    fireEvent.mouseLeave(screen.getByTestId('tool-card-dot-history-1'))
    expect(screen.getByTestId('tool-card-dots-intent-history-1').textContent).toBe('Confirm the final historical summary remains useful after execution.')
  })

  it('keeps another inspected historical Intention visible while the badge owns a running call', () => {
    const messages = [{ role: 'assistant' as const, content: [
      { type: 'tool_call' as const, callId: 'old', name: 'read', input: {}, intent: 'Inspect the earlier projection behavior for comparison.' },
      { type: 'tool_call' as const, callId: 'live', name: 'grep', input: {}, intent: 'Validate the current live activity de-duplication contract.' },
    ] }]
    render(<DashboardChatPanel messages={messages} activeToolCallIds={['live']} badgeIntentionCallId="live" />)
    expect(screen.queryByTestId('tool-card-dots-intent-old')).toBeNull()
    fireEvent.mouseEnter(screen.getByTestId('tool-card-dot-old'))
    expect(screen.getByTestId('tool-card-dots-intent-old').textContent).toBe('Inspect the earlier projection behavior for comparison.')
  })

  it('hides the collapsed summary after expansion and exposes each row Intention', () => {
    const messages = [{ role: 'assistant' as const, content: [
      { type: 'tool_call' as const, callId: 'expand-1', name: 'read', input: { path: '/very/long/private/path' }, intent: 'Inspect the responsive activity header contract.' },
      { type: 'tool_call' as const, callId: 'expand-2', name: 'grep', input: { pattern: 'private' }, intent: 'Verify technical parameters remain outside the default expanded header.' },
    ] }]
    render(<DashboardChatPanel messages={messages} activeToolCallIds={[]} />)
    fireEvent.click(screen.getByTestId('tool-activity-direction'))
    expect(screen.queryByTestId('tool-card-dots-intent-expand-1')).toBeNull()
    expect(screen.getByTestId('grouped-tool-intent-expand-1').textContent).toBe('Inspect the responsive activity header contract.')
    expect(screen.getByTestId('grouped-tool-intent-expand-2').textContent).toBe('Verify technical parameters remain outside the default expanded header.')
    const expandedRow = screen.getByTestId('grouped-tool-row-expand-1')
    expect(expandedRow.className).toContain('grid-cols-[auto_minmax(0,1fr)]')
    expect(expandedRow.className).toContain('sm:grid-cols-[auto_minmax(0,1fr)_auto]')
    expect(expandedRow.textContent).toContain('Inspect the responsive activity header contract.')
    expect(screen.getByTestId('tool-call-group-toggle-expand-1').textContent).not.toContain('/very/long/private/path')
    expect(screen.getByTestId('tool-call-group-details-expand-1').textContent).toContain('/very/long/private/path')
    expect(screen.getByTestId('tool-call-group-details-expand-1').textContent).toContain('/private/')
  })

  it('aggregates completed legacy calls without Intention instead of repeating placeholders', () => {
    const calls = Array.from({ length: 53 }, (_, index) => ({ type: 'tool_call' as const, callId: `legacy-${index}`, name: 'read_file', input: { path: `/private/${index}` } }))
    const results = calls.map((call, index) => ({ type: 'tool_result' as const, callId: call.callId, ok: index >= 49 ? false : true, content: index >= 49 ? 'failed' : 'ok' }))
    render(<DashboardChatPanel activeToolCallIds={[]} messages={[{ role: 'assistant', content: calls }, { role: 'tool', content: results }]} />)
    fireEvent.click(screen.getByTestId('tool-activity-direction'))
    expect(screen.queryByText(/completed operations have no recorded Intention/)).toBeNull()
    expect(screen.queryByText('Details available')).toBeNull()
    expect(screen.getAllByTestId(/grouped-tool-row-legacy-/)).toHaveLength(8)
    expect(screen.queryByTestId('grouped-tool-row-legacy-0')).toBeNull()
    const toggle = screen.getByTestId('tool-mobile-row-limit-toggle')
    expect(toggle.textContent).toBe('Show all 53 operations')
    expect(toggle.className).toContain('min-h-12')
    fireEvent.click(toggle)
    expect(screen.getAllByTestId(/grouped-tool-row-legacy-/)).toHaveLength(53)
    expect(screen.getByTestId('tool-call-group-details-legacy-0').textContent).toContain('/private/0')
  })

  it('distinguishes grep search dots from file-read dots', () => {
    render(<DashboardChatPanel activeToolCallIds={[]} messages={[{ role: 'assistant', content: [
      { type: 'tool_call', callId: 'grep-shape', name: 'grep', input: {}, intent: 'Locate matching behavior references.' },
      { type: 'tool_call', callId: 'read-shape', name: 'read_file', input: {}, intent: 'Inspect the selected implementation.' },
      { type: 'tool_call', callId: 'reads-shape', name: 'read_files', input: {}, intent: 'Compare related implementation files.' },
    ] }]} />)
    expect(screen.getByTestId('tool-card-dot-grep-shape').querySelector('[data-shape="search"]')).toBeTruthy()
    expect(screen.getByTestId('tool-card-dot-read-shape').querySelector('[data-shape="read"]')).toBeTruthy()
    expect(screen.getByTestId('tool-card-dot-reads-shape').querySelector('[data-shape="read"]')).toBeTruthy()
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

  it('groups consecutive same-name tool dots with counts without crossing tool boundaries', () => {
    render(
      <DashboardChatPanel
        messages={[
          {
            role: 'assistant',
            content: [
              { type: 'tool_call', callId: 'repeat-read-1', name: 'read', input: { path: '/repo/a.ts' } },
              { type: 'tool_call', callId: 'repeat-read-2', name: 'read', input: { path: '/repo/b.ts' } },
              { type: 'tool_call', callId: 'repeat-grep-1', name: 'grep', input: { pattern: 'x' } },
              { type: 'tool_call', callId: 'repeat-grep-2', name: 'grep', input: { pattern: 'y' } },
              { type: 'tool_call', callId: 'repeat-read-3', name: 'read', input: { path: '/repo/c.ts' } },
            ],
          },
          {
            role: 'tool',
            content: [
              { type: 'tool_result', callId: 'repeat-read-1', ok: true, content: 'a' },
              { type: 'tool_result', callId: 'repeat-read-2', ok: false, content: 'missing' },
              { type: 'tool_result', callId: 'repeat-grep-1', ok: true, content: 'x' },
              { type: 'tool_result', callId: 'repeat-grep-2', ok: true, content: 'y' },
              { type: 'tool_result', callId: 'repeat-read-3', ok: true, content: 'c' },
            ],
          },
        ]}
      />,
    )

    expect(screen.getByTestId('tool-card-dot-count-repeat-read-1').textContent).toBe('×2')
    expect(screen.getByTestId('tool-card-dot-count-repeat-grep-1').textContent).toBe('×2')
    expect(screen.getByTestId('tool-card-dot-repeat-read-3')).toBeTruthy()
    expect(screen.getByTestId('tool-card-dot-group-repeat-read-1').textContent).toContain('×2')
    expect(screen.getByTestId('tool-card-dot-group-repeat-read-1').querySelector('.text-rose-600')).toBeTruthy()
    expect(screen.queryByTestId('tool-card-dot-count-repeat-read-3')).toBeNull()
  })

  it('offers a bottom Collapse action after expanding long tool activity', async () => {
    render(
      <DashboardChatPanel
        messages={[
          {
            role: 'assistant',
            content: Array.from({ length: 12 }, (_, index) => ({
              type: 'tool_call' as const,
              callId: `long-${index}`,
              name: index % 2 === 0 ? 'read' : 'grep',
              input: index % 2 === 0 ? { path: `/repo/${index}.ts` } : { pattern: `${index}` },
            })),
          },
        ]}
      />,
    )

    fireEvent.click(screen.getByTestId('tool-activity-direction'))
    expect(screen.getByTestId('tool-call-group-details-long-0')).toBeTruthy()
    const collapse = screen.getByTestId('tool-activity-collapse-bottom')
    expect(collapse.textContent).toContain('Collapse')
    const group = screen.getByTestId('tool-call-group-long-0')
    const scrollIntoView = vi.fn()
    Object.defineProperty(group, 'scrollIntoView', { configurable: true, value: scrollIntoView })
    vi.spyOn(group, 'getBoundingClientRect').mockReturnValue({ top: -600, bottom: -40, left: 0, right: 320, width: 320, height: 560, x: 0, y: -600, toJSON: () => ({}) })
    fireEvent.click(collapse)
    expect(screen.queryByTestId('tool-call-group-details-long-0')).toBeNull()
    expect(screen.getByTestId('tool-card-dots-long-0')).toBeTruthy()
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' }))
  })

  it('collapses a long mixed tool activity into one compact block', () => {
    render(
      <ChatPanel
        messages={[
          {
            role: 'assistant',
            content: [
              { type: 'tool_call', callId: 'c1', name: 'read', input: { path: '/repo/a.ts' }, intent: 'Inspect the target implementation.' },
              { type: 'tool_call', callId: 'c2', name: 'grep', input: { pattern: 'needle', path: '/repo' }, intent: 'Locate all relevant references.' },
              { type: 'tool_call', callId: 'c3', name: 'edit', input: { path: '/repo/a.ts' }, intent: 'Apply the focused source change.' },
              { type: 'tool_call', callId: 'c4', name: 'bash', input: { command: 'pnpm test' }, intent: 'Verify the change with focused tests.' },
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
    const intentSummary = screen.getByTestId('tool-call-intent-summary-c1')
    expect(intentSummary.textContent).toBe('Verify the change with focused tests.')
    expect(screen.getByText('1 Failed')).toBeTruthy()
    expect(screen.getAllByText(/Failed/i)).toHaveLength(1)
    expect(screen.getByText('3 Succeeded')).toBeTruthy()
    expect(screen.queryByText(/read · \/repo\/a\.ts/)).toBeNull()

    fireEvent.click(screen.getByTestId('tool-call-group-toggle-c1'))

    expect(screen.getByText(/read · \/repo\/a\.ts/)).toBeTruthy()
    expect(screen.getByText(/grep · \/needle\//)).toBeTruthy()
    expect(screen.getByText(/edit · \/repo\/a\.ts/)).toBeTruthy()
    expect(screen.getByText(/bash · pnpm test/)).toBeTruthy()
    const grepRow = screen.getByTestId('grouped-tool-row-c2')
    expect(grepRow.querySelector('.sm\\:hidden')?.textContent).toContain('1 hit in /repo')
    expect(grepRow.className).toContain('grid-cols-[auto_minmax(0,1fr)]')
    expect(screen.getByTestId('grouped-tool-intent-c1').textContent).toBe('Inspect the target implementation.')
    expect(screen.getByTestId('grouped-tool-intent-c4').textContent).toBe('Verify the change with focused tests.')

    fireEvent.click(screen.getByTestId('grouped-tool-row-c1'))
    expect(screen.getByTestId('tool-call-detail-intent-c1').textContent).toBe('Inspect the target implementation.')
    const technical = screen.getByTestId('tool-call-technical-details-c1')
    expect(technical.hasAttribute('open')).toBe(true)
    expect(technical.textContent).toContain('request')
    expect(technical.textContent).not.toContain('Technical details')
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
    const runningRead = screen.getByTestId('grouped-tool-row-c4').querySelector('svg')
    const runningBash = screen.getByTestId('grouped-tool-row-c5').querySelector('svg')
    expect(runningRead?.className.baseVal).toContain('animate-spin')
    expect(runningBash?.className.baseVal).toContain('animate-spin')
    expect(runningRead?.className.baseVal).not.toContain('text-emerald')
    expect(screen.getByText('2 Succeeded')).toBeTruthy()
    expect(screen.getByText('3 Running')).toBeTruthy()
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

  it('merges reasoning-bearing tool turns into one dots rail without hiding reasoning in Standard mode', () => {
    const messages = [
      {
        role: 'assistant' as const,
        content: [
          { type: 'thinking' as const, text: 'inspect the first file' },
          { type: 'tool_call' as const, callId: 'reason-dot-1', name: 'read', input: { path: '/repo/a.ts' } },
        ],
      },
      {
        role: 'tool' as const,
        content: [{ type: 'tool_result' as const, callId: 'reason-dot-1', ok: true, content: 'a' }],
      },
      {
        role: 'assistant' as const,
        content: [
          { type: 'thinking' as const, text: 'inspect the second file' },
          { type: 'tool_call' as const, callId: 'reason-dot-2', name: 'read', input: { path: '/repo/b.ts' } },
        ],
      },
      {
        role: 'tool' as const,
        content: [{ type: 'tool_result' as const, callId: 'reason-dot-2', ok: true, content: 'b' }],
      },
    ]

    const { rerender } = render(<DashboardChatPanel messages={messages} />)

    expect(screen.getByTestId('tool-card-dot-count-reason-dot-1').textContent).toBe('×2')
    expect(screen.getAllByTestId(/tool-card-dots-/)).toHaveLength(1)
    expect(screen.queryByText('Tool activity')).toBeNull()
    expect(screen.getAllByText('Thinking')).toHaveLength(2)

    rerender(<DashboardChatPanel messages={messages} toolCardMode="standard" />)

    expect(screen.getAllByText('Thinking')).toHaveLength(2)
    expect(screen.getAllByTestId(/tool-call-group-reason-dot-/)).toHaveLength(2)
  })

  it('keeps one dots rail when standalone reasoning separates tool turns', () => {
    render(
      <DashboardChatPanel
        messages={[
          {
            role: 'assistant',
            content: [{ type: 'tool_call', callId: 'rail-1', name: 'read', input: { path: '/repo/a.ts' } }],
          },
          {
            role: 'tool',
            content: [{ type: 'tool_result', callId: 'rail-1', ok: true, content: 'a' }],
          },
          {
            role: 'assistant',
            content: [{ type: 'thinking', text: 'compare the next file' }],
          },
          {
            role: 'assistant',
            content: [{ type: 'tool_call', callId: 'rail-2', name: 'read', input: { path: '/repo/b.ts' } }],
          },
          {
            role: 'tool',
            content: [{ type: 'tool_result', callId: 'rail-2', ok: true, content: 'b' }],
          },
          {
            role: 'assistant',
            content: [
              { type: 'thinking', text: 'verify the result' },
              { type: 'tool_call', callId: 'rail-3', name: 'bash', input: { command: 'pnpm test' } },
            ],
          },
          {
            role: 'tool',
            content: [{ type: 'tool_result', callId: 'rail-3', ok: true, content: 'passed' }],
          },
        ]}
      />,
    )

    expect(screen.getAllByTestId(/tool-card-dots-/)).toHaveLength(1)
    expect(screen.getByTestId('tool-card-dot-count-rail-1').textContent).toBe('×2')
    expect(screen.getByTestId('tool-card-dot-rail-3')).toBeTruthy()
    expect(screen.getAllByText('Thinking')).toHaveLength(2)
  })

  it('keeps one compact dots rail when narration and blank protocol content separate tool turns', () => {
    render(
      <DashboardChatPanel
        messages={[
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'First inspect the workspace.' }],
          },
          {
            role: 'assistant',
            content: [{ type: 'tool_call', callId: 'narrated-1', name: 'read', input: { path: '/repo' } }],
          },
          {
            role: 'tool',
            content: [{ type: 'tool_result', callId: 'narrated-1', ok: true, content: 'files' }, { type: 'text', text: '   ' }],
          },
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'Now run and edit a file.' }],
          },
          {
            role: 'assistant',
            content: [{ type: 'tool_call', callId: 'narrated-2', name: 'bash', input: { command: 'pnpm test' } }],
          },
          {
            role: 'tool',
            content: [{ type: 'tool_result', callId: 'narrated-2', ok: true, content: 'passed' }, { type: 'thinking', text: '\n' }],
          },
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Apply the precise edit.' },
              { type: 'tool_call', callId: 'narrated-3', name: 'replace_many_in_file', input: { path: '/repo/a.ts' } },
            ],
          },
          {
            role: 'tool',
            content: [{ type: 'tool_result', callId: 'narrated-3', ok: false, content: 'outside sandbox' }, { type: 'text', text: '' }],
          },
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'Everything is complete.' }],
          },
        ]}
      />,
    )

    const rail = screen.getByTestId('tool-card-dots-narrated-1')
    expect(screen.getAllByTestId(/tool-card-dots-/)).toHaveLength(1)
    expect(within(rail).getAllByTestId(/tool-card-dot-narrated-/)).toHaveLength(3)
    expect(screen.getByText('First inspect the workspace.')).toBeTruthy()
    expect(screen.getByText('Now run and edit a file.')).toBeTruthy()
    expect(screen.getByText('Apply the precise edit.')).toBeTruthy()
    expect(screen.getByText('Everything is complete.')).toBeTruthy()
    expect(screen.getAllByLabelText('Assistant')).toHaveLength(1)
    expect(screen.getByTestId('tool-card-dot-narrated-3').querySelector('.text-rose-600')).toBeTruthy()
    const virtualRows = Array.from(document.querySelectorAll('[data-virt-index]'))
    expect(virtualRows).toHaveLength(5)
    const textlessRows = virtualRows.filter((row) => (row.textContent ?? '').trim().length === 0)
    expect(textlessRows).toHaveLength(1)
    expect(textlessRows[0]?.querySelector('[data-testid="tool-activity-rail"]')).toBeTruthy()
    expect(
      rail.compareDocumentPosition(screen.getByText('Everything is complete.'))
        & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
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

describe('AssistantMarkdown streaming stability', () => {
  it('keeps completed markdown block DOM mounted while the tail grows and commits', () => {
    const { container, rerender } = render(<AssistantMarkdown text={'Stable paragraph.\n\nTail'} streaming />)
    const stableNode = container.querySelector('.ak-chat-text p')
    expect(stableNode?.textContent).toBe('Stable paragraph.')

    rerender(<AssistantMarkdown text={'Stable paragraph.\n\nTail grows'} streaming />)
    expect(container.querySelector('.ak-chat-text p')).toBe(stableNode)

    rerender(<AssistantMarkdown text={'Stable paragraph.\n\nTail grows'} streaming={false} />)
    expect(container.querySelector('.ak-chat-text p')).toBe(stableNode)
  })

  it('commits a blank-line-terminated final code block before later text arrives', () => {
    const code = '```typescript\nconst stable = true\n```\n\n'
    const { rerender } = render(<AssistantMarkdown text={code} streaming />)
    const stableCode = screen.getByTestId('code-block-raw')
    rerender(<AssistantMarkdown text={`${code}later`} streaming />)
    expect(screen.getByTestId('code-block-raw')).toBe(stableCode)
  })

  it('keeps a completed code block DOM node mounted when later blocks stream', () => {
    const code = '```typescript\nconst stable = true\n```\n\n'
    const { rerender } = render(<AssistantMarkdown text={`${code}later`} streaming />)
    const stableCode = screen.getByTestId('code-block-raw')
    rerender(<AssistantMarkdown text={`${code}later text grows`} streaming />)
    expect(screen.getByTestId('code-block-raw')).toBe(stableCode)
    rerender(<AssistantMarkdown text={`${code}later text grows`} streaming={false} />)
    expect(screen.getByTestId('code-block-raw')).toBe(stableCode)
  })
})

describe('splitMarkdownBlocks', () => {
  it('splits completed blocks from the trailing block being written', () => {
    const { blocks, tail } = splitMarkdownBlocks('# Title\n\nfirst para\n\nsecond par')
    expect(blocks).toEqual(['# Title\n\n', 'first para\n\n'])
    expect(tail).toBe('second par')
    // Joining the completed blocks plus the tail must reproduce the input.
    expect(blocks.join('') + tail).toBe('# Title\n\nfirst para\n\nsecond par')
  })

  it('does not treat a blank line inside a fenced code block as a boundary', () => {
    const text = '```ts\nconst a = 1\n\nconst b = 2\n```\n\nafter'
    const { blocks, tail } = splitMarkdownBlocks(text)
    // The blank line inside the fence stays in one block; only the boundary
    // after the closing fence splits.
    expect(blocks).toEqual(['```ts\nconst a = 1\n\nconst b = 2\n```\n\n'])
    expect(tail).toBe('after')
  })

  it('returns no completed blocks until the first boundary appears', () => {
    expect(splitMarkdownBlocks('just one line still typing')).toEqual({ blocks: [], tail: 'just one line still typing' })
  })
})
