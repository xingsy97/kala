import '@testing-library/react'
import { cleanup } from '@testing-library/react'
import * as React from 'react'
import { afterEach, beforeEach, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import { i18n } from '../i18n/index.js'

class ResizeObserverStub implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

globalThis.ResizeObserver ??= ResizeObserverStub

function createMatchMedia(): typeof window.matchMedia {
  return vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }))
}

function installMatchMedia(): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: createMatchMedia(),
  })
}

installMatchMedia()

beforeEach(() => {
  installMatchMedia()
})

const virtuosoScrollToIndexMock = vi.fn()
const virtuosoScrollToMock = vi.fn()
const virtuosoScrollByMock = vi.fn()

;(globalThis as typeof globalThis & {
  __virtuosoScrollToIndexMock?: typeof virtuosoScrollToIndexMock
}).__virtuosoScrollToIndexMock = virtuosoScrollToIndexMock
;(globalThis as typeof globalThis & {
  __virtuosoScrollToMock?: typeof virtuosoScrollToMock
}).__virtuosoScrollToMock = virtuosoScrollToMock

// cmdk calls Element.scrollIntoView on the highlighted item; JSDOM does not
// implement it. A no-op keeps command-palette tests from crashing at layout.
if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView(): void {}
}

// @formkit/auto-animate calls Element.animate() via MutationObserver; JSDOM
// doesn't implement it. Stub with a no-op Animation-like object so the
// callback never throws.
if (typeof Element !== 'undefined' && !Element.prototype.animate) {
  Element.prototype.animate = function animate(): Animation {
    return {
      cancel() {},
      finish() {},
      play() {},
      pause() {},
      reverse() {},
      addEventListener() {},
      removeEventListener() {},
      onfinish: null,
      oncancel: null,
      finished: Promise.resolve() as unknown as Promise<Animation>,
    } as unknown as Animation
  }
}

vi.mock('react-virtuoso', async () => {
  const React = await import('react')
  const Virtuoso = React.forwardRef<unknown, Record<string, unknown>>((props, ref) => {
    React.useImperativeHandle(ref, () => ({
      scrollToIndex: virtuosoScrollToIndexMock,
      scrollTo: virtuosoScrollToMock,
      scrollBy: virtuosoScrollByMock,
    }))
    const data = Array.isArray(props.data) ? props.data : undefined
    const totalCount = typeof props.totalCount === 'number' ? props.totalCount : data?.length ?? 0
    const itemContent = props.itemContent as ((index: number, item?: unknown) => React.ReactNode) | undefined
    const computeItemKey = props.computeItemKey as ((index: number, item?: unknown) => React.Key) | undefined
    const components = props.components as { Footer?: React.ComponentType<{ context?: unknown }>; Scroller?: React.ComponentType<React.HTMLAttributes<HTMLDivElement>> } | undefined
    const context = props.context
    ;(globalThis as typeof globalThis & {
      __virtuosoAtBottomStateChange?: (atBottom: boolean) => void
      __virtuosoFollowOutput?: (isAtBottom: boolean) => boolean | 'auto' | 'smooth'
    }).__virtuosoAtBottomStateChange = props.atBottomStateChange as ((atBottom: boolean) => void) | undefined
    ;(globalThis as typeof globalThis & {
      __virtuosoFollowOutput?: (isAtBottom: boolean) => boolean | 'auto' | 'smooth'
    }).__virtuosoFollowOutput = props.followOutput as ((isAtBottom: boolean) => boolean | 'auto' | 'smooth') | undefined
    ;(globalThis as typeof globalThis & {
      __virtuosoRangeChanged?: (range: { startIndex: number; endIndex: number }) => void
    }).__virtuosoRangeChanged = props.rangeChanged as ((range: { startIndex: number; endIndex: number }) => void) | undefined
    const children: React.ReactNode[] = Array.from({ length: totalCount }, (_, index) =>
      React.createElement(
        'div',
        { key: computeItemKey?.(index, data?.[index]) ?? index, 'data-testid': 'virtuoso-test-item' },
        itemContent?.(index, data?.[index]),
      ),
    )
    if (components?.Footer) children.push(React.createElement(components.Footer, { key: 'footer', context }))
    const Scroller = components?.Scroller ?? 'div'
    const scrollerProps = {
      'data-testid': 'virtuoso-scroller',
      'data-virtuoso-scroller': 'true',
    } as React.HTMLAttributes<HTMLDivElement>
    return React.createElement(Scroller, scrollerProps, children)
  })
  Virtuoso.displayName = 'VirtuosoMock'
  return { Virtuoso }
})

let testQueryClient = createTestQueryClient()

function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity, staleTime: 0 },
      mutations: { retry: false },
    },
  })
}

vi.mock('@testing-library/react', async () => {
  const actual = await vi.importActual<typeof import('@testing-library/react')>('@testing-library/react')
  const wrappedRender = ((ui: Parameters<typeof actual.render>[0], options?: Parameters<typeof actual.render>[1]) => {
    const ExistingWrapper = options?.wrapper
    const Wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) => {
      const inner = ExistingWrapper
        ? React.createElement(ExistingWrapper, null, children)
        : children
      return React.createElement(QueryClientProvider, { client: testQueryClient }, inner)
    }
    return actual.render(ui, { ...options, wrapper: Wrapper })
  }) as typeof actual.render
  return { ...actual, render: wrappedRender }
})

afterEach(() => {
  cleanup()
  void i18n.changeLanguage('en')
  try { localStorage.removeItem('ak-dashboard-language') } catch {}
  virtuosoScrollToIndexMock.mockClear()
  virtuosoScrollToMock.mockClear()
  virtuosoScrollByMock.mockClear()
  testQueryClient.clear()
  testQueryClient = createTestQueryClient()
  installMatchMedia()
})
