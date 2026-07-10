/**
 * Long-task reliability primitives.
 *
 * - Heartbeats: emit a small liveness record so an external supervisor can
 *   distinguish "process wedged" from "process took a long step".
 * - Idempotency ledger: track (callId, effect) tuples that have been
 *   attempted or completed so a restarted host does not double-apply a
 *   destructive tool call.
 *
 * Both are file-backed and append-only. They live under the run's artifact
 * root so operators can inspect them alongside the session log.
 */

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export type HeartbeatRecord = {
  timestamp: string
  processId: string
  sessionId?: string
  hostVersion?: string
  status: 'starting' | 'idle' | 'thinking' | 'executing_tools' | 'awaiting_approval' | 'compacting' | 'shutting_down'
  eventSeq?: number
  pendingCallIds?: readonly string[]
  metadata?: Record<string, unknown>
}

export type HeartbeatEmitter = {
  emit(record: Omit<HeartbeatRecord, 'timestamp'>): Promise<void>
  path: string
  close(): void
}

export type StartHeartbeatOptions = {
  path: string
  intervalMs?: number
  provide(): Omit<HeartbeatRecord, 'timestamp'>
  onError?: (err: unknown) => void
}

/**
 * Write heartbeat records to a JSONL file on a fixed cadence. Callers can
 * also push out-of-cycle records via `emit()`.
 */
export async function startHeartbeat(options: StartHeartbeatOptions): Promise<HeartbeatEmitter> {
  const interval = options.intervalMs ?? 5_000
  await mkdir(dirname(options.path), { recursive: true })
  await appendFile(options.path, '', 'utf8')

  async function writeRecord(record: HeartbeatRecord): Promise<void> {
    try {
      await appendFile(options.path, `${JSON.stringify(record)}\n`, 'utf8')
    } catch (err) {
      options.onError?.(err)
    }
  }

  const timer: NodeJS.Timeout = setInterval(() => {
    const partial = options.provide()
    void writeRecord({ timestamp: new Date().toISOString(), ...partial })
  }, interval)
  timer.unref?.()

  return {
    path: options.path,
    async emit(partial) {
      await writeRecord({ timestamp: new Date().toISOString(), ...partial })
    },
    close() {
      clearInterval(timer)
    },
  }
}

export type IdempotencyEntry = {
  key: string
  state: 'in_flight' | 'completed' | 'failed'
  startedAt: string
  endedAt?: string
  attemptCount: number
  outcome?: {
    ok: boolean
    error?: string
    resultRef?: string
  }
}

export type IdempotencyLedger = {
  path: string
  /**
   * Record that a call is starting. Returns the resolved entry (either newly
   * created or restored from disk). Callers must supply a stable key such as
   * `${sessionId}:${callId}`  -  the ledger does not invent one.
   */
  begin(key: string): Promise<IdempotencyEntry>
  complete(key: string, outcome: NonNullable<IdempotencyEntry['outcome']>): Promise<IdempotencyEntry>
  fail(key: string, error: string): Promise<IdempotencyEntry>
  entry(key: string): IdempotencyEntry | undefined
  entries(): readonly IdempotencyEntry[]
}

export async function openIdempotencyLedger(path: string): Promise<IdempotencyLedger> {
  await mkdir(dirname(path), { recursive: true })
  const map = new Map<string, IdempotencyEntry>()
  try {
    const raw = await readFile(path, 'utf8')
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        const record = JSON.parse(line) as IdempotencyEntry
        if (record && typeof record.key === 'string') map.set(record.key, record)
      } catch {
        continue
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }

  async function flush(entry: IdempotencyEntry): Promise<IdempotencyEntry> {
    map.set(entry.key, entry)
    const snapshot = [...map.values()]
    await writeFile(path, `${snapshot.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8')
    return { ...entry }
  }

  return {
    path,
    async begin(key: string): Promise<IdempotencyEntry> {
      const existing = map.get(key)
      if (existing) {
        existing.attemptCount += 1
        if (existing.state === 'failed') existing.state = 'in_flight'
        return await flush(existing)
      }
      return await flush({
        key,
        state: 'in_flight',
        startedAt: new Date().toISOString(),
        attemptCount: 1,
      })
    },
    async complete(key: string, outcome): Promise<IdempotencyEntry> {
      const existing = map.get(key) ?? {
        key,
        state: 'in_flight' as const,
        startedAt: new Date().toISOString(),
        attemptCount: 1,
      }
      return await flush({
        ...existing,
        state: 'completed',
        endedAt: new Date().toISOString(),
        outcome,
      })
    },
    async fail(key: string, error: string): Promise<IdempotencyEntry> {
      const existing = map.get(key) ?? {
        key,
        state: 'in_flight' as const,
        startedAt: new Date().toISOString(),
        attemptCount: 1,
      }
      return await flush({
        ...existing,
        state: 'failed',
        endedAt: new Date().toISOString(),
        outcome: { ok: false, error },
      })
    },
    entry(key: string): IdempotencyEntry | undefined {
      const found = map.get(key)
      return found ? { ...found } : undefined
    },
    entries(): readonly IdempotencyEntry[] {
      return [...map.values()].map((entry) => ({ ...entry }))
    },
  }
}

export type CrashKillReport = {
  schemaVersion: 1
  generatedAt: string
  sessionId: string
  pendingCalls: number
  lastHeartbeat?: HeartbeatRecord
  suspectedFailure: 'wedged' | 'restart_before_result' | 'clean_shutdown' | 'unknown'
  recoveryHint?: string
}

/**
 * Read the last heartbeat record. Returns undefined for missing/empty files.
 */
export async function readLatestHeartbeat(path: string): Promise<HeartbeatRecord | undefined> {
  try {
    const raw = await readFile(path, 'utf8')
    const lines = raw.split('\n').filter((line) => line.trim().length > 0)
    const last = lines[lines.length - 1]
    if (!last) return undefined
    return JSON.parse(last) as HeartbeatRecord
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw err
  }
}

/**
 * Produce a coarse crash-kill classification. Meant for the reliability
 * dashboard and post-mortem tooling.
 */
export function classifyCrashKill(input: {
  sessionId: string
  lastHeartbeat?: HeartbeatRecord
  pendingCalls: number
  timeSinceLastHeartbeatMs?: number
  wedgedThresholdMs?: number
}): CrashKillReport {
  const wedgedThreshold = input.wedgedThresholdMs ?? 60_000
  let suspectedFailure: CrashKillReport['suspectedFailure'] = 'unknown'
  let recoveryHint: string | undefined
  const last = input.lastHeartbeat
  if (!last) {
    suspectedFailure = 'restart_before_result'
    recoveryHint = 'No heartbeat recorded. Replay session events and resubmit last user turn.'
  } else if (last.status === 'shutting_down') {
    suspectedFailure = 'clean_shutdown'
    recoveryHint = 'Process shut down cleanly; safe to resume from the recorded event log.'
  } else if (input.timeSinceLastHeartbeatMs !== undefined && input.timeSinceLastHeartbeatMs > wedgedThreshold && input.pendingCalls > 0) {
    suspectedFailure = 'wedged'
    recoveryHint = 'Process appears wedged with pending calls; consider restarting host and letting the recovery events fire.'
  } else if (input.pendingCalls > 0) {
    suspectedFailure = 'restart_before_result'
    recoveryHint = 'Pending tool calls without matching results; host should emit recovery events on restart.'
  } else {
    suspectedFailure = 'clean_shutdown'
    recoveryHint = 'No pending calls; session is safe to resume.'
  }
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    sessionId: input.sessionId,
    pendingCalls: input.pendingCalls,
    ...(last ? { lastHeartbeat: last } : {}),
    suspectedFailure,
    ...(recoveryHint ? { recoveryHint } : {}),
  }
}

export async function writeCrashKillReport(input: { rootDir: string; report: CrashKillReport }): Promise<string> {
  await mkdir(input.rootDir, { recursive: true })
  const path = join(input.rootDir, 'crash-kill-report.json')
  await writeFile(path, `${JSON.stringify(input.report, null, 2)}\n`, 'utf8')
  return path
}
