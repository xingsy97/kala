/**
 * `reliability classify` command: reads a heartbeat JSONL file together with a
 * `reliability-audit.json` (or session log to audit inline) and writes a
 * `crash-kill-report.json` describing whether the process appears wedged, has
 * pending work after a restart, or exited cleanly. Meant for post-crash triage
 * and for CI to assert that a killed benchmark run reached a known terminal
 * state rather than silently losing pending calls.
 *
 * Reads inputs only. Uses the primitives from `reliability-supervisor.ts` and
 * `reliability.ts` — this module is a thin CLI-facing binder.
 */

import { mkdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  classifyCrashKill,
  readLatestHeartbeat,
  type CrashKillReport,
} from './reliability-supervisor.js'
import { auditSessionReliability, type SessionReliabilityAudit } from './reliability.js'

export type ClassifyReliabilityInput = {
  rootDir: string
  heartbeatPath: string
  sessionLogPath: string
  wedgedThresholdMs?: number
  now?: () => number
  outputFilename?: string
}

export async function classifyReliability(
  input: ClassifyReliabilityInput,
): Promise<{ report: CrashKillReport; reportPath: string; audit: SessionReliabilityAudit }> {
  const audit = (await auditSessionReliability({ rootDir: input.rootDir, sessionLogPath: input.sessionLogPath })).audit
  const heartbeat = await readLatestHeartbeat(input.heartbeatPath)
  const now = input.now?.() ?? Date.now()
  const timeSinceLastHeartbeatMs = heartbeat
    ? Math.max(0, now - Date.parse(heartbeat.timestamp))
    : undefined
  const report = classifyCrashKill({
    sessionId: audit.sessionId,
    pendingCalls: audit.pendingCalls.length,
    ...(heartbeat ? { lastHeartbeat: heartbeat } : {}),
    ...(timeSinceLastHeartbeatMs !== undefined ? { timeSinceLastHeartbeatMs } : {}),
    ...(input.wedgedThresholdMs !== undefined ? { wedgedThresholdMs: input.wedgedThresholdMs } : {}),
  })
  await mkdir(input.rootDir, { recursive: true })
  const reportPath = join(input.rootDir, input.outputFilename ?? 'crash-kill-report.json')
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  return { report, reportPath, audit }
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }
}
