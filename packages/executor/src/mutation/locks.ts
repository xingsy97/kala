const queues = new Map<string, Promise<unknown>>()

export async function withFileLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const previous = queues.get(path) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => { release = resolve })
  queues.set(path, previous.then(() => current, () => current))
  await previous.catch(() => undefined)
  try {
    return await fn()
  } finally {
    release()
    if (queues.get(path) === current) queues.delete(path)
  }
}
