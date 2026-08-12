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

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type HTMLAttributes,
  type TouchEvent,
  type WheelEvent,
} from 'react'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'

import { cn } from '../../lib/utils.js'

export type VirtualTranscriptHandle = {
  scrollToIndex: (index: number, opts?: { behavior?: 'auto' | 'smooth' }) => void
  scrollToBottom: () => void
}

function scrollVirtuosoToBottom(handle: VirtuosoHandle | null): void {
  if (!handle) return
  // One command is enough. Combining scrollToIndex with scrollTo made two
  // independent Virtuoso measurements fight during live row/footer resizing.
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
  const pinnedRef = useRef(pinnedToBottom)
  const userUnpinnedRef = useRef(!pinnedToBottom)
  const previousPinnedProp = useRef(pinnedToBottom)
  const touchStartY = useRef<number | null>(null)
  const lastScrollTop = useRef(0)
  const pointerScrollActive = useRef(false)
  const userScrollingTowardBottom = useRef(false)
  const footerObserver = useRef<ResizeObserver | null>(null)
  const footerSettleRafs = useRef<number[]>([])
  const footerSettleTimers = useRef<number[]>([])
  pinnedRef.current = pinnedToBottom
  if (!previousPinnedProp.current && pinnedToBottom) userUnpinnedRef.current = false
  previousPinnedProp.current = pinnedToBottom

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
        userUnpinnedRef.current = false
        pinnedRef.current = true
        onPinnedChange(true)
        scrollVirtuosoToBottom(virtuoso.current)
      },
    }),
    [onPinnedChange],
  )

  // Two-way pin: virtuoso reports `atBottom`, we forward it. When the
  // external `pinnedToBottom` flag flips true we auto-follow, otherwise
  // we don't.
  const handleAtBottomChange = useCallback(
    (atBottom: boolean) => {
      // A ResizeObserver pass can report a stale `true` immediately after the
      // user starts scrolling upward. Never let that overwrite explicit user
      // intent; only a real downward scroll reaching the bottom clears the lock.
      if (atBottom && userUnpinnedRef.current) return
      pinnedRef.current = atBottom
      onPinnedChange(atBottom)
    },
    [onPinnedChange],
  )

  const unpinFromUserScroll = useCallback(() => {
    userUnpinnedRef.current = true
    userScrollingTowardBottom.current = false
    if (!pinnedRef.current) return
    pinnedRef.current = false
    onPinnedChange(false)
  }, [onPinnedChange])

  const handleWheel = useCallback(
    (event: WheelEvent<HTMLDivElement>) => {
      userScrollingTowardBottom.current = event.deltaY > 0
      if (event.deltaY < 0) unpinFromUserScroll()
    },
    [unpinFromUserScroll],
  )

  const handleTouchStart = useCallback((event: TouchEvent<HTMLDivElement>) => {
    touchStartY.current = event.touches[0]?.clientY ?? null
  }, [])

  const handleTouchMove = useCallback(
    (event: TouchEvent<HTMLDivElement>) => {
      const startY = touchStartY.current
      const currentY = event.touches[0]?.clientY
      if (startY == null || currentY == null) return
      userScrollingTowardBottom.current = currentY < startY - 8
      if (currentY - startY > 8) unpinFromUserScroll()
    },
    [unpinFromUserScroll],
  )

  const handleScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    const scroller = event.currentTarget
    const next = scroller.scrollTop
    const distanceFromBottom = scroller.scrollHeight - scroller.clientHeight - next
    if (pointerScrollActive.current && next < lastScrollTop.current - 1) unpinFromUserScroll()
    if (userUnpinnedRef.current && userScrollingTowardBottom.current && distanceFromBottom <= 8) {
      userUnpinnedRef.current = false
      pinnedRef.current = true
      userScrollingTowardBottom.current = false
      onPinnedChange(true)
    }
    lastScrollTop.current = next
  }, [onPinnedChange, unpinFromUserScroll])

  const followOutput = useCallback(
    (isAtBottom: boolean): 'auto' | false => {
      // Read the ref rather than the render-time prop: wheel/touch/scrollbar
      // input unpins synchronously, before React commits the parent update.
      // `auto` also avoids a queue of smooth-scroll animations fighting the
      // user while high-frequency streaming updates resize the live tail.
      if (pinnedRef.current && isAtBottom) return 'auto'
      return false
    },
    [],
  )

  // The footer is outside Virtuoso's totalCount. Its content can change from
  // Thinking to a taller "Preparing next step" after the send token's retries
  // have finished, and Virtuoso then corrects its measurements asynchronously.
  // Observe the actual footer box and settle across those measurement turns.
  const cancelFooterSettle = useCallback(() => {
    for (const raf of footerSettleRafs.current) cancelAnimationFrame(raf)
    for (const timer of footerSettleTimers.current) window.clearTimeout(timer)
    footerSettleRafs.current = []
    footerSettleTimers.current = []
  }, [])
  const settlePinnedFooter = useCallback(() => {
    cancelFooterSettle()
    // `atBottom=false` can be a transient Virtuoso measurement while the footer
    // grows. Only explicit wheel/touch/scrollbar intent may disable following.
    if (userUnpinnedRef.current) return
    const scroll = (): void => {
      if (!userUnpinnedRef.current) scrollVirtuosoToBottom(virtuoso.current)
    }
    scroll()
    footerSettleRafs.current.push(requestAnimationFrame(() => {
      scroll()
      footerSettleRafs.current.push(requestAnimationFrame(scroll))
    }))
    footerSettleTimers.current = [60, 180, 360].map((ms) => window.setTimeout(scroll, ms))
  }, [cancelFooterSettle])
  const bindFooterElement = useCallback((element: HTMLDivElement | null) => {
    footerObserver.current?.disconnect()
    footerObserver.current = null
    if (!element || typeof ResizeObserver === 'undefined') return
    let previousHeight = element.getBoundingClientRect().height
    const observer = new ResizeObserver(() => {
      const nextHeight = element.getBoundingClientRect().height
      if (Math.abs(nextHeight - previousHeight) < 0.5) return
      previousHeight = nextHeight
      settlePinnedFooter()
    })
    observer.observe(element)
    footerObserver.current = observer
  }, [settlePinnedFooter])
  const hasFooter = Boolean(footerSlot)
  const hadFooter = useRef(hasFooter)
  const previousFooterSlot = useRef(footerSlot)
  useEffect(() => {
    const contentChanged = footerSlot !== previousFooterSlot.current
    if (hasFooter && (!hadFooter.current || contentChanged)) settlePinnedFooter()
    hadFooter.current = hasFooter
    previousFooterSlot.current = footerSlot
  }, [footerSlot, hasFooter, settlePinnedFooter])
  useEffect(() => () => {
    footerObserver.current?.disconnect()
    cancelFooterSettle()
  }, [cancelFooterSettle])

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
        return (
          <div
            {...props}
            ref={scrollerRef}
            className={cn(props.className, 'virtual-transcript-scroller overflow-x-hidden')}
            data-virtuoso-scroller="true"
            onPointerDown={(event) => {
              props.onPointerDown?.(event)
              pointerScrollActive.current = true
            }}
            onPointerUp={(event) => {
              props.onPointerUp?.(event)
              pointerScrollActive.current = false
            }}
            onPointerCancel={(event) => {
              props.onPointerCancel?.(event)
              pointerScrollActive.current = false
            }}
            onScroll={(event) => {
              props.onScroll?.(event)
              handleScroll(event)
            }}
            onTouchMove={(event) => {
              props.onTouchMove?.(event)
              handleTouchMove(event)
            }}
            onTouchStart={(event) => {
              props.onTouchStart?.(event)
              handleTouchStart(event)
            }}
            onWheel={(event) => {
              props.onWheel?.(event)
              handleWheel(event)
            }}
          />
        )
      }),
      Footer: function TranscriptFooter({ context }: { context?: { slot: JSX.Element | null | undefined; itemClassName: string | undefined; bindFooterElement: (element: HTMLDivElement | null) => void } }) {
        const slot = context?.slot
        const footerClassName = context?.itemClassName
        return slot ? <div ref={context?.bindFooterElement} className={footerClassName}>{slot}</div> : null
      },
    }),
    [handleScroll, handleTouchMove, handleTouchStart, handleWheel],
  )

  const footerContext = useMemo(
    () => ({ slot: footerSlot, itemClassName, bindFooterElement }),
    [bindFooterElement, footerSlot, itemClassName],
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
        atBottomThreshold={8}
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
