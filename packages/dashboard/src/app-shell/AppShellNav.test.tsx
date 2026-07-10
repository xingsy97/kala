import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { AppShellNav } from './AppShellNav.js'

describe('AppShellNav', () => {
  it('renders five nav buttons and marks the active section', () => {
    render(<AppShellNav section="benchmarks" onSelect={() => {}} />)
    for (const id of ['agent', 'benchmarks', 'operations', 'artifacts', 'settings']) {
      expect(screen.getByTestId(`app-shell-nav-${id}`)).toBeTruthy()
    }
    expect(screen.getByTestId('app-shell-nav-benchmarks').getAttribute('aria-current')).toBe('page')
    expect(screen.getByTestId('app-shell-nav-agent').getAttribute('aria-current')).toBeNull()
  })

  it('invokes onSelect when a tab is clicked', () => {
    const onSelect = vi.fn()
    render(<AppShellNav section="agent" onSelect={onSelect} />)
    fireEvent.click(screen.getByTestId('app-shell-nav-benchmarks'))
    expect(onSelect).toHaveBeenCalledWith('benchmarks')
  })
})
