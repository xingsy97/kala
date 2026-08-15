import type { CallToolEffect } from '@agent-kernel/kernel'

import { runAgentTool } from '../extensions/agent-tool.js'
import { isSkillManager, runSkillTool } from '../extensions/skills.js'
import { runTodoGraphTool } from '../extensions/todo-graph.js'
import type { HostLoopDeps } from '../loop-types.js'
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
): Promise<ToolExecutionResult> {
  const record = deps.store.get(sessionId)
  const schema = record?.config.tools.find((tool) => tool.name === effect.name)
  // Historical sessions may persist websearch as an executor tool. Its
  // model-facing name is the compatibility boundary after the Host migration.
  const executionKind = effect.name === 'websearch' ? 'host' : (schema?.executionKind ?? 'executor')
  if (executionKind === 'executor') {
    const handler = schema?.executionHandler ?? effect.name
    return await deps.tools.callTool(sessionId, handler === effect.name ? effect : { ...effect, name: handler }, turnId)
  }

  const handler = effect.name === 'websearch' ? 'websearch' : (schema?.executionHandler ?? effect.name)
  switch (handler) {
    case 'websearch':
      if (!deps.webSearchCredentials) {
        return { ok: false, content: 'web search credential store is not configured' }
      }
      return await runWebSearch(effect.input, { credentials: deps.webSearchCredentials })
    case 'agent':
      return await runAgentTool(deps, sessionId, effect, aborts)
    case 'todo_graph':
      return await runTodoGraphTool(deps, sessionId, effect)
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
