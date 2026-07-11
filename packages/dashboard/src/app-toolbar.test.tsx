import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { WorkbenchToolbar } from './app.js'

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
