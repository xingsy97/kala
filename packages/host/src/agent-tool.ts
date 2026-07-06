/**
 * The `agent` builtin — the only host-side tool.
 *
 * Everything else in the tool registry maps to an executor process; `agent`
 * lives inside the host loop because it needs to spawn a *child JSONL
 * session* using the same store, dispatch a `user_message` through the same
 * loop, and hand the child's final assistant text back as a tool_result.
 *
 * Sub-agents run headless (no dashboard is subscribed to the child) so we
 * force `allow_all` approval mode regardless of the parent's setting —
 * otherwise every RequestApprovalEffect deadlocks. See
 * [ADR 0014](../../../docs/adr/0014-subagent-approval-mode.md).
 */

import type {
  AgentConfig,
  AgentState,
  CallToolEffect,
} from '@agent-kernel/kernel'

import type { SessionRecord, SessionStore } from './store/session.js'
import type { HostLoopDeps, ModelResolver } from './loop.js'
import { dispatchOne } from './loop.js'

const DEFAULT_MAX_AGENT_DEPTH = 3
export const AGENT_TOOL_NAME = 'agent'

export async function runAgentTool(
  deps: HostLoopDeps,
  parentSessionId: string,
  effect: CallToolEffect,
  aborts: Map<string, AbortController>,
): Promise<{ ok: boolean; content: string }> {
  const parent = deps.store.get(parentSessionId)
  if (!parent) return { ok: false, content: 'parent session not found' }
  const prompt = effect.input.prompt
  if (typeof prompt !== 'string' || prompt.trim().length === 0) {
    return { ok: false, content: 'agent prompt is required' }
  }
  const depth = depthOf(deps.store, parent)
  const maxDepth = parent.config.maxAgentDepth ?? DEFAULT_MAX_AGENT_DEPTH
  if (depth >= maxDepth) return { ok: false, content: 'agent depth exceeded' }

  const child = await deps.store.create({
    config: filteredAgentConfig(parent.config, effect.input.tools),
    parentSessionId,
    parentCursor: parent.state.cursor,
    ...(parent.workspaceId !== undefined ? { workspaceId: parent.workspaceId } : {}),
    ...(parent.workspaceName !== undefined ? { workspaceName: parent.workspaceName } : {}),
    ...(parent.state.cwd !== undefined ? { initialCwd: parent.state.cwd } : {}),
    // Sub-agents run headless: no dashboard is attached to the child session,
    // so any RequestApprovalEffect would deadlock. Force allow_all regardless
    // of the parent's mode. See docs/adr/0014-subagent-approval-mode.md.
    initialApprovalMode: 'allow_all',
  })
  const model = typeof effect.input.model === 'string' ? effect.input.model : undefined
  const priorModel = model ? deps.models?.get(child.sessionId) : undefined
  if (model && isSettableModelResolver(deps.models)) {
    deps.models.set(child.sessionId, model)
  }
  try {
    await dispatchOne(
      deps,
      child.sessionId,
      { kind: 'user_message', text: prompt },
      aborts,
    )
  } finally {
    if (model && isSettableModelResolver(deps.models)) {
      if (priorModel) deps.models.set(child.sessionId, priorModel)
      else deps.models.delete(child.sessionId)
    }
  }
  const final = deps.store.get(child.sessionId)?.state
  if (!final || final.status !== 'done') {
    return { ok: false, content: `agent ended with status ${final?.status ?? 'unknown'}` }
  }
  return { ok: true, content: finalAssistantText(final) }
}

function filteredAgentConfig(
  config: AgentConfig,
  requestedTools: unknown,
): AgentConfig {
  if (!Array.isArray(requestedTools)) return config
  const allowed = new Set(requestedTools.filter((t): t is string => typeof t === 'string'))
  return { ...config, tools: config.tools.filter((t) => allowed.has(t.name)) }
}

function depthOf(store: SessionStore, record: SessionRecord): number {
  let depth = 0
  let cur: SessionRecord | undefined = record
  while (cur?.parentSessionId) {
    depth++
    cur = store.get(cur.parentSessionId)
  }
  return depth
}

function finalAssistantText(state: AgentState): string {
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const msg = state.messages[i]!
    if (msg.role !== 'assistant') continue
    return msg.content
      .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
      .map((c) => c.text)
      .join('\n')
      .trim()
  }
  return ''
}

type SettableModelResolver = ModelResolver & {
  set(sessionId: string, model: string): void
  delete(sessionId: string): void
}

function isSettableModelResolver(
  models: ModelResolver | undefined,
): models is SettableModelResolver {
  return Boolean(
    models &&
      typeof (models as SettableModelResolver).set === 'function' &&
      typeof (models as SettableModelResolver).delete === 'function',
  )
}
