import type { AgentState } from '@agent-kernel/kernel'
import type { ToolSchema } from '@agent-kernel/kernel'

import type { DashboardSocket } from '../../session.js'
import type { LlmCall } from '../chat/context-composition.js'
import type { DetailSelection, StatusTopologyNode, SubAgentRelationSummary, ToolCallLifecycle } from './trace-types.js'
import { llmCallModel, llmCallProvider, toolLifecycleSummary } from './llm-model.js'

/** Pure detail-panel + topology derivations for the inspector. */

export function subAgentRelationSummary(
  parentSessionId: string | null,
  parentCursor: number | null,
  toolCalls: readonly ToolCallLifecycle[],
): SubAgentRelationSummary {
  const agentCalls = toolCalls.filter((call) => call.name === 'agent')
  return {
    parentSessionId,
    parentCursor,
    total: agentCalls.length,
    completed: agentCalls.filter((call) => call.result?.ok === true).length,
    failed: agentCalls.filter((call) => call.result?.ok === false).length,
    running: agentCalls.filter((call) => !call.result).length,
  }
}

export function statusTopology(socket: DashboardSocket | null, state: AgentState | null, llmCalls: readonly LlmCall[]): readonly StatusTopologyNode[] {
  const lastLlm = llmCalls.at(-1) ?? null
  return [
    { id: 'dashboard', label: 'Dashboard', value: 'browser UI', status: 'ok' },
    {
      id: 'host',
      label: 'Host',
      value: socket ? (socket.connected ? 'socket connected' : 'socket disconnected') : 'no socket',
      status: socket ? (socket.connected ? 'ok' : 'error') : 'unknown',
    },
    {
      id: 'executor',
      label: 'Executor',
      value: state?.cwd ? state.cwd : 'cwd not reported',
      status: state?.cwd ? 'ok' : 'unknown',
    },
    {
      id: 'llm',
      label: 'LLM',
      value: lastLlm ? `${llmCallProvider(lastLlm)} / ${llmCallModel(lastLlm)}` : 'not called yet',
      status: lastLlm ? (lastLlm.error ? 'error' : lastLlm.trace ? 'ok' : 'warn') : 'unknown',
    },
  ]
}

export function isSkillTool(tool: ToolSchema): boolean {
  return tool.name === 'skill'
}

export function detailTitle(selection: DetailSelection): string {
  if (!selection) return 'Selected Detail'
  if (selection.kind === 'llm') {
    if (selection.call.source === 'compact') return `Compaction LLM #${selection.call.requestSeq}`
    return `LLM Call #${selection.call.requestSeq} → ${selection.call.responseSeq ? `#${selection.call.responseSeq}` : 'pending'}`
  }
  if (selection.kind === 'tool') return `Tool Call · ${selection.call.name}`
  return `Timeline Event #${selection.entry.seq}`
}

export function detailDescription(selection: DetailSelection): string {
  if (!selection) return 'Select a reducer event, LLM call, or tool call to inspect raw data.'
  if (selection.kind === 'llm') {
    return 'Kernel request, provider request/response trace, and parsed kernel response.'
  }
  if (selection.kind === 'tool') {
    return `${selection.call.callId} · ${toolLifecycleSummary(selection.call)}`
  }
  return `${selection.entry.event.kind} · reducer input, emitted effects, and raw JSON.`
}
