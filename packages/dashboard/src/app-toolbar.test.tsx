import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { NoSessionArea, WorkbenchToolbar } from './app.js'
import { coarseStatusForIndicator } from './app-logic/session-activity.js'

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
