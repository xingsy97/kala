import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { NumberTicker } from './number-ticker.js'

function mockMatchMedia(matches: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (q: string) => ({
      matches,
      media: q,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  })
}

describe('NumberTicker', () => {
  beforeEach(() => {
    mockMatchMedia(false)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders the initial value on mount', () => {
    render(<NumberTicker value={42} data-testid="tick" />)
    expect(screen.getByTestId('tick').textContent).toBe('42')
  })

  it('formats intermediate frames through formatValue', () => {
    let latest = ''
    render(
      <NumberTicker
        value={0}
        formatValue={(n) => {
          latest = `${Math.round(n)}!`
          return latest
        }}
        data-testid="tick"
      />,
    )
    expect(latest).toBe('0!')
    expect(screen.getByTestId('tick').textContent).toBe('0!')
  })

  it('lands on the final value once the raf loop completes', async () => {
    // Drive raf ourselves so the test is deterministic  -  the natural
    // schedule under jsdom is a no-op microtask which never advances
    // performance.now(), so intermediate frames never see t=1.
    const callbacks: Array<(now: number) => void> = []
    const rafSpy = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((cb) => {
        callbacks.push(cb)
        return callbacks.length
      })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})
    const nowSpy = vi.spyOn(performance, 'now')
    let clock = 0
    nowSpy.mockImplementation(() => clock)

    const { rerender } = render(
      <NumberTicker value={100} durationMs={200} data-testid="tick" />,
    )
    clock = 0
    rerender(<NumberTicker value={200} durationMs={200} data-testid="tick" />)
    // Fire raf frames past the duration.
    clock = 250
    await act(async () => {
      while (callbacks.length > 0) {
        const cb = callbacks.shift()!
        cb(clock)
      }
    })

    expect(rafSpy).toHaveBeenCalled()
    expect(screen.getByTestId('tick').textContent).toBe('200')
  })

  it('snaps directly to the new value when prefers-reduced-motion is set', () => {
    mockMatchMedia(true)
    const { rerender } = render(<NumberTicker value={10} data-testid="tick" />)
    rerender(<NumberTicker value={999} data-testid="tick" />)
    expect(screen.getByTestId('tick').textContent).toBe('999')
  })
})
