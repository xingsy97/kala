import { useSyncExternalStore } from 'react'

type Listener = () => void

let minute = Math.floor(Date.now() / 60_000)
let timer: number | null = null
const listeners = new Set<Listener>()

function scheduleNextMinute(): void {
  if (listeners.size === 0 || typeof window === 'undefined') return
  const now = Date.now()
  const delay = 60_000 - now % 60_000 + 10
  timer = window.setTimeout(() => {
    timer = null
    minute = Math.floor(Date.now() / 60_000)
    for (const current of listeners) current()
    scheduleNextMinute()
  }, delay)
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener)
  if (timer === null && typeof window !== 'undefined') scheduleNextMinute()
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && timer !== null) {
      window.clearTimeout(timer)
      timer = null
    }
  }
}

export function useMinuteClock(): number {
  return useSyncExternalStore(subscribe, () => minute, () => minute)
}
