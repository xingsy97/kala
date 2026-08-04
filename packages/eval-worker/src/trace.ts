import { TrialTraceSchema, type NormalizedAgentEvent, type TrialTrace } from '@agent-kernel/eval-protocol'
import type { SandboxSnapshot } from '@agent-kernel/eval-sdk'

export function deriveTrialTrace(input: {
  runId: string; trialId: string; backendId: string; taskId: string; trialStartedAt: string; environmentStartedAt: string; environmentCompletedAt: string
  agentStartedAt: string; agentCompletedAt: string; verifierStartedAt: string; verifierCompletedAt: string
  workspaceBefore: SandboxSnapshot; workspaceAfter: SandboxSnapshot; events: readonly NormalizedAgentEvent[]
}): TrialTrace {
  const traceId = safeId('trace-' + input.runId + '-' + input.trialId)
  const refs = { runId: input.runId, trialId: input.trialId, backendId: input.backendId, taskId: input.taskId }
  const terminal = latest([input.environmentCompletedAt, input.agentCompletedAt, input.verifierCompletedAt, input.workspaceAfter.createdAt])
  const span = (spanId: string, parentSpanId: string | undefined, name: TrialTrace['spans'][number]['name'], startedAt: string, completedAt: string, extra: Partial<TrialTrace['spans'][number]> = {}) => ({ schemaVersion: 1 as const, traceId, spanId, ...(parentSpanId ? { parentSpanId } : {}), name, startedAt, completedAt: Date.parse(completedAt) < Date.parse(startedAt) ? startedAt : completedAt, status: 'ok' as const, refs, artifactRefs: [], ...extra })
  const spans: TrialTrace['spans'] = [
    span('run', undefined, 'evaluation.run', input.trialStartedAt, terminal),
    span('trial', 'run', 'evaluation.trial', input.trialStartedAt, terminal),
    span('environment', 'trial', 'environment.prepare', input.environmentStartedAt, input.environmentCompletedAt),
    span('workspace-before', 'trial', 'workspace.snapshot', input.workspaceBefore.createdAt, input.workspaceBefore.createdAt, { artifactRefs: [input.runId + '/' + input.trialId + '/workspace.before.json'] }),
    span('agent', 'trial', 'agent.execute', input.agentStartedAt, input.agentCompletedAt),
    span('workspace-after', 'trial', 'workspace.snapshot', input.workspaceAfter.createdAt, input.workspaceAfter.createdAt, { artifactRefs: [input.runId + '/' + input.trialId + '/workspace.after.json'] }),
    span('verifier', 'trial', 'verifier.execute', input.verifierStartedAt, input.verifierCompletedAt, { artifactRefs: [input.runId + '/' + input.trialId + '/verifier-result.json'] }),
  ]
  for (const event of input.events) {
    const name = eventName(event)
    if (!name) continue
    const spanId = 'event-' + String(event.sequence)
    const status = event.kind === 'error' ? 'error' as const : 'ok' as const
    spans.push(span(spanId, 'agent', name, event.at, event.at, { eventSequence: event.sequence, status, ...(status === 'error' ? { outcomeCategory: 'agent_event_error' } : {}) }))
  }
  return TrialTraceSchema.parse({ schemaVersion: 1, traceId, runId: input.runId, trialId: input.trialId, spans })
}

function eventName(event: NormalizedAgentEvent): TrialTrace['spans'][number]['name'] | undefined {
  if (event.kind === 'model_call') return 'model.call'
  if (event.kind === 'tool_call' || event.kind === 'command') return 'tool.call'
  if (event.kind === 'subagent') return 'subagent.run'
  if (event.kind === 'compaction') return 'compaction'
  if (event.kind === 'memory') return /write|store|save|delete/iu.test(String(event.data.operation ?? event.data.action ?? '')) ? 'memory.write' : 'memory.read'
  return undefined
}
function latest(values: readonly string[]): string { return new Date(Math.max(...values.map(Date.parse))).toISOString() }
function safeId(value: string): string { return value.replace(/[^A-Za-z0-9._:-]/gu, '-').slice(0, 240) }
