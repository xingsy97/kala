import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { fold } from '@agent-kernel/kernel'
import type { AgentState } from '@agent-kernel/kernel'
import type { EventEntry } from '@agent-kernel/shared'
import { deriveSessionState } from '@agent-kernel/shared'

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
  recoveryEventDetails: readonly RecoveryEventDetail[]
  integrity: ReliabilityIntegritySummary
  warnings: readonly string[]
  eventCount: number
  lastEventKind?: string
}

export type RecoveryEventDetail = {
  seq: number
  kind: 'llm_interrupted' | 'tool_result_recovered'
  callId?: string
}

export type ReliabilityIntegritySummary = {
  duplicateToolCallIds: readonly string[]
  duplicateToolResultIds: readonly string[]
  toolResultsWithoutCall: readonly string[]
  toolCallsWithoutResult: readonly string[]
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
  const recoveryDetails = recoveryEventDetails(parsed.events)
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
    recoveryEvents: recoveryDetails.length,
    recoveryEventDetails: recoveryDetails,
    integrity: integritySummary(parsed.events),
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
  if (!isAgentStatus(status)) return undefined
  const derived = deriveSessionState({ status, pendingCalls: pendingCalls as never })
  if (derived.activity === 'thinking' && pendingCalls.length === 0) return 'llm_call'
  if (derived.activity === 'tooling' && pendingCalls.length > 0) return 'tool_call'
  if (derived.activity === 'waiting_user' && pendingCalls.length > 0) return 'approval'
  return undefined
}

function isAgentStatus(status: string): status is AgentState['status'] {
  return status === 'idle' || status === 'thinking' || status === 'awaiting_approval' || status === 'executing_tools' || status === 'done' || status === 'error'
}

function recoveryEventDetails(events: readonly EventEntry[]): readonly RecoveryEventDetail[] {
  return events.flatMap((entry) => recoveryEventDetail(entry) ?? [])
}

function recoveryEventDetail(entry: EventEntry): RecoveryEventDetail | null {
  if (entry.event.kind === 'tool_result' && entry.event.content.includes('host restarted while call was pending')) {
    return { seq: entry.seq, kind: 'tool_result_recovered', callId: entry.event.callId }
  }
  if (entry.event.kind === 'llm_response') {
    return entry.event.message.content.some((content) => content.type === 'text' && content.text === '[interrupted]')
      ? { seq: entry.seq, kind: 'llm_interrupted' }
      : null
  }
  return null
}

function integritySummary(events: readonly EventEntry[]): ReliabilityIntegritySummary {
  const callCounts = new Map<string, number>()
  const resultCounts = new Map<string, number>()
  for (const entry of events) {
    if (entry.event.kind === 'llm_response') {
      for (const content of entry.event.message.content) {
        if (content.type === 'tool_call') callCounts.set(content.callId, (callCounts.get(content.callId) ?? 0) + 1)
      }
    }
    if (entry.event.kind === 'tool_result') resultCounts.set(entry.event.callId, (resultCounts.get(entry.event.callId) ?? 0) + 1)
  }
  const callIds = new Set(callCounts.keys())
  const resultIds = new Set(resultCounts.keys())
  return {
    duplicateToolCallIds: duplicateIds(callCounts),
    duplicateToolResultIds: duplicateIds(resultCounts),
    toolResultsWithoutCall: [...resultIds].filter((callId) => !callIds.has(callId)).sort(),
    toolCallsWithoutResult: [...callIds].filter((callId) => !resultIds.has(callId)).sort(),
  }
}

function duplicateIds(counts: ReadonlyMap<string, number>): readonly string[] {
  return [...counts.entries()].filter(([, count]) => count > 1).map(([callId]) => callId).sort()
}
