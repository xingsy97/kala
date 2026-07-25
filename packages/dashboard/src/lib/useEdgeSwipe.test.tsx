import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useEdgeSwipe } from './useEdgeSwipe.js'

function touch(clientX: number, clientY: number): Touch {
  return { clientX, clientY } as unknown as Touch
}

function dispatchTouch(type: 'touchstart' | 'touchend', touches: Touch[]): void {
  const event = new Event(type) as TouchEvent & Event
  Object.defineProperty(event, 'touches', { value: type === 'touchstart' ? touches : [] })
  Object.defineProperty(event, 'changedTouches', { value: touches })
  window.dispatchEvent(event)
}

describe('useEdgeSwipe', () => {
  afterEach(() => vi.restoreAllMocks())

  it('fires onOpen for a right-swipe starting at the left edge', () => {
    const onOpen = vi.fn()
    renderHook(() => useEdgeSwipe({ onOpen, edgeWidth: 24, threshold: 56 }))
    dispatchTouch('touchstart', [touch(5, 200)])
    dispatchTouch('touchend', [touch(120, 210)])
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('does not fire onOpen when the swipe starts away from the edge', () => {
    const onOpen = vi.fn()
    renderHook(() => useEdgeSwipe({ onOpen, edgeWidth: 24, threshold: 56 }))
    dispatchTouch('touchstart', [touch(200, 200)])
    dispatchTouch('touchend', [touch(320, 210)])
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('fires onClose for a left-swipe', () => {
    const onClose = vi.fn()
    renderHook(() => useEdgeSwipe({ onClose, threshold: 56 }))
    dispatchTouch('touchstart', [touch(300, 200)])
    dispatchTouch('touchend', [touch(180, 205)])
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('ignores mostly-vertical gestures (scrolling)', () => {
    const onOpen = vi.fn()
    const onClose = vi.fn()
    renderHook(() => useEdgeSwipe({ onOpen, onClose, edgeWidth: 24, threshold: 56, maxVerticalDrift: 60 }))
    dispatchTouch('touchstart', [touch(5, 100)])
    dispatchTouch('touchend', [touch(120, 400)])
    expect(onOpen).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('ignores short swipes below the threshold', () => {
    const onOpen = vi.fn()
    renderHook(() => useEdgeSwipe({ onOpen, edgeWidth: 24, threshold: 56 }))
    dispatchTouch('touchstart', [touch(5, 200)])
    dispatchTouch('touchend', [touch(40, 205)])
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('does nothing when disabled', () => {
    const onOpen = vi.fn()
    renderHook(() => useEdgeSwipe({ onOpen, enabled: false }))
    dispatchTouch('touchstart', [touch(5, 200)])
    dispatchTouch('touchend', [touch(150, 205)])
    expect(onOpen).not.toHaveBeenCalled()
  })
})
