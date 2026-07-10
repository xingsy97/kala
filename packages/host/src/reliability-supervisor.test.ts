import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  classifyCrashKill,
  openIdempotencyLedger,
  readLatestHeartbeat,
  startHeartbeat,
  writeCrashKillReport,
} from './reliability-supervisor.js'

describe('reliability supervisor', () => {
  it('emits heartbeat records and reads them back', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rel-'))
    try {
      const path = join(dir, 'heartbeat.jsonl')
      const emitter = await startHeartbeat({
        path,
        intervalMs: 60_000,
        provide: () => ({ processId: 'pid-1', sessionId: 'session-A', status: 'idle' }),
      })
      await emitter.emit({ processId: 'pid-1', sessionId: 'session-A', status: 'executing_tools', pendingCallIds: ['c-1'] })
      await emitter.emit({ processId: 'pid-1', sessionId: 'session-A', status: 'shutting_down' })
      emitter.close()
      const last = await readLatestHeartbeat(path)
      expect(last?.status).toBe('shutting_down')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rehydrates an idempotency ledger from disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'idem-'))
    try {
      const path = join(dir, 'ledger.jsonl')
      const first = await openIdempotencyLedger(path)
      await first.begin('session-A:call-1')
      await first.complete('session-A:call-1', { ok: true, resultRef: 'artifacts/tool-result.json' })

      const second = await openIdempotencyLedger(path)
      const restored = second.entry('session-A:call-1')!
      expect(restored.state).toBe('completed')
      expect(restored.outcome?.resultRef).toBe('artifacts/tool-result.json')

      const retried = await second.begin('session-A:call-1')
      expect(retried.attemptCount).toBeGreaterThanOrEqual(2)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('classifies wedged, clean, and restart cases', async () => {
    const wedged = classifyCrashKill({
      sessionId: 'session-A',
      pendingCalls: 1,
      lastHeartbeat: { timestamp: new Date(Date.now() - 120_000).toISOString(), processId: 'pid-1', status: 'thinking' },
      timeSinceLastHeartbeatMs: 120_000,
      wedgedThresholdMs: 60_000,
    })
    expect(wedged.suspectedFailure).toBe('wedged')
    const clean = classifyCrashKill({
      sessionId: 'session-A',
      pendingCalls: 0,
      lastHeartbeat: { timestamp: new Date().toISOString(), processId: 'pid-1', status: 'shutting_down' },
      timeSinceLastHeartbeatMs: 100,
    })
    expect(clean.suspectedFailure).toBe('clean_shutdown')
    const noHeartbeat = classifyCrashKill({ sessionId: 'session-A', pendingCalls: 1 })
    expect(noHeartbeat.suspectedFailure).toBe('restart_before_result')
  })

  it('writes crash-kill reports to disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'crash-'))
    try {
      const report = classifyCrashKill({ sessionId: 'session-A', pendingCalls: 0 })
      const path = await writeCrashKillReport({ rootDir: dir, report })
      const raw = await readFile(path, 'utf8')
      const parsed = JSON.parse(raw) as { sessionId: string }
      expect(parsed.sessionId).toBe('session-A')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('tolerates a truncated ledger line', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'idem2-'))
    try {
      const path = join(dir, 'ledger.jsonl')
      await writeFile(path, '{ "key": "a", "state": "completed", "startedAt": "2026-01-01T00:00:00Z", "attemptCount": 1 }\n{"truncated', 'utf8')
      const ledger = await openIdempotencyLedger(path)
      expect(ledger.entry('a')?.state).toBe('completed')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
