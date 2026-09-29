import { runWebSearch } from '../web-search/index.js'
import { runAgentTool } from './agent-tool.js'
import { runPostToolHooks, runPreToolHooks } from './hooks-runner.js'
import { isSkillManager, runSkillTool } from './skills.js'
import { runTodoGraphTool } from './todo-graph.js'
import { runToolCatalogTool } from './tool-catalog.js'
import { createExtensionRegistry, type HostExtension } from './registry.js'

export const BUILTIN_HOST_TOOL_HANDLERS = [
  'ask_user_choice',
  'websearch',
  'agent',
  'todo_graph',
  'tool_search',
  'tool_describe',
  'skill',
] as const

export function createBuiltinExtensionRegistry(additional: readonly HostExtension[] = []) {
  const registry = createExtensionRegistry([
    {
      id: 'kala.builtin.host-tools',
      version: '2026-09-29',
      toolHandlers: {
        async ask_user_choice({ deps, sessionId, effect }) {
          if (!deps.askUserChoice) return { ok: false, content: 'ask_user_choice is not configured on this host' }
          return await deps.askUserChoice.ask(sessionId, effect)
        },
        async websearch({ deps, sessionId, effect }) {
          if (!deps.webSearchCredentials) return { ok: false, content: 'web search credential store is not configured' }
          return await runWebSearch(effect.input, {
            credentials: deps.webSearchCredentials,
            sessionId,
            callId: effect.callId,
            audit: deps.audit,
          })
        },
        async agent({ deps, sessionId, effect, aborts, loop, runtimeController }) {
          return await runAgentTool(deps, sessionId, effect, aborts, loop, runtimeController)
        },
        async todo_graph({ deps, sessionId, effect }) {
          return await runTodoGraphTool(deps, sessionId, effect)
        },
        async tool_search({ deps, sessionId, effect }) {
          const record = deps.store.get(sessionId)
          if (!record) return { ok: false, content: 'Session is unavailable' }
          return await runToolCatalogTool(record, 'tool_search', effect.input)
        },
        async tool_describe({ deps, sessionId, effect }) {
          const record = deps.store.get(sessionId)
          if (!record) return { ok: false, content: 'Session is unavailable' }
          return await runToolCatalogTool(record, 'tool_describe', effect.input)
        },
        async skill({ deps, sessionId, effect }) {
          if (!deps.skills) return { ok: false, content: 'skills are not configured on this host' }
          return await runSkillTool(
            isSkillManager(deps.skills)
              ? await deps.skills.refreshSession(deps.store.get(sessionId)!)
              : deps.skills,
            effect.input,
          )
        },
      },
    },
    {
      id: 'kala.command-hooks',
      version: '2026-09-29',
      lifecycle: {
        async beforeToolDispatch({ deps, sessionId, effect }) {
          const blocked = await runPreToolHooks(deps, sessionId, effect)
          return blocked ? { ok: false, content: blocked } : null
        },
        async afterToolDispatch({ deps, sessionId, effect }, result) {
          await runPostToolHooks(deps, sessionId, effect, result)
        },
      },
    },
    ...additional,
  ])
  registry.seal()
  return registry
}
