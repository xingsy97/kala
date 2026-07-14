/**
 * Virtualised transcript renderer used by [[ChatPanel]] and the nested view
 * inside [[SubAgentCard]]. Wraps `react-virtuoso` and exposes a narrow API
 * that owns the two behaviours ChatPanel used to hand-roll against
 * `[data-radix-scroll-area-viewport]`:
 *
 *   1. Pinned-to-bottom auto-follow. Virtuoso's `atBottomStateChange` +
 *      `followOutput` collapses the manual 64px threshold and RAF loops.
 *      When new items append, we only auto-scroll if the user is still
 *      pinned; if they scrolled up to read history we leave them alone.
 *   2. `highlightIndex` scroll-to. Callers (Inspector jump-to-message)
 *      set `highlightIndex` and we call `scrollToIndex`; the visual
 *      highlight itself is still painted by the caller's `renderItem`.
 *
 * We deliberately do NOT wrap the transcript in Radix ScrollArea anymore —
 * Virtuoso owns its own scroll container. The parent must give this
 * component a definite height (flex-1 min-h-0 inside a flex column, or an
 * explicit `h-*`) so the internal virtualiser has a viewport to measure
 * against.
 */

import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type HTMLAttributes } from 'react'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'

import { cn } from '../../lib/utils.js'

export type VirtualTranscriptHandle = {
  scrollToIndex: (index: number, opts?: { behavior?: 'auto' | 'smooth' }) => void
  scrollToBottom: () => void
}

function scrollVirtuosoToBottom(handle: VirtuosoHandle | null, itemCount: number): void {
  if (!handle) return
  handle.scrollToIndex({
    index: Math.max(itemCount - 1, 0),
    align: 'end',
    behavior: 'auto',
  })
  // The live status row ("Assistant is thinking", approvals, etc.) is a
  // Virtuoso Footer, not part of totalCount. scrollToIndex lands on the last
  // transcript item, so explicitly jump to the scroll container end as well;
  // otherwise footer-only changes can remain partially hidden.
  handle.scrollTo({ top: Number.MAX_SAFE_INTEGER, behavior: 'auto' })
}

type Props<Item> = {
  items: readonly Item[]
  renderItem: (item: Item, index: number) => JSX.Element
  keyFor: (item: Item, index: number) => string | number
  /** External auto-follow flag. Two-way bound via `onPinnedChange`. */
  pinnedToBottom: boolean
  onPinnedChange: (pinned: boolean) => void
  /** When this index changes we scroll to it. -1/null skip. */
  highlightIndex?: number | null
  /** Rendered after the last item, inside the scroll container. */
  footerSlot?: JSX.Element | null
  className?: string
  /** Wrapper padding so items inherit the same gutters as the old .map layout. */
  itemClassName?: string
  /**
   * Estimated row height in px. Only affects initial paint quality — actual
   * heights are measured. Set roughly to the median row so the initial
   * scrollbar isn't wildly off.
   */
  defaultItemHeight?: number
  /** Test hook. */
  dataTestId?: string
}

function VirtualTranscriptInner<Item>(
  {
    items,
    renderItem,
    keyFor,
    pinnedToBottom,
    onPinnedChange,
    highlightIndex,
    footerSlot,
    className,
    itemClassName,
    defaultItemHeight = 80,
    dataTestId,
  }: Props<Item>,
  ref: React.ForwardedRef<VirtualTranscriptHandle>,
): JSX.Element {
  const virtuoso = useRef<VirtuosoHandle | null>(null)

  useImperativeHandle(
    ref,
    () => ({
      scrollToIndex: (index, opts) => {
        virtuoso.current?.scrollToIndex({
          index,
          align: 'center',
          behavior: opts?.behavior ?? 'smooth',
        })
      },
      scrollToBottom: () => {
        scrollVirtuosoToBottom(virtuoso.current, items.length)
      },
    }),
    [items.length],
  )

  // Two-way pin: virtuoso reports `atBottom`, we forward it. When the
  // external `pinnedToBottom` flag flips true we auto-follow, otherwise
  // we don't.
  const handleAtBottomChange = useCallback(
    (atBottom: boolean) => {
      onPinnedChange(atBottom)
    },
    [onPinnedChange],
  )

  const followOutput = useCallback(
    (isAtBottom: boolean): 'smooth' | false => {
      if (pinnedToBottom && isAtBottom) return 'smooth'
      return false
    },
    [pinnedToBottom],
  )

  // Scroll to highlightIndex when it changes. Guard against out-of-range.
  const lastHighlight = useRef<number | null | undefined>(undefined)
  useEffect(() => {
    if (highlightIndex == null) return
    if (highlightIndex === lastHighlight.current) return
    lastHighlight.current = highlightIndex
    if (highlightIndex < 0 || highlightIndex >= items.length) return
    virtuoso.current?.scrollToIndex({
      index: highlightIndex,
      align: 'center',
      behavior: 'smooth',
    })
  }, [highlightIndex, items.length])

  useEffect(() => {
    if (!footerSlot || !pinnedToBottom) return
    scrollVirtuosoToBottom(virtuoso.current, items.length)
    let raf2 = 0
    const raf1 = requestAnimationFrame(() => {
      scrollVirtuosoToBottom(virtuoso.current, items.length)
      raf2 = requestAnimationFrame(() => scrollVirtuosoToBottom(virtuoso.current, items.length))
    })
    const timeouts = [
      window.setTimeout(() => scrollVirtuosoToBottom(virtuoso.current, items.length), 60),
      window.setTimeout(() => scrollVirtuosoToBottom(virtuoso.current, items.length), 180),
    ]
    return () => {
      cancelAnimationFrame(raf1)
      cancelAnimationFrame(raf2)
      for (const timeout of timeouts) window.clearTimeout(timeout)
    }
  }, [footerSlot, items.length, pinnedToBottom])

  const totalCount = items.length
  const itemContent = useCallback(
    (index: number): JSX.Element => {
      const item = items[index]
      if (item === undefined) return <div />
      return (
        <div className={itemClassName} data-virt-index={index}>
          {renderItem(item, index)}
        </div>
      )
    },
    [items, renderItem, itemClassName],
  )

  const components = useMemo(
    () => ({
      Scroller: forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function TranscriptScroller(props, scrollerRef) {
        return <div {...props} ref={scrollerRef} className={cn(props.className, 'virtual-transcript-scroller overflow-x-hidden')} data-virtuoso-scroller="true" />
      }),
      Footer: function TranscriptFooter({ context }: { context?: { slot: JSX.Element | null | undefined; itemClassName: string | undefined } }) {
        const slot = context?.slot
        const footerClassName = context?.itemClassName
        return slot ? <div className={footerClassName}>{slot}</div> : null
      },
    }),
    [],
  )

  const footerContext = useMemo(
    () => ({ slot: footerSlot, itemClassName }),
    [footerSlot, itemClassName],
  )

  return (
    <div className={cn('virtual-transcript min-h-0 min-w-0 max-w-full flex-1 overflow-x-hidden', className)} data-scroll-owner="virtuoso" data-testid={dataTestId}>
      <Virtuoso
        ref={virtuoso}
        style={{ height: '100%' }}
        totalCount={totalCount}
        itemContent={itemContent}
        computeItemKey={(index) => {
          const item = items[index]
          if (item === undefined) return `k-${index}`
          return String(keyFor(item, index))
        }}
        atBottomStateChange={handleAtBottomChange}
        followOutput={followOutput}
        atBottomThreshold={64}
        defaultItemHeight={defaultItemHeight}
        components={components}
        context={footerContext}
        increaseViewportBy={{ top: 400, bottom: 400 }}
      />
    </div>
  )
}

export const VirtualTranscript = forwardRef(VirtualTranscriptInner) as <Item>(
  props: Props<Item> & { ref?: React.ForwardedRef<VirtualTranscriptHandle> },
) => JSX.Element

// Re-export for consumers that need the type across forwardRef boundaries.
export type { VirtuosoHandle }

/**
 * A stubbable hook the two virtualised call sites share. We keep the initial
 * pin state defaulting to true (like the old app.tsx did) and expose a
 * one-shot reset — callers use it when the session changes.
 */
export function usePinnedToBottom(resetKey: unknown): {
  pinned: boolean
  setPinned: (v: boolean) => void
} {
  const [pinned, setPinned] = useState(true)
  useEffect(() => {
    setPinned(true)
  }, [resetKey])
  return { pinned, setPinned }
}
