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
    document.head.querySelectorAll('link[rel="icon"]').forEach((link) => link.remove())
  })

  it('keeps the title stable and animates the favicon while running', () => {
    vi.useFakeTimers()
    const favicon = document.createElement('link')
    favicon.rel = 'icon'
    favicon.href = '/favicon.svg'
    document.head.appendChild(favicon)

    const { rerender, unmount } = render(<Harness running={false} />)
    expect(document.title).toBe(DASHBOARD_TITLE)

    rerender(<Harness running />)
    expect(document.title).toBe(DASHBOARD_TITLE)
    const firstRunningHref = favicon.href
    expect(firstRunningHref).toContain('data:image/svg+xml')

    vi.advanceTimersByTime(500)
    expect(document.title).toBe(DASHBOARD_TITLE)
    expect(favicon.href).not.toBe(firstRunningHref)

    vi.advanceTimersByTime(500)
    expect(document.title).toBe(DASHBOARD_TITLE)

    rerender(<Harness running={false} />)
    expect(document.title).toBe(DASHBOARD_TITLE)
    expect(favicon.getAttribute('href')).toBe('/favicon.svg')

    unmount()
    expect(document.title).toBe(DASHBOARD_TITLE)
    expect(favicon.getAttribute('href')).toBe('/favicon.svg')
  })
})
