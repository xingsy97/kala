import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { NoSessionArea, WorkbenchToolbar, sessionDirectoryIsLoading } from './app.js'
import { coarseStatusForIndicator, deriveSelectedSessionActivity } from './app-logic/session-activity.js'

function renderToolbar(overrides: Partial<Parameters<typeof WorkbenchToolbar>[0]> = {}): void {
  render(
    <WorkbenchToolbar
      sessionLabel="Loaded session"
      cwd="/workspace"
      onOpenTopbar={() => {}}
      topbarAvailable={false}
      onOpenExplorer={() => {}}
      explorerAvailable={false}
      onOpenInspector={() => {}}
      inspectorAvailable={false}
      onChangeCwd={() => {}}
      sessionSelected={false}
      {...overrides}
    />,
  )
}

describe('session directory loading', () => {
  it('does not wait for an executor snapshot when SaaS workspace support is disabled', () => {
    expect(sessionDirectoryIsLoading(false, true, false)).toBe(false)
  })

  it('still waits for both snapshots in Standalone workspace mode', () => {
    expect(sessionDirectoryIsLoading(true, true, false)).toBe(true)
    expect(sessionDirectoryIsLoading(true, true, true)).toBe(false)
  })
})

describe('WorkbenchToolbar', () => {
  it('shows loading instead of no session selected while sessions are loading', () => {
    renderToolbar({ sessionLoading: true })

    expect(screen.getByTestId('session-title').getAttribute('data-loading')).toBe('true')
    expect(screen.getByTestId('session-label').textContent).toBe('Loading...')
    expect(screen.getByTestId('session-label').textContent).not.toBe('no session selected')
  })

  it('shows no session selected only after loading has settled without a selected session', () => {
    renderToolbar({ sessionLoading: false })

    expect(screen.getByTestId('session-title').getAttribute('data-loading')).toBeNull()
    expect(screen.getByTestId('session-label').textContent).toBe('no session selected')
  })

  it('keeps the selected session label when a session is active', () => {
    renderToolbar({ sessionSelected: true, sessionLoading: true, sessionActivityStatus: 'loading', onChangeCwd: vi.fn() })

    expect(screen.getByTestId('session-label').textContent).toBe('Loaded session')
  })

  it('uses the dedicated transform owner for the title activity spinner', () => {
    renderToolbar({ sessionSelected: true, sessionActivityStatus: 'thinking', onChangeCwd: vi.fn() })

    const indicator = screen.getByTestId('session-status-indicator')
    const spinner = screen.getByTestId('session-status-spinner')
    const icon = indicator.querySelector('svg')
    expect(spinner.className).toContain('ak-session-status-spinner')
    expect(icon?.className.baseVal).not.toContain('animate-spin')
    expect(icon?.className.baseVal).not.toContain('translateZ')
    expect(indicator.textContent).toContain('Thinking')
  })

  it('keeps one stable spinner DOM node across rapid running-state updates', () => {
    const { rerender } = render(
      <WorkbenchToolbar
        sessionLabel="Loaded session"
        cwd="/workspace"
        onOpenTopbar={() => {}}
        topbarAvailable={false}
        onOpenExplorer={() => {}}
        explorerAvailable={false}
        onOpenInspector={() => {}}
        inspectorAvailable={false}
        onChangeCwd={() => {}}
        sessionSelected
        sessionActivityStatus="loading"
      />,
    )
    const spinner = screen.getByTestId('session-status-spinner')
    rerender(
      <WorkbenchToolbar
        sessionLabel="Loaded session"
        cwd="/workspace"
        onOpenTopbar={() => {}}
        topbarAvailable={false}
        onOpenExplorer={() => {}}
        explorerAvailable={false}
        onOpenInspector={() => {}}
        inspectorAvailable={false}
        onChangeCwd={() => {}}
        sessionSelected
        sessionActivityStatus="loading"
      />,
    )
    expect(screen.getByTestId('session-status-spinner')).toBe(spinner)
    expect(spinner.className).toContain('ak-session-status-spinner')
    expect(screen.getByTestId('session-status-indicator').textContent).toBeTruthy()
    expect(screen.getByTestId('session-status-indicator').getAttribute('data-status')).toBe('loading')
  })
})

describe('NoSessionArea', () => {
  it('starts a new session without passing the click event as workspace id', () => {
    const onNewSession = vi.fn()
    render(<NoSessionArea onNewSession={onNewSession} hasSessions={false} />)

    fireEvent.click(screen.getByTestId('no-session-new-button'))

    expect(onNewSession).toHaveBeenCalledTimes(1)
    expect(onNewSession).toHaveBeenCalledWith()
  })
})

describe('deriveSelectedSessionActivity', () => {
  it('does not leak the previous session live state during a selection switch', () => {
    const activity = deriveSelectedSessionActivity({
      selectedSessionId: 'session-b',
      hydratedSessionId: 'session-a',
      summaryStatus: 'idle',
      liveStatus: 'executing_tools',
      streamingActive: true,
      awaitingAck: true,
      compactRunning: true,
    })

    expect(activity.status).toBe('idle')
    expect(activity.derived.isRunning).toBe(false)
    expect(activity.usesLiveProjection).toBe(false)
  })

  it('keeps a completed Host summary stable while stale cached running content paints', () => {
    const activity = deriveSelectedSessionActivity({
      selectedSessionId: 'session-done',
      hydratedSessionId: null,
      summaryStatus: 'done',
      liveStatus: 'executing_tools',
      streamingActive: false,
      awaitingAck: false,
      compactRunning: false,
    })

    expect(activity.status).toBe('done')
    expect(activity.indicatorStatus).toBe('done')
    expect(activity.derived.isRunning).toBe(false)
    expect(activity.usesLiveProjection).toBe(false)
  })

  it('uses live state only after the selected session projection is hydrated', () => {
    const activity = deriveSelectedSessionActivity({
      selectedSessionId: 'session-b',
      hydratedSessionId: 'session-b',
      summaryStatus: 'idle',
      liveStatus: 'thinking',
      streamingActive: false,
      awaitingAck: false,
      compactRunning: false,
    })

    expect(activity.status).toBe('thinking')
    expect(activity.indicatorStatus).toBe('loading')
    expect(activity.derived.isRunning).toBe(true)
  })
})

describe('coarseStatusForIndicator', () => {
  it('collapses every running activity to a single stable value', () => {
    // thinking ⇄ executing_tools flips many times during a tool-heavy turn;
    // both (and the client `loading` bridge) must map to the same value so the
    // status-indicator identity is stable and the spinner/Explorer do not
    // re-render on every flip.
    expect(coarseStatusForIndicator('thinking')).toBe('loading')
    expect(coarseStatusForIndicator('executing_tools')).toBe('loading')
    expect(coarseStatusForIndicator('loading')).toBe('loading')
  })

  it('passes non-running statuses through unchanged', () => {
    expect(coarseStatusForIndicator('idle')).toBe('idle')
    expect(coarseStatusForIndicator('done')).toBe('done')
    expect(coarseStatusForIndicator('awaiting_approval')).toBe('awaiting_approval')
    expect(coarseStatusForIndicator('error')).toBe('error')
    expect(coarseStatusForIndicator(undefined)).toBeUndefined()
  })
})
