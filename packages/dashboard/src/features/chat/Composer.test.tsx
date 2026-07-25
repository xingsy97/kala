import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { createInitialState, type ImageContent, type TextContent } from '@agent-kernel/kernel'
import type { FileListEntry, HumanAttentionTimeline } from '@agent-kernel/shared'

import { Composer } from './Composer.js'
import type { ChatDisplayPrefs } from './chatDisplayPrefs.js'

const EMPTY_HUMAN_ATTENTION = { sessionId: '', points: [], latest: null } as const

function renderComposer(props?: {
  onSubmit?: (
    text: string,
    mode: 'steer' | 'queue',
    images?: readonly ImageContent[],
    extraBlocks?: readonly TextContent[],
  ) => void
  onCompact?: () => void
  onCancel?: () => void
  onClearSession?: () => void
  onRenameSession?: (label: string | null) => void
  onDeleteSession?: () => void
  onListFiles?: (query: string) => Promise<readonly FileListEntry[]>
  onReadFile?: (path: string) => Promise<{ content?: string; error?: string }>
  queuedMessages?: React.ComponentProps<typeof Composer>['queuedMessages']
  onQueuedDelete?: (id: string) => void
  state?: React.ComponentProps<typeof Composer>['state']
  disabled?: boolean
  humanAttention?: React.ComponentProps<typeof Composer>['humanAttention']
  displayPrefs?: ChatDisplayPrefs
  awaitingAck?: boolean
}) {
  return render(
    <Composer
      model=""
      models={[]}
      onModelChange={() => {}}
      approvalMode="auto"
      onApprovalModeChange={() => {}}
      state={props?.state ?? null}
      config={null}
      humanAttention={props?.humanAttention ?? EMPTY_HUMAN_ATTENTION}
      queuedMessages={props?.queuedMessages ?? []}
      displayPrefs={props?.displayPrefs}
      disabled={props?.disabled}
      {...(props?.onQueuedDelete ? { onQueuedDelete: props.onQueuedDelete } : {})}
      onSubmit={props?.onSubmit ?? (() => {})}
      onCompact={props?.onCompact ?? (() => {})}
      {...(props?.onCancel ? { onCancel: props.onCancel } : {})}
      {...(props?.onClearSession ? { onClearSession: props.onClearSession } : {})}
      {...(props?.onRenameSession ? { onRenameSession: props.onRenameSession } : {})}
      {...(props?.onDeleteSession ? { onDeleteSession: props.onDeleteSession } : {})}
      {...(props?.onListFiles ? { onListFiles: props.onListFiles } : {})}
      {...(props?.onReadFile ? { onReadFile: props.onReadFile } : {})}
      awaitingAck={props?.awaitingAck}
    />,
  )
}

describe('Composer', () => {
  it('keeps runtime state out of the composer footer', () => {
    render(
      <Composer
        model=""
        models={[]}
        onModelChange={() => {}}
        approvalMode="auto"
        onApprovalModeChange={() => {}}
        state={null}
        config={null}
        humanAttention={EMPTY_HUMAN_ATTENTION}
        queuedMessages={[]}
        onSubmit={() => {}}
        onCompact={() => {}}
      />,
    )

    expect(screen.queryByTestId('composer-state-chips')).toBeNull()
    expect(screen.queryByTestId('connection-status')).toBeNull()
    const indicator = screen.getByTestId('context-usage-indicator')
    expect(indicator.textContent ?? '').toContain('?')
    expect(indicator.textContent ?? '').not.toContain('Events')
    expect(indicator.textContent ?? '').not.toContain('Tools')
    expect(indicator.textContent ?? '').not.toContain('Tokens')
  })

  it('uses the low-attention hint as the empty input placeholder', () => {
    renderComposer({ humanAttention: attentionTimeline(18, 'absent', 52) })

    expect(screen.getByTestId('composer-input').getAttribute('placeholder')).toBe('Review recent changes before broad instructions…')
  })

  it('keeps the disabled placeholder above the low-attention hint', () => {
    renderComposer({ disabled: true, humanAttention: attentionTimeline(18, 'absent', 52) })

    expect(screen.getByTestId('composer-input').getAttribute('placeholder')).toBe('waiting for host...')
  })

  it('aligns composer width with the chat content width preference', () => {
    renderComposer({ displayPrefs: { fontSize: 3, contentWidth: 2, sideSpace: 1, lineHeight: 1 } })

    const composer = screen.getByTestId('composer')
    expect(composer.style.getPropertyValue('--ak-chat-content-width')).toBe('104rem')
    expect(composer.querySelector('.ak-chat-container')).toBeTruthy()
  })

  it('shows slash command suggestions for /compact', () => {
    const onCompact = vi.fn()
    renderComposer({ onCompact })

    fireEvent.change(screen.getByTestId('composer-input'), {
      target: { value: '/co' },
    })

    expect(screen.getByTestId('slash-command-menu')).toBeTruthy()
    expect(screen.getByText('/compact')).toBeTruthy()
    expect(screen.getByText('Compact context')).toBeTruthy()
    expect(screen.getByText('Summarize older transcript context for the current session.')).toBeTruthy()
    fireEvent.click(screen.getByText('/compact'))
    expect(onCompact).toHaveBeenCalledTimes(1)
  })

  it('submits /compact as a command instead of a user message', () => {
    const onSubmit = vi.fn()
    const onCompact = vi.fn()
    renderComposer({ onSubmit, onCompact })

    fireEvent.change(screen.getByTestId('composer-input'), {
      target: { value: '/compact' },
    })
    fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Enter' })

    expect(onCompact).toHaveBeenCalledTimes(1)
    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByTestId('composer-input')).toHaveProperty('value', '')
  })

  it('runs /cancel as a command when cancellation is available', () => {
    const onSubmit = vi.fn()
    const onCancel = vi.fn()
    renderComposer({ onSubmit, onCancel })

    fireEvent.change(screen.getByTestId('composer-input'), {
      target: { value: '/can' },
    })

    expect(screen.getByTestId('slash-command-menu')).toBeTruthy()
    expect(screen.getByText('/cancel')).toBeTruthy()
    fireEvent.click(screen.getByText('/cancel'))

    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByTestId('composer-input')).toHaveProperty('value', '')
  })

  it('runs /stop as the stop-turn slash command', () => {
    const onSubmit = vi.fn()
    const onCancel = vi.fn()
    renderComposer({ onSubmit, onCancel })

    fireEvent.change(screen.getByTestId('composer-input'), {
      target: { value: '/stop' },
    })
    fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Enter' })

    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('renames the current session from slash command args', () => {
    const onSubmit = vi.fn()
    const onRenameSession = vi.fn()
    renderComposer({ onSubmit, onRenameSession })

    fireEvent.change(screen.getByTestId('composer-input'), {
      target: { value: '/rename Better label' },
    })
    fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Enter' })

    expect(onRenameSession).toHaveBeenCalledWith('Better label')
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('opens rename UI when /rename has no args and clears labels with --clear', () => {
    const onRenameSession = vi.fn()
    renderComposer({ onRenameSession })

    fireEvent.change(screen.getByTestId('composer-input'), {
      target: { value: '/rename' },
    })
    fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Enter' })
    expect(onRenameSession).toHaveBeenLastCalledWith(null)

    fireEvent.change(screen.getByTestId('composer-input'), {
      target: { value: '/rename --clear' },
    })
    fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Enter' })
    expect(onRenameSession).toHaveBeenLastCalledWith('')
  })

  it('requires an exact /delete command before invoking delete', () => {
    const onSubmit = vi.fn()
    const onDeleteSession = vi.fn()
    renderComposer({ onSubmit, onDeleteSession })

    fireEvent.change(screen.getByTestId('composer-input'), {
      target: { value: '/del' },
    })
    expect(screen.getByTestId('slash-command-menu')).toBeTruthy()
    expect(screen.getByText('/delete')).toBeTruthy()
    fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Enter' })

    expect(onDeleteSession).not.toHaveBeenCalled()
    expect(onSubmit).toHaveBeenCalledWith('/del', 'steer', undefined, undefined)

    fireEvent.change(screen.getByTestId('composer-input'), {
      target: { value: '/delete' },
    })
    fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Enter' })
    expect(onDeleteSession).toHaveBeenCalledTimes(1)
  })

  it('does not run /delete with trailing arguments', async () => {
    const onSubmit = vi.fn()
    const onDeleteSession = vi.fn()
    renderComposer({ onSubmit, onDeleteSession })

    fireEvent.change(screen.getByTestId('composer-input'), {
      target: { value: '/delete now' },
    })
    fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Enter' })

    expect(onDeleteSession).not.toHaveBeenCalled()
    expect(onSubmit).not.toHaveBeenCalled()
    expect((await screen.findByTestId('composer-toast')).textContent).toContain('/delete does not accept extra text.')
  })

  it('uses the send button position for stop only while running with empty input', () => {
    const onSubmit = vi.fn()
    const onCancel = vi.fn()
    renderComposer({
      onSubmit,
      onCancel,
      state: { ...createInitialState({}), status: 'thinking' },
    })

    expect(screen.getByTestId('composer-stop')).toBeTruthy()
    expect(screen.queryByTestId('composer-send')).toBeNull()
    fireEvent.click(screen.getByTestId('composer-stop'))
    expect(onCancel).toHaveBeenCalledTimes(1)

    fireEvent.change(screen.getByTestId('composer-input'), {
      target: { value: 'new instruction' },
    })

    expect(screen.getByTestId('composer-send')).toBeTruthy()
    expect(screen.queryByTestId('composer-stop')).toBeNull()
    fireEvent.click(screen.getByTestId('composer-send'))
    expect(onSubmit).toHaveBeenCalledWith('new instruction', 'steer', undefined, undefined)
  })

  it('runs /clear as a command when fresh-session creation is available', () => {
    const onSubmit = vi.fn()
    const onClearSession = vi.fn()
    renderComposer({ onSubmit, onClearSession })

    fireEvent.change(screen.getByTestId('composer-input'), {
      target: { value: '/cle' },
    })

    expect(screen.getByTestId('slash-command-menu')).toBeTruthy()
    expect(screen.getByText('/clear')).toBeTruthy()
    fireEvent.click(screen.getByText('/clear'))

    expect(onClearSession).toHaveBeenCalledTimes(1)
    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByTestId('composer-input')).toHaveProperty('value', '')
  })

  it('does not render a separate compact button', () => {
    renderComposer()

    expect(screen.queryByTestId('composer-compact')).toBeNull()
  })

  it('submits using the selected send mode', () => {
    const onSubmit = vi.fn()
    renderComposer({ onSubmit })

    fireEvent.click(screen.getByTestId('send-mode-toggle'))
    fireEvent.click(screen.getByTestId('send-mode-queue'))
    fireEvent.change(screen.getByTestId('composer-input'), {
      target: { value: 'later' },
    })
    fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Enter' })

    expect(onSubmit).toHaveBeenCalledWith('later', 'queue', undefined, undefined)
  })

  it('keeps send mode selection available in simple mode', () => {
    const onSubmit = vi.fn()
    const previousMode = window.localStorage.getItem('ak-composer-mode')
    window.localStorage.setItem('ak-composer-mode', 'simple')
    renderComposer({ onSubmit })
    if (previousMode === null) window.localStorage.removeItem('ak-composer-mode')
    else window.localStorage.setItem('ak-composer-mode', previousMode)

    expect(screen.getByTestId('composer-simple-shell')).toBeTruthy()
    fireEvent.click(screen.getByTestId('send-mode-toggle'))
    fireEvent.click(screen.getByTestId('send-mode-queue'))

    const input = screen.getByTestId('composer-input-simple')
    input.textContent = 'later from simple'
    fireEvent.input(input)
    fireEvent.click(screen.getByTestId('composer-send'))

    expect(onSubmit).toHaveBeenCalledWith('later from simple', 'queue', undefined, undefined)
  })

  it('supports slash commands in simple mode', () => {
    const onCompact = vi.fn()
    const previousMode = window.localStorage.getItem('ak-composer-mode')
    window.localStorage.setItem('ak-composer-mode', 'simple')
    renderComposer({ onCompact })
    if (previousMode === null) window.localStorage.removeItem('ak-composer-mode')
    else window.localStorage.setItem('ak-composer-mode', previousMode)

    const input = screen.getByTestId('composer-input-simple')
    input.textContent = '/co'
    fireEvent.input(input)

    expect(screen.getByTestId('slash-command-menu')).toBeTruthy()
    expect(screen.getByText('/compact')).toBeTruthy()
    fireEvent.click(screen.getByText('/compact'))
    expect(onCompact).toHaveBeenCalledTimes(1)
  })

  it('keeps simple mode placeholder visual-only and replaces it on paste', () => {
    const onSubmit = vi.fn()
    const previousMode = window.localStorage.getItem('ak-composer-mode')
    window.localStorage.setItem('ak-composer-mode', 'simple')
    renderComposer({ onSubmit })
    if (previousMode === null) window.localStorage.removeItem('ak-composer-mode')
    else window.localStorage.setItem('ak-composer-mode', previousMode)

    const input = screen.getByTestId('composer-input-simple')
    expect(input.getAttribute('data-placeholder')).toBeTruthy()
    expect(input.getAttribute('data-empty')).toBe('true')
    expect(input.textContent).toBe('')

    fireEvent.paste(input, {
      clipboardData: {
        getData: (type: string) => (type === 'text/plain' ? 'pasted text' : ''),
        items: [],
      },
    })

    expect(input.getAttribute('data-empty')).toBeNull()
    expect(input.textContent).toBe('pasted text')
    fireEvent.click(screen.getByTestId('composer-send'))
    expect(onSubmit).toHaveBeenCalledWith('pasted text', 'steer', undefined, undefined)
  })

  it('keeps context usage next to send in simple mode', () => {
    const previousMode = window.localStorage.getItem('ak-composer-mode')
    window.localStorage.setItem('ak-composer-mode', 'simple')
    renderComposer()
    if (previousMode === null) window.localStorage.removeItem('ak-composer-mode')
    else window.localStorage.setItem('ak-composer-mode', previousMode)

    const shell = screen.getByTestId('composer-simple-shell')
    const indicator = screen.getByTestId('context-usage-indicator')
    const send = screen.getByTestId('composer-send')
    const sendMode = screen.getByTestId('send-mode-toggle')

    expect(shell.contains(indicator)).toBe(true)
    expect(shell.contains(send)).toBe(true)
    expect(indicator.compareDocumentPosition(send) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(indicator.className).toContain('h-9')
    expect(send.className).toContain('h-9')
    expect(sendMode.className).toContain('h-9')

    // The composer-mode toggle is a hover handle, but it must not reserve a
    // standalone row above either composer mode.
    const modeToggle = screen.getByTestId('composer-mode-toggle')
    expect(modeToggle).toBeTruthy()
    expect(modeToggle.className).toContain('absolute')
    expect(modeToggle.className).toContain('-top-2')
    fireEvent.click(sendMode)
    expect(screen.queryByTestId('composer-mode-toggle-menuitem')).toBeNull()
  })

  it('shows queued message management in simple mode', () => {
    const onQueuedDelete = vi.fn()
    const previousMode = window.localStorage.getItem('ak-composer-mode')
    window.localStorage.setItem('ak-composer-mode', 'simple')
    renderComposer({
      onQueuedDelete,
      queuedMessages: [
        {
          id: 'queued-simple-1',
          text: 'run after current turn',
          mode: 'queue',
          createdAt: '2026-07-06T00:00:00.000Z',
        },
      ],
    })
    if (previousMode === null) window.localStorage.removeItem('ak-composer-mode')
    else window.localStorage.setItem('ak-composer-mode', previousMode)

    expect(screen.getByTestId('composer-simple-shell')).toBeTruthy()
    expect(screen.getByTestId('queued-messages-dock').textContent ?? '').toContain('run after current turn')
    fireEvent.click(screen.getByTestId('queued-message-delete'))
    expect(onQueuedDelete).toHaveBeenCalledWith('queued-simple-1')
  })

  it('lets the queued messages dock grow up to three rows before scrolling', () => {
    renderComposer({
      queuedMessages: [
        { id: 'q1', text: 'one queued message', mode: 'queue', createdAt: '2026-07-06T00:00:00.000Z' },
      ],
    })
    expect(screen.getByTestId('queued-messages-scrollarea').className).not.toContain('h-40')

    renderComposer({
      queuedMessages: Array.from({ length: 4 }, (_, index) => ({
        id: `q${index + 1}`,
        text: `queued message ${index + 1}`,
        mode: 'queue' as const,
        createdAt: `2026-07-06T00:00:0${index}.000Z`,
      })),
    })
    const scrollAreas = screen.getAllByTestId('queued-messages-scrollarea')
    expect(scrollAreas.at(-1)?.className ?? '').toContain('h-40')
  })

  it('explains send modes and shows queue previews', () => {
    render(
      <Composer
        model=""
        models={[]}
        onModelChange={() => {}}
        approvalMode="auto"
        onApprovalModeChange={() => {}}
        state={null}
        config={null}
        humanAttention={EMPTY_HUMAN_ATTENTION}
        queuedMessages={[
          {
            id: 'queued-1',
            text: 'run this after the current answer',
            mode: 'queue',
            createdAt: '2026-07-06T00:00:00.000Z',
          },
          {
            id: 'steer-1',
            text: 'prefer the safer path',
            mode: 'steer',
            createdAt: '2026-07-06T00:00:01.000Z',
          },
        ]}
        onSubmit={() => {}}
        onCompact={() => {}}
      />,
    )

    fireEvent.click(screen.getByTestId('send-mode-toggle'))
    expect(screen.getByTestId('send-mode-steer').textContent ?? '').toContain('Steer active turn')
    expect(screen.getByTestId('send-mode-queue').textContent ?? '').toContain('Queue follow-up')
    expect(screen.getByTestId('send-mode-steer').getAttribute('title') ?? '').toContain('current run')
    expect(screen.getByTestId('send-mode-queue').getAttribute('title') ?? '').toContain('FIFO')
    const dock = screen.getByTestId('queued-messages-dock')
    expect(dock.textContent ?? '').toContain('2 Messages in Queue')
    expect(dock.textContent ?? '').toContain('run this after the current answer')
    expect(dock.textContent ?? '').toContain('Queued follow-up')
    expect(dock.textContent ?? '').toContain('Steering update')
  })

  it('allows queued messages to be reordered, edited, and deleted', () => {
    const onQueuedReorder = vi.fn()
    const onQueuedUpdate = vi.fn()
    const onQueuedDelete = vi.fn()
    render(
      <Composer
        model=""
        models={[]}
        onModelChange={() => {}}
        approvalMode="auto"
        onApprovalModeChange={() => {}}
        state={null}
        config={null}
        humanAttention={EMPTY_HUMAN_ATTENTION}
        queuedMessages={[
          { id: 'q1', text: 'first queued', mode: 'queue', createdAt: '2026-07-06T00:00:00.000Z' },
          { id: 'q2', text: 'second queued', mode: 'queue', createdAt: '2026-07-06T00:00:01.000Z' },
        ]}
        onQueuedReorder={onQueuedReorder}
        onQueuedUpdate={onQueuedUpdate}
        onQueuedDelete={onQueuedDelete}
        onSubmit={() => {}}
        onCompact={() => {}}
      />,
    )

    const rows = screen.getAllByTestId('queued-message-row')
    fireEvent.click(screen.getAllByTestId('queued-message-down')[0]!)
    expect(onQueuedReorder).toHaveBeenCalledWith('q1', null)

    fireEvent.dragStart(rows[1]!, { dataTransfer: dataTransferFor('q2') })
    fireEvent.dragOver(rows[0]!, { dataTransfer: dataTransferFor('q2') })
    fireEvent.drop(rows[0]!, { dataTransfer: dataTransferFor('q2') })
    expect(onQueuedReorder).toHaveBeenCalledWith('q2', 'q1')

    fireEvent.click(screen.getAllByTestId('queued-message-edit')[0]!)
    const input = screen.getByTestId('queued-message-edit-input')
    fireEvent.change(input, { target: { value: 'edited queued' } })
    fireEvent.click(screen.getByTestId('queued-message-save'))
    expect(onQueuedUpdate).toHaveBeenCalledWith('q1', 'edited queued')

    fireEvent.click(screen.getAllByTestId('queued-message-delete')[1]!)
    expect(onQueuedDelete).toHaveBeenCalledWith('q2')
  })

  it('renders the approval mode picker and reports selection', () => {
    const onApprovalModeChange = vi.fn()
    render(
      <Composer
        model=""
        models={[]}
        onModelChange={() => {}}
        approvalMode="auto"
        onApprovalModeChange={onApprovalModeChange}
        state={null}
        config={null}
        humanAttention={EMPTY_HUMAN_ATTENTION}
        queuedMessages={[]}
        onSubmit={() => {}}
        onCompact={() => {}}
      />,
    )
    const picker = screen.getByTestId('approval-mode-picker')
    expect(picker).toBeTruthy()
    expect(picker.textContent ?? '').toContain('Auto')
    expect(picker.textContent ?? '').not.toContain('ask only for tools marked unsafe')
  })

  it('keeps model and approval picker labels hidden below desktop width', () => {
    render(
      <Composer
        model="claude-opus"
        models={[{ id: 'claude-opus', label: 'Claude Opus', provider: 'Anthropic', providerId: 'anthropic' }]}
        onModelChange={() => {}}
        approvalMode="auto"
        onApprovalModeChange={() => {}}
        state={null}
        config={null}
        humanAttention={EMPTY_HUMAN_ATTENTION}
        queuedMessages={[]}
        onSubmit={() => {}}
        onCompact={() => {}}
      />,
    )
    expect(screen.getByTestId('model-picker').className).toContain('md:w-24')
    expect(screen.getByTestId('approval-mode-picker').className).toContain('md:w-16')
  })

  it('keeps allow all danger copy out of the compact approval picker label', () => {
    render(
      <Composer
        model=""
        models={[]}
        onModelChange={() => {}}
        approvalMode="allow_all"
        onApprovalModeChange={() => {}}
        state={null}
        config={null}
        humanAttention={EMPTY_HUMAN_ATTENTION}
        queuedMessages={[]}
        onSubmit={() => {}}
        onCompact={() => {}}
      />,
    )

    const picker = screen.getByTestId('approval-mode-picker')
    expect(picker.textContent ?? '').toContain('Allow all')
    expect(picker.textContent ?? '').not.toContain('danger')
  })

  it('attaches pasted image as an image content block on submit', async () => {
    const onSubmit = vi.fn()
    renderComposer({ onSubmit })

    const file = new File([new Uint8Array([0, 1, 2])], 'pasted.png', { type: 'image/png' })
    const clipboardData = {
      items: [
        {
          kind: 'file' as const,
          type: 'image/png',
          getAsFile: () => file,
        },
      ],
    }
    fireEvent.paste(screen.getByTestId('composer-input'), { clipboardData })

    const tray = await screen.findByTestId('pasted-image-tray')
    expect(tray).toBeTruthy()
    expect((screen.getByTestId('composer-send') as HTMLButtonElement).disabled).toBe(false)

    fireEvent.change(screen.getByTestId('composer-input'), {
      target: { value: 'look at this' },
    })
    fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Enter' })

    expect(onSubmit).toHaveBeenCalledTimes(1)
    const [text, mode, images] = onSubmit.mock.calls[0] as [
      string,
      'steer' | 'queue',
      readonly ImageContent[] | undefined,
    ]
    expect(text).toBe('look at this')
    expect(mode).toBe('steer')
    expect(images).toBeDefined()
    expect(images).toHaveLength(1)
    expect(images?.[0]?.type).toBe('image')
    expect(images?.[0]?.source.kind).toBe('base64')
    if (images?.[0]?.source.kind === 'base64') {
      expect(images[0].source.mediaType).toBe('image/png')
      expect(images[0].source.data.length).toBeGreaterThan(0)
    }
    expect(screen.queryByTestId('pasted-image-tray')).toBeNull()
  })

  it('removes a pasted image when the close button is clicked', async () => {
    renderComposer()
    const file = new File([new Uint8Array([0])], 'pic.png', { type: 'image/png' })
    fireEvent.paste(screen.getByTestId('composer-input'), {
      clipboardData: {
        items: [{ kind: 'file' as const, type: 'image/png', getAsFile: () => file }],
      },
    })
    const tray = await screen.findByTestId('pasted-image-tray')
    const removeBtn = tray.querySelector('[data-testid^="pasted-image-remove-"]')
    expect(removeBtn).toBeTruthy()
    fireEvent.click(removeBtn as Element)
    expect(screen.queryByTestId('pasted-image-tray')).toBeNull()
  })

  it('opens the mention picker when the user types @ and inserts the picked path', async () => {
    const onListFiles = vi.fn().mockResolvedValue([
      { path: 'packages/host/src/server.ts', size: 0 },
      { path: 'packages/kernel/src/core.ts', size: 0 },
    ] as readonly FileListEntry[])
    renderComposer({ onListFiles })

    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: 'look at @host' } })
    input.selectionStart = 'look at @host'.length
    fireEvent.select(input)

    await waitFor(() => expect(onListFiles).toHaveBeenCalled())
    const list = await screen.findByTestId('mention-list')
    expect(list.textContent ?? '').toContain('packages/host/src/server.ts')
    expect(screen.getByTestId('mention-match-highlight').textContent).toBe('host')

    fireEvent.click(screen.getByTestId('mention-option-0'))
    expect(input.value).toContain('@packages/host/src/server.ts')
    expect(screen.queryByTestId('mention-menu')).toBeNull()
  })

  it('inlines the referenced file contents on submit and drops the mention block on error', async () => {
    const onSubmit = vi.fn()
    const onListFiles = vi.fn().mockResolvedValue([
      { path: 'a.ts', size: 0 },
      { path: 'b.ts', size: 0 },
    ] as readonly FileListEntry[])
    const onReadFile = vi.fn(async (path: string) => {
      if (path === 'a.ts') return { content: 'export const A = 1' }
      return { error: 'EFBIG: too large' }
    })
    renderComposer({ onSubmit, onListFiles, onReadFile })

    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement
    fireEvent.change(input, {
      target: { value: 'diff @a.ts and @b.ts please' },
    })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    const [text, mode, images, extras] = onSubmit.mock.calls[0] as [
      string,
      'steer' | 'queue',
      readonly ImageContent[] | undefined,
      readonly TextContent[] | undefined,
    ]
    expect(text).toBe('diff @a.ts and @b.ts please')
    expect(mode).toBe('steer')
    expect(images).toBeUndefined()
    expect(extras).toBeDefined()
    expect(extras).toHaveLength(1)
    expect(extras?.[0]?.text).toContain('--- a.ts ---')
    expect(extras?.[0]?.text).toContain('export const A = 1')
    expect(onReadFile).toHaveBeenCalledWith('a.ts')
    expect(onReadFile).toHaveBeenCalledWith('b.ts')
    await screen.findByTestId('composer-toast')
  })
})

function dataTransferFor(id: string): DataTransfer {
  return {
    effectAllowed: 'move',
    dropEffect: 'move',
    getData: vi.fn(() => id),
    setData: vi.fn(),
  } as unknown as DataTransfer
}

function attentionTimeline(score: number, level: NonNullable<HumanAttentionTimeline['latest']>['level'], riskExposure: number): HumanAttentionTimeline {
  const latest: NonNullable<HumanAttentionTimeline['latest']> = {
    sessionId: 's1',
    messageCursor: 7,
    score,
    level,
    confidence: 0.72,
    dimensions: {
      inputQuality: 24,
      reviewDepth: 18,
      correctionQuality: 12,
      riskAwareness: 20,
      continuity: 30,
      riskExposure,
    },
    reasons: [
      {
        kind: 'high_risk_action',
        severity: 'warning',
        message: 'Recent changes need review.',
      },
    ],
    evaluatedAt: '2026-07-23T00:00:00.000Z',
    evaluator: 'heuristic',
  }
  return { sessionId: 's1', points: [latest], latest }
}
