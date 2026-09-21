import { createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { createInitialState, type FileContent, type ImageContent, type ReferencedFileContent, type TextContent } from '@agent-kernel/kernel'
import type { FileListEntry, HumanAttentionTimeline } from '@agent-kernel/shared'

import { Composer } from './Composer.js'
import type { ChatDisplayPrefs } from './chatDisplayPrefs.js'

const EMPTY_HUMAN_ATTENTION = { sessionId: '', points: [], latest: null } as const

function renderComposer(props?: {
  onSubmit?: (
    text: string,
    mode: 'steer' | 'queue',
    attachments?: readonly (ImageContent | FileContent)[],
    extraBlocks?: readonly TextContent[],
  ) => void
  onUploadFiles?: (files: readonly File[]) => Promise<readonly ReferencedFileContent[]>
  onReleaseFiles?: (files: readonly ReferencedFileContent[]) => Promise<void>
  onCompact?: () => void
  onCancel?: () => void
  onClearSession?: () => void
  onRenameSession?: (label: string | null) => void
  onDeleteSession?: () => void
  onListFiles?: (query: string) => Promise<readonly FileListEntry[]>
  onReadFile?: (path: string) => Promise<{ content?: string; error?: string }>
  queuedMessages?: React.ComponentProps<typeof Composer>['queuedMessages']
  onQueuedDelete?: (id: string) => void
  onQueuedUpdate?: (id: string, text: string) => void
  state?: React.ComponentProps<typeof Composer>['state']
  disabled?: boolean
  serviceUnavailable?: boolean
  workspaceUnavailable?: boolean
  onReconnectService?: () => void
  humanAttention?: React.ComponentProps<typeof Composer>['humanAttention']
  displayPrefs?: ChatDisplayPrefs
  awaitingAck?: boolean
  approvalMode?: React.ComponentProps<typeof Composer>['approvalMode']
  onApprovalModeChange?: React.ComponentProps<typeof Composer>['onApprovalModeChange']
  footerExtras?: React.ReactNode
  simpleFooterExtras?: React.ReactNode
}) {
  return render(
    <Composer
      model=""
      models={[]}
      onModelChange={() => {}}
      approvalMode={props?.approvalMode ?? 'auto'}
      onApprovalModeChange={props?.onApprovalModeChange ?? (() => {})}
      state={props?.state ?? null}
      config={null}
      humanAttention={props?.humanAttention ?? EMPTY_HUMAN_ATTENTION}
      queuedMessages={props?.queuedMessages ?? []}
      displayPrefs={props?.displayPrefs}
      disabled={props?.disabled}
      serviceUnavailable={props?.serviceUnavailable}
      workspaceUnavailable={props?.workspaceUnavailable}
      onReconnectService={props?.onReconnectService}
      {...(props?.onQueuedDelete ? { onQueuedDelete: props.onQueuedDelete } : {})}
      {...(props?.onQueuedUpdate ? { onQueuedUpdate: props.onQueuedUpdate } : {})}
      onSubmit={props?.onSubmit ?? (() => {})}
      {...(props?.onUploadFiles ? { onUploadFiles: props.onUploadFiles } : {})}
      {...(props?.onReleaseFiles ? { onReleaseFiles: props.onReleaseFiles } : {})}
      onCompact={props?.onCompact ?? (() => {})}
      {...(props?.onCancel ? { onCancel: props.onCancel } : {})}
      {...(props?.onClearSession ? { onClearSession: props.onClearSession } : {})}
      {...(props?.onRenameSession ? { onRenameSession: props.onRenameSession } : {})}
      {...(props?.onDeleteSession ? { onDeleteSession: props.onDeleteSession } : {})}
      {...(props?.onListFiles ? { onListFiles: props.onListFiles } : {})}
      {...(props?.onReadFile ? { onReadFile: props.onReadFile } : {})}
      awaitingAck={props?.awaitingAck}
      footerExtras={props?.footerExtras}
      simpleFooterExtras={props?.simpleFooterExtras}
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

  it('replaces the unavailable Composer with one compact recoverable Service state', () => {
    const reconnect = vi.fn()
    renderComposer({ disabled: true, serviceUnavailable: true, onReconnectService: reconnect })
    const connectionState = screen.getByTestId('service-connection-state')
    expect(connectionState.textContent).toContain('Connecting to service')
    expect(connectionState.textContent).not.toContain('Restoring the realtime connection')
    expect(Array.from(connectionState.querySelectorAll('span')).some((node) => node.className.includes('motion-safe:animate-ping'))).toBe(true)
    expect(screen.queryByTestId('composer')).toBeNull()
    expect(screen.queryByTestId('composer-input')).toBeNull()
    expect(screen.queryByTestId('composer-input-simple')).toBeNull()
    expect(screen.queryByTestId('composer-config-trigger')).toBeNull()
    expect(screen.queryByTestId('composer-send')).toBeNull()
    expect(screen.queryByTestId('context-usage-bar')).toBeNull()
    fireEvent.click(screen.getByTestId('service-reconnect'))
    expect(reconnect).toHaveBeenCalledOnce()
  })

  it('distinguishes an offline Workspace Executor from an unavailable Service', () => {
    renderComposer({ disabled: true, workspaceUnavailable: true })
    expect(screen.getByPlaceholderText('workspace executor is offline...')).toBeTruthy()
    expect(screen.queryByTestId('service-connection-state')).toBeNull()
  })

  it('uses the low-attention hint as the empty input placeholder', () => {
    renderComposer({ humanAttention: attentionTimeline(18, 'absent', 52) })

    expect(screen.getByTestId('composer-input').getAttribute('placeholder')).toBe('Review recent changes before broad instructions…')
  })

  it('keeps the disabled placeholder above the low-attention hint', () => {
    renderComposer({ disabled: true, humanAttention: attentionTimeline(18, 'absent', 52) })

    expect(screen.getByTestId('composer-input').getAttribute('placeholder')).toBe('waiting for service...')
  })

  it('aligns composer width with the chat content width preference', () => {
    renderComposer({ displayPrefs: { fontSize: 3, contentWidth: 2, sideSpace: 1, lineHeight: 1 } })

    const composer = screen.getByTestId('composer')
    expect(composer.style.getPropertyValue('--ak-chat-content-width')).toBe('104rem')
    expect(composer.querySelector('.ak-composer-container')).toBeTruthy()
    expect(composer.className).toContain('bg-transparent')
    expect(composer.className).not.toContain('px-2')
    expect(composer.className).not.toContain('sm:px-3')
    expect(composer.className).not.toContain('lg:px-4')
    expect(composer.className).not.toContain('bg-card')
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

  it('clears the submitted draft before the reliable acknowledgement resolves', () => {
    const onSubmit = vi.fn(() => new Promise<void>(() => {}))
    renderComposer({ onSubmit })

    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: 'sent now' } })
    fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Enter' })

    expect(onSubmit).toHaveBeenCalledWith('sent now', 'steer', undefined, undefined)
    expect(screen.getByTestId('composer-input')).toHaveProperty('value', '')
  })

  it('restores the draft and surfaces an error when reliable submit fails', async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error('message acknowledgement timed out'))
    renderComposer({ onSubmit })

    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: 'keep this draft' } })
    fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Enter' })

    await screen.findByText('message acknowledgement timed out')
    expect(screen.getByTestId('composer-input')).toHaveProperty('value', 'keep this draft')
  })

  it('does not overwrite a new draft when a previous send acknowledgement fails', async () => {
    let rejectSubmit: ((error: Error) => void) | undefined
    const onSubmit = vi.fn(() => new Promise<void>((_, reject) => { rejectSubmit = reject }))
    renderComposer({ onSubmit })

    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: 'first draft' } })
    fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Enter' })
    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: 'new draft' } })
    rejectSubmit?.(new Error('ack failed'))

    await screen.findByText('ack failed')
    expect(screen.getByTestId('composer-input')).toHaveProperty('value', 'new draft')
  })

  it('offers working send mode selection in simple mode', () => {
    const onSubmit = vi.fn()
    const previousMode = window.localStorage.getItem('ak-composer-mode')
    window.localStorage.setItem('ak-composer-mode', 'simple')
    try {
      renderComposer({ onSubmit })
      fireEvent.click(screen.getByTestId('send-mode-toggle'))
      fireEvent.click(screen.getByTestId('send-mode-queue'))
      fireEvent.click(screen.getByTestId('send-mode-toggle'))
      expect(screen.getByTestId('send-mode-queue').getAttribute('aria-selected')).toBe('true')
      fireEvent.click(screen.getByTestId('send-mode-toggle'))
      const input = screen.getByTestId('composer-input-simple')
      input.textContent = 'follow up'
      fireEvent.input(input)
      fireEvent.click(screen.getByTestId('composer-send'))
      expect(onSubmit).toHaveBeenCalledWith('follow up', 'queue', undefined, undefined)
    } finally {
      if (previousMode === null) window.localStorage.removeItem('ak-composer-mode')
      else window.localStorage.setItem('ak-composer-mode', previousMode)
    }
  })

  it('accepts the first keystroke after a running send clears the simple editor', () => {
    const onSubmit = vi.fn(() => new Promise<void>(() => {}))
    window.localStorage.setItem('ak-composer-mode', 'simple')
    renderComposer({ onSubmit, state: { ...createInitialState({ sessionId: 'running-simple' }), status: 'thinking' } })
    const input = screen.getByTestId('composer-input-simple')
    input.textContent = 'first message'
    fireEvent.input(input)
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSubmit).toHaveBeenCalledWith('first message', 'steer', undefined, undefined)
    expect(input.textContent).toBe('')
    input.textContent = 'n'
    fireEvent.input(input)
    expect(input.textContent).toBe('n')
  })

  it('focuses the mobile simple composer without scrolling the viewport', () => {
    const previousMode = window.localStorage.getItem('ak-composer-mode')
    window.localStorage.setItem('ak-composer-mode', 'simple')
    renderComposer()
    if (previousMode === null) window.localStorage.removeItem('ak-composer-mode')
    else window.localStorage.setItem('ak-composer-mode', previousMode)

    const input = screen.getByTestId('composer-input-simple') as HTMLDivElement
    const focus = vi.spyOn(input, 'focus')
    fireEvent.pointerDown(input, { pointerType: 'touch' })

    expect(focus).toHaveBeenCalledWith({ preventScroll: true })
  })

  it('exposes a mobile simple-to-full mode control', () => {
    const previousMode = window.localStorage.getItem('ak-composer-mode')
    window.localStorage.setItem('ak-composer-mode', 'simple')
    renderComposer()
    if (previousMode === null) window.localStorage.removeItem('ak-composer-mode')
    else window.localStorage.setItem('ak-composer-mode', previousMode)

    fireEvent.click(screen.getByTestId('composer-mode-toggle'))
    expect(screen.getByTestId('composer-input')).toBeTruthy()
  })

  it('preserves the simple draft while switching to full mode', () => {
    const previousMode = window.localStorage.getItem('ak-composer-mode')
    window.localStorage.setItem('ak-composer-mode', 'simple')
    renderComposer()
    if (previousMode === null) window.localStorage.removeItem('ak-composer-mode')
    else window.localStorage.setItem('ak-composer-mode', previousMode)

    const simpleInput = screen.getByTestId('composer-input-simple')
    simpleInput.textContent = 'draft survives the density switch'
    fireEvent.input(simpleInput)
    fireEvent.click(screen.getByTestId('composer-mode-toggle'))

    expect(screen.getByTestId('composer-input')).toHaveProperty('value', 'draft survives the density switch')
    expect(screen.getByTestId('composer-full-shell').className).not.toContain('gap-0')
    const fullToggle = screen.getByTestId('composer-mode-toggle')
    expect(screen.getByTestId('composer-footer').contains(fullToggle)).toBe(true)
    expect(fullToggle.className).toContain('bg-transparent')
  })

  it('keeps the standard composer footer on one mobile row', () => {
    renderComposer({
      state: createInitialState({ sessionId: 'mobile-standard', systemPrompt: 'sys' }),
    })

    const footer = screen.getByTestId('composer-footer')
    const rail = screen.getByTestId('composer-footer-rail')
    const actions = screen.getByTestId('composer-footer-actions')

    expect(footer.className).toContain('flex-nowrap')
    expect(footer.className).not.toContain('flex-wrap')
    expect(footer.className).toContain('overflow-hidden')
    expect(rail.className).toContain('overflow-x-auto')
    expect(rail.className).toContain('flex-nowrap')
    expect(actions.className).toContain('flex-none')
    expect(rail.contains(screen.getByTestId('composer-mode-toggle'))).toBe(true)
    expect(actions.contains(screen.getByTestId('composer-send'))).toBe(true)
  })

  it('renders only the simple Task Graph accessory beside Attach', () => {
    const previousMode = window.localStorage.getItem('ak-composer-mode')
    window.localStorage.setItem('ak-composer-mode', 'simple')
    renderComposer({
      footerExtras: <button data-testid="shell-trigger">Shell</button>,
      simpleFooterExtras: <button data-testid="task-graph-trigger">Graph</button>,
    })
    if (previousMode === null) window.localStorage.removeItem('ak-composer-mode')
    else window.localStorage.setItem('ak-composer-mode', previousMode)

    const extras = screen.getByTestId('composer-simple-footer-extras')
    const attachment = screen.getByTestId('composer-attach-file')
    const graph = screen.getByTestId('task-graph-trigger')
    expect(extras.contains(attachment)).toBe(true)
    expect(extras.contains(graph)).toBe(true)
    expect(attachment.compareDocumentPosition(graph) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.queryByTestId('shell-trigger')).toBeNull()
    expect(screen.queryByTestId('human-attention-indicator')).toBeNull()
    expect(screen.getByTestId('composer-simple-shell').contains(extras)).toBe(true)
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

  it('keeps simple mode placeholder visual-only and replaces it on paste', async () => {
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

    await waitFor(() => expect(input.textContent).toBe('pasted text'))
    expect(input.getAttribute('data-empty')).toBeNull()
    fireEvent.click(screen.getByTestId('composer-send'))
    expect(onSubmit).toHaveBeenCalledWith('pasted text', 'steer', undefined, undefined)
  })

  it('uses the midpoint between the iOS safe area and compact bottom padding', () => {
    renderComposer()
    const composer = screen.getByTestId('composer')
    expect(composer.className).toContain('pb-[calc(env(safe-area-inset-bottom)/2+0.125rem)]')
    expect(composer.className).not.toContain('max(env(safe-area-inset-bottom)')
  })

  it('places one usage bar above the simple input instead of an inline indicator', () => {
    const previousMode = window.localStorage.getItem('ak-composer-mode')
    window.localStorage.setItem('ak-composer-mode', 'simple')
    renderComposer()
    if (previousMode === null) window.localStorage.removeItem('ak-composer-mode')
    else window.localStorage.setItem('ak-composer-mode', previousMode)

    const shell = screen.getByTestId('composer-simple-shell')
    const frame = screen.getByTestId('composer-simple-frame')
    const indicator = screen.getByTestId('context-usage-bar')
    const send = screen.getByTestId('composer-send')

    expect(shell.contains(indicator)).toBe(true)
    expect(frame.contains(indicator)).toBe(true)
    expect(shell.contains(send)).toBe(true)
    expect(shell.contains(screen.getByTestId('composer-config-trigger'))).toBe(true)
    expect(indicator.className).toContain('absolute')
    expect(screen.queryByTestId('context-usage-indicator')).toBeNull()
    expect(indicator.className).toContain('-inset-x-px')
    expect(indicator.className).toContain('h-5')
    expect(indicator.className).toContain('rounded-t-[22px]')
    expect(send.className).toContain('h-11')
    expect(screen.getByTestId('send-mode-toggle')).toBeTruthy()

    // The mode switch is a quiet control inside the shared Composer surface,
    // not a bordered segment that makes the capsule visually heavier.
    const modeToggle = screen.getByTestId('composer-mode-toggle')
    expect(modeToggle).toBeTruthy()
    expect(modeToggle.className).not.toContain('absolute')
    expect(modeToggle.className).toContain('h-11')
    expect(modeToggle.className).toContain('w-10')
    expect(modeToggle.className).toContain('bg-transparent')
    expect(modeToggle.className).toContain('border-0')
    expect(modeToggle.querySelector('svg')).toBeTruthy()
    expect(shell.contains(modeToggle)).toBe(true)
    expect(modeToggle.compareDocumentPosition(shell.querySelector('textarea, [contenteditable="true"]') ?? indicator) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.queryByTestId('composer-mode-toggle-menuitem')).toBeNull()
  })

  it('keeps simple accessories on one row when multiline and keeps Send separate', () => {
    const previousMode = window.localStorage.getItem('ak-composer-mode')
    window.localStorage.setItem('ak-composer-mode', 'simple')
    try {
      renderComposer({
        footerExtras: <button type="button" data-testid="hidden-shell-tool">Shell tool</button>,
        simpleFooterExtras: <button type="button">Graph tool</button>,
      })

      const shell = screen.getByTestId('composer-simple-shell')
      const tools = screen.getByTestId('composer-simple-footer-extras')
      const sendColumn = screen.getByTestId('composer-simple-send-column')
      expect(shell.getAttribute('data-layout')).toBe('single-row-tools')
      expect(tools.getAttribute('data-layout')).toBe('horizontal')
      expect(tools.className).toContain('flex-row')
      expect(sendColumn.contains(screen.getByTestId('composer-send'))).toBe(true)
      expect(tools.contains(screen.getByTestId('composer-send'))).toBe(false)

      const input = screen.getByTestId('composer-input-simple')
      input.textContent = 'first line\nsecond line'
      fireEvent.input(input)

      expect(shell.getAttribute('data-layout')).toBe('single-row-tools')
      expect(tools.getAttribute('data-layout')).toBe('horizontal')
      expect(tools.className).toContain('flex-row')
      expect(tools.className).not.toContain('flex-col')
      expect(screen.queryByTestId('hidden-shell-tool')).toBeNull()
      expect(sendColumn.contains(screen.getByTestId('composer-send'))).toBe(true)
    } finally {
      if (previousMode === null) window.localStorage.removeItem('ak-composer-mode')
      else window.localStorage.setItem('ak-composer-mode', previousMode)
    }
  })

  it('shows compact image tokens and preserves attachments while editing queued messages', () => {
    const onQueuedUpdate = vi.fn()
    const queuedWithImages = [{
        id: 'queued-image',
        text: 'review this',
        mode: 'queue',
        createdAt: '2026-07-06T00:00:00.000Z',
        content: [
          { type: 'text', text: 'review this' },
          { type: 'image', source: { kind: 'base64', mediaType: 'image/png', data: 'base64-a' } },
          { type: 'image', source: { kind: 'base64', mediaType: 'image/jpeg', data: 'base64-b' } },
        ],
      }]
    renderComposer({ onQueuedUpdate, queuedMessages: queuedWithImages })

    expect(screen.getByText('review this [Image #1] [Image #2]')).toBeTruthy()
    expect(screen.queryByRole('img')).toBeNull()
    fireEvent.click(screen.getByTestId('queued-message-edit'))
    expect(screen.getByTestId('queued-message-edit-attachments').textContent).toBe('[Image #1] [Image #2]')
    fireEvent.change(screen.getByTestId('queued-message-edit-input'), { target: { value: 'updated text' } })
    fireEvent.click(screen.getByTestId('queued-message-save'))
    expect(onQueuedUpdate).toHaveBeenCalledWith('queued-image', 'updated text', queuedWithImages[0]!.content)
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

  it('allows queued messages to be reordered, edited, and deleted', async () => {
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
    expect(onQueuedUpdate).toHaveBeenCalledWith('q1', 'edited queued', undefined)
    await waitFor(() => expect(screen.queryByTestId('queued-message-edit-input')).toBeNull())

    fireEvent.click(screen.getAllByTestId('queued-message-delete')[1]!)
    expect(onQueuedDelete).toHaveBeenCalledWith('q2')
  })

  it('uses commercial-size text, shell height, and touch targets in both composer modes', () => {
    const previousMode = window.localStorage.getItem('ak-composer-mode')
    window.localStorage.setItem('ak-composer-mode', 'simple')
    const { unmount } = renderComposer()
    expect(screen.getByTestId('composer-simple-shell').className).toContain('min-h-14')
    expect(screen.getByTestId('composer-input-simple').className).toContain('text-[1.125rem]')
    expect(screen.getByTestId('composer-input-simple').className).not.toContain('sm:text-base')
    expect(screen.getByTestId('composer-input-simple').className).toContain('min-h-12')
    expect(screen.getByTestId('composer-mode-toggle').className).toContain('h-11')
    expect(screen.getByTestId('composer-send').className).toContain('h-11')
    expect(screen.getByTestId('send-mode-toggle')).toBeTruthy()
    unmount()

    window.localStorage.setItem('ak-composer-mode', 'full')
    renderComposer()
    expect(screen.getByTestId('composer-input').className).toContain('min-h-14')
    expect(screen.getByTestId('composer-input').className).toContain('text-[1.125rem]')
    expect(screen.getByTestId('composer-input').className).not.toContain('sm:text-base')
    expect(screen.getByTestId('composer-input').className).not.toContain('sm:text-sm')
    if (previousMode === null) window.localStorage.removeItem('ak-composer-mode')
    else window.localStorage.setItem('ak-composer-mode', previousMode)
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

  it('changes approval mode through the mobile-native config control', () => {
    const onApprovalModeChange = vi.fn()
    const previousMode = window.localStorage.getItem('ak-composer-mode')
    window.localStorage.setItem('ak-composer-mode', 'simple')
    renderComposer({ approvalMode: 'auto', onApprovalModeChange })
    if (previousMode === null) window.localStorage.removeItem('ak-composer-mode')
    else window.localStorage.setItem('ak-composer-mode', previousMode)

    fireEvent.click(screen.getByTestId('composer-config-trigger'))
    const nativeApproval = screen.getByTestId('composer-config-approval-native')
    expect(nativeApproval.className).toContain('sm:hidden')
    fireEvent.change(nativeApproval, { target: { value: 'ask' } })
    expect(onApprovalModeChange).toHaveBeenCalledWith('ask')
  })

  it('does not dismiss config when a desktop select portal receives mousedown', async () => {
    const previousMode = window.localStorage.getItem('ak-composer-mode')
    window.localStorage.setItem('ak-composer-mode', 'simple')
    renderComposer({ approvalMode: 'auto' })
    if (previousMode === null) window.localStorage.removeItem('ak-composer-mode')
    else window.localStorage.setItem('ak-composer-mode', previousMode)

    fireEvent.click(screen.getByTestId('composer-config-trigger'))
    const config = screen.getByTestId('composer-config-popover')
    const desktopApproval = within(config).getAllByRole('combobox', { name: /approval mode/i })[1]!
    fireEvent.keyDown(desktopApproval, { key: 'ArrowDown' })
    const option = await screen.findByRole('option', { name: /^Ask everything/i })
    expect(option.closest('[data-composer-config-select="approval"]')).toBeTruthy()
    fireEvent.mouseDown(option)
    expect(screen.getByTestId('composer-config-popover')).toBeTruthy()
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

  it('uploads a pasted image as a durable Host reference before submit', async () => {
    const onSubmit = vi.fn()
    const imageReference: ReferencedFileContent = {
      type: 'file', name: 'pasted-image-1.png', mediaType: 'image/png',
      source: { kind: 'host_ref', attachmentId: '00000000-0000-4000-8000-000000000001', sha256: 'a'.repeat(64), bytes: 8 },
    }
    const onUploadFiles = vi.fn(async () => [imageReference])
    renderComposer({ onSubmit, onUploadFiles })

    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], 'pasted.png', { type: 'image/png' })
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

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onUploadFiles).toHaveBeenCalledTimes(1)
    const uploaded = onUploadFiles.mock.calls[0]?.[0]
    expect(uploaded).toHaveLength(1)
    expect(uploaded?.[0]?.type).toBe('image/png')
    expect(uploaded?.[0]?.size).toBe(8)
    const [text, mode, attachments] = onSubmit.mock.calls[0] as [
      string,
      'steer' | 'queue',
      readonly (ImageContent | FileContent)[] | undefined,
    ]
    expect(text).toBe('look at this')
    expect(mode).toBe('steer')
    expect(attachments).toEqual([imageReference])
    await waitFor(() => expect(screen.queryByTestId('pasted-image-tray')).toBeNull())
  })

  it('accepts WebKit clipboard images exposed only through clipboardData.files', async () => {
    renderComposer()
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], 'webkit.png', { type: 'image/png' })
    fireEvent.paste(screen.getByTestId('composer-input'), { clipboardData: { items: [], files: [file] } })
    expect(await screen.findByTestId('pasted-image-tray')).toBeTruthy()
  })

  it('uses the native Desktop image clipboard when WebKit exposes no file representation', async () => {
    const readClipboardImage = vi.fn(async () => 'data:image/png;base64,iVBORw0KGgo=')
    Object.defineProperty(window, '__RUNLAB_DESKTOP__', { value: true, configurable: true })
    Object.defineProperty(window, '__RUNLAB_DESKTOP_BRIDGE__', {
      value: {
        version: 1,
        getInfo: async () => ({ version: 'test', focused: true, visible: true }),
        setActivity: async () => {},
        notify: async () => {},
        subscribe: () => () => {},
        readClipboardImage,
      },
      configurable: true,
    })
    try {
      renderComposer()
      const input = screen.getByTestId('composer-input')
      const event = createEvent.paste(input, {
        clipboardData: { items: [], files: [], getData: () => 'clipboard URI that must not be inserted' },
      })
      fireEvent(input, event)
      expect(event.defaultPrevented).toBe(true)
      expect(await screen.findByTestId('pasted-image-tray')).toBeTruthy()
      expect((input as HTMLTextAreaElement).value).toBe('')
      expect(readClipboardImage).toHaveBeenCalledOnce()
    } finally {
      delete (window as Window & { __RUNLAB_DESKTOP__?: boolean }).__RUNLAB_DESKTOP__
      delete (window as Window & { __RUNLAB_DESKTOP_BRIDGE__?: unknown }).__RUNLAB_DESKTOP_BRIDGE__
    }
  })

  it('restores plain text when the Desktop native clipboard contains no image', async () => {
    const readClipboardImage = vi.fn(async () => null)
    Object.defineProperty(window, '__RUNLAB_DESKTOP__', { value: true, configurable: true })
    Object.defineProperty(window, '__RUNLAB_DESKTOP_BRIDGE__', {
      value: {
        version: 1,
        getInfo: async () => ({ version: 'test', focused: true, visible: true }),
        setActivity: async () => {}, notify: async () => {}, subscribe: () => () => {}, readClipboardImage,
      },
      configurable: true,
    })
    try {
      renderComposer()
      const input = screen.getByTestId('composer-input')
      const event = createEvent.paste(input, {
        clipboardData: { items: [], files: [], getData: () => 'ordinary pasted text' },
      })
      fireEvent(input, event)
      expect(event.defaultPrevented).toBe(true)
      await waitFor(() => expect((input as HTMLTextAreaElement).value).toBe('ordinary pasted text'))
      expect(readClipboardImage).toHaveBeenCalledOnce()
    } finally {
      delete (window as Window & { __RUNLAB_DESKTOP__?: boolean }).__RUNLAB_DESKTOP__
      delete (window as Window & { __RUNLAB_DESKTOP_BRIDGE__?: unknown }).__RUNLAB_DESKTOP_BRIDGE__
    }
  })

  it('selects, previews, removes, and submits generic file attachments', async () => {
    const onSubmit = vi.fn()
    const reference: ReferencedFileContent = {
      type: 'file',
      name: 'answer.ts',
      mediaType: 'text/typescript',
      source: {
        kind: 'host_ref',
        attachmentId: '00000000-0000-4000-8000-000000000000',
        sha256: 'a'.repeat(64),
        bytes: 25,
      },
    }
    const onUploadFiles = vi.fn(async () => [reference])
    renderComposer({ onSubmit, onUploadFiles })
    const file = new File(['export const answer = 42\n'], 'answer.ts', { type: 'text/typescript' })

    fireEvent.change(screen.getByTestId('composer-file-input'), {
      target: { files: [file] },
    })

    const tray = await screen.findByTestId('attachment-tray')
    expect(tray.textContent).toContain('answer.ts')
    expect(tray.textContent).toContain('text/typescript')
    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: 'review this file' } })
    fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Enter' })

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onUploadFiles).toHaveBeenCalledWith([file])
    const attachments = onSubmit.mock.calls[0]?.[2] as readonly (ImageContent | FileContent)[]
    expect(attachments).toEqual([reference])
    expect(screen.queryByTestId('attachment-tray')).toBeNull()

    fireEvent.change(screen.getByTestId('composer-file-input'), {
      target: { files: [file] },
    })
    const secondTray = await screen.findByTestId('attachment-tray')
    fireEvent.click(secondTray.querySelector('[data-testid^="attached-file-remove-"]') as Element)
    expect(screen.queryByTestId('attachment-tray')).toBeNull()
  })

  it('releases uploaded file references when message admission is rejected', async () => {
    const reference: ReferencedFileContent = {
      type: 'file',
      name: 'answer.ts',
      mediaType: 'text/typescript',
      source: {
        kind: 'host_ref',
        attachmentId: '00000000-0000-4000-8000-000000000000',
        sha256: 'a'.repeat(64),
        bytes: 25,
      },
    }
    const onReleaseFiles = vi.fn(async () => undefined)
    renderComposer({
      onSubmit: vi.fn(async () => {
        throw Object.assign(new Error('admission rejected'), { safeToReleaseAttachments: true })
      }),
      onUploadFiles: vi.fn(async () => [reference]),
      onReleaseFiles,
    })
    const file = new File(['export const answer = 42\n'], 'answer.ts', { type: 'text/typescript' })
    fireEvent.change(screen.getByTestId('composer-file-input'), { target: { files: [file] } })
    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: 'review this file' } })
    fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Enter' })

    await waitFor(() => expect(onReleaseFiles).toHaveBeenCalledWith([reference]))
    expect(screen.getByTestId('composer-input')).toHaveProperty('value', 'review this file')
    expect(screen.getByTestId('attachment-tray').textContent).toContain('answer.ts')
  })

  it('retains pending references when admission acceptance is transport-ambiguous', async () => {
    const reference: ReferencedFileContent = {
      type: 'file',
      name: 'answer.ts',
      mediaType: 'text/typescript',
      source: {
        kind: 'host_ref',
        attachmentId: '00000000-0000-4000-8000-000000000000',
        sha256: 'a'.repeat(64),
        bytes: 25,
      },
    }
    const onReleaseFiles = vi.fn(async () => undefined)
    renderComposer({
      onSubmit: vi.fn(async () => { throw new Error('connection reset') }),
      onUploadFiles: vi.fn(async () => [reference]),
      onReleaseFiles,
    })
    const file = new File(['export const answer = 42\n'], 'answer.ts', { type: 'text/typescript' })
    fireEvent.change(screen.getByTestId('composer-file-input'), { target: { files: [file] } })
    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: 'review this file' } })
    fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Enter' })

    await screen.findByTestId('composer-toast')
    expect(onReleaseFiles).not.toHaveBeenCalled()
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

  it('rejects more than four pasted images before adding attachments', async () => {
    const onSubmit = vi.fn()
    renderComposer({ onSubmit })
    const files = Array.from({ length: 5 }, (_, index) => new File([new Uint8Array([index])], `pic-${index}.png`, { type: 'image/png' }))
    fireEvent.paste(screen.getByTestId('composer-input'), {
      clipboardData: {
        items: files.map((file) => ({ kind: 'file' as const, type: file.type, getAsFile: () => file })),
      },
    })
    expect((await screen.findByTestId('composer-toast')).textContent).toContain('at most 4 images')
    expect(screen.queryByTestId('pasted-image-tray')).toBeNull()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('keeps an oversized pasted image and explains why it cannot be sent', async () => {
    const onSubmit = vi.fn()
    renderComposer({ onSubmit })
    const file = new File([new Uint8Array(2 * 1024 * 1024 + 1)], 'large.gif', { type: 'image/gif' })
    fireEvent.paste(screen.getByTestId('composer-input'), {
      clipboardData: {
        items: [{ kind: 'file' as const, type: file.type, getAsFile: () => file }],
      },
    })
    await screen.findByTestId('pasted-image-tray')
    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: 'keep this' } })
    fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Enter' })
    expect((await screen.findByTestId('composer-toast')).textContent).toContain('at most 2 MiB')
    expect(screen.getByTestId('composer-input')).toHaveProperty('value', 'keep this')
    expect(screen.getByTestId('pasted-image-tray')).toBeTruthy()
    expect(onSubmit).not.toHaveBeenCalled()
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

  it('persists the unsent draft per session and restores it on switch', () => {
    const s1 = { ...createInitialState({}), sessionId: 'draft-a' }
    const s2 = { ...createInitialState({}), sessionId: 'draft-b' }
    window.localStorage.removeItem('agent-kernel:composer:draft:draft-a')
    window.localStorage.removeItem('agent-kernel:composer:draft:draft-b')

    const { rerender } = renderComposer({ state: s1 })
    const input = () => screen.getByTestId('composer-input') as HTMLTextAreaElement

    // Type a draft in session A.
    fireEvent.change(input(), { target: { value: 'draft for A' } })
    expect(input().value).toBe('draft for A')

    // Switch to session B — the composer must be empty (B has no draft), not A's.
    rerender(
      <Composer
        model="" models={[]} onModelChange={() => {}} approvalMode="auto" onApprovalModeChange={() => {}}
        state={s2} config={null} humanAttention={EMPTY_HUMAN_ATTENTION} queuedMessages={[]}
        onSubmit={() => {}} onCompact={() => {}}
      />,
    )
    expect(input().value).toBe('')

    // Type a different draft in B.
    fireEvent.change(input(), { target: { value: 'draft for B' } })

    // Switch back to A — A's draft is restored.
    rerender(
      <Composer
        model="" models={[]} onModelChange={() => {}} approvalMode="auto" onApprovalModeChange={() => {}}
        state={s1} config={null} humanAttention={EMPTY_HUMAN_ATTENTION} queuedMessages={[]}
        onSubmit={() => {}} onCompact={() => {}}
      />,
    )
    expect(input().value).toBe('draft for A')

    window.localStorage.removeItem('agent-kernel:composer:draft:draft-a')
    window.localStorage.removeItem('agent-kernel:composer:draft:draft-b')
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
