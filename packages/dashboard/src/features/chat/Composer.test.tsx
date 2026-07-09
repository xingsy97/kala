import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { ImageContent } from '@agent-kernel/kernel'

import { Composer } from './Composer.js'

function renderComposer(props?: {
  onSubmit?: (text: string, mode: 'steer' | 'queue', images?: readonly ImageContent[]) => void
  onCompact?: () => void
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
      queuedMessages={0}
      onSubmit={props?.onSubmit ?? (() => {})}
      onCompact={props?.onCompact ?? (() => {})}
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
        queuedMessages={0}
        onSubmit={() => {}}
        onCompact={() => {}}
      />,
    )

    expect(screen.queryByTestId('composer-state-chips')).toBeNull()
    expect(screen.queryByTestId('connection-status')).toBeNull()
    expect(screen.getByTestId('context-usage-indicator').textContent ?? '').toContain('Cursor')
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

  it('does not render a separate compact button', () => {
    renderComposer()

    expect(screen.queryByTestId('composer-compact')).toBeNull()
  })

  it('submits using the selected send mode', () => {
    const onSubmit = vi.fn()
    renderComposer({ onSubmit })

    fireEvent.click(screen.getByTestId('send-mode-queue'))
    fireEvent.change(screen.getByTestId('composer-input'), {
      target: { value: 'later' },
    })
    fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Enter' })

    expect(onSubmit).toHaveBeenCalledWith('later', 'queue', undefined)
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
        queuedMessages={0}
        onSubmit={() => {}}
        onCompact={() => {}}
      />,
    )
    expect(screen.getByTestId('approval-mode-picker')).toBeTruthy()
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
})
