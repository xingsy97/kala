import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { ImageContent, TextContent } from '@agent-kernel/kernel'
import type { FileListEntry } from '@agent-kernel/shared'

import { Composer } from './Composer.js'

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
  onListFiles?: (query: string) => Promise<readonly FileListEntry[]>
  onReadFile?: (path: string) => Promise<{ content?: string; error?: string }>
}) {
  return render(
    <Composer
      model=""
      models={[]}
      onModelChange={() => {}}
      approvalMode="auto"
      onApprovalModeChange={() => {}}
      state={null}
      config={null}
      queuedMessages={[]}
      onSubmit={props?.onSubmit ?? (() => {})}
      onCompact={props?.onCompact ?? (() => {})}
      {...(props?.onCancel ? { onCancel: props.onCancel } : {})}
      {...(props?.onClearSession ? { onClearSession: props.onClearSession } : {})}
      {...(props?.onListFiles ? { onListFiles: props.onListFiles } : {})}
      {...(props?.onReadFile ? { onReadFile: props.onReadFile } : {})}
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
        queuedMessages={[]}
        onSubmit={() => {}}
        onCompact={() => {}}
      />,
    )

    expect(screen.queryByTestId('composer-state-chips')).toBeNull()
    expect(screen.queryByTestId('connection-status')).toBeNull()
    const indicator = screen.getByTestId('context-usage-indicator')
    expect(indicator.textContent ?? '').toContain('n/a')
    expect(indicator.textContent ?? '').not.toContain('Events')
    expect(indicator.textContent ?? '').not.toContain('Tools')
    expect(indicator.textContent ?? '').not.toContain('Tokens')
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

  it('explains send modes and shows pending delivery previews', () => {
    render(
      <Composer
        model=""
        models={[]}
        onModelChange={() => {}}
        approvalMode="auto"
        onApprovalModeChange={() => {}}
        state={null}
        config={null}
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
    expect(dock.textContent ?? '').toContain('2 pending deliveries')
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
