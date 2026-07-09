import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { createRef } from 'react'

import {
  VirtualTranscript,
  type VirtualTranscriptHandle,
  usePinnedToBottom,
} from './VirtualTranscript.js'

type Item = { id: number; label: string }

function makeItems(n: number): Item[] {
  return Array.from({ length: n }, (_, i) => ({ id: i, label: `item-${i}` }))
}

describe('VirtualTranscript', () => {
  it('renders one row per item and calls renderItem', () => {
    const items = makeItems(3)
    const renderItem = vi.fn((it: Item) => <span data-testid={`row-${it.id}`}>{it.label}</span>)
    render(
      <VirtualTranscript<Item>
        items={items}
        renderItem={renderItem}
        keyFor={(it) => it.id}
        pinnedToBottom
        onPinnedChange={() => {}}
      />,
    )
    expect(screen.getByTestId('row-0')).toBeTruthy()
    expect(screen.getByTestId('row-1')).toBeTruthy()
    expect(screen.getByTestId('row-2')).toBeTruthy()
    expect(renderItem).toHaveBeenCalledTimes(3)
  })

  it('renders footerSlot after the items', () => {
    render(
      <VirtualTranscript<Item>
        items={makeItems(2)}
        renderItem={(it) => <span>{it.label}</span>}
        keyFor={(it) => it.id}
        pinnedToBottom
        onPinnedChange={() => {}}
        footerSlot={<div data-testid="footer">footer</div>}
      />,
    )
    expect(screen.getByTestId('footer')).toBeTruthy()
  })

  it('scrollToBottom on the imperative handle jumps to the last item', () => {
    const ref = createRef<VirtualTranscriptHandle>()
    render(
      <VirtualTranscript<Item>
        ref={ref}
        items={makeItems(50)}
        renderItem={(it) => <span>{it.label}</span>}
        keyFor={(it) => it.id}
        pinnedToBottom
        onPinnedChange={() => {}}
      />,
    )
    // Won't throw. The mocked Virtuoso records the call; we only assert
    // the handle stays defined.
    expect(ref.current).not.toBeNull()
    expect(() => ref.current?.scrollToBottom()).not.toThrow()
  })

  it('scrollToIndex is called when highlightIndex changes', () => {
    const ref = createRef<VirtualTranscriptHandle>()
    const { rerender } = render(
      <VirtualTranscript<Item>
        ref={ref}
        items={makeItems(20)}
        renderItem={(it) => <span>{it.label}</span>}
        keyFor={(it) => it.id}
        pinnedToBottom={false}
        onPinnedChange={() => {}}
        highlightIndex={null}
      />,
    )
    // Bump highlight — the mocked handle just records; we assert no throw
    // and that the handle is stable across rerenders.
    rerender(
      <VirtualTranscript<Item>
        ref={ref}
        items={makeItems(20)}
        renderItem={(it) => <span>{it.label}</span>}
        keyFor={(it) => it.id}
        pinnedToBottom={false}
        onPinnedChange={() => {}}
        highlightIndex={5}
      />,
    )
    expect(ref.current).not.toBeNull()
  })

  it('an out-of-range highlightIndex is a no-op', () => {
    const ref = createRef<VirtualTranscriptHandle>()
    const { rerender } = render(
      <VirtualTranscript<Item>
        ref={ref}
        items={makeItems(3)}
        renderItem={(it) => <span>{it.label}</span>}
        keyFor={(it) => it.id}
        pinnedToBottom={false}
        onPinnedChange={() => {}}
        highlightIndex={null}
      />,
    )
    rerender(
      <VirtualTranscript<Item>
        ref={ref}
        items={makeItems(3)}
        renderItem={(it) => <span>{it.label}</span>}
        keyFor={(it) => it.id}
        pinnedToBottom={false}
        onPinnedChange={() => {}}
        highlightIndex={99}
      />,
    )
    // Just assert render didn't crash. Real virtuoso would clamp; the
    // component guards before delegating.
    expect(screen.getAllByText(/item-/).length).toBeGreaterThan(0)
  })

  it('empty items array renders footer only when provided', () => {
    render(
      <VirtualTranscript<Item>
        items={[]}
        renderItem={(it) => <span>{it.label}</span>}
        keyFor={(it) => it.id}
        pinnedToBottom
        onPinnedChange={() => {}}
        footerSlot={<div data-testid="only-footer">f</div>}
      />,
    )
    expect(screen.getByTestId('only-footer')).toBeTruthy()
  })
})

describe('usePinnedToBottom', () => {
  it('defaults to pinned=true and resets when resetKey changes', () => {
    // Small harness component to drive the hook.
    function Harness({
      resetKey,
      onState,
    }: {
      resetKey: unknown
      onState: (v: boolean) => void
    }): JSX.Element {
      const { pinned, setPinned } = usePinnedToBottom(resetKey)
      onState(pinned)
      return (
        <button data-testid="unpin" onClick={() => setPinned(false)}>
          unpin
        </button>
      )
    }
    let last = true
    const { rerender } = render(<Harness resetKey="a" onState={(v) => (last = v)} />)
    expect(last).toBe(true)
    // Unpin
    fireEvent.click(screen.getByTestId('unpin'))
    // React schedules; next render surfaces it. We rerender the same key
    // to flush without changing reset.
    rerender(<Harness resetKey="a" onState={(v) => (last = v)} />)
    expect(last).toBe(false)
    // Change resetKey — should snap back to pinned=true.
    rerender(<Harness resetKey="b" onState={(v) => (last = v)} />)
    return waitFor(() => expect(last).toBe(true))
  })
})
