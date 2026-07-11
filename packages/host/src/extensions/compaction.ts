/**
 * Context compaction.
 *
 * When `state.contextPressureLevel === 'hard'` (auto) or the user fires
 * `/compact` (manual), summarize the old message prefix into one synthetic
 * system message while keeping the most recent user turn verbatim. The reducer
 * applies the replacement in response to a `compact_replaced` event; this
 * module chooses the pivot, drives the summarizer LLM call with a bounded
 * retry ladder, and dispatches the event through the normal loop path.
 *
 * Robustness surface (see `docs/host/context-compaction.md`  -  that document is
 * the source of truth):
 *
 * - **Consecutive-failure circuit breaker**. Three failed non-manual attempts
 *   in a row disable auto/preflight/tool_result triggers for the session; a
 *   successful manual attempt resets the counter.
 * - **Summarizer retry ladder**. Context-window failures trigger a bounded
 *   sequence of retries: tighten tool-result caps, then head-drop oldest
 *   groups (assistant + its subsequent tool_results) so tool_call/tool_result
 *   pairing is preserved across the trim.
 * - **Same-batch back-off**. A failed `tool_result` compaction mutes further
 *   in-batch retries so we don't loop after every subsequent tool result.
 * - **Empty summary rejection**. A summarizer that returns nothing is a
 *   failed attempt, not a successful compaction of the transcript to "".
 * - **Reducer rejection observability**. When the reducer refuses a
 *   `compact_replaced` (would orphan a pending tool_result), the host detects
 *   the noop, dispatches `compact_rejected` for ledger visibility, and counts
 *   the attempt as a failure.
 * - **Unknown-context-limit fallback**. Preflight uses a synthetic 128k
 *   fallback and disables auto rather than silently doing nothing.
 */

import type {
  AgentEvent,
  AgentState,
  Message,
  MessageContent,
} from '@agent-kernel/kernel'
import type { LLMTrace } from '@agent-kernel/shared'
import {
  createArtifactStore,
  validateCompactionSummary,
  type CompactionSummaryValidation,
} from '@agent-kernel/shared/enhancement'

import type { HostLoopDeps, LoopHandle } from '../loop-types.js'
import { dispatchOne } from '../loop.js'

const SUMMARIZER_PROMPT = `You are compacting an agent-kernel coding-agent session.

Summarize ONLY the messages provided in this compaction request. A recent suffix of the conversation will be kept verbatim after your summary, so do not invent or describe messages you cannot see.

Write a concise but complete engineering handoff in Markdown with exactly these sections:

# Compacted Context
## User Intent And Constraints
Capture explicit user requests, corrections, preferences, and constraints that should continue to govern future work.

## Repository And Runtime State
Capture relevant project architecture, current working directory if known, important files/modules, active session state, selected model/provider facts if they matter, and durable environment assumptions.

## Decisions And Rationale
Capture decisions already made and why, especially rejected alternatives or constraints that prevent rework.

## Work Completed
List concrete changes, file paths, commands run, tests run, and observed outcomes. Include failures and partial attempts when they matter.

## Open Work
List remaining tasks, blockers, uncertainties, and the next best action.

Rules:
- Preserve exact file paths, command names, tool names, identifiers, error messages, test names, API shapes, and user wording when important.
- Preserve todo/task state from todowrite or equivalent tool calls.
- Preserve tool-result evidence, but summarize noisy logs to the command, exit/status, and decisive lines.
- Do not include generic advice, filler, or commentary about being a summary.
- Do not claim work is done unless the provided messages establish it.
- Keep the whole response under 1600 tokens.`

const COMPACT_TIMEOUT_MS = 60_000
const MIN_RECENT_TAIL_TOKENS = 4_000
const TARGET_RECENT_TAIL_RATIO = 0.15
const MAX_RECENT_TAIL_TOKENS = 24_000

// Retry ladder  -  each entry is one summarizer attempt. See the doc table for
// the reasoning; briefly: attempt 1 uses the normal cap, then we tighten,
// then we start head-dropping while keeping tool_call/tool_result pairing
// intact by dropping whole assistant-message groups at a time.
const RETRY_LADDER: readonly {
  toolResultCap: number
  dropHeadGroups: number
}[] = [
  { toolResultCap: 8_000, dropHeadGroups: 0 },
  { toolResultCap: 2_000, dropHeadGroups: 0 },
  { toolResultCap: 2_000, dropHeadGroups: 1 },
  { toolResultCap: 2_000, dropHeadGroups: 2 },
]

const MAX_CONSECUTIVE_COMPACT_FAILURES = 3

// Fallback used when the session config has no contextLimit set. Chosen so
// preflight is a useful brake for typical modern models (200k Claude, 128k
// GPT-4o class) rather than a silent no-op. Never overrides real config.
const FALLBACK_CONTEXT_LIMIT_TOKENS = 128_000

type CompactTrigger = 'manual' | 'auto' | 'preflight' | 'tool_result'

/**
 * Per-session runtime state that the compaction extension needs across calls.
 * Kept as a module-scope map (rather than plumbed through HostLoopDeps) so
 * this remains a purely additive change; if the process restarts the counter
 * resets, which mirrors the fact that manual compaction is always allowed.
 */
type CompactSessionRuntime = {
  consecutiveFailures: number
  // Marks a same-batch back-off. The value is a stable identifier for the
  // active batch; when the batch identifier changes (or clears), back-off
  // lifts. We use the id of the assistant message that spawned the batch.
  mutedForBatch?: string
}

const sessionRuntime = new Map<string, CompactSessionRuntime>()

function getRuntime(sessionId: string): CompactSessionRuntime {
  let rt = sessionRuntime.get(sessionId)
  if (!rt) {
    rt = { consecutiveFailures: 0 }
    sessionRuntime.set(sessionId, rt)
  }
  return rt
}

export function resetCompactRuntime(sessionId: string): void {
  sessionRuntime.delete(sessionId)
}

export async function maybeAutoCompact(
  deps: HostLoopDeps,
  sessionId: string,
  inFlight: Set<string>,
  handle: LoopHandle,
): Promise<void> {
  const record = deps.store.get(sessionId)
  if (!record) return
  if (record.state.contextPressureLevel !== 'hard') return
  const s = record.state.status
  if (s !== 'idle' && s !== 'done' && s !== 'error') return
  if (inFlight.has(sessionId)) return
  await handle.compact(sessionId, 'auto')
}

export async function runCompact(
  deps: HostLoopDeps,
  sessionId: string,
  trigger: CompactTrigger,
  inFlight: Set<string>,
  aborts: Map<string, AbortController>,
): Promise<boolean> {
  if (inFlight.has(sessionId)) {
    // Concurrent invocation. `manual` is the only one a human sees; the
    // others (auto/preflight/tool_result) are silent no-ops by design.
    if (trigger === 'manual') throw new Error('compact already in flight')
    return false
  }
  const record = deps.store.get(sessionId)
  if (!record) throw new Error(`Unknown session: ${sessionId}`)
  const rt = getRuntime(sessionId)
  const attemptId = newAttemptId()

  if (trigger !== 'manual' && rt.consecutiveFailures >= MAX_CONSECUTIVE_COMPACT_FAILURES) {
    await dispatchSkip(deps, sessionId, trigger, attemptId, 'circuit_breaker_open', aborts)
    return false
  }

  // Same-batch back-off: after a failed tool_result compaction we mute
  // further attempts for the same active batch. The batch identity is the
  // index of the assistant message that owns the currently-pending calls.
  if (trigger === 'tool_result') {
    const batchId = activeBatchIdentity(record.state)
    if (batchId && rt.mutedForBatch === batchId) {
      await dispatchSkip(deps, sessionId, trigger, attemptId, 'back_off_same_batch', aborts)
      return false
    }
  }

  const s = record.state.status
  if (s !== 'idle' && s !== 'done' && s !== 'error' && !isBusyCompactable(trigger, record.state)) {
    if (trigger === 'manual') throw new Error('cannot compact while the session is busy')
    await dispatchSkip(deps, sessionId, trigger, attemptId, 'session_busy', aborts)
    return false
  }
  if (!hasCompactableContent(record.state.messages)) {
    if (trigger === 'manual') throw new Error('nothing to compact yet')
    await dispatchSkip(deps, sessionId, trigger, attemptId, 'no_compactable_content', aborts)
    return false
  }

  inFlight.add(sessionId)
  try {
    const contextLimit = record.config.contextLimit
    const tokensBefore = record.state.usage.inputTokens
    const replacedCount = record.state.messages.length
    const preserveFrom = choosePreserveFrom(record.state, trigger, contextLimit)
    const preservedTail = record.state.messages.slice(preserveFrom)

    let compact: SummarizeOk
    try {
      compact = await summarizeWithLadder(deps, sessionId, record.state.messages.slice(0, preserveFrom))
    } catch (err) {
      await recordFailure(deps, sessionId, trigger, attemptId, rt, err, aborts)
      if (trigger === 'tool_result') markBatchBackOff(rt, record.state)
      if (trigger === 'manual') throw err
      return false
    }

    if (!compact.summary || compact.summary.length === 0) {
      await recordFailure(deps, sessionId, trigger, attemptId, rt, new Error('empty summary'), aborts, 'empty_summary')
      if (trigger === 'tool_result') markBatchBackOff(rt, record.state)
      if (trigger === 'manual') throw new Error('summarizer returned empty summary')
      return false
    }

    const validation = validateCompactionSummary(compact.summary)
    await maybeWriteCompactionSummaryValidation(deps, sessionId, trigger, validation, compact.summary)

    if (validation.reasonCodes.includes('empty_summary')) {
      await recordFailure(deps, sessionId, trigger, attemptId, rt, new Error('empty summary'), aborts, 'empty_summary')
      if (trigger === 'tool_result') markBatchBackOff(rt, record.state)
      if (trigger === 'manual') throw new Error('summarizer returned empty summary')
      return false
    }

    const tokensAfter = Math.max(
      0,
      Math.round(compact.summary.length / 4) + estimateTokens(preservedTail),
    )

    const messagesBefore = deps.store.get(sessionId)?.state.messages.length ?? 0
    await dispatchOne(
      deps,
      sessionId,
      {
        kind: 'compact_replaced',
        trigger,
        attemptId,
        preserveFrom,
        request: compact.request,
        ...(compact.usage ? { responseUsage: compact.usage } : {}),
        summary: compact.summary,
        replacedCount,
        tokensBefore,
        tokensAfter,
      },
      aborts,
      compact.trace,
      compact.model,
    )

    // Reducer-rejection detection: if the reducer refused the pivot (would
    // orphan a pending tool_result, or preserveFrom was invalid), it silently
    // no-ops. We detect by observing that message count did not change.
    // preserveFrom < messagesBefore should always reduce count; equal count
    // after with a non-empty summary means the reducer noop'd.
    const messagesAfter = deps.store.get(sessionId)?.state.messages.length ?? 0
    const expectedNewCount = expectedMessageCountAfter(record.state.messages, preserveFrom)
    if (messagesAfter === messagesBefore && messagesBefore !== expectedNewCount) {
      const reason: 'pending_call_orphaned' | 'invalid_preserve_from' =
        record.state.pendingCalls.length > 0 ? 'pending_call_orphaned' : 'invalid_preserve_from'
      await dispatchOne(
        deps,
        sessionId,
        { kind: 'compact_rejected', attemptId, reason },
        aborts,
      )
      rt.consecutiveFailures += 1
      if (trigger === 'tool_result') markBatchBackOff(rt, record.state)
      if (trigger === 'manual') throw new Error(`compact rejected by reducer: ${reason}`)
      return false
    }

    // Success: reset counters and back-off.
    rt.consecutiveFailures = 0
    rt.mutedForBatch = undefined
    return true
  } finally {
    inFlight.delete(sessionId)
  }
}

async function recordFailure(
  deps: HostLoopDeps,
  sessionId: string,
  trigger: CompactTrigger,
  attemptId: string,
  rt: CompactSessionRuntime,
  err: unknown,
  aborts: Map<string, AbortController>,
  reasonOverride?: 'empty_summary',
): Promise<void> {
  rt.consecutiveFailures += 1
  const reason = reasonOverride ?? 'summarizer_failed'
  await dispatchSkip(deps, sessionId, trigger, attemptId, reason, aborts, errorMessage(err))
}

async function dispatchSkip(
  deps: HostLoopDeps,
  sessionId: string,
  trigger: CompactTrigger,
  attemptId: string,
  reason:
    | 'circuit_breaker_open'
    | 'back_off_same_batch'
    | 'summarizer_failed'
    | 'empty_summary'
    | 'no_compactable_content'
    | 'session_busy',
  aborts: Map<string, AbortController>,
  errorMessageText?: string,
): Promise<void> {
  await dispatchOne(
    deps,
    sessionId,
    {
      kind: 'compact_skipped',
      trigger,
      attemptId,
      reason,
      ...(errorMessageText ? { errorMessage: errorMessageText } : {}),
    },
    aborts,
  )
}

function markBatchBackOff(rt: CompactSessionRuntime, state: AgentState): void {
  const id = activeBatchIdentity(state)
  if (id) rt.mutedForBatch = id
}

function activeBatchIdentity(state: AgentState): string | undefined {
  const idx = findActiveToolBatchIndex(state)
  if (idx === undefined) return undefined
  return `batch:${idx}`
}

function expectedMessageCountAfter(before: readonly Message[], preserveFrom: number): number {
  // Reducer keeps the leading system message (if any), inserts the summary
  // system message, then appends the preserved tail. So expected new count =
  // 1 (system, if present) + 1 (summary) + (before.length - preserveFrom).
  const leadingSystem = before.length > 0 && before[0]!.role === 'system' ? 1 : 0
  return leadingSystem + 1 + (before.length - preserveFrom)
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  try {
    return String(err)
  } catch {
    return 'unknown error'
  }
}

function newAttemptId(): string {
  return `cmp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

async function maybeWriteCompactionSummaryValidation(
  deps: HostLoopDeps,
  sessionId: string,
  trigger: CompactTrigger,
  validation: CompactionSummaryValidation,
  summary: string,
): Promise<void> {
  if (!deps.artifactRootDir) return
  try {
    const record = deps.store.get(sessionId)
    const store = createArtifactStore(deps.artifactRootDir, {
      ...(record?.state.cwd ? { workspaceRoot: record.state.cwd } : {}),
    })
    const seq = record?.state.cursor ?? 0
    await store.writeJson(
      'compaction_summary_validation',
      `compaction-summaries/${sessionId}/${seq}.json`,
      {
        schemaVersion: 1 as const,
        sessionId,
        eventSeq: seq,
        trigger,
        generatedAt: new Date().toISOString(),
        summaryChars: summary.length,
        ...validation,
      },
    )
  } catch {
    // Validation is observability. Failing to persist it must not break compaction.
  }
}

type SummarizeOk = {
  summary: string
  request: NonNullable<Extract<AgentEvent, { kind: 'compact_replaced' }>['request']>
  usage?: NonNullable<Extract<AgentEvent, { kind: 'compact_replaced' }>['responseUsage']>
  trace?: LLMTrace
  model?: string
}

async function summarize(
  deps: HostLoopDeps,
  sessionId: string,
  messages: readonly Message[],
): Promise<SummarizeOk> {
  const model = deps.models?.get(sessionId)
  const request = {
    ...(model ? { model } : {}),
    systemPrompt: SUMMARIZER_PROMPT,
    messages,
    tools: [],
  }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), COMPACT_TIMEOUT_MS)
  let res: Awaited<ReturnType<HostLoopDeps['llm']['call']>>
  try {
    res = await deps.llm.call({
      ...request,
      thinkingBudget: 0,
      signal: ctrl.signal,
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
  return {
    summary: text.trim(),
    request,
    ...(res.usage ? { usage: res.usage } : {}),
    ...(res.trace ? { trace: res.trace } : {}),
    ...(res.trace?.model ?? model ? { model: res.trace?.model ?? model } : {}),
  }
}

async function summarizeWithLadder(
  deps: HostLoopDeps,
  sessionId: string,
  messages: readonly Message[],
): Promise<SummarizeOk> {
  let lastErr: unknown
  for (let attempt = 0; attempt < RETRY_LADDER.length; attempt++) {
    const rung = RETRY_LADDER[attempt]!
    const trimmed = prepareCompactionInputWithLimit(messages, rung.toolResultCap)
    const withHeadDropped = dropHeadGroups(trimmed, rung.dropHeadGroups)
    if (withHeadDropped.length === 0) continue
    try {
      return await summarize(deps, sessionId, withHeadDropped)
    } catch (err) {
      lastErr = err
      if (!isContextOverflowError(err)) throw err
      // Fall through to the next rung.
    }
  }
  throw lastErr ?? new Error('summarizer retry ladder exhausted')
}

/**
 * Drop the oldest `count` "groups" from the summarizer input. A group is one
 * assistant message plus its immediately-following tool_result messages  - 
 * dropping whole groups preserves tool_call/tool_result pairing across the
 * trim. A leading run of non-assistant messages is dropped along with the
 * first group so we never leave an orphan tool_result at the head.
 */
function dropHeadGroups(messages: readonly Message[], count: number): Message[] {
  if (count <= 0) return [...messages]
  const groups: Message[][] = []
  let current: Message[] = []
  for (const m of messages) {
    if (m.role === 'assistant') {
      if (current.length > 0) groups.push(current)
      current = [m]
    } else {
      current.push(m)
    }
  }
  if (current.length > 0) groups.push(current)
  // First group may consist of pre-assistant messages (system/user). Never
  // drop the leading system message; treat it as sticky.
  const stickyLeading: Message[] = []
  let startGroupIndex = 0
  if (groups.length > 0 && groups[0]!.every((m) => m.role !== 'assistant')) {
    // Preserve leading system if present, drop the rest of this group along
    // with the requested count of subsequent groups.
    for (const m of groups[0]!) if (m.role === 'system') stickyLeading.push(m)
    startGroupIndex = 1
  }
  const remaining = groups.slice(startGroupIndex + count)
  return [...stickyLeading, ...remaining.flat()]
}

function isContextOverflowError(err: unknown): boolean {
  // Heuristic: providers surface context-window errors as strings today.
  // A typed error kind on the adapter would let us replace this, but until
  // then this regex covers the common shapes across Anthropic, OpenAI, and
  // OpenRouter.
  const text = err instanceof Error ? err.message : String(err)
  return /context|window|token|too large|maximum input|input exceeds|prompt is too long/i.test(text)
}

function hasCompactableContent(messages: readonly Message[]): boolean {
  return messages.some((m, index) => isCompactableMessage(m, index))
}

function isCompactableMessage(message: Message, index: number): boolean {
  // The durable leading system prompt is setup, not history. Later system
  // messages are synthetic compact summaries and may be compacted again.
  return !(index === 0 && message.role === 'system')
}

function isPreflightCompactable(
  trigger: CompactTrigger,
  state: AgentState,
): boolean {
  return trigger === 'preflight' && state.status === 'thinking' && state.pendingCalls.length === 0
}

function isBusyCompactable(trigger: CompactTrigger, state: AgentState): boolean {
  if (isPreflightCompactable(trigger, state)) return true
  return trigger === 'tool_result' && state.status === 'executing_tools' && state.pendingCalls.length > 0 && findActiveToolBatchIndex(state) !== undefined
}

function prepareCompactionInputWithLimit(messages: readonly Message[], maxToolResultChars: number): Message[] {
  return messages.map((message) => ({
    ...message,
    content: message.content.map((content: MessageContent) => {
      if (content.type !== 'tool_result') return content
      if (content.content.length <= maxToolResultChars) return content
      return {
        ...content,
        content: compactToolResult(content.content, maxToolResultChars),
      }
    }),
  }))
}

function compactToolResult(content: string, maxChars: number): string {
  const headChars = Math.floor(maxChars * 0.6)
  const tailChars = Math.max(0, maxChars - headChars)
  const omitted = content.length - headChars - tailChars
  if (omitted <= 0) return content
  return [
    content.slice(0, headChars).trimEnd(),
    `[... ${omitted} chars omitted from old tool result before compaction ...]`,
    content.slice(-tailChars).trimStart(),
  ].join('\n')
}

function choosePreserveFrom(state: AgentState, trigger: CompactTrigger, contextLimit: number | undefined): number {
  if (trigger === 'tool_result') {
    const safe = choosePendingSafePreserveFrom(state, contextLimit)
    if (safe !== undefined) return safe
  }
  return chooseRecentUserPreserveFrom(state.messages, contextLimit)
}

function chooseRecentUserPreserveFrom(messages: readonly Message[], contextLimit: number | undefined): number {
  const targetRecentTailTokens = recentTailTargetTokens(contextLimit)
  let candidate = messages.length
  let foundUserPivot = false
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role !== 'user') continue
    if (!hasCompactableContent(messages.slice(0, i))) continue
    foundUserPivot = true
    candidate = i
    const tail = messages.slice(i)
    if (estimateTokens(tail) <= targetRecentTailTokens) return i
  }
  // Summary-only compaction: after one or more successful compactions, the
  // remaining old context may be stored only as synthetic system summaries.
  // Re-summarize those messages instead of reporting "nothing to compact".
  return foundUserPivot ? candidate : messages.length
}

function choosePendingSafePreserveFrom(state: AgentState, contextLimit: number | undefined): number | undefined {
  const activeAssistant = findActiveToolBatchIndex(state)
  if (activeAssistant === undefined) return undefined
  // Walk backward from the assistant that spawned the active batch, looking
  // for a user message we can cut on. Per SPEC  - Cut-Point Selection the pivot
  // MUST be a user index  -  never an assistant with a pending call (would
  // orphan the tool_result), never a tool_result itself.
  for (let i = activeAssistant - 1; i >= 0; i--) {
    if (state.messages[i]?.role !== 'user') continue
    if (!hasCompactableContent(state.messages.slice(0, i))) continue
    const tail = state.messages.slice(i)
    // Prefer tails inside the budget, but the closest user message to the
    // active batch is always safe: it keeps the parent user turn + the
    // assistant tool_call + all pending tool_results together.
    if (estimateTokens(tail) <= recentTailTargetTokens(contextLimit) || i === activeAssistant - 1) {
      return i
    }
  }
  return undefined
}

function findActiveToolBatchIndex(state: AgentState): number | undefined {
  const pending = new Set(state.pendingCalls.map((call) => call.callId))
  if (pending.size === 0) return undefined
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const message = state.messages[i]
    if (!message || message.role !== 'assistant') continue
    for (const content of message.content) {
      if (content.type === 'tool_call' && pending.has(content.callId)) return i
    }
  }
  return undefined
}

/**
 * Recent-tail target. See doc "Cut-Point Selection" for the rationale of the
 * bounds; below `contextLimit === undefined` we return the fixed floor rather
 * than 0 so we still preserve a meaningful window on unknown-limit models.
 * Small-context models (<16k) use a proportional fallback so the fixed floors
 * don't sum to more than the window itself.
 */
function recentTailTargetTokens(contextLimit: number | undefined): number {
  const effective = contextLimit && contextLimit > 0 ? contextLimit : FALLBACK_CONTEXT_LIMIT_TOKENS
  if (effective < 16_000) {
    return Math.max(1_500, Math.floor(effective * 0.4))
  }
  return Math.min(
    MAX_RECENT_TAIL_TOKENS,
    Math.max(MIN_RECENT_TAIL_TOKENS, Math.round(effective * TARGET_RECENT_TAIL_RATIO)),
  )
}

function estimateTokens(messages: readonly Message[]): number {
  let chars = 0
  for (const message of messages) {
    chars += message.role.length + 8
    for (const content of message.content) {
      if (content.type === 'text' || content.type === 'thinking') {
        chars += content.text.length
      } else if (content.type === 'tool_call') {
        chars += content.name.length + content.callId.length + JSON.stringify(content.input).length
      } else if (content.type === 'tool_result') {
        chars += content.callId.length + content.content.length + 16
      } else {
        chars += content.source.kind === 'file_ref'
          ? content.source.path.length + 64
          : Math.round(content.source.data.length / 4)
      }
    }
  }
  return Math.ceil(chars / 4)
}
