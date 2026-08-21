import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { NoSessionArea, WorkbenchToolbar, resolveSessionDirectoryLoadingOwner, sessionDirectoryIsLoading } from './app.js'
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
      onOpenSidebar={() => {}}
      sidebarAvailable={false}
      onChangeCwd={() => {}}
      sessionSelected={false}
      {...overrides}
    />,
  )
}

describe('session directory loading', () => {
  it('depends only on the Session snapshot', () => {
    expect(sessionDirectoryIsLoading(false)).toBe(true)
    expect(sessionDirectoryIsLoading(true)).toBe(false)
  })

  it('assigns cold loading to exactly one visible surface', () => {
    expect(resolveSessionDirectoryLoadingOwner({ loading: true, wideLayout: true, explorerOpen: true, explorerDrawerOpen: false })).toBe('explorer')
    expect(resolveSessionDirectoryLoadingOwner({ loading: true, wideLayout: true, explorerOpen: false, explorerDrawerOpen: false })).toBe('workbench')
    expect(resolveSessionDirectoryLoadingOwner({ loading: true, wideLayout: false, explorerOpen: false, explorerDrawerOpen: true })).toBe('explorer')
    expect(resolveSessionDirectoryLoadingOwner({ loading: true, wideLayout: false, explorerOpen: false, explorerDrawerOpen: false })).toBe('workbench')
    expect(resolveSessionDirectoryLoadingOwner({ loading: false, wideLayout: true, explorerOpen: true, explorerDrawerOpen: false })).toBeNull()
  })
})

describe('WorkbenchToolbar', () => {
  it('renders the title controls as one inset floating surface', () => {
    renderToolbar({ sessionSelected: true })

    const rail = screen.getByTestId('workbench-toolbar-rail')
    const surface = screen.getByTestId('workbench-toolbar')
    expect(rail.contains(surface)).toBe(true)
    expect(surface.className).toContain('ak-titlebar-surface')
    expect(rail.className).toContain('p-1.5')
    expect(surface.className).toContain('min-h-9')
  })

  it('uses one sidebar opener and does not duplicate it with a terminal shortcut', () => {
    const onOpenSidebar = vi.fn()
    renderToolbar({ sessionSelected: true, onOpenSidebar, sidebarAvailable: true })

    fireEvent.click(screen.getByRole('button', { name: 'Open sidebar' }))
    expect(onOpenSidebar).toHaveBeenCalledOnce()
    expect(screen.getByTestId('sidebar-toggle')).toBeTruthy()
    expect(screen.queryByTestId('terminal-toggle')).toBeNull()
    expect(screen.queryByTestId('inspector-toggle')).toBeNull()
  })

  it('keeps a stable Sessions title while the directory is loading', () => {
    renderToolbar({ sessionDirectoryLoading: true })

    expect(screen.getByTestId('session-title').getAttribute('data-loading')).toBeNull()
    expect(screen.getByTestId('session-label').textContent).toBe('Sessions')
    expect(screen.getByTestId('session-label').textContent).not.toBe('no session selected')
    const title = screen.getByTestId('session-title')
    expect(title.querySelector('.ak-loading-spinner')).toBeNull()
    expect(title.querySelector('svg.animate-spin')).toBeNull()
  })

  it('shows no session selected only after loading has settled without a selected session', () => {
    renderToolbar({ sessionDirectoryLoading: false })

    expect(screen.getByTestId('session-title').getAttribute('data-loading')).toBeNull()
    expect(screen.getByTestId('session-label').textContent).toBe('no session selected')
  })

  it('keeps the selected session label when a session is active', () => {
    renderToolbar({ sessionSelected: true, sessionDirectoryLoading: true, sessionActivityStatus: 'loading', onChangeCwd: vi.fn() })

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
        onOpenSidebar={() => {}}
        sidebarAvailable={false}
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
        onOpenSidebar={() => {}}
        sidebarAvailable={false}
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
