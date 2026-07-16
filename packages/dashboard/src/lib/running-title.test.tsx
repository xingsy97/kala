import { render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DASHBOARD_TITLE, useRunningTitleIndicator } from './running-title.js'

function Harness({ running }: { running: boolean }): JSX.Element {
  useRunningTitleIndicator(running)
  return <div />
}

describe('useRunningTitleIndicator', () => {
  afterEach(() => {
    vi.useRealTimers()
    document.title = DASHBOARD_TITLE
  })

  it('animates the document title while running and restores it when idle', () => {
    vi.useFakeTimers()
    const { rerender, unmount } = render(<Harness running={false} />)
    expect(document.title).toBe(DASHBOARD_TITLE)

    rerender(<Harness running />)
    expect(document.title).toBe(`/ ${DASHBOARD_TITLE}`)

    vi.advanceTimersByTime(500)
    expect(document.title).toBe(`- ${DASHBOARD_TITLE}`)

    vi.advanceTimersByTime(500)
    expect(document.title).toBe(`\\ ${DASHBOARD_TITLE}`)

    vi.advanceTimersByTime(500)
    expect(document.title).toBe(`| ${DASHBOARD_TITLE}`)

    rerender(<Harness running={false} />)
    expect(document.title).toBe(DASHBOARD_TITLE)

    unmount()
    expect(document.title).toBe(DASHBOARD_TITLE)
  })
})
