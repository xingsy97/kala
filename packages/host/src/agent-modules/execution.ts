import type { CallToolEffect } from '@agent-kernel/kernel'

import { runAgentTool } from '../extensions/agent-tool.js'
import { isSkillManager, runSkillTool } from '../extensions/skills.js'
import { runTodoGraphTool } from '../extensions/todo-graph.js'
import type { HostLoopDeps } from '../loop-types.js'

export type ToolExecutionResult = {
  ok: boolean
  content: string
}

export async function dispatchConfiguredTool(
  deps: HostLoopDeps,
  sessionId: string,
  effect: CallToolEffect,
  aborts: Map<string, AbortController>,
): Promise<ToolExecutionResult> {
  const record = deps.store.get(sessionId)
  const schema = record?.config.tools.find((tool) => tool.name === effect.name)
  const executionKind = schema?.executionKind ?? 'executor'
  if (executionKind === 'executor') return await deps.tools.callTool(sessionId, effect)

  const handler = schema?.executionHandler ?? effect.name
  switch (handler) {
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
