import { useEffect, useRef } from 'react'

/**
 * Defers disposal by one task so React Strict Mode's setup-cleanup-setup probe
 * can retain the same resource. Replaced resources and real unmounts are still
 * disposed promptly.
 */
export function useDeferredDispose<T extends object>(resource: T, dispose: (resource: T) => void): void {
  const pendingRef = useRef(new Map<T, ReturnType<typeof setTimeout>>())
  const disposeRef = useRef(dispose)
  disposeRef.current = dispose

  useEffect(() => {
    const pending = pendingRef.current.get(resource)
    if (pending !== undefined) {
      clearTimeout(pending)
      pendingRef.current.delete(resource)
    }

    return () => {
      const timeout = setTimeout(() => {
        pendingRef.current.delete(resource)
        disposeRef.current(resource)
      }, 0)
      pendingRef.current.set(resource, timeout)
    }
  }, [resource])
}
