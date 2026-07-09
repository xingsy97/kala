import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { AgentState } from '@agent-kernel/kernel'
import type { ContextUsageSnapshot } from '@agent-kernel/shared'

import { ContextPressureBanner } from './ContextPressureBanner.js'

function stateWithStatus(status: AgentState['status'] = 'idle'): AgentState {
  return { status } as AgentState
}

function snapshotWithUsage(inputTokens: number): ContextUsageSnapshot {
  return {
    model: { ref: 'test-model' },
    contextWindow: { tokens: 1_000, source: 'manual_config' },
    usage: { inputTokens, totalTokens: inputTokens },
    breakdown: {
      system: 100,
      transcript: Math.max(0, inputTokens - 100),
      tools: 0,
      memory: 0,
      attachments: 0,
      pendingUserInput: 0,
    },
    estimator: {
      total: { kind: 'heuristic', confidence: 'rough' },
      breakdown: { kind: 'heuristic', confidence: 'rough' },
      version: 'test',
    },
    updatedAt: 0,
  }
}

describe('ContextPressureBanner', () => {
  it('renders nothing when there is no pressure', () => {
    const { container } = render(
      <ContextPressureBanner
        state={stateWithStatus()}
        contextSnapshot={snapshotWithUsage(100)}
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

  it('renders the high tier with a Compact now button', () => {
    const onCompactNow = vi.fn()
    render(
      <ContextPressureBanner
        state={stateWithStatus()}
        contextSnapshot={snapshotWithUsage(800)}
        compactRunning={false}
        onCompactNow={onCompactNow}
      />,
    )
    const banner = screen.getByTestId('context-pressure-banner')
    expect(banner.getAttribute('data-level')).toBe('high')
    const button = screen.getByTestId('context-pressure-compact-now')
    expect((button as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(button)
    expect(onCompactNow).toHaveBeenCalledTimes(1)
  })

  it('disables the high-tier button while a compact is running', () => {
    render(
      <ContextPressureBanner
        state={stateWithStatus()}
        contextSnapshot={snapshotWithUsage(800)}
        compactRunning
        onCompactNow={() => {}}
      />,
    )
    const button = screen.getByTestId('context-pressure-compact-now')
    expect((button as HTMLButtonElement).disabled).toBe(true)
    expect(button.textContent ?? '').toMatch(/compacting/i)
  })

  it('renders nothing at the critical tier (auto-compact now surfaces in the transcript, not here)', () => {
    const { container } = render(
      <ContextPressureBanner
        state={stateWithStatus()}
        contextSnapshot={snapshotWithUsage(950)}
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
        contextSnapshot={snapshotWithUsage(950)}
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
        contextSnapshot={snapshotWithUsage(800)}
        compactRunning={false}
        suppressed
        onCompactNow={() => {}}
      />,
    )

    expect(container.firstChild).toBeNull()
  })
})
