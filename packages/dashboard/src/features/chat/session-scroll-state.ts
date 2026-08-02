import { useCallback, useState } from 'react'

export type SessionScrollState = {
  pinned: boolean
}

const states = new Map<string, SessionScrollState>()

export function readSessionScrollState(sessionId: string | null): SessionScrollState {
  if (!sessionId) return { pinned: true }
  return states.get(sessionId) ?? { pinned: true }
}

export function writeSessionScrollState(sessionId: string | null, state: SessionScrollState): void {
  if (!sessionId) return
  states.set(sessionId, state)
}

export function deleteSessionScrollState(sessionId: string): void {
  states.delete(sessionId)
}

export function useSessionPinnedState(sessionId: string | null): {
  pinned: boolean
  setPinned(pinned: boolean): void
} {
  const [selection, setSelection] = useState(() => ({
    sessionId,
    pinned: readSessionScrollState(sessionId).pinned,
  }))
  const effective = selection.sessionId === sessionId
    ? selection
    : { sessionId, pinned: readSessionScrollState(sessionId).pinned }
  const setPinned = useCallback((pinned: boolean): void => {
    writeSessionScrollState(sessionId, { pinned })
    setSelection({ sessionId, pinned })
  }, [sessionId])
  return { pinned: effective.pinned, setPinned }
}

export function clearSessionScrollStatesForTest(): void {
  states.clear()
}
