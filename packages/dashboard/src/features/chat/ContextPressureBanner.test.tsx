import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { AgentState } from '@agent-kernel/kernel'
import type { ContextSnapshot } from '@agent-kernel/shared'

import { ContextPressureBanner } from './ContextPressureBanner.js'

function stateWithStatus(status: AgentState['status'] = 'idle'): AgentState {
  return { status } as AgentState
}

function snapshotWithLevel(level: ContextSnapshot['pressureLevel']): ContextSnapshot {
  return {
    estimatedMessageTokens: 100,
    estimatedToolSchemaTokens: 0,
    estimatedTotalInputTokens: 100,
    reserveTokens: 0,
    effectiveLimit: 1_000,
    pressureLevel: level,
    reasonCodes: level === 'none' ? [] : [`pressure_${level}`],
  }
}

describe('ContextPressureBanner', () => {
  it('renders nothing when there is no pressure', () => {
    const { container } = render(
      <ContextPressureBanner
        state={stateWithStatus()}
        contextSnapshot={snapshotWithLevel('none')}
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
        contextSnapshot={null}
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
        state={stateWithStatus()}
        contextSnapshot={snapshotWithLevel('soft')}
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
        state={stateWithStatus()}
        contextSnapshot={snapshotWithLevel('soft')}
        compactRunning
        onCompactNow={() => {}}
      />,
    )
    const button = screen.getByTestId('context-pressure-compact-now')
    expect((button as HTMLButtonElement).disabled).toBe(true)
    expect(button.textContent ?? '').toMatch(/compacting/i)
  })

  it('renders nothing at the hard tier (auto-compact now surfaces in the transcript, not here)', () => {
    const { container } = render(
      <ContextPressureBanner
        state={stateWithStatus()}
        contextSnapshot={snapshotWithLevel('hard')}
        compactRunning={false}
        onCompactNow={() => {}}
      />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('does not show context-pressure copy while the current turn is active', () => {
    const { container } = render(
      <ContextPressureBanner
        state={stateWithStatus('thinking')}
        contextSnapshot={snapshotWithLevel('hard')}
        compactRunning={false}
        onCompactNow={() => {}}
      />,
    )

    expect(container.firstChild).toBeNull()
  })

  it('can be suppressed while the client is awaiting submit acknowledgement', () => {
    const { container } = render(
      <ContextPressureBanner
        state={stateWithStatus()}
        contextSnapshot={snapshotWithLevel('soft')}
        compactRunning={false}
        suppressed
        onCompactNow={() => {}}
      />,
    )

    expect(container.firstChild).toBeNull()
  })
})
