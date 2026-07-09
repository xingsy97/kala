import '@testing-library/react'
import { cleanup } from '@testing-library/react'
import { afterEach, vi } from 'vitest'

class ResizeObserverStub implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

globalThis.ResizeObserver ??= ResizeObserverStub

// cmdk calls Element.scrollIntoView on the highlighted item; JSDOM does not
// implement it. A no-op keeps command-palette tests from crashing at layout.
if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView(): void {}
}

vi.mock('react-virtuoso', async () => {
  const React = await import('react')
  const Virtuoso = React.forwardRef<unknown, Record<string, unknown>>((props, ref) => {
    React.useImperativeHandle(ref, () => ({
      scrollToIndex: vi.fn(),
      scrollTo: vi.fn(),
      scrollBy: vi.fn(),
    }))
    const totalCount = typeof props.totalCount === 'number' ? props.totalCount : 0
    const itemContent = props.itemContent as ((index: number) => React.ReactNode) | undefined
    const computeItemKey = props.computeItemKey as ((index: number) => React.Key) | undefined
    const components = props.components as { Footer?: React.ComponentType } | undefined
    const children: React.ReactNode[] = Array.from({ length: totalCount }, (_, index) =>
      React.createElement(
        'div',
        { key: computeItemKey?.(index) ?? index, 'data-testid': 'virtuoso-test-item' },
        itemContent?.(index),
      ),
    )
    if (components?.Footer) children.push(React.createElement(components.Footer, { key: 'footer' }))
    return React.createElement(
      'div',
      { 'data-testid': 'virtuoso-scroller', 'data-virtuoso-scroller': 'true' },
      children,
    )
  })
  Virtuoso.displayName = 'VirtuosoMock'
  return { Virtuoso }
})

afterEach(() => {
  cleanup()
})
