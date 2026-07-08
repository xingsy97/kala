import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { fold } from '@agent-kernel/kernel'
import type { EventEntry } from '@agent-kernel/shared'

import { readSessionLog } from './store/log.js'

export type SessionReliabilityAudit = {
  sessionId: string
  status: string
  pendingCalls: Array<{
    callId: string
    name: string
    status: string
  }>
  dangling: boolean
  danglingKind?: 'llm_call' | 'tool_call' | 'approval'
  recoveryEvents: number
  warnings: readonly string[]
  eventCount: number
  lastEventKind?: string
}

export type AuditSessionReliabilityInput = {
  rootDir: string
  sessionLogPath: string
}

export type ReliabilityChaosReplayInput = {
  rootDir: string
  sessionLogPaths: readonly string[]
}

export type ReliabilityChaosReplay = {
  generatedAt: string
  sessionCount: number
  recoverableCount: number
  danglingCount: number
  recoveryEventCount: number
  danglingByKind: Record<string, number>
  sessions: Array<{
    sessionId: string
    sessionLogPath: string
    status: string
    recoverable: boolean
    dangling: boolean
    danglingKind?: SessionReliabilityAudit['danglingKind']
    recoveryEvents: number
    eventCount: number
    lastEventKind?: string
  }>
}

export async function auditSessionReliability(
  input: AuditSessionReliabilityInput,
): Promise<{ audit: SessionReliabilityAudit; auditPath: string }> {
  const audit = await createSessionReliabilityAudit(input.sessionLogPath)
  await mkdir(input.rootDir, { recursive: true })
  const auditPath = join(input.rootDir, 'reliability-audit.json')
  await writeFile(auditPath, `${JSON.stringify(audit, null, 2)}\n`, 'utf8')
  return { audit, auditPath }
}

export async function replayReliabilityChaos(
  input: ReliabilityChaosReplayInput,
): Promise<{ report: ReliabilityChaosReplay; reportPath: string }> {
  const sessions: ReliabilityChaosReplay['sessions'] = []
  const danglingByKind: Record<string, number> = {}
  for (const sessionLogPath of input.sessionLogPaths) {
    const audit = await createSessionReliabilityAudit(sessionLogPath)
    if (audit.danglingKind) danglingByKind[audit.danglingKind] = (danglingByKind[audit.danglingKind] ?? 0) + 1
    sessions.push({
      sessionId: audit.sessionId,
      sessionLogPath,
      status: audit.status,
      recoverable: !audit.dangling || audit.recoveryEvents > 0,
      dangling: audit.dangling,
      ...(audit.danglingKind ? { danglingKind: audit.danglingKind } : {}),
      recoveryEvents: audit.recoveryEvents,
      eventCount: audit.eventCount,
      ...(audit.lastEventKind ? { lastEventKind: audit.lastEventKind } : {}),
    })
  }
  const report: ReliabilityChaosReplay = {
    generatedAt: new Date().toISOString(),
    sessionCount: sessions.length,
    recoverableCount: sessions.filter((session) => session.recoverable).length,
    danglingCount: sessions.filter((session) => session.dangling).length,
    recoveryEventCount: sessions.reduce((sum, session) => sum + session.recoveryEvents, 0),
    danglingByKind,
    sessions,
  }
  await mkdir(input.rootDir, { recursive: true })
  const reportPath = join(input.rootDir, 'reliability-chaos.json')
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  return { report, reportPath }
}

async function createSessionReliabilityAudit(sessionLogPath: string): Promise<SessionReliabilityAudit> {
  const parsed = await readSessionLog(sessionLogPath)
  const finalState = fold(parsed.header.initialState, parsed.events.map((entry) => entry.event), parsed.header.config)
  const pendingCalls = finalState.pendingCalls.map((call) => ({
    callId: call.callId,
    name: call.name,
    status: call.status,
  }))
  const danglingKind = classifyDangling(finalState.status, pendingCalls)
  const audit: SessionReliabilityAudit = {
    sessionId: parsed.header.sessionId,
    status: finalState.status,
    pendingCalls,
    dangling: danglingKind !== undefined,
    ...(danglingKind ? { danglingKind } : {}),
    recoveryEvents: parsed.events.filter(isRecoveryEvent).length,
    warnings: parsed.warnings,
    eventCount: parsed.events.length,
    ...(parsed.events[parsed.events.length - 1]?.event.kind ? { lastEventKind: parsed.events[parsed.events.length - 1]!.event.kind } : {}),
  }
  return audit
}

function classifyDangling(
  status: string,
  pendingCalls: readonly { status: string }[],
): SessionReliabilityAudit['danglingKind'] | undefined {
  if (status === 'thinking' && pendingCalls.length === 0) return 'llm_call'
  if (status === 'executing_tools' && pendingCalls.length > 0) return 'tool_call'
  if (status === 'awaiting_approval' && pendingCalls.length > 0) return 'approval'
  return undefined
}

function isRecoveryEvent(entry: EventEntry): boolean {
  if (entry.event.kind === 'tool_result' && entry.event.content.includes('host restarted while call was pending')) return true
  if (entry.event.kind === 'llm_response') {
    return entry.event.message.content.some((content) => content.type === 'text' && content.text === '[interrupted]')
  }
  return false
}
