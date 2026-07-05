import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { createInitialState } from '@agent-kernel/kernel'

import { Composer } from './Composer.js'

const baseState = createInitialState({ sessionId: 'sess-composer' })

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
      state={baseState}
      onSubmit={props?.onSubmit ?? (() => {})}
      onCompact={props?.onCompact ?? (() => {})}
    />,
  )
}

describe('Composer', () => {
  it('renders session status chips in the footer', () => {
    render(
      <Composer
        model=""
        models={[]}
        onModelChange={() => {}}
        status="ready"
        state={{
          ...baseState,
          status: 'done',
          cursor: 3,
          usage: { inputTokens: 42, outputTokens: 7, costUsd: 0 },
        }}
        onSubmit={() => {}}
        onCompact={() => {}}
      />,
    )

    const chips = screen.getByTestId('composer-state-chips')
    expect(chips.textContent ?? '').toContain('AgentDone')
    expect(chips.textContent ?? '').toContain('Cursor3')
    expect(chips.textContent ?? '').toContain('Tokens42 in / 7 out')
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

  it('exposes a compact button for manual context compaction', () => {
    const onCompact = vi.fn()
    renderComposer({ onCompact })

    fireEvent.click(screen.getByTestId('composer-compact'))

    expect(onCompact).toHaveBeenCalledTimes(1)
  })

  it('shows compact progress on the compact button', () => {
    render(
      <Composer
        model=""
        models={[]}
        onModelChange={() => {}}
        status="ready"
        state={baseState}
        compacting
        onSubmit={() => {}}
        onCompact={() => {}}
      />,
    )

    const compact = screen.getByTestId('composer-compact')
    expect(compact.getAttribute('aria-label')).toBe('compacting context')
    expect(compact).toHaveProperty('disabled', true)
  })
})
