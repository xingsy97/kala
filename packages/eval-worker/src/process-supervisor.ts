export type SupervisedResult<T> = { status: 'completed'; value: T } | { status: 'timeout' | 'cancelled'; error: Error }

export async function supervise<T>(input: {
  operation: (signal: AbortSignal) => Promise<T>
  timeoutMs: number
  signal?: AbortSignal
  onCancel?: () => Promise<void>
  cancellationGraceMs?: number
}): Promise<SupervisedResult<T>> {
  if (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0) throw new Error('timeoutMs must be positive')
  const controller = new AbortController()
  let releaseCancellation!: () => void
  const cancellation = new Promise<void>((resolve) => { releaseCancellation = resolve })
  const abort = (reason: unknown) => {
    if (controller.signal.aborted) return
    controller.abort(reason)
    releaseCancellation()
  }
  const externalAbort = () => abort(input.signal?.reason ?? new Error('operation cancelled'))
  input.signal?.addEventListener('abort', externalAbort, { once: true })
  if (input.signal?.aborted) externalAbort()
  const timeout = setTimeout(() => abort(new Error('absolute deadline exceeded')), input.timeoutMs)
  timeout.unref()
  const operation = Promise.resolve().then(() => input.operation(controller.signal))
  const settled = operation.then(
    (value) => ({ kind: 'completed' as const, value }),
    (error: unknown) => ({ kind: 'failed' as const, error }),
  )
  try {
    const first = await Promise.race([settled, cancellation.then(() => ({ kind: 'cancelled' as const }))])
    if (first.kind === 'completed') return { status: 'completed', value: first.value }
    if (first.kind === 'failed') {
      if (!controller.signal.aborted) throw first.error
    }
    const graceMs = input.cancellationGraceMs ?? 5_000
    const cleanup = input.onCancel ? Promise.resolve().then(input.onCancel) : Promise.resolve()
    const grace = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, graceMs)
      timer.unref()
    })
    await Promise.race([Promise.allSettled([cleanup, operation]).then(() => undefined), grace])
    const cancelled = input.signal?.aborted === true
    const reason = controller.signal.reason
    return { status: cancelled ? 'cancelled' : 'timeout', error: reason instanceof Error ? reason : new Error(cancelled ? 'operation cancelled' : 'absolute deadline exceeded') }
  } finally {
    clearTimeout(timeout)
    abort(new Error('supervision complete'))
    input.signal?.removeEventListener('abort', externalAbort)
    void operation.catch(() => undefined)
  }
}
