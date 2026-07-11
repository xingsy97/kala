import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { AppShellNav } from './AppShellNav.js'

function renderNav(overrides: Partial<Parameters<typeof AppShellNav>[0]> = {}): void {
  render(
    <AppShellNav
      section="benchmarks"
      onSelect={() => {}}
      onOpenSettings={() => {}}
      {...overrides}
    />,
  )
}

describe('AppShellNav', () => {
  it('renders nav tabs and marks the active section', () => {
    renderNav()
    for (const id of ['agent', 'benchmarks', 'operations', 'artifacts', 'pipeline', 'docs']) {
      expect(screen.getByTestId(`app-shell-nav-${id}`)).toBeTruthy()
    }
    expect(screen.queryByTestId('app-shell-nav-settings')).toBeNull()
    expect(screen.getByTestId('app-shell-nav-benchmarks').getAttribute('aria-current')).toBe('page')
    expect(screen.getByTestId('app-shell-nav-agent').getAttribute('aria-current')).toBeNull()
  })

  it('invokes onSelect when a tab is clicked', () => {
    const onSelect = vi.fn()
    renderNav({ section: 'agent', onSelect })
    fireEvent.click(screen.getByTestId('app-shell-nav-benchmarks'))
    expect(onSelect).toHaveBeenCalledWith('benchmarks')
  })

  it('settings icon fires onOpenSettings', () => {
    const onOpenSettings = vi.fn()
    renderNav({ onOpenSettings })
    fireEvent.click(screen.getByTestId('app-shell-nav-settings-icon'))
    expect(onOpenSettings).toHaveBeenCalledTimes(1)
  })

  it('renders connection status after the settings button when provided', () => {
    renderNav({ connectionStatus: <span data-testid="connection-status">Connected</span> })
    const settings = screen.getByTestId('app-shell-nav-settings-icon')
    const status = screen.getByTestId('connection-status')
    expect(settings.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('does not render the inspector collapse control in the global nav', () => {
    renderNav()
    expect(screen.queryByTestId('app-shell-nav-inspector-icon')).toBeNull()
  })
})
