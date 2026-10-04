import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { Bell, ChevronRight, CircleAlert, LoaderCircle, X } from 'lucide-react'

import {
  createScheduledTasksClient,
  type ScheduledTaskInbox as ScheduledTaskInboxSnapshot,
  type ScheduledTaskInboxItem,
} from '../../scheduled-tasks-client.js'

const POLL_INTERVAL_MS = 30_000
const MAX_VISIBLE_ITEMS = 5
const POPOVER_WIDTH = 320
const VIEWPORT_MARGIN = 8

export type ScheduledTaskInboxProps = {
  host: string
  token?: string
  onOpenTask: (taskId: string) => void
}

type InboxState = ScheduledTaskInboxSnapshot & {
  identity: string
  loading: boolean
  error: string | null
}

const emptyState = (identity: string): InboxState => ({
  identity,
  items: [],
  unreadCount: 0,
  loading: true,
  error: null,
})

const statusDetails: Record<ScheduledTaskInboxItem['status'], { label: string; className: string }> = {
  enqueued: { label: 'Run started', className: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' },
  failed: { label: 'Run failed', className: 'bg-destructive/10 text-destructive' },
  needs_review: { label: 'Needs review', className: 'bg-amber-500/10 text-amber-700 dark:text-amber-300' },
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === 'AbortError'
}

function formatScheduledTime(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

export function ScheduledTaskInbox({ host, token, onOpenTask }: ScheduledTaskInboxProps) {
  const identity = `${host}\u0000${token ?? ''}`
  const client = useMemo(() => createScheduledTasksClient({ host, token }), [host, token])
  const [state, setState] = useState<InboxState>(() => emptyState(identity))
  const [open, setOpen] = useState(false)
  const [page, setPage] = useState(0)
  const [popoverStyle, setPopoverStyle] = useState<CSSProperties>({ position: 'fixed', top: VIEWPORT_MARGIN, left: VIEWPORT_MARGIN, width: POPOVER_WIDTH })
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const generationRef = useRef(0)
  const pendingSeenRef = useRef(new Set<string>())
  const acknowledgementControllersRef = useRef(new Set<AbortController>())

  const currentState = state.identity === identity ? state : emptyState(identity)
  const visibleItems = currentState.items.slice(page * MAX_VISIBLE_ITEMS, (page + 1) * MAX_VISIBLE_ITEMS)

  useEffect(() => {
    const generation = ++generationRef.current
    let disposed = false
    let requestController: AbortController | null = null

    setState(emptyState(identity))

    const load = async () => {
      requestController?.abort()
      const controller = new AbortController()
      requestController = controller
      try {
        const result = await client.inbox({ signal: controller.signal })
        if (disposed || generationRef.current !== generation) return
        setState({ identity, ...result, loading: false, error: null })
      } catch (error) {
        if (disposed || generationRef.current !== generation || isAbortError(error)) return
        setState((previous) => previous.identity === identity
          ? { ...previous, loading: false, error: error instanceof Error ? error.message : 'Could not load scheduled runs' }
          : previous)
      }
    }

    void load()
    const interval = window.setInterval(() => { void load() }, POLL_INTERVAL_MS)

    return () => {
      disposed = true
      window.clearInterval(interval)
      requestController?.abort()
      for (const controller of acknowledgementControllersRef.current) controller.abort()
      acknowledgementControllersRef.current.clear()
      pendingSeenRef.current.clear()
    }
  }, [client, identity])

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current
    if (!trigger) return
    const rect = trigger.getBoundingClientRect()
    const maxLeft = Math.max(VIEWPORT_MARGIN, window.innerWidth - POPOVER_WIDTH - VIEWPORT_MARGIN)
    setPopoverStyle({
      position: 'fixed',
      top: Math.min(rect.bottom + VIEWPORT_MARGIN, Math.max(VIEWPORT_MARGIN, window.innerHeight - VIEWPORT_MARGIN)),
      left: Math.max(VIEWPORT_MARGIN, Math.min(rect.right - POPOVER_WIDTH, maxLeft)),
      width: POPOVER_WIDTH,
    })
  }, [])

  useEffect(() => {
    if (!open) return
    updatePosition()
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (!triggerRef.current?.contains(target) && !popoverRef.current?.contains(target)) setOpen(false)
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false)
        triggerRef.current?.focus()
      }
    }
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open, updatePosition])

  const unseenVisibleIds = open ? visibleItems.filter((item) => !item.seen).map((item) => item.occurrenceId) : []
  const acknowledgementKey = unseenVisibleIds.join('\u0000')

  useEffect(() => {
    if (!open || !acknowledgementKey) return
    const occurrenceIds = acknowledgementKey.split('\u0000')
    const pendingKeys = occurrenceIds.map((occurrenceId) => `${identity}\u0000${occurrenceId}`)
    const newIds = occurrenceIds.filter((_, index) => !pendingSeenRef.current.has(pendingKeys[index]!))
    if (newIds.length === 0) return

    const controller = new AbortController()
    const generation = generationRef.current
    const ownPendingKeys = newIds.map((occurrenceId) => `${identity}\u0000${occurrenceId}`)
    ownPendingKeys.forEach((key) => pendingSeenRef.current.add(key))
    acknowledgementControllersRef.current.add(controller)

    void client.markInboxSeen(newIds, { signal: controller.signal }).then((result) => {
      if (generationRef.current !== generation) return
      const acknowledged = new Set(result.acknowledged)
      setState((previous) => previous.identity === identity ? {
        ...previous,
        unreadCount: result.unreadCount,
        items: previous.items.map((item) => acknowledged.has(item.occurrenceId) ? { ...item, seen: true } : item),
      } : previous)
    }).catch((error: unknown) => {
      if (!isAbortError(error) && generationRef.current === generation) {
        setState((previous) => previous.identity === identity
          ? { ...previous, error: error instanceof Error ? error.message : 'Could not mark scheduled runs as seen' }
          : previous)
      }
    }).finally(() => {
      acknowledgementControllersRef.current.delete(controller)
      ownPendingKeys.forEach((key) => pendingSeenRef.current.delete(key))
    })
  }, [acknowledgementKey, client, identity, open])

  const unreadLabel = currentState.unreadCount === 1 ? '1 unread' : `${currentState.unreadCount} unread`
  const popover = open && typeof document !== 'undefined' ? createPortal(
    <div
      ref={popoverRef}
      id="scheduled-task-inbox-popover"
      role="dialog"
      aria-modal="false"
      aria-labelledby="scheduled-task-inbox-title"
      className="z-[100] overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-xl"
      style={popoverStyle}
    >
      <div className="flex items-center justify-between border-b border-border px-3 py-2.5">
        <div className="min-w-0">
          <h2 id="scheduled-task-inbox-title" className="text-sm font-semibold">Scheduled runs</h2>
          {currentState.unreadCount > 0 ? <p className="text-xs text-muted-foreground">{unreadLabel}</p> : null}
        </div>
        <button type="button" className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label="Close scheduled runs" onClick={() => setOpen(false)}>
          <X className="size-4" aria-hidden="true" />
        </button>
      </div>

      <div className="max-h-[22rem] overflow-y-auto p-1.5">
        {currentState.loading ? (
          <div role="status" className="flex items-center justify-center gap-2 px-3 py-8 text-sm text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> Loading scheduled runs
          </div>
        ) : currentState.error && currentState.items.length === 0 ? (
          <div role="alert" className="flex gap-2 px-3 py-6 text-sm text-destructive">
            <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>{currentState.error}</span>
          </div>
        ) : visibleItems.length === 0 ? (
          <p className="px-3 py-8 text-center text-sm text-muted-foreground">No recent scheduled runs</p>
        ) : (
          <>
            {visibleItems.map((item) => {
              const details = statusDetails[item.status]
              return (
                <button
                  key={item.occurrenceId}
                  type="button"
                  className="group flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => {
                    setOpen(false)
                    onOpenTask(item.taskId)
                  }}
                >
                  <span className={`size-2 shrink-0 rounded-full ${item.seen ? 'bg-muted-foreground/30' : 'bg-primary'}`} aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${details.className}`}>{details.label}</span>
                    </span>
                    <span className="mt-1 block truncate text-xs text-muted-foreground">{formatScheduledTime(item.scheduledFor)}</span>
                  </span>
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground group-hover:text-foreground" aria-hidden="true" />
                </button>
              )
            })}
            {currentState.items.length > MAX_VISIBLE_ITEMS ? (
              <div className="flex items-center justify-between border-t border-border px-2.5 py-2 text-xs">
                <button type="button" disabled={page === 0} onClick={() => setPage((value) => value - 1)} className="text-primary disabled:text-muted-foreground">Newer</button>
                <span className="text-muted-foreground">{page * MAX_VISIBLE_ITEMS + 1}–{Math.min((page + 1) * MAX_VISIBLE_ITEMS, currentState.items.length)} / {currentState.items.length}</span>
                <button type="button" disabled={(page + 1) * MAX_VISIBLE_ITEMS >= currentState.items.length} onClick={() => setPage((value) => value + 1)} className="text-primary disabled:text-muted-foreground">Older</button>
              </div>
            ) : null}
            {currentState.error ? <p role="alert" className="px-2.5 py-2 text-xs text-destructive">{currentState.error}</p> : null}
          </>
        )}
      </div>
    </div>,
    document.body,
  ) : null

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="relative inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={`Scheduled run inbox, ${unreadLabel}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="scheduled-task-inbox-popover"
        onClick={() => { if (!open) setPage(0); setOpen((value) => !value) }}
      >
        <Bell className="size-4" aria-hidden="true" />
        {currentState.unreadCount > 0 ? (
          <span className="absolute right-1 top-1 size-2 rounded-full bg-destructive ring-2 ring-background" aria-hidden="true" />
        ) : null}
      </button>
      {popover}
    </>
  )
}
