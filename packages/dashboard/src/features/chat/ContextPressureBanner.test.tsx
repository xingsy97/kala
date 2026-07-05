import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { AgentState } from '@agent-kernel/kernel'

import { ContextPressureBanner } from './ContextPressureBanner.js'

function stateWithLevel(level: AgentState['contextPressureLevel']): AgentState {
  return { contextPressureLevel: level } as AgentState
}

describe('ContextPressureBanner', () => {
  it('renders nothing when there is no pressure', () => {
    const { container } = render(
      <ContextPressureBanner
        state={stateWithLevel('none')}
        compactRunning={false}
        onCompactNow={() => {}}
      />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing when state is missing', () => {
    const { container } = render(
      <ContextPressureBanner
        state={null}
        compactRunning={false}
        onCompactNow={() => {}}
      />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('renders the soft tier with a Compact now button', () => {
    const onCompactNow = vi.fn()
    render(
      <ContextPressureBanner
        state={stateWithLevel('soft')}
        compactRunning={false}
        onCompactNow={onCompactNow}
      />,
    )
    const banner = screen.getByTestId('context-pressure-banner')
    expect(banner.getAttribute('data-level')).toBe('soft')
    const button = screen.getByTestId('context-pressure-compact-now')
    expect((button as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(button)
    expect(onCompactNow).toHaveBeenCalledTimes(1)
  })

  it('disables the soft-tier button while a compact is running', () => {
    render(
      <ContextPressureBanner
        state={stateWithLevel('soft')}
        compactRunning
        onCompactNow={() => {}}
      />,
    )
    const button = screen.getByTestId('context-pressure-compact-now')
    expect((button as HTMLButtonElement).disabled).toBe(true)
    expect(button.textContent ?? '').toMatch(/compacting/i)
  })

  it('renders the hard tier explaining auto-compaction', () => {
    render(
      <ContextPressureBanner
        state={stateWithLevel('hard')}
        compactRunning={false}
        onCompactNow={() => {}}
      />,
    )
    const banner = screen.getByTestId('context-pressure-banner')
    expect(banner.getAttribute('data-level')).toBe('hard')
    expect(banner.textContent ?? '').toMatch(/auto-compacting/i)
    expect(screen.queryByTestId('context-pressure-compact-now')).toBeNull()
  })
})
