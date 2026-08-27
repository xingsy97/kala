import type { CallToolEffect } from '@agent-kernel/kernel'

import { runAgentTool, type SubAgentRuntimeController } from '../extensions/agent-tool.js'
import { isSkillManager, runSkillTool } from '../extensions/skills.js'
import { runTodoGraphTool } from '../extensions/todo-graph.js'
import { runToolCatalogTool } from '../extensions/tool-catalog.js'
import type { HostLoopDeps, LoopHandle } from '../loop-types.js'
import { runWebSearch } from '../web-search/index.js'

export type ToolExecutionResult = {
  ok: boolean
  content: string
  failure?: import('@agent-kernel/kernel').ToolFailure
  durationMs?: number
}

export async function dispatchConfiguredTool(
  deps: HostLoopDeps,
  sessionId: string,
  effect: CallToolEffect,
  aborts: Map<string, AbortController>,
  turnId?: string,
  loop?: LoopHandle,
  plannedContinuation = false,
  runtimeController?: SubAgentRuntimeController,
): Promise<ToolExecutionResult> {
  const record = deps.store.get(sessionId)
  const schema = record?.config.tools.find((tool) => tool.name === effect.name)
  // Historical sessions may persist websearch as an executor tool. Its
  // model-facing name is the compatibility boundary after the Host migration.
  const executionKind = effect.name === 'websearch' ? 'host' : (schema?.executionKind ?? 'executor')
  if (executionKind === 'executor') {
    const handler = schema?.executionHandler ?? effect.name
    const call = plannedContinuation && deps.tools.callToolWhenAvailable
      ? deps.tools.callToolWhenAvailable.bind(deps.tools)
      : deps.tools.callTool.bind(deps.tools)
    return await call(sessionId, handler === effect.name ? effect : { ...effect, name: handler }, turnId)
  }

  const handler = effect.name === 'websearch' ? 'websearch' : (schema?.executionHandler ?? effect.name)
  switch (handler) {
    case 'websearch':
      if (!deps.webSearchCredentials) {
        return { ok: false, content: 'web search credential store is not configured' }
      }
      return await runWebSearch(effect.input, { credentials: deps.webSearchCredentials, sessionId, callId: effect.callId, audit: deps.audit })
    case 'agent':
      return await runAgentTool(deps, sessionId, effect, aborts, loop, runtimeController)
    case 'todo_graph':
      return await runTodoGraphTool(deps, sessionId, effect)
    case 'tool_search':
    case 'tool_describe':
      if (!record) return { ok: false, content: 'Session is unavailable' }
      return await runToolCatalogTool(record, handler, effect.input)
    case 'skill':
      if (!deps.skills) return { ok: false, content: 'skills are not configured on this host' }
      return await runSkillTool(
        isSkillManager(deps.skills)
          ? await deps.skills.refreshSession(deps.store.get(sessionId)!)
          : deps.skills,
        effect.input,
      )
    default:
      return {
        ok: false,
        content: `host tool handler is not registered: ${handler}`,
      }
  }
}
