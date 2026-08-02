export const STREAM_COMMIT_INTERVAL_MS = 33
export const STREAM_CATCH_UP_INTERVAL_MS = 66
export const STREAM_CATCH_UP_BACKLOG = 800

export function streamCommitInterval(backlog: number): number {
  return backlog >= STREAM_CATCH_UP_BACKLOG
    ? STREAM_CATCH_UP_INTERVAL_MS
    : STREAM_COMMIT_INTERVAL_MS
}

export function streamReleaseCount(backlog: number, pacedCount: number): number {
  if (backlog >= 2_000) return Math.max(pacedCount, 200)
  if (backlog >= 800) return Math.max(pacedCount, 64)
  if (backlog >= 250) return Math.max(pacedCount, 24)
  return pacedCount
}

export function shouldCommitStreamFrame({
  now,
  lastCommitAt,
  backlog,
  visible,
}: {
  now: number
  lastCommitAt: number
  backlog: number
  visible: boolean
}): boolean {
  if (!visible) return false
  return now - lastCommitAt >= streamCommitInterval(backlog)
}
