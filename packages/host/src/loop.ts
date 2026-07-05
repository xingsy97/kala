/**
 * The host loop.
 *
 * The kernel is a pure function. The host loop is the impure driver: it
 *   1. calls `step(state, event, config)` for every incoming event,
 *   2. persists the event to the JSONL log,
 *   3. broadcasts state/event changes to Socket.IO subscribers,
 *   4. inspects the returned effects and *performs* them (LLM call, tool
 *      dispatch, approval request, finish, error), which may produce new
 *      events that feed back into (1).
 *
 * The loop's control flow lives inside `Session.dispatch()`. Each dispatch
 * is a single kernel step plus its side-effect fan-out; callers await it to
 * be sure the persisted log is in sync with in-memory state before returning
 * over the wire.
 */

import type {
  AgentConfig,
  AgentEvent,
  AgentState,
  CallLlmEffect,
  CallToolEffect,
  EmitErrorEffect,
  FinishEffect,
  RequestApprovalEffect,
  Effect,
} from '@agent-kernel/kernel'
import { step } from '@agent-kernel/kernel'

import type { LLMAdapter } from './llm/adapter.js'
import type { SessionRecord, SessionStore } from './store/session.js'

export type LoopBroadcast = {
  onEvent(
    sessionId: string,
    seq: number,
    event: AgentEvent,
    effects: readonly Effect[],
    state: AgentState,
  ): void
  onApprovalRequired(sessionId: string, eff: RequestApprovalEffect): void
  onError(sessionId: string, message: string): void
  onUsageChanged(sessionId: string, state: AgentState): void
}

export type ToolDispatcher = {
  callTool(sessionId: string, eff: CallToolEffect): Promise<{
    ok: boolean
    content: string
  }>
  cancelPending(sessionId: string): void
}

export type ModelResolver = {
  get(sessionId: string): string | undefined
}

export type HostLoopDeps = {
  store: SessionStore
  llm: LLMAdapter
  tools: ToolDispatcher
  broadcast: LoopBroadcast
  models?: ModelResolver
}

export type LoopHandle = {
  dispatch(sessionId: string, event: AgentEvent): Promise<void>
}

export function runHostLoop(deps: HostLoopDeps): LoopHandle {
  return {
    async dispatch(sessionId, event) {
      await dispatchOne(deps, sessionId, event)
    },
  }
}

async function dispatchOne(
  deps: HostLoopDeps,
  sessionId: string,
  event: AgentEvent,
): Promise<void> {
  const record = deps.store.get(sessionId)
  if (!record) throw new Error(`Unknown session: ${sessionId}`)

  const prior = record.state
  const { next, effects } = step(prior, event, record.config)

  const usageChanged =
    next.usage.inputTokens !== prior.usage.inputTokens ||
    next.usage.outputTokens !== prior.usage.outputTokens ||
    next.usage.costUsd !== prior.usage.costUsd

  await deps.store.record(
    sessionId,
    event,
    effects,
    next,
    usageChanged ? next.usage : undefined,
  )

  deps.broadcast.onEvent(sessionId, next.cursor, event, effects, next)
  if (usageChanged) deps.broadcast.onUsageChanged(sessionId, next)

  // Cancellation of in-flight IO is the host's job (SPEC §Non-goals:
  // "Cancellation of in-flight tools — Only handles state — Host cancels
  // IO"). The kernel already dropped pendingCalls; here we tell the
  // executor to stop chewing on the corresponding subprocesses so
  // `tool:cancel` reaches it per wire-protocol §5.2. This runs
  // regardless of whether pending was empty — cancelPending is a no-op
  // in that case, and being unconditional matches the spec's "cancel
  // means stop everything now" contract. Runs before effect fan-out so
  // even if a stray call_llm/call_tool effect appeared it wouldn't race
  // against a still-live executor.
  if (event.kind === 'cancel') {
    deps.tools.cancelPending(sessionId)
  }

  for (const eff of effects) {
    await performEffect(deps, record, eff)
  }
}

async function performEffect(
  deps: HostLoopDeps,
  record: SessionRecord,
  effect: Effect,
): Promise<void> {
  switch (effect.kind) {
    case 'call_llm':
      return performCallLlm(deps, record.sessionId, record.config, effect)
    case 'call_tool':
      return performCallTool(deps, record.sessionId, effect)
    case 'request_approval':
      deps.broadcast.onApprovalRequired(record.sessionId, effect)
      return
    case 'finish':
      performFinish(effect)
      return
    case 'emit_error':
      performEmitError(deps, record.sessionId, effect)
      return
  }
}

async function performCallLlm(
  deps: HostLoopDeps,
  sessionId: string,
  config: AgentConfig,
  effect: CallLlmEffect,
): Promise<void> {
  const model = deps.models?.get(sessionId)
  try {
    const res = await deps.llm.call({
      messages: effect.messages,
      tools: effect.tools,
      ...(config.systemPrompt ? { systemPrompt: config.systemPrompt } : {}),
      ...(model ? { model } : {}),
    })
    await dispatchOne(deps, sessionId, {
      kind: 'llm_response',
      message: res.message,
      ...(res.usage ? { usage: res.usage } : {}),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await dispatchOne(deps, sessionId, { kind: 'llm_error', error: message })
  }
}

async function performCallTool(
  deps: HostLoopDeps,
  sessionId: string,
  effect: CallToolEffect,
): Promise<void> {
  try {
    const res = await deps.tools.callTool(sessionId, effect)
    await dispatchOne(deps, sessionId, {
      kind: 'tool_result',
      callId: effect.callId,
      ok: res.ok,
      content: res.content,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await dispatchOne(deps, sessionId, {
      kind: 'tool_result',
      callId: effect.callId,
      ok: false,
      content: message,
    })
  }
}

function performFinish(_effect: FinishEffect): void {
  // Turn ended. Nothing to do — the state.status='done' broadcast already
  // told subscribers. Kept as a switch case for exhaustiveness.
}

function performEmitError(
  deps: HostLoopDeps,
  sessionId: string,
  effect: EmitErrorEffect,
): void {
  deps.broadcast.onError(sessionId, effect.error)
}
