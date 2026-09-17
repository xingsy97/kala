import { render, screen, fireEvent } from '@testing-library/react'
import { Cog } from 'lucide-react'
import { describe, expect, it, vi } from 'vitest'

import { InterfaceToggle, SectionHeader, SettingsSectionButton, Toggle } from './controls.js'

// The controls are pure presentational primitives extracted from SettingsDialog.
// These tests lock their contract so the extraction can't silently regress.
// (Plain matchers only — the suite does not register jest-dom.)

describe('Toggle', () => {
  it('reflects checked state and toggles on click', () => {
    const onChange = vi.fn()
    render(<Toggle checked={false} onChange={onChange} ariaLabel="wifi" testId="t" />)
    const btn = screen.getByTestId('t')
    expect(btn.getAttribute('role')).toBe('switch')
    expect(btn.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(btn)
    expect(onChange).toHaveBeenCalledWith(true)
  })

  it('does not fire when disabled', () => {
    const onChange = vi.fn()
    render(<Toggle checked onChange={onChange} ariaLabel="wifi" testId="t" disabled />)
    fireEvent.click(screen.getByTestId('t'))
    expect(onChange).not.toHaveBeenCalled()
  })
})

describe('InterfaceToggle', () => {
  it('renders label + description and delegates to Toggle', () => {
    const onChange = vi.fn()
    render(
      <ul>
        <InterfaceToggle label="Smooth text" description="fade in" checked onChange={onChange} testId="row" />
      </ul>,
    )
    expect(screen.getByText('Smooth text')).toBeTruthy()
    expect(screen.queryByText('fade in')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'About Smooth text' }))
    expect(screen.getByRole('tooltip').textContent).toBe('fade in')
    fireEvent.click(screen.getByTestId('row'))
    expect(onChange).toHaveBeenCalledWith(false)
  })
})

describe('SectionHeader', () => {
  it('renders title, and subtitle only when provided', () => {
    const { rerender } = render(<SectionHeader title="Interface" />)
    expect(screen.getByRole('heading', { name: 'Interface' })).toBeTruthy()
    expect(screen.queryByText('sub')).toBeNull()
    rerender(<SectionHeader title="Interface" subtitle="sub" />)
    expect(screen.queryByText('sub')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'About Interface' }))
    expect(screen.getByText('sub')).toBeTruthy()
  })
})

describe('SettingsSectionButton', () => {
  it('exposes a stable testid per section key and fires onClick', () => {
    const onClick = vi.fn()
    render(<SettingsSectionButton section={{ key: 'interface', icon: Cog }} active={false} onClick={onClick} />)
    fireEvent.click(screen.getByTestId('settings-tab-interface'))
    expect(onClick).toHaveBeenCalled()
  })
})
