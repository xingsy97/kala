import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { Composer } from './Composer.js'

function renderComposer(props?: {
  onSubmit?: (text: string) => void
  onCompact?: () => void
}) {
  return render(
    <Composer
      model=""
      models={[]}
      onModelChange={() => {}}
      status="ready"
      state={null}
      config={null}
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
        status="ready"
        state={null}
        config={null}
        onSubmit={() => {}}
        onCompact={() => {}}
      />,
    )

    expect(screen.queryByTestId('composer-state-chips')).toBeNull()
    expect(screen.getByTestId('connection-status').textContent ?? '').toContain('Host ready')
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
})
