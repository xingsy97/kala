import pRetry, { AbortError } from 'p-retry'

import { classifyProviderError, isRetryable } from '../provider-health.js'

export async function retryProviderCall<T>(input: {
  retries: number
  minTimeoutMs: number
  signal?: AbortSignal
  run: () => Promise<T>
  shouldRetryResult?: (result: T, attemptNumber: number) => Promise<unknown | undefined> | unknown | undefined
}): Promise<T> {
  return await pRetry(
    async (attemptNumber) => {
      if (input.signal?.aborted) throw new AbortError(abortError())
      try {
        const result = await input.run()
        const resultError = await input.shouldRetryResult?.(result, attemptNumber)
        if (resultError) {
          throw resultError instanceof Error ? resultError : new Error(String(resultError))
        }
        return result
      } catch (err) {
        if (isAbortError(err)) throw new AbortError(toError(err))
        if (!isRetryable(classifyProviderError(err))) throw new AbortError(toError(err))
        throw err
      }
    },
    {
      retries: Math.max(0, input.retries),
      minTimeout: Math.max(0, input.minTimeoutMs),
      factor: 2,
      signal: input.signal,
    },
  )
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError'
}

function abortError(): Error {
  const err = new Error('aborted')
  err.name = 'AbortError'
  return err
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err))
}
