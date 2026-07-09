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
 * loop without needing a public wrapper — everything downstream sees a
 * uniform record → step → persist → broadcast → effect fan-out cycle.
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
import type { SessionRecord } from './store/session.js'
import { maybeAutoCompact, runCompact } from './extensions/compaction.js'
import { AGENT_TOOL_NAME, runAgentTool } from './extensions/agent-tool.js'
import { runPostToolHooks, runPreToolHooks } from './extensions/hooks-runner.js'
import { runSkillTool, SKILL_TOOL_NAME } from './extensions/skills.js'
import type {
  HostLoopDeps,
  LoopHandle,
  LoopRuntime,
  PostCompactionLoopGuard,
} from './loop-types.js'

// Re-export the loop's type surface so existing consumers that import these
// from `./loop.js` keep resolving. The definitions live in the leaf module
// `loop-types.ts` (see the note there) to keep extensions off `loop.ts`.
export type {
  HostLoopDeps,
  LoopBroadcast,
  LoopHandle,
  LoopRuntime,
  ModelResolver,
  PostCompactionLoopGuard,
  SubAgentFinishedPayload,
  SubAgentStartedPayload,
  ToolDispatcher,
} from './loop-types.js'

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
  const loopGuard = new Map<string, PostCompactionLoopGuard>()

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
          await dispatchOne(deps, sessionId, event, inFlightAborts, undefined, undefined, {
            handle,
            loopGuard,
          })
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
      loopGuard.set(sessionId, {
        remainingCalls: POST_COMPACTION_GUARD_CALLS,
        seen: new Map(),
      })
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
  model?: string,
  runtime?: LoopRuntime,
): Promise<void> {
  const record = deps.store.get(sessionId)
  if (!record) throw new Error(`Unknown session: ${sessionId}`)

  const prior = record.state
  const { next, effects } = step(prior, event, record.config)

  const usageChanged =
    next.usage.inputTokens !== prior.usage.inputTokens ||
    next.usage.outputTokens !== prior.usage.outputTokens ||
    next.usage.cacheCreationTokens !== prior.usage.cacheCreationTokens ||
    next.usage.cacheReadTokens !== prior.usage.cacheReadTokens

  await deps.store.record(
    sessionId,
    event,
    effects,
    next,
    usageChanged ? next.usage : undefined,
    llmTrace,
    model,
  )

  safeBroadcast(() =>
    deps.broadcast.onEvent(sessionId, next.cursor, event, effects, next, llmTrace, model),
  )

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
    const inFlight = aborts.get(sessionId)
    if (inFlight) inFlight.abort()
  }

  for (const eff of effects) {
    await performEffect(deps, record, eff, aborts, runtime)
  }
}

async function performEffect(
  deps: HostLoopDeps,
  record: SessionRecord,
  effect: Effect,
  aborts: Map<string, AbortController>,
  runtime?: LoopRuntime,
): Promise<void> {
  switch (effect.kind) {
    case 'call_llm':
      return performCallLlm(deps, record.sessionId, record.config, effect, aborts, runtime)
    case 'call_tool':
      return performCallTool(deps, record.sessionId, effect, aborts, runtime)
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
  runtime?: LoopRuntime,
): Promise<void> {
  const model = deps.models?.get(sessionId)
  const messages = await messagesForLlmCall(deps, sessionId, config, effect.messages, runtime)
  const controller = new AbortController()
  aborts.set(sessionId, controller)
  // Only ask for token deltas when the broadcast wants them. If no consumer
  // is wired up, we skip streaming entirely — the adapter falls through to
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
      messages,
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
      res.trace?.model ?? model,
      runtime,
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
        undefined,
        model,
        runtime,
      )
      return
    }
    const message = err instanceof Error ? err.message : String(err)
    await dispatchOne(deps, sessionId, { kind: 'llm_error', error: message }, aborts, undefined, model, runtime)
  } finally {
    if (aborts.get(sessionId) === controller) aborts.delete(sessionId)
  }
}

async function performCallTool(
  deps: HostLoopDeps,
  sessionId: string,
  effect: CallToolEffect,
  aborts: Map<string, AbortController>,
  runtime?: LoopRuntime,
): Promise<void> {
  try {
    const blockedByLoop = guardPostCompactionLoop(sessionId, effect, runtime?.loopGuard)
    if (blockedByLoop) {
      await dispatchOne(
        deps,
        sessionId,
        {
          kind: 'tool_result',
          callId: effect.callId,
          ok: false,
          content: blockedByLoop,
        },
        aborts,
        undefined,
        undefined,
        runtime,
      )
      return
    }
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
        undefined,
        undefined,
        runtime,
      )
      return
    }
    const res = effect.name === AGENT_TOOL_NAME
      ? await runAgentTool(deps, sessionId, effect, aborts)
      : effect.name === SKILL_TOOL_NAME
        ? deps.skills
          ? await runSkillTool(deps.skills, effect.input)
          : { ok: false, content: 'skills are not configured on this host' }
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
      undefined,
      undefined,
      runtime,
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
      undefined,
      undefined,
      runtime,
    )
  }
}

const PREFLIGHT_RESERVE_FLOOR_TOKENS = 8_000
const PREFLIGHT_RESERVE_RATIO = 0.12
const POST_COMPACTION_GUARD_CALLS = 6
const POST_COMPACTION_REPEAT_LIMIT = 2

async function messagesForLlmCall(
  deps: HostLoopDeps,
  sessionId: string,
  config: AgentConfig,
  messages: readonly import('@agent-kernel/kernel').Message[],
  runtime?: LoopRuntime,
): Promise<readonly import('@agent-kernel/kernel').Message[]> {
  if (!runtime || !shouldPreflightCompact(config, messages)) return messages
  await runtime.handle.compact(sessionId, 'preflight')
  return deps.store.get(sessionId)?.state.messages ?? messages
}

function shouldPreflightCompact(
  config: AgentConfig,
  messages: readonly import('@agent-kernel/kernel').Message[],
): boolean {
  if (!config.contextLimit || config.contextLimit <= 0) return false
  if (!messages.some((m) => m.role !== 'system')) return false
  const reserve = Math.min(
    Math.max(
      PREFLIGHT_RESERVE_FLOOR_TOKENS,
      Math.round(config.contextLimit * PREFLIGHT_RESERVE_RATIO),
    ),
    Math.floor(config.contextLimit * 0.25),
  )
  const limit = Math.max(0, config.contextLimit - reserve)
  return estimateMessageTokens(messages) >= limit
}

function estimateMessageTokens(messages: readonly import('@agent-kernel/kernel').Message[]): number {
  let chars = 0
  for (const message of messages) {
    chars += message.role.length + 8
    for (const content of message.content) {
      if (content.type === 'text' || content.type === 'thinking') chars += content.text.length
      else if (content.type === 'tool_call') chars += content.name.length + content.callId.length + JSON.stringify(content.input).length
      else if (content.type === 'tool_result') chars += content.callId.length + content.content.length + 16
      else chars += content.source.kind === 'file_ref'
        ? content.source.path.length + 64
        : Math.round(content.source.data.length / 4)
    }
  }
  return Math.ceil(chars / 4)
}

function guardPostCompactionLoop(
  sessionId: string,
  effect: CallToolEffect,
  guards: Map<string, PostCompactionLoopGuard> | undefined,
): string | undefined {
  const guard = guards?.get(sessionId)
  if (!guard) return undefined
  guard.remainingCalls -= 1
  if (guard.remainingCalls < 0) {
    guards?.delete(sessionId)
    return undefined
  }
  const key = `${effect.name}:${stableStringify(effect.input)}`
  const count = (guard.seen.get(key) ?? 0) + 1
  guard.seen.set(key, count)
  if (count <= POST_COMPACTION_REPEAT_LIMIT) return undefined
  guards?.delete(sessionId)
  return `blocked: repeated identical tool call after context compaction (${effect.name}). Re-read compacted context and choose a different next step.`
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
  return `{${entries.join(',')}}`
}

function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === 'AbortError' || err.message.toLowerCase().includes('abort'))
  )
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
