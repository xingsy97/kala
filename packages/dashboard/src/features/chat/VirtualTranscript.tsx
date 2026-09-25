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
  scrollToIndex: (index: number, opts?: { behavior?: 'auto' | 'smooth'; align?: 'start' | 'center' | 'end' }) => void
  scrollToBottom: () => void
}

export type TranscriptViewportAnchor = { firstVisibleIndex: number | null; firstVisibleAligned: boolean }

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
  onViewportAnchorChange?: (anchor: TranscriptViewportAnchor) => void
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
    onViewportAnchorChange,
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
  const scrollerElement = useRef<HTMLDivElement | null>(null)
  const viewportMeasureRaf = useRef<number | null>(null)
  const indexAlignmentRaf = useRef<number | null>(null)
  const indexAlignmentGeneration = useRef(0)
  const lastViewportAnchor = useRef<TranscriptViewportAnchor>({ firstVisibleIndex: null, firstVisibleAligned: false })
  pinnedRef.current = pinnedToBottom
  if (!previousPinnedProp.current && pinnedToBottom) userUnpinnedRef.current = false
  previousPinnedProp.current = pinnedToBottom

  const measureViewportAnchor = useCallback(() => {
    viewportMeasureRaf.current = null
    const scroller = scrollerElement.current
    if (!scroller || !onViewportAnchorChange) return
    const viewport = scroller.getBoundingClientRect()
    const rows = Array.from(scroller.querySelectorAll<HTMLElement>('[data-virt-index]'))
      .map((element) => ({ index: Number(element.dataset.virtIndex), rect: element.getBoundingClientRect() }))
      .filter((row) => Number.isSafeInteger(row.index) && row.rect.bottom > viewport.top + 0.5 && row.rect.top < viewport.bottom - 0.5)
      .sort((a, b) => a.rect.top - b.rect.top || a.index - b.index)
    const first = rows[0]
    const next = { firstVisibleIndex: first?.index ?? null, firstVisibleAligned: Boolean(first && Math.abs(first.rect.top - viewport.top) <= 2) }
    const previous = lastViewportAnchor.current
    if (previous.firstVisibleIndex === next.firstVisibleIndex && previous.firstVisibleAligned === next.firstVisibleAligned) return
    lastViewportAnchor.current = next
    onViewportAnchorChange(next)
  }, [onViewportAnchorChange])

  const scheduleViewportMeasure = useCallback(() => {
    if (viewportMeasureRaf.current !== null) cancelAnimationFrame(viewportMeasureRaf.current)
    viewportMeasureRaf.current = requestAnimationFrame(measureViewportAnchor)
  }, [measureViewportAnchor])

  const alignRenderedIndexAtStart = useCallback((index: number) => {
    indexAlignmentGeneration.current += 1
    const generation = indexAlignmentGeneration.current
    if (indexAlignmentRaf.current !== null) cancelAnimationFrame(indexAlignmentRaf.current)
    let frame = 0
    let alignedFrames = 0
    const align = (): void => {
      if (generation !== indexAlignmentGeneration.current) return
      const scroller = scrollerElement.current
      const row = scroller?.querySelector<HTMLElement>(`[data-virt-index="${index}"]`)
      if (scroller && row) {
        const delta = row.getBoundingClientRect().top - scroller.getBoundingClientRect().top
        if (Math.abs(delta) <= 2) {
          alignedFrames += 1
          // Virtuoso can apply a delayed size correction after the requested
          // row first reaches the top. Keep ownership of the target for a few
          // frames so that correction cannot turn one click into a no-op that
          // needs to be repeated.
          if (alignedFrames >= 8) {
            measureViewportAnchor()
            indexAlignmentRaf.current = null
            return
          }
        } else {
          alignedFrames = 0
          scroller.scrollTop += delta
        }
      } else if (frame === 4 || frame === 12 || frame === 24 || frame === 48) {
        alignedFrames = 0
        virtuoso.current?.scrollToIndex({ index, align: 'start', behavior: 'auto' })
      }
      frame += 1
      if (frame < 90) indexAlignmentRaf.current = requestAnimationFrame(align)
      else indexAlignmentRaf.current = null
    }
    indexAlignmentRaf.current = requestAnimationFrame(align)
  }, [measureViewportAnchor])

  useImperativeHandle(
    ref,
    () => ({
      scrollToIndex: (index, opts) => {
        // Programmatic transcript navigation is explicit user intent too.
        // Flip the synchronous pin refs before asking Virtuoso to move: the
        // parent pin prop is committed on a later render, while a streaming
        // tail/footer resize can otherwise observe the stale `true` value and
        // immediately pull the viewport back to the bottom.
        userUnpinnedRef.current = true
        pinnedRef.current = false
        userScrollingTowardBottom.current = false
        const align = opts?.align ?? 'center'
        virtuoso.current?.scrollToIndex({ index, align, behavior: opts?.behavior ?? 'smooth' })
        if (align === 'start') alignRenderedIndexAtStart(index)
      },
      scrollToBottom: () => {
        userUnpinnedRef.current = false
        pinnedRef.current = true
        onPinnedChange(true)
        scrollVirtuosoToBottom(virtuoso.current)
      },
    }),
    [alignRenderedIndexAtStart, onPinnedChange],
  )

  useEffect(() => {
    scheduleViewportMeasure()
    return () => {
      if (viewportMeasureRaf.current !== null) cancelAnimationFrame(viewportMeasureRaf.current)
      if (indexAlignmentRaf.current !== null) cancelAnimationFrame(indexAlignmentRaf.current)
      indexAlignmentGeneration.current += 1
    }
  }, [items.length, scheduleViewportMeasure])

  // `atBottomStateChange` also fires when Virtuoso remeasures a row or its
  // viewport. Treat it as confirmation that an already-unpinned reader reached
  // the bottom, not as user intent to leave the bottom. Otherwise a layout
  // resize briefly reports false, mounts the go-to-bottom button, and can feed
  // another resize back into Virtuoso.
  const handleAtBottomChange = useCallback(
    (atBottom: boolean) => {
      if (!atBottom || userUnpinnedRef.current) return
      if (pinnedRef.current) return
      pinnedRef.current = true
      onPinnedChange(true)
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
    // Scroll input is the navigation reference. Measure synchronously so a
    // click in the same frame cannot observe the previous viewport anchor.
    measureViewportAnchor()
  }, [measureViewportAnchor, onPinnedChange, unpinFromUserScroll])

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
        const bindScroller = (element: HTMLDivElement | null): void => {
          scrollerElement.current = element
          if (typeof scrollerRef === 'function') scrollerRef(element)
          else if (scrollerRef) scrollerRef.current = element
          if (element) scheduleViewportMeasure()
        }
        return (
          <div
            {...props}
            ref={bindScroller}
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
    [handleScroll, handleTouchMove, handleTouchStart, handleWheel, scheduleViewportMeasure],
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
        rangeChanged={scheduleViewportMeasure}
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
