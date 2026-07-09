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
  if (depth >= maxDepth) {
    // Depth failure has no child session, so we can't emit a start/finish
    // pair. Just return the enveloped error so the parent's timeline still
    // shows the SubAgentCard in failed state.
    return failEnvelope('depth-exceeded', agentTypeOf(effect), 'agent depth exceeded', 0, 0)
  }

  const agentType = agentTypeOf(effect)
  const model = typeof effect.input.model === 'string' ? effect.input.model : undefined
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

  const startedAt = new Date()
  deps.broadcast.onSubAgentStarted?.({
    parentSessionId,
    parentCallId: effect.callId,
    childSessionId: child.sessionId,
    ...(agentType !== undefined ? { agentType } : {}),
    prompt,
    ...(model !== undefined ? { model } : {}),
    startedAt: startedAt.toISOString(),
  })

  const priorModel = model ? deps.models?.get(child.sessionId) : undefined
  if (model && isSettableModelResolver(deps.models)) {
    deps.models.set(child.sessionId, model)
  }
  let dispatchError: string | undefined
  try {
    await dispatchOne(
      deps,
      child.sessionId,
      { kind: 'user_message', text: prompt },
      aborts,
    )
  } catch (err) {
    dispatchError = err instanceof Error ? err.message : String(err)
  } finally {
    if (model && isSettableModelResolver(deps.models)) {
      if (priorModel) deps.models.set(child.sessionId, priorModel)
      else deps.models.delete(child.sessionId)
    }
  }
  const finishedAt = new Date()
  const durationMs = finishedAt.getTime() - startedAt.getTime()
  const final = deps.store.get(child.sessionId)?.state
  const turns = final?.cursor ?? 0

  if (dispatchError || !final || final.status !== 'done') {
    const error = dispatchError ?? `agent ended with status ${final?.status ?? 'unknown'}`
    deps.broadcast.onSubAgentFinished?.({
      parentSessionId,
      parentCallId: effect.callId,
      childSessionId: child.sessionId,
      status: 'failed',
      turns,
      durationMs,
      finishedAt: finishedAt.toISOString(),
      error,
    })
    return failEnvelope(child.sessionId, agentType, error, turns, durationMs)
  }

  deps.broadcast.onSubAgentFinished?.({
    parentSessionId,
    parentCallId: effect.callId,
    childSessionId: child.sessionId,
    status: 'completed',
    turns,
    durationMs,
    finishedAt: finishedAt.toISOString(),
  })
  return okEnvelope(child.sessionId, agentType, finalAssistantText(final), turns, durationMs)
}

function agentTypeOf(effect: CallToolEffect): string | undefined {
  const raw = (effect.input as Record<string, unknown>)['agent_type']
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined
}

function okEnvelope(
  childSessionId: string,
  agentType: string | undefined,
  resultText: string,
  turns: number,
  durationMs: number,
): { ok: true; content: string } {
  const header = envelopeHeader(childSessionId, agentType, 'completed', turns, durationMs)
  return {
    ok: true,
    content: `${header}\n<result>\n${escapeEnvelopeBody(resultText)}\n</result>\n</sub_agent>`,
  }
}

function failEnvelope(
  childSessionId: string,
  agentType: string | undefined,
  error: string,
  turns: number,
  durationMs: number,
): { ok: false; content: string } {
  const header = envelopeHeader(childSessionId, agentType, 'failed', turns, durationMs)
  return {
    ok: false,
    content: `${header}\n<error>\n${escapeEnvelopeBody(error)}\n</error>\n</sub_agent>`,
  }
}

function envelopeHeader(
  childSessionId: string,
  agentType: string | undefined,
  status: 'completed' | 'failed',
  turns: number,
  durationMs: number,
): string {
  const attrs = [
    `session_id="${escapeAttr(childSessionId)}"`,
    ...(agentType ? [`agent_type="${escapeAttr(agentType)}"`] : []),
    `status="${status}"`,
    `turns="${turns}"`,
    `duration_ms="${durationMs}"`,
  ]
  return `<sub_agent\n  ${attrs.join('\n  ')}\n>`
}

function escapeAttr(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escapeEnvelopeBody(text: string): string {
  // Escape only `<` and `>` so a child that returns literal HTML/XML doesn't
  // confuse the envelope parser. `&` is preserved so entities the child wrote
  // still render normally when the dashboard unescapes.
  return text.replace(/</g, '&lt;').replace(/>/g, '&gt;')
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
