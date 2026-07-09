import { useEffect, useState } from 'react'

/**
 * useTypewriter — reveals `text` one character at a time.
 *
 * - Resets when `text` changes.
 * - If the user prefers reduced motion, returns the full text immediately.
 * - Cadence: ~`charMs` per character; `startDelayMs` before the first char.
 * - `done` flips to true when the whole string is printed; callers can hide
 *   the trailing blinking cursor at that point.
 */
export function useTypewriter(
  text: string,
  { charMs = 28, startDelayMs = 60 }: { charMs?: number; startDelayMs?: number } = {},
): { visible: string; done: boolean } {
  const prefersReducedMotion = typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches

  const [visible, setVisible] = useState(prefersReducedMotion ? text : '')
  const [done, setDone] = useState(prefersReducedMotion || text.length === 0)

  useEffect(() => {
    if (prefersReducedMotion || text.length === 0) {
      setVisible(text)
      setDone(true)
      return
    }
    setVisible('')
    setDone(false)
    let i = 0
    const startTimer = window.setTimeout(function tick() {
      i += 1
      setVisible(text.slice(0, i))
      if (i >= text.length) {
        setDone(true)
        return
      }
      window.setTimeout(tick, charMs)
    }, startDelayMs)
    return () => {
      window.clearTimeout(startTimer)
    }
  }, [text, charMs, startDelayMs, prefersReducedMotion])

  return { visible, done }
}
