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
 * [ADR 0014](../../../../docs/adr/0014-subagent-approval-mode.md).
 */

import type {
  AgentConfig,
  AgentState,
  CallToolEffect,
} from '@agent-kernel/kernel'

import {
  createArtifactStore,
  isSubAgentRole,
  resolveSubAgentPolicy,
  type SubAgentPolicy,
  type SubAgentPolicyInput,
  type SubAgentRole,
} from '@agent-kernel/shared/enhancement'

import type { SessionRecord, SessionStore } from '../store/session.js'
import type { HostLoopDeps, ModelResolver } from '../loop-types.js'
import { dispatchOne } from '../loop.js'

const DEFAULT_MAX_AGENT_DEPTH = 3
const DEFAULT_MAX_AGENT_FANOUT = 4
export const AGENT_TOOL_NAME = 'agent'

type ActiveSubAgent = {
  parentSessionId: string
  parentCallId: string
  childSessionId: string
  agentType?: string
  startedAt: Date
  cancelled: boolean
  cancelReason?: string
}

const activeSubAgents = new Map<string, ActiveSubAgent>()

function activeKey(parentSessionId: string, parentCallId: string): string {
  return `${parentSessionId}\u0000${parentCallId}`
}

export function activeSubAgentFor(
  parentSessionId: string,
  parentCallId: string,
): ActiveSubAgent | null {
  return activeSubAgents.get(activeKey(parentSessionId, parentCallId)) ?? null
}

export function activeSubAgentsForParent(parentSessionId: string): readonly ActiveSubAgent[] {
  return [...activeSubAgents.values()].filter((entry) => entry.parentSessionId === parentSessionId)
}

export async function interruptSubAgent(
  deps: HostLoopDeps,
  aborts: Map<string, AbortController>,
  parentSessionId: string,
  parentCallId: string,
  childSessionId?: string,
  reason = 'sub-agent interrupted by user',
): Promise<{ ok: boolean; childSessionId?: string; error?: string }> {
  const marked = markSubAgentInterrupted(parentSessionId, parentCallId, childSessionId, reason)
  if (!marked.ok) return marked
  await dispatchOne(deps, marked.childSessionId, { kind: 'cancel' }, aborts)
  return { ok: true, childSessionId: marked.childSessionId }
}

export function markSubAgentInterrupted(
  parentSessionId: string,
  parentCallId: string,
  childSessionId?: string,
  reason = 'sub-agent interrupted by user',
): { ok: true; childSessionId: string } | { ok: false; error: string } {
  const active = activeSubAgentFor(parentSessionId, parentCallId)
  if (!active) return { ok: false, error: 'sub-agent is not running' }
  if (childSessionId && active.childSessionId !== childSessionId) {
    return { ok: false, error: 'sub-agent child session mismatch' }
  }
  active.cancelled = true
  active.cancelReason = reason
  return { ok: true, childSessionId: active.childSessionId }
}

export async function interruptSubAgentsForParent(
  deps: HostLoopDeps,
  aborts: Map<string, AbortController>,
  parentSessionId: string,
  reason = 'parent session cancelled',
): Promise<void> {
  for (const active of activeSubAgentsForParent(parentSessionId)) {
    await interruptSubAgent(deps, aborts, active.parentSessionId, active.parentCallId, active.childSessionId, reason)
  }
}

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
  const maxFanOut = parent.config.maxAgentFanOut ?? DEFAULT_MAX_AGENT_FANOUT
  const concurrentSiblingCount = activeSubAgentsForParent(parentSessionId).length

  const agentType = agentTypeOf(effect)
  const model = typeof effect.input.model === 'string' ? effect.input.model : undefined
  const policyInput = readPolicyInput(effect, parent.config)
  const policy = resolveSubAgentPolicy({
    input: policyInput,
    parentTools: parent.config.tools.map((tool) => tool.name),
    parentDepth: depth,
    maxDepth,
    concurrentSiblingCount,
    maxFanOut,
  })

  if (policy.reasons.includes('policy_max_depth_exceeded')) {
    await persistSubAgentPolicyArtifact(deps, parent, undefined, effect.callId, policy)
    return failEnvelope(
      'depth-exceeded',
      agentType,
      `agent depth exceeded: parent depth ${depth} >= max ${maxDepth}`,
      0,
      0,
    )
  }
  if (policy.reasons.includes('policy_max_fanout_exceeded')) {
    await persistSubAgentPolicyArtifact(deps, parent, undefined, effect.callId, policy)
    return failEnvelope(
      'fanout-exceeded',
      agentType,
      `agent fan-out exceeded: ${concurrentSiblingCount} live siblings >= max ${maxFanOut}`,
      0,
      0,
    )
  }

  const effectiveTools = pickEffectiveTools(effect.input.tools, policy.allowedTools)
  const child = await deps.store.create({
    config: filteredAgentConfig(parent.config, effectiveTools),
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

  await persistSubAgentPolicyArtifact(deps, parent, child.sessionId, effect.callId, policy)

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

  const active: ActiveSubAgent = {
    parentSessionId,
    parentCallId: effect.callId,
    childSessionId: child.sessionId,
    ...(agentType !== undefined ? { agentType } : {}),
    startedAt,
    cancelled: false,
  }
  activeSubAgents.set(activeKey(parentSessionId, effect.callId), active)

  const priorModel = model ? deps.models?.get(child.sessionId) : undefined
  if (model && isSettableModelResolver(deps.models)) {
    deps.models.set(child.sessionId, model)
  }
  const timeoutHandle = policy.timeoutMs !== undefined
    ? setTimeout(() => {
        void interruptSubAgent(
          deps,
          aborts,
          parentSessionId,
          effect.callId,
          child.sessionId,
          `sub-agent exceeded timeoutMs=${policy.timeoutMs}`,
        )
      }, policy.timeoutMs)
    : undefined
  let dispatchError: string | undefined
  try {
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
      if (timeoutHandle) clearTimeout(timeoutHandle)
      if (model && isSettableModelResolver(deps.models)) {
        if (priorModel) deps.models.set(child.sessionId, priorModel)
        else deps.models.delete(child.sessionId)
      }
    }
  } finally {
    activeSubAgents.delete(activeKey(parentSessionId, effect.callId))
  }
  const finishedAt = new Date()
  const durationMs = finishedAt.getTime() - startedAt.getTime()
  const final = deps.store.get(child.sessionId)?.state
  const turns = final?.cursor ?? 0

  if (active.cancelled) {
    const error = active.cancelReason ?? 'sub-agent interrupted'
    deps.broadcast.onSubAgentFinished?.({
      parentSessionId,
      parentCallId: effect.callId,
      childSessionId: child.sessionId,
      status: 'cancelled',
      turns,
      durationMs,
      finishedAt: finishedAt.toISOString(),
      error,
    })
    return cancelEnvelope(child.sessionId, agentType, error, turns, durationMs)
  }

  if (dispatchError || !final || final.status !== 'done') {
    const error =
      dispatchError ??
      final?.error ??
      `agent ended with status ${final?.status ?? 'unknown'}`
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

function cancelEnvelope(
  childSessionId: string,
  agentType: string | undefined,
  reason: string,
  turns: number,
  durationMs: number,
): { ok: false; content: string } {
  const header = envelopeHeader(childSessionId, agentType, 'cancelled', turns, durationMs)
  return {
    ok: false,
    content: `${header}\n<error>\n${escapeEnvelopeBody(reason)}\n</error>\n</sub_agent>`,
  }
}

function envelopeHeader(
  childSessionId: string,
  agentType: string | undefined,
  status: 'completed' | 'failed' | 'cancelled',
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

function readPolicyInput(effect: CallToolEffect, _parentConfig: AgentConfig): SubAgentPolicyInput | undefined {
  const raw = effect.input as Record<string, unknown>
  const roleRaw = raw['role']
  const role = isSubAgentRole(roleRaw) ? roleRaw : undefined
  const explicitAllowed = Array.isArray(raw['tools']) ? (raw['tools'] as unknown[]).filter((tool): tool is string => typeof tool === 'string') : undefined
  const input: SubAgentPolicyInput = {
    ...(role ? { role } : {}),
    ...(typeof raw['objective'] === 'string' && raw['objective'].length > 0 ? { objective: raw['objective'] as string } : {}),
    ...(explicitAllowed && explicitAllowed.length > 0 ? { allowedTools: explicitAllowed } : {}),
    ...(typeof raw['max_turns'] === 'number' && Number.isFinite(raw['max_turns']) ? { maxTurns: Math.floor(raw['max_turns'] as number) } : {}),
    ...(typeof raw['timeout_ms'] === 'number' && Number.isFinite(raw['timeout_ms']) ? { timeoutMs: Math.floor(raw['timeout_ms'] as number) } : {}),
    ...(typeof raw['expected_output'] === 'string' && raw['expected_output'].length > 0 ? { expectedOutput: raw['expected_output'] as string } : {}),
  }
  if (Object.keys(input).length === 0 && roleRaw === undefined) return undefined
  return input
}

function pickEffectiveTools(
  requestedTools: unknown,
  policyAllowedTools: readonly string[] | undefined,
): readonly string[] | undefined {
  const requested = Array.isArray(requestedTools)
    ? (requestedTools as unknown[]).filter((t): t is string => typeof t === 'string')
    : undefined
  if (policyAllowedTools && policyAllowedTools.length > 0) return policyAllowedTools
  return requested
}

async function persistSubAgentPolicyArtifact(
  deps: HostLoopDeps,
  parent: SessionRecord,
  childSessionId: string | undefined,
  parentCallId: string,
  policy: SubAgentPolicy,
): Promise<void> {
  if (!deps.artifactRootDir) return
  try {
    const store = createArtifactStore(deps.artifactRootDir, {
      ...(parent.state.cwd ? { workspaceRoot: parent.state.cwd } : {}),
    })
    const artifact = {
      schemaVersion: 1 as const,
      parentSessionId: parent.sessionId,
      parentCallId,
      ...(childSessionId ? { childSessionId } : {}),
      createdAt: new Date().toISOString(),
      policy,
    }
    await store.writeJson(
      'subagent_policy',
      `subagent-policies/${parent.sessionId}/${parentCallId}.json`,
      artifact,
    )
  } catch {
    // Persistence failures must not break the sub-agent run. The policy is a
    // derived artifact; if the disk is unavailable the sub-agent still runs
    // under the resolved policy in memory.
  }
}
