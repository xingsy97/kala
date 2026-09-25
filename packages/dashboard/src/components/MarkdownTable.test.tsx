import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { MarkdownTable } from './MarkdownTable.js'

let resizeCallbacks: ResizeObserverCallback[] = []

class ControlledResizeObserver implements ResizeObserver {
  constructor(callback: ResizeObserverCallback) {
    resizeCallbacks.push(callback)
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

afterEach(() => {
  resizeCallbacks = []
  vi.unstubAllGlobals()
})

describe('MarkdownTable', () => {
  it('stays out of tab order without horizontal overflow and scopes headers', () => {
    vi.stubGlobal('ResizeObserver', ControlledResizeObserver)
    render(
      <MarkdownTable label="Message table">
        <thead><tr><th>Name</th></tr></thead>
        <tbody><tr><td>Ada</td></tr></tbody>
      </MarkdownTable>,
    )
    const region = screen.getByRole('region', { name: 'Message table' })
    expect(region.hasAttribute('tabindex')).toBe(false)
    expect(screen.getByRole('table')).toBeTruthy()
    expect(screen.getByRole('columnheader').getAttribute('scope')).toBe('col')
  })

  it('enters tab order when overflow appears and preserves contextual labels', () => {
    vi.stubGlobal('ResizeObserver', ControlledResizeObserver)
    render(
      <>
        <MarkdownTable label="Documentation table"><tbody><tr><td>Docs</td></tr></tbody></MarkdownTable>
        <MarkdownTable label="File preview table"><tbody><tr><td>File</td></tr></tbody></MarkdownTable>
      </>,
    )
    const docs = screen.getByRole('region', { name: 'Documentation table' })
    Object.defineProperties(docs, {
      clientWidth: { configurable: true, value: 200 },
      scrollWidth: { configurable: true, value: 400 },
    })
    act(() => resizeCallbacks.forEach((callback) => callback([], {} as ResizeObserver)))
    expect(docs.getAttribute('tabindex')).toBe('0')
    expect(screen.getByRole('region', { name: 'File preview table' }).hasAttribute('tabindex')).toBe(false)
  })
})
