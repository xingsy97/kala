import { useCallback, useEffect, useRef, useState } from 'react'
import type { SessionPreviewAnchor } from './SessionHoverPreview.js'

export function useSessionHoverPreview(selectedSessionId: string | null) {
  const [anchor, setAnchor] = useState<SessionPreviewAnchor | null>(null)
  const anchorRef = useRef<SessionPreviewAnchor | null>(null)
  const closeTimer = useRef<number | null>(null)
  const explorerRef = useRef<HTMLDivElement>(null)
  const previewRef = useRef<HTMLDivElement>(null)

  const cancelClose = useCallback(() => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current)
    closeTimer.current = null
  }, [])
  const dismiss = useCallback(() => {
    cancelClose()
    anchorRef.current = null
    setAnchor(null)
  }, [cancelClose])
  const leave = useCallback((sessionId?: string) => {
    if (!anchorRef.current || (sessionId !== undefined && anchorRef.current.sessionId !== sessionId)) return
    if (closeTimer.current !== null) return
    closeTimer.current = window.setTimeout(dismiss, 80)
  }, [dismiss])
  const enter = useCallback((next: SessionPreviewAnchor | null) => {
    cancelClose()
    anchorRef.current = next
    setAnchor((current) => current?.sessionId === next?.sessionId ? current : next)
  }, [cancelClose])
  const hoverPreview = useCallback((hovering: boolean) => {
    if (hovering) cancelClose()
    else leave()
  }, [cancelClose, leave])

  // Selection remains the teardown boundary: changing tree state during
  // mousedown can replace the row before the browser dispatches its click.
  useEffect(dismiss, [dismiss, selectedSessionId])
  useEffect(() => cancelClose, [cancelClose])

  useEffect(() => {
    if (!anchor) return
    const explorer = explorerRef.current
    const ownsPointer = (target: EventTarget | null): boolean => {
      if (!(target instanceof Element)) return false
      if (previewRef.current?.contains(target)) return true
      const row = target.closest('[data-session-id]')
      return !!row && !!explorer?.contains(row) && row.getAttribute('data-session-id') === anchorRef.current?.sessionId
    }
    // react-arborist may replace a hovered row without delivering pointerleave.
    // Track the actual pointer target independently of that row's React lifetime.
    const move = (event: PointerEvent): void => {
      if (ownsPointer(event.target)) cancelClose()
      else leave()
    }
    const exitWindow = (event: PointerEvent): void => {
      if (event.relatedTarget === null) dismiss()
    }
    const scroll = (event: Event): void => {
      if (event.target instanceof Node && previewRef.current?.contains(event.target)) return
      dismiss()
    }
    const visibility = (): void => {
      if (document.visibilityState === 'hidden') dismiss()
    }
    const observer = new MutationObserver(() => {
      const row = Array.from(explorer?.querySelectorAll<HTMLElement>('[data-testid="session-row"]') ?? [])
        .find((element) => element.dataset.sessionId === anchorRef.current?.sessionId)
      if (!row) dismiss()
    })
    if (explorer) observer.observe(explorer, { childList: true, subtree: true })
    document.addEventListener('pointermove', move, true)
    document.addEventListener('pointerout', exitWindow, true)
    document.addEventListener('pointercancel', dismiss, true)
    document.addEventListener('visibilitychange', visibility)
    window.addEventListener('blur', dismiss)
    window.addEventListener('resize', dismiss)
    window.addEventListener('scroll', scroll, true)
    return () => {
      observer.disconnect()
      document.removeEventListener('pointermove', move, true)
      document.removeEventListener('pointerout', exitWindow, true)
      document.removeEventListener('pointercancel', dismiss, true)
      document.removeEventListener('visibilitychange', visibility)
      window.removeEventListener('blur', dismiss)
      window.removeEventListener('resize', dismiss)
      window.removeEventListener('scroll', scroll, true)
    }
  }, [anchor, cancelClose, dismiss, leave])

  return { anchor, enter, leave, hoverPreview, explorerRef, previewRef }
}
