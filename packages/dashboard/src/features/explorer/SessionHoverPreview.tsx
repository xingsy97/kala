import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Wrench } from 'lucide-react'

import type { CachedSessionView } from '../../session-view-cache.js'
import { cn } from '../../lib/utils.js'
import { useSessionPreview, type SessionPreviewStore } from './session-preview-store.js'
import { projectSessionPreviewItems, type SessionPreviewItem } from './session-preview-items.js'

export type SessionPreviewAnchor = {
  sessionId: string
  label: string
  rect: DOMRect
}

type Props = {
  anchor: SessionPreviewAnchor | null
  previewStore?: SessionPreviewStore
  getCachedSessionView?: (sessionId: string) => CachedSessionView | null
  subscribeCachedSessionView?: (sessionId: string, listener: () => void) => () => void
  onHoverChange(hovering: boolean): void
}

export function SessionHoverPreview({ anchor, previewStore, getCachedSessionView, subscribeCachedSessionView, onHoverChange }: Props): JSX.Element | null {
  const [ready, setReady] = useState(false)
  const timerRef = useRef<number | null>(null)

  useEffect(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    setReady(false)
    if (!anchor || (!previewStore && !getCachedSessionView)) return
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      setReady(true)
    }, 50)
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [anchor?.sessionId, getCachedSessionView, previewStore])

  useEffect(() => {
    if (!ready || !anchor || !previewStore) return
    return previewStore.watch(anchor.sessionId)
  }, [anchor?.sessionId, previewStore, ready])

  const [cacheVersion, setCacheVersion] = useState(0)
  useEffect(() => {
    if (!ready || !anchor || previewStore || !subscribeCachedSessionView) return
    return subscribeCachedSessionView(anchor.sessionId, () => setCacheVersion((version) => version + 1))
  }, [anchor?.sessionId, previewStore, ready, subscribeCachedSessionView])

  const snapshot = useSessionPreview(previewStore, ready ? anchor?.sessionId ?? null : null)
  const cached = snapshot?.view ?? (ready && anchor ? getCachedSessionView?.(anchor.sessionId) ?? null : null)
  const items = useMemo(
    () => cached?.state ? projectSessionPreviewItems(cached.state.messages, cached.timeline, snapshot?.streamingText ?? '') : [],
    [cached?.state?.messages, cached?.timeline, snapshot?.streamingText, cacheVersion],
  )

  if (!anchor || !cached || cached.hydratedSessionId !== anchor.sessionId || items.length === 0) return null

  const position = previewPosition(anchor.rect)
  const previewHeight = Math.min(520, Math.max(220, 64 + items.length * 52))

  return createPortal(
    <div
      className={cn(
        'fixed z-50 flex max-h-[min(42rem,calc(100vh-2rem))] min-h-0 w-[min(40rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border border-border/70 bg-popover text-popover-foreground shadow-2xl',
        'ring-1 ring-black/5 dark:ring-white/10',
      )}
      style={{ left: position.left, top: position.top, height: previewHeight }}
      data-testid="session-hover-preview"
      onPointerEnter={() => onHoverChange(true)}
      onPointerLeave={() => onHoverChange(false)}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <div className="flex h-10 flex-none items-center justify-between gap-3 border-b border-border/70 bg-muted/30 px-3">
        <div className="min-w-0 truncate text-xs font-semibold" title={anchor.label}>{anchor.label}</div>
        <div className="flex min-w-0 items-center gap-2 font-mono text-[10px] text-muted-foreground">
          <span className={cn('h-1.5 w-1.5 rounded-full', snapshot?.freshness === 'live' ? 'bg-emerald-500' : snapshot?.freshness === 'stale' ? 'bg-amber-500' : 'bg-slate-400')} aria-hidden="true" />
          <span data-testid="session-hover-preview-freshness">{snapshot?.freshness ?? 'cached'}</span>
          <span className="min-w-0 truncate" title={cached.selectedModel ?? undefined}>{cached.selectedModel ?? ''}</span>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2" data-testid="session-hover-preview-summary">
        <div className="grid gap-1.5">
          {items.map((item) => <PreviewRow key={item.id} item={item} />)}
        </div>
      </div>
    </div>,
    document.body,
  )
}

function PreviewRow({ item }: { item: SessionPreviewItem }): JSX.Element {
  return (
    <div
      className={cn(
        'grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-2 rounded-md px-2 py-1.5 text-[11px]',
        item.kind === 'omitted' && 'border border-dashed border-border/70 bg-muted/35',
        item.kind !== 'omitted' && item.role === 'user' && 'bg-sky-500/8',
        item.tone === 'danger' && 'bg-rose-500/10 text-rose-800 dark:text-rose-200',
      )}
      data-preview-kind={item.kind}
      data-testid={item.kind === 'omitted' ? 'session-preview-complex-omitted' : 'session-preview-row'}
    >
      <span className={cn(
        'inline-flex h-5 max-w-28 items-center gap-1 rounded bg-background/80 px-1.5 font-mono text-[9px] font-medium uppercase tracking-wider text-muted-foreground ring-1 ring-border/50',
        item.tone === 'success' && 'text-emerald-700 dark:text-emerald-300',
        item.tone === 'danger' && 'text-rose-700 dark:text-rose-300',
      )}>
        {item.kind === 'tool_call' ? <Wrench className="h-2.5 w-2.5" aria-hidden="true" /> : null}
        <span className="truncate">{item.label}</span>
      </span>
      <span className="min-w-0 whitespace-pre-wrap break-words leading-5 [overflow-wrap:anywhere]">{item.text}</span>
    </div>
  )
}

function previewPosition(rect: DOMRect): { left: number; top: number } {
  const width = Math.min(640, window.innerWidth - 32)
  const height = Math.min(672, window.innerHeight - 32)
  const gap = 8
  const rightSideLeft = rect.right + gap
  const left = rightSideLeft + width <= window.innerWidth - 8
    ? rightSideLeft
    : Math.max(8, rect.left - gap - width)
  const top = Math.min(Math.max(8, rect.top - 8), Math.max(8, window.innerHeight - height - 8))
  return { left, top }
}
