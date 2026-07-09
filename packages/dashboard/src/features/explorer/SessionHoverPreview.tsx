import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { ChatPanel } from '../chat/ChatPanel.js'
import { visibleTranscript } from '../../transcript.js'
import type { CachedSessionView } from '../../session-view-cache.js'
import { cn } from '../../lib/utils.js'

export type SessionPreviewAnchor = {
  sessionId: string
  label: string
  rect: DOMRect
}

type Props = {
  anchor: SessionPreviewAnchor | null
  getCachedSessionView?: (sessionId: string) => CachedSessionView | null
  onHoverChange(hovering: boolean): void
}

export function SessionHoverPreview({ anchor, getCachedSessionView, onHoverChange }: Props): JSX.Element | null {
  const [ready, setReady] = useState(false)
  const timerRef = useRef<number | null>(null)

  useEffect(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
    setReady(false)
    if (!anchor || !getCachedSessionView) return
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      setReady(true)
    }, 350)
    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [anchor, getCachedSessionView])

  const cached = useMemo(() => {
    if (!ready || !anchor || !getCachedSessionView) return null
    const entry = getCachedSessionView(anchor.sessionId)
    if (!entry || entry.hydratedSessionId !== anchor.sessionId) return null
    if (!entry.state || !entry.config) return null
    if (entry.timeline.length === 0 && entry.state.messages.filter((message) => message.role !== 'system').length === 0) return null
    return entry
  }, [anchor, getCachedSessionView, ready])

  if (!anchor || !cached) return null

  const position = previewPosition(anchor.rect)
  const items = visibleTranscript(cached.state?.messages ?? [], cached.timeline, '', [], cached.queuedMessages, {
    includeStatePrefix: cached.parentSessionId !== null,
  })

  return createPortal(
    <div
      className={cn(
        'fixed z-50 flex h-[min(42rem,calc(100vh-2rem))] w-[min(44rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-lg border border-border bg-background shadow-2xl',
        'ring-1 ring-black/5 dark:ring-white/10',
      )}
      style={{ left: position.left, top: position.top }}
      data-testid="session-hover-preview"
      onPointerEnter={() => onHoverChange(true)}
      onPointerLeave={() => onHoverChange(false)}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <div className="flex h-9 flex-none items-center justify-between gap-3 border-b border-border bg-muted/40 px-3">
        <div className="min-w-0 truncate text-xs font-semibold text-foreground" title={anchor.label}>{anchor.label}</div>
        <div className="min-w-0 truncate font-mono text-[10px] text-muted-foreground" title={cached.selectedModel ?? undefined}>{cached.selectedModel ?? ''}</div>
      </div>
      <div className="min-h-0 flex-1 bg-background" data-testid="session-hover-preview-chat">
        <ChatPanel
          items={items}
          pinnedToBottom
          onPinnedChange={() => {}}
          displayPrefs={{ fontSize: 0, contentWidth: 0, sideSpace: 0, lineHeight: 0, mathScale: 0 }}
          liveToolActivityTailCount={3}
        />
      </div>
    </div>,
    document.body,
  )
}

function previewPosition(rect: DOMRect): { left: number; top: number } {
  const width = Math.min(704, window.innerWidth - 32)
  const height = Math.min(672, window.innerHeight - 32)
  const gap = 8
  const rightSideLeft = rect.right + gap
  const left = rightSideLeft + width <= window.innerWidth - 8
    ? rightSideLeft
    : Math.max(8, rect.left - gap - width)
  const top = Math.min(Math.max(8, rect.top - 8), Math.max(8, window.innerHeight - height - 8))
  return { left, top }
}
