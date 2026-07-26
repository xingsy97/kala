/**
 * Generic "hidden ids" UI preference hook, shared by hidden-workspaces and
 * hidden-sessions. A set of ids is persisted to localStorage under the given
 * key (`{ version: 1, ids: string[] }`), read synchronously on first paint so
 * the sidebar never flashes hidden items, and kept in sync with cross-tab
 * `storage` events. Hiding is a purely local UI filter — it never touches
 * server/session state. Write failures are swallowed (non-critical preference).
 */

import { useCallback, useEffect, useMemo, useState } from 'react'

import { parseHiddenIds, serializeHiddenIds } from './hidden-workspaces.js'

export type UseHiddenIds = {
  hiddenIds: ReadonlySet<string>
  isHidden(id: string): boolean
  hide(id: string): void
  unhide(id: string): void
  count: number
}

export function useHiddenIds(storageKey: string): UseHiddenIds {
  const readInitial = useCallback((): ReadonlySet<string> => {
    if (typeof window === 'undefined') return new Set<string>()
    try {
      return parseHiddenIds(window.localStorage.getItem(storageKey))
    } catch {
      return new Set<string>()
    }
  }, [storageKey])

  const persist = useCallback((ids: ReadonlySet<string>): void => {
    if (typeof window === 'undefined') return
    try {
      if (ids.size === 0) window.localStorage.removeItem(storageKey)
      else window.localStorage.setItem(storageKey, serializeHiddenIds(ids))
    } catch {
      // Local preference; ignore write failures.
    }
  }, [storageKey])

  const [hiddenIds, setHiddenIds] = useState<ReadonlySet<string>>(() => readInitial())

  useEffect(() => {
    if (typeof window === 'undefined') return
    // Re-read when the key changes (e.g. a different feature instance).
    setHiddenIds(readInitial())
    const onStorage = (event: StorageEvent): void => {
      if (event.key === null) {
        setHiddenIds(new Set<string>())
        return
      }
      if (event.key !== storageKey) return
      setHiddenIds(parseHiddenIds(event.newValue))
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [storageKey, readInitial])

  const hide = useCallback((id: string): void => {
    if (!id) return
    setHiddenIds((prev) => {
      if (prev.has(id)) return prev
      const next = new Set(prev)
      next.add(id)
      persist(next)
      return next
    })
  }, [persist])

  const unhide = useCallback((id: string): void => {
    if (!id) return
    setHiddenIds((prev) => {
      if (!prev.has(id)) return prev
      const next = new Set(prev)
      next.delete(id)
      persist(next)
      return next
    })
  }, [persist])

  const isHidden = useCallback((id: string): boolean => hiddenIds.has(id), [hiddenIds])

  return useMemo(
    () => ({ hiddenIds, isHidden, hide, unhide, count: hiddenIds.size }),
    [hiddenIds, isHidden, hide, unhide],
  )
}
