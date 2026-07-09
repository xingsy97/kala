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

export async function auditSessionReliability(
  input: AuditSessionReliabilityInput,
): Promise<{ audit: SessionReliabilityAudit; auditPath: string }> {
  const parsed = await readSessionLog(input.sessionLogPath)
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
  await mkdir(input.rootDir, { recursive: true })
  const auditPath = join(input.rootDir, 'reliability-audit.json')
  await writeFile(auditPath, `${JSON.stringify(audit, null, 2)}\n`, 'utf8')
  return { audit, auditPath }
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
