export type ScheduledTask<T> = {
  promise: Promise<T>
  cancel(): void
}

type BrowserScheduler = {
  postTask<T>(callback: () => T | Promise<T>, options?: { priority?: 'background' | 'user-visible'; signal?: AbortSignal }): Promise<T>
}

export function scheduleBackground<T>(run: (signal: AbortSignal) => T | Promise<T>): ScheduledTask<T> {
  const controller = new AbortController()
  let timeoutId: number | null = null
  let rejectTask: ((reason?: unknown) => void) | null = null
  let started = false

  const promise = new Promise<T>((resolve, reject) => {
    rejectTask = reject
    const execute = (): void => {
      timeoutId = null
      if (controller.signal.aborted) {
        reject(controller.signal.reason ?? new DOMException('Task cancelled', 'AbortError'))
        return
      }
      started = true
      Promise.resolve().then(() => run(controller.signal)).then(resolve, reject)
    }

    const scheduler = (globalThis as typeof globalThis & { scheduler?: BrowserScheduler }).scheduler
    if (scheduler?.postTask) {
      void scheduler.postTask(execute, { priority: 'background', signal: controller.signal }).catch(reject)
    } else if (typeof window !== 'undefined') {
      timeoutId = window.setTimeout(execute, 0)
    } else {
      queueMicrotask(execute)
    }
  })

  return {
    promise,
    cancel() {
      if (controller.signal.aborted) return
      const reason = new DOMException('Task cancelled', 'AbortError')
      controller.abort(reason)
      if (timeoutId !== null && typeof window !== 'undefined') window.clearTimeout(timeoutId)
      if (!started) rejectTask?.(reason)
    },
  }
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}
