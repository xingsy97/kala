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
 * We deliberately do NOT wrap the transcript in Radix ScrollArea anymore  - 
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
   * Estimated row height in px. Only affects initial paint quality  -  actual
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
        virtuoso.current?.scrollToIndex({
          index: Math.max(items.length - 1, 0),
          align: 'end',
          behavior: 'auto',
        })
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
        return <div {...props} ref={scrollerRef} className={cn(props.className, 'virtual-transcript-scroller')} data-virtuoso-scroller="true" />
      }),
      Footer: footerSlot ? () => <div className={itemClassName}>{footerSlot}</div> : undefined,
    }),
    [footerSlot, itemClassName],
  )

  return (
    <div className={cn('virtual-transcript min-h-0 flex-1', className)} data-scroll-owner="virtuoso" data-testid={dataTestId}>
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
 * one-shot reset  -  callers use it when the session changes.
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
