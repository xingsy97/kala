import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { AppShellNav } from './AppShellNav.js'

function renderNav(overrides: Partial<Parameters<typeof AppShellNav>[0]> = {}): void {
  render(
    <AppShellNav
      section="benchmarks"
      onSelect={() => {}}
      onOpenSettings={() => {}}
      onToggleInspector={() => {}}
      inspectorOpen={false}
      inspectorAvailable={true}
      {...overrides}
    />,
  )
}

describe('AppShellNav', () => {
  it('renders five nav tabs and marks the active section', () => {
    renderNav()
    for (const id of ['agent', 'benchmarks', 'operations', 'artifacts', 'pipeline']) {
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

  it('inspector icon fires onToggleInspector when available', () => {
    const onToggleInspector = vi.fn()
    renderNav({ onToggleInspector })
    fireEvent.click(screen.getByTestId('app-shell-nav-inspector-icon'))
    expect(onToggleInspector).toHaveBeenCalledTimes(1)
  })

  it('hides inspector icon when not available', () => {
    renderNav({ inspectorAvailable: false })
    expect(screen.queryByTestId('app-shell-nav-inspector-icon')).toBeNull()
  })
})
