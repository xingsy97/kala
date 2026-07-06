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
 * `dispatchOne` is exported so sibling modules (`compaction.ts`,
 * `agent-tool.ts`) can dispatch synthesised events back through the same
 * loop without needing a public wrapper  -  everything downstream sees a
 * uniform record  -  step  -  persist  -  broadcast  -  effect fan-out cycle.
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
import type { LLMTrace } from '@agent-kernel/shared'
import type { HookConfig, HookRunner } from './hooks.js'
import type { SessionRecord, SessionStore } from './store/session.js'
import { maybeAutoCompact, runCompact } from './compaction.js'
import { AGENT_TOOL_NAME, runAgentTool } from './agent-tool.js'
import { runPostToolHooks, runPreToolHooks } from './hooks-runner.js'

export type LoopBroadcast = {
  onEvent(
    sessionId: string,
    seq: number,
    event: AgentEvent,
    effects: readonly Effect[],
    state: AgentState,
    llmTrace?: LLMTrace,
  ): void
  onApprovalRequired(sessionId: string, eff: RequestApprovalEffect): void
  onError(sessionId: string, message: string): void
  onUsageChanged(sessionId: string, state: AgentState): void
  /**
   * Streaming text token from the adapter, forwarded to dashboards.
   * Optional  -  non-streaming adapters never invoke it and the wire event
   * simply doesn't fire.
   */
  onTokenDelta?(sessionId: string, text: string): void
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
  hooks?: readonly HookConfig[]
  hookRunner?: HookRunner
}

export type LoopHandle = {
  dispatch(sessionId: string, event: AgentEvent): Promise<void>
  compact(sessionId: string, trigger?: 'manual' | 'auto'): Promise<void>
  /**
   * Abort the in-flight LLM call for a session, if any. Any streamed text
   * so far becomes the final assistant message with a `[cancelled]` suffix,
   * so the event log always sees a complete `llm_response`  -  never a
   * dangling call. No-op when nothing is streaming.
   */
  cancelStream(sessionId: string): void
}

export function runHostLoop(deps: HostLoopDeps): LoopHandle {
  // Per-session guard so an auto-compact triggered by a hard-tier state
  // change can't fire again while the summarizer LLM call is still in flight.
  // Also blocks user-triggered `/compact` from stacking on top of an
  // in-flight compaction.
  const compactionInFlight = new Set<string>()

  // Per-session AbortController for the currently in-flight LLM call.
  // `cancelStream` aborts it; `performCallLlm` installs a fresh one at the
  // start of every call and clears it on completion.
  const inFlightAborts = new Map<string, AbortController>()
  const sessionTails = new Map<string, Promise<void>>()

  const handle: LoopHandle = {
    async dispatch(sessionId, event) {
      if (event.kind === 'cancel') {
        await dispatchOne(deps, sessionId, event, inFlightAborts)
        return
      }
      const prior = sessionTails.get(sessionId) ?? Promise.resolve()
      const next = prior
        .catch(() => {})
        .then(async () => {
          await dispatchOne(deps, sessionId, event, inFlightAborts)
          await maybeAutoCompact(deps, sessionId, compactionInFlight, handle)
        })
        .finally(() => {
          if (sessionTails.get(sessionId) === next) sessionTails.delete(sessionId)
        })
      sessionTails.set(sessionId, next)
      await next
    },
    async compact(sessionId, trigger = 'manual') {
      await runCompact(deps, sessionId, trigger, compactionInFlight, inFlightAborts)
    },
    cancelStream(sessionId) {
      const ctrl = inFlightAborts.get(sessionId)
      if (ctrl) ctrl.abort()
    },
  }
  return handle
}

export async function dispatchOne(
  deps: HostLoopDeps,
  sessionId: string,
  event: AgentEvent,
  aborts: Map<string, AbortController>,
  llmTrace?: LLMTrace,
): Promise<void> {
  const record = deps.store.get(sessionId)
  if (!record) throw new Error(`Unknown session: ${sessionId}`)

  const prior = record.state
  const { next, effects } = step(prior, event, record.config)

  const usageChanged =
    next.usage.inputTokens !== prior.usage.inputTokens ||
    next.usage.outputTokens !== prior.usage.outputTokens ||
    next.usage.costUsd !== prior.usage.costUsd ||
    next.usage.cacheCreationTokens !== prior.usage.cacheCreationTokens ||
    next.usage.cacheReadTokens !== prior.usage.cacheReadTokens

  await deps.store.record(
    sessionId,
    event,
    effects,
    next,
    usageChanged ? next.usage : undefined,
    llmTrace,
  )

  safeBroadcast(() =>
    deps.broadcast.onEvent(sessionId, next.cursor, event, effects, next, llmTrace),
  )
  if (usageChanged) {
    safeBroadcast(() => deps.broadcast.onUsageChanged(sessionId, next))
  }

  // Cancellation of in-flight IO is the host's job (SPEC  - Non-goals:
  // "Cancellation of in-flight tools  -  Only handles state  -  Host cancels
  // IO"). The kernel already dropped pendingCalls; here we tell the
  // executor to stop chewing on the corresponding subprocesses so
  // `tool:cancel` reaches it per wire-protocol  - 5.2. This runs
  // regardless of whether pending was empty  -  cancelPending is a no-op
  // in that case, and being unconditional matches the spec's "cancel
  // means stop everything now" contract. Runs before effect fan-out so
  // even if a stray call_llm/call_tool effect appeared it wouldn't race
  // against a still-live executor.
  if (event.kind === 'cancel') {
    deps.tools.cancelPending(sessionId)
    const inFlight = aborts.get(sessionId)
    if (inFlight) inFlight.abort()
  }

  for (const eff of effects) {
    await performEffect(deps, record, eff, aborts)
  }
}

async function performEffect(
  deps: HostLoopDeps,
  record: SessionRecord,
  effect: Effect,
  aborts: Map<string, AbortController>,
): Promise<void> {
  switch (effect.kind) {
    case 'call_llm':
      return performCallLlm(deps, record.sessionId, record.config, effect, aborts)
    case 'call_tool':
      return performCallTool(deps, record.sessionId, effect, aborts)
    case 'request_approval':
      safeBroadcast(() => deps.broadcast.onApprovalRequired(record.sessionId, effect))
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
  aborts: Map<string, AbortController>,
): Promise<void> {
  const model = deps.models?.get(sessionId)
  const controller = new AbortController()
  aborts.set(sessionId, controller)
  // Only ask for token deltas when the broadcast wants them. If no consumer
  // is wired up, we skip streaming entirely  -  the adapter falls through to
  // the plain buffered path and no partial-message accounting is needed.
  let streamedText = ''
  const wantStream = typeof deps.broadcast.onTokenDelta === 'function'
  const onTextDelta = wantStream
    ? (t: string) => {
        streamedText += t
        safeBroadcast(() => deps.broadcast.onTokenDelta!(sessionId, t))
      }
    : undefined
  try {
    const res = await deps.llm.call({
      messages: effect.messages,
      tools: effect.tools,
      signal: controller.signal,
      ...(config.systemPrompt ? { systemPrompt: config.systemPrompt } : {}),
      ...(model ? { model } : {}),
      ...(config.thinkingBudget !== undefined
        ? { thinkingBudget: config.thinkingBudget }
        : {}),
      ...(onTextDelta ? { onTextDelta } : {}),
    })
    await dispatchOne(
      deps,
      sessionId,
      {
        kind: 'llm_response',
        message: res.message,
        ...(res.usage ? { usage: res.usage } : {}),
      },
      aborts,
      res.trace,
    )
  } catch (err) {
    // AbortError from the fetch call means the user cancelled mid-stream.
    // Turn whatever was collected into a normal llm_response so the log
    // stays exact and the FSM leaves the `thinking` state.
    if (isAbortError(err)) {
      const suffix = streamedText.length > 0 ? '\n\n[cancelled]' : '[cancelled]'
      await dispatchOne(
        deps,
        sessionId,
        {
          kind: 'llm_response',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: streamedText + suffix }],
          },
        },
        aborts,
      )
      return
    }
    const message = err instanceof Error ? err.message : String(err)
    await dispatchOne(deps, sessionId, { kind: 'llm_error', error: message }, aborts)
  } finally {
    if (aborts.get(sessionId) === controller) aborts.delete(sessionId)
  }
}

async function performCallTool(
  deps: HostLoopDeps,
  sessionId: string,
  effect: CallToolEffect,
  aborts: Map<string, AbortController>,
): Promise<void> {
  try {
    const blocked = await runPreToolHooks(deps, sessionId, effect)
    if (blocked) {
      await dispatchOne(
        deps,
        sessionId,
        {
          kind: 'tool_result',
          callId: effect.callId,
          ok: false,
          content: blocked,
        },
        aborts,
      )
      return
    }
    const res = effect.name === AGENT_TOOL_NAME
      ? await runAgentTool(deps, sessionId, effect, aborts)
      : await deps.tools.callTool(sessionId, effect)
    await runPostToolHooks(deps, sessionId, effect, res)
    await dispatchOne(
      deps,
      sessionId,
      {
        kind: 'tool_result',
        callId: effect.callId,
        ok: res.ok,
        content: res.content,
      },
      aborts,
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await dispatchOne(
      deps,
      sessionId,
      {
        kind: 'tool_result',
        callId: effect.callId,
        ok: false,
        content: message,
      },
      aborts,
    )
  }
}

function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === 'AbortError' || err.message.toLowerCase().includes('abort'))
  )
}

function performFinish(_effect: FinishEffect): void {
  // Turn ended. Nothing to do  -  the state.status='done' broadcast already
  // told subscribers. Kept as a switch case for exhaustiveness.
}

function performEmitError(
  deps: HostLoopDeps,
  sessionId: string,
  effect: EmitErrorEffect,
): void {
  safeBroadcast(() => deps.broadcast.onError(sessionId, effect.error))
}

function safeBroadcast(fn: () => void): void {
  try {
    fn()
  } catch {
    // Broadcast failures are delivery failures, not state-machine failures.
    // The event has already been persisted, so clients can recover by
    // resubscribing and replaying from the JSONL log.
  }
}
