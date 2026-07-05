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
  Message,
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
}

export type LoopHandle = {
  dispatch(sessionId: string, event: AgentEvent): Promise<void>
  compact(sessionId: string): Promise<void>
  /**
   * Abort the in-flight LLM call for a session, if any. Any streamed text
   * so far becomes the final assistant message with a `[cancelled]` suffix,
   * so the event log always sees a complete `llm_response`  -  never a
   * dangling call. No-op when nothing is streaming.
   */
  cancelStream(sessionId: string): void
}

/**
 * Fixed instruction fed to the summarizer LLM call. The output replaces the
 * session's message list, so preserving every decision / file path / open
 * TODO matters more than prose polish.
 */
const SUMMARIZER_PROMPT =
  'You are a summarizer. Compress the conversation above into a single, dense summary under 800 tokens. Preserve every decision, file path, tool result, and open task. Do not add commentary. Reply with ONLY the summary text.'
const COMPACT_TIMEOUT_MS = 60_000

const AGENT_TOOL_NAME = 'agent'
const DEFAULT_MAX_AGENT_DEPTH = 3

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

  const handle: LoopHandle = {
    async dispatch(sessionId, event) {
      await dispatchOne(deps, sessionId, event, inFlightAborts)
      await maybeAutoCompact(deps, sessionId, compactionInFlight, handle)
    },
    async compact(sessionId) {
      await runCompact(deps, sessionId, compactionInFlight, inFlightAborts)
    },
    cancelStream(sessionId) {
      const ctrl = inFlightAborts.get(sessionId)
      if (ctrl) ctrl.abort()
    },
  }
  return handle
}

async function maybeAutoCompact(
  deps: HostLoopDeps,
  sessionId: string,
  inFlight: Set<string>,
  handle: LoopHandle,
): Promise<void> {
  const record = deps.store.get(sessionId)
  if (!record) return
  if (record.state.contextPressureLevel !== 'hard') return
  // Only auto-fire when the session is at a resting point. Firing mid-turn
  // (thinking / awaiting_approval / executing_tools) would try to compact
  // messages the reducer refuses to drop while pending calls exist.
  const s = record.state.status
  if (s !== 'idle' && s !== 'done' && s !== 'error') return
  if (inFlight.has(sessionId)) return
  await handle.compact(sessionId)
}

async function runCompact(
  deps: HostLoopDeps,
  sessionId: string,
  inFlight: Set<string>,
  aborts: Map<string, AbortController>,
): Promise<void> {
  if (inFlight.has(sessionId)) return
  const record = deps.store.get(sessionId)
  if (!record) throw new Error(`Unknown session: ${sessionId}`)
  const s = record.state.status
  if (s !== 'idle' && s !== 'done' && s !== 'error') {
    throw new Error('cannot compact while the session is busy')
  }
  if (!hasCompactableContent(record.state.messages)) {
    throw new Error('nothing to compact yet')
  }

  inFlight.add(sessionId)
  try {
    const tokensBefore = record.state.usage.inputTokens
    const replacedCount = record.state.messages.length
    const summary = await summarize(deps, sessionId, record.state.messages)
    // No provider gives a reliable prompt-token count for the summary alone
    // before it's used. Estimate cheaply: 4 chars  -  1 token. Refined on the
    // next real LLM call where usage.inputTokens is reported by the provider.
    const tokensAfter = Math.max(0, Math.round(summary.length / 4))
    await dispatchOne(
      deps,
      sessionId,
      {
        kind: 'compact_replaced',
        summary,
        replacedCount,
        tokensBefore,
        tokensAfter,
      },
      aborts,
    )
  } finally {
    inFlight.delete(sessionId)
  }
}

async function summarize(
  deps: HostLoopDeps,
  sessionId: string,
  messages: readonly Message[],
): Promise<string> {
  const model = deps.models?.get(sessionId)
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), COMPACT_TIMEOUT_MS)
  let res: Awaited<ReturnType<HostLoopDeps['llm']['call']>>
  try {
    res = await deps.llm.call({
      messages,
      tools: [],
      systemPrompt: SUMMARIZER_PROMPT,
      signal: ctrl.signal,
      ...(model ? { model } : {}),
    })
  } catch (err) {
    if (ctrl.signal.aborted) throw new Error('compact timed out')
    throw err
  } finally {
    clearTimeout(timer)
  }
  const text = res.message.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('\n')
  return text.trim() || '[compact produced empty summary]'
}

function hasCompactableContent(messages: readonly Message[]): boolean {
  return messages.some((m) => m.role !== 'system')
}

async function dispatchOne(
  deps: HostLoopDeps,
  sessionId: string,
  event: AgentEvent,
  aborts: Map<string, AbortController>,
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
        deps.broadcast.onTokenDelta!(sessionId, t)
      }
    : undefined
  try {
    const res = await deps.llm.call({
      messages: effect.messages,
      tools: effect.tools,
      signal: controller.signal,
      ...(config.systemPrompt ? { systemPrompt: config.systemPrompt } : {}),
      ...(model ? { model } : {}),
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
    const res = effect.name === AGENT_TOOL_NAME
      ? await runAgentTool(deps, sessionId, effect, aborts)
      : await deps.tools.callTool(sessionId, effect)
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

async function runAgentTool(
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
  deps.broadcast.onError(sessionId, effect.error)
}
