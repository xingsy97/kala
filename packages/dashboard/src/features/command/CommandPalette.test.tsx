import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { CommandPalette, modKey, type CommandPaletteItem } from './CommandPalette.js'

function baseCmd(overrides: Partial<CommandPaletteItem> & Pick<CommandPaletteItem, 'id'>): CommandPaletteItem {
  return {
    id: overrides.id,
    label: overrides.label ?? overrides.id,
    hint: overrides.hint ?? 'hint',
    run: overrides.run ?? vi.fn(),
    ...overrides,
  }
}

describe('CommandPalette', () => {
  it('filters local commands, shows disabled reasons, and runs enabled commands', () => {
    const runSettings = vi.fn()
    const onOpenChange = vi.fn()
    render(
      <CommandPalette
        open
        onOpenChange={onOpenChange}
        commands={[
          { id: 'settings', label: 'Open settings', hint: 'Configure dashboard settings', run: runSettings },
          { id: 'session', label: 'New session', hint: 'Create a new session', disabled: true, disabledReason: 'No workspace online', run: vi.fn() },
        ]}
      />,
    )

    expect(screen.getByTestId('command-palette')).toBeTruthy()
    expect(screen.getByText('No workspace online')).toBeTruthy()

    fireEvent.change(screen.getByTestId('command-palette-search'), { target: { value: 'settings' } })
    expect(screen.getByTestId('command-palette-item-settings')).toBeTruthy()
    expect(screen.queryByTestId('command-palette-item-session')).toBeNull()

    fireEvent.click(screen.getByTestId('command-palette-item-settings'))
    expect(runSettings).toHaveBeenCalledTimes(1)
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('renders group headings in a stable order (Actions last)', () => {
    render(
      <CommandPalette
        open
        onOpenChange={vi.fn()}
        commands={[
          baseCmd({ id: 'a1', group: 'Actions', label: 'Untagged' }),
          baseCmd({ id: 's1', group: 'Session', label: 'Session One' }),
          baseCmd({ id: 'r1', group: 'Runtime', label: 'Runtime One' }),
          baseCmd({ id: 'v1', group: 'View', label: 'View One' }),
        ]}
      />,
    )
    const headings = Array.from(document.querySelectorAll('[cmdk-group-heading]')).map(
      (n) => (n.textContent ?? '').trim(),
    )
    expect(headings).toEqual(['Runtime', 'Session', 'View', 'Actions'])
  })

  it('matches on keywords even when the label does not contain the query', () => {
    render(
      <CommandPalette
        open
        onOpenChange={vi.fn()}
        commands={[
          baseCmd({ id: 'compact', label: 'Compact context', hint: 'summary', keywords: ['shrink', 'summarize'] }),
          baseCmd({ id: 'other', label: 'Other', hint: '' }),
        ]}
      />,
    )
    fireEvent.change(screen.getByTestId('command-palette-search'), { target: { value: 'shrink' } })
    expect(screen.getByTestId('command-palette-item-compact')).toBeTruthy()
    expect(screen.queryByTestId('command-palette-item-other')).toBeNull()
  })

  it('does not run disabled commands even on click', () => {
    const disabled = vi.fn()
    const onOpenChange = vi.fn()
    render(
      <CommandPalette
        open
        onOpenChange={onOpenChange}
        commands={[
          baseCmd({ id: 'nope', label: 'Nope', disabled: true, disabledReason: 'why', run: disabled }),
        ]}
      />,
    )
    // cmdk marks disabled items as data-disabled; clicking does not fire onSelect.
    const item = screen.getByTestId('command-palette-item-nope')
    fireEvent.click(item)
    expect(disabled).not.toHaveBeenCalled()
  })

  it('renders shortcut chips when provided', () => {
    render(
      <CommandPalette
        open
        onOpenChange={vi.fn()}
        commands={[
          baseCmd({ id: 'k', label: 'Palette', shortcut: [' - ', 'K'] }),
        ]}
      />,
    )
    expect(screen.getByText(' - ')).toBeTruthy()
    expect(screen.getByText('K')).toBeTruthy()
  })

  it('restores focus to the previously focused element on close', async () => {
    const button = document.createElement('button')
    button.textContent = 'origin'
    document.body.appendChild(button)
    button.focus()
    expect(document.activeElement).toBe(button)

    const { rerender } = render(
      <CommandPalette
        open
        onOpenChange={vi.fn()}
        commands={[baseCmd({ id: 'x', label: 'X' })]}
      />,
    )
    rerender(
      <CommandPalette
        open={false}
        onOpenChange={vi.fn()}
        commands={[baseCmd({ id: 'x', label: 'X' })]}
      />,
    )
    await new Promise((resolve) => requestAnimationFrame(resolve))
    expect(document.activeElement).toBe(button)
    button.remove()
  })
})

describe('modKey', () => {
  it('returns Ctrl on non-Mac platforms', () => {
    const original = navigator.platform
    Object.defineProperty(navigator, 'platform', { value: 'Linux x86_64', configurable: true })
    expect(modKey()).toBe('Ctrl')
    Object.defineProperty(navigator, 'platform', { value: original, configurable: true })
  })

  it('returns  -  on Mac', () => {
    const original = navigator.platform
    Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true })
    expect(modKey()).toBe(' - ')
    Object.defineProperty(navigator, 'platform', { value: original, configurable: true })
  })
})
