import { useSyncExternalStore } from 'react'

type Listener = () => void

let minute = Math.floor(Date.now() / 60_000)
let timer: number | null = null
const listeners = new Set<Listener>()

function subscribe(listener: Listener): () => void {
  listeners.add(listener)
  if (timer === null && typeof window !== 'undefined') {
    timer = window.setInterval(() => {
      minute = Math.floor(Date.now() / 60_000)
      for (const current of listeners) current()
    }, 60_000)
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && timer !== null) {
      window.clearInterval(timer)
      timer = null
    }
  }
}

export function useMinuteClock(): number {
  return useSyncExternalStore(subscribe, () => minute, () => minute)
}
