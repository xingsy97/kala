/**
 * React hook that owns the "hidden workspaces" UI preference.
 *
 * Reads the initial set from localStorage synchronously (so the sidebar never
 * flashes hidden workspaces on first paint) and keeps in-memory state in sync
 * with `storage` events fired by other browser tabs. Writes are persisted
 * immediately; the persistence failure path is swallowed because the feature
 * is a non-critical local preference - a full disk / private mode should not
 * break the sidebar.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'

import {
  HIDDEN_WORKSPACES_STORAGE_KEY,
  parseHiddenIds,
  serializeHiddenIds,
} from './hidden-workspaces.js'

export type UseHiddenWorkspaces = {
  hiddenIds: ReadonlySet<string>
  isHidden(workspaceId: string): boolean
  hide(workspaceId: string): void
  unhide(workspaceId: string): void
  count: number
}

function readInitial(): ReadonlySet<string> {
  if (typeof window === 'undefined') return new Set<string>()
  try {
    return parseHiddenIds(window.localStorage.getItem(HIDDEN_WORKSPACES_STORAGE_KEY))
  } catch {
    return new Set<string>()
  }
}

function persist(ids: ReadonlySet<string>): void {
  if (typeof window === 'undefined') return
  try {
    if (ids.size === 0) {
      window.localStorage.removeItem(HIDDEN_WORKSPACES_STORAGE_KEY)
    } else {
      window.localStorage.setItem(HIDDEN_WORKSPACES_STORAGE_KEY, serializeHiddenIds(ids))
    }
  } catch {
    // Local preference; ignore write failures.
  }
}

export function useHiddenWorkspaces(): UseHiddenWorkspaces {
  const [hiddenIds, setHiddenIds] = useState<ReadonlySet<string>>(() => readInitial())

  useEffect(() => {
    if (typeof window === 'undefined') return
    const onStorage = (event: StorageEvent): void => {
      if (event.key === null) {
        setHiddenIds(new Set<string>())
        return
      }
      if (event.key !== HIDDEN_WORKSPACES_STORAGE_KEY) return
      setHiddenIds(parseHiddenIds(event.newValue))
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const hide = useCallback((workspaceId: string): void => {
    if (!workspaceId) return
    setHiddenIds((prev) => {
      if (prev.has(workspaceId)) return prev
      const next = new Set(prev)
      next.add(workspaceId)
      persist(next)
      return next
    })
  }, [])

  const unhide = useCallback((workspaceId: string): void => {
    if (!workspaceId) return
    setHiddenIds((prev) => {
      if (!prev.has(workspaceId)) return prev
      const next = new Set(prev)
      next.delete(workspaceId)
      persist(next)
      return next
    })
  }, [])

  const isHidden = useCallback(
    (workspaceId: string): boolean => hiddenIds.has(workspaceId),
    [hiddenIds],
  )

  return useMemo(
    () => ({ hiddenIds, isHidden, hide, unhide, count: hiddenIds.size }),
    [hiddenIds, isHidden, hide, unhide],
  )
}
