/**
 * Context compaction.
 *
 * When `state.contextPressureLevel === 'hard'` (auto) or the user fires
 * `/compact` (manual), summarize the old message prefix into one synthetic
 * system message while keeping the most recent user turn verbatim. The reducer
 * applies the replacement in response to a `compact_replaced` event; this
 * module chooses the pivot, drives the summarizer LLM call, and dispatches the
 * event through the normal loop path.
 */

import type { AgentEvent, Message } from '@agent-kernel/kernel'
import {
  createArtifactStore,
  validateCompactionSummary,
  type CompactionSummaryValidation,
} from '@agent-kernel/shared/enhancement'

import type { HostLoopDeps, LoopHandle } from '../loop-types.js'
import { dispatchOne } from '../loop.js'

/**
 * Fixed instruction fed to the summarizer LLM call. The output replaces the
 * old transcript prefix, not the recent suffix. It must therefore behave like
 * a durable engineering handoff: concrete state beats narrative prose.
 */
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
const TARGET_RECENT_TAIL_TOKENS = 12_000
const MAX_COMPACT_TOOL_RESULT_CHARS = 8_000

export async function maybeAutoCompact(
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
  await handle.compact(sessionId, 'auto')
}

export async function runCompact(
  deps: HostLoopDeps,
  sessionId: string,
  trigger: 'manual' | 'auto' | 'preflight',
  inFlight: Set<string>,
  aborts: Map<string, AbortController>,
): Promise<void> {
  if (inFlight.has(sessionId)) return
  const record = deps.store.get(sessionId)
  if (!record) throw new Error(`Unknown session: ${sessionId}`)
  const s = record.state.status
  if (s !== 'idle' && s !== 'done' && s !== 'error' && !isPreflightCompactable(trigger, record.state)) {
    throw new Error('cannot compact while the session is busy')
  }
  if (!hasCompactableContent(record.state.messages)) {
    throw new Error('nothing to compact yet')
  }

  inFlight.add(sessionId)
  try {
    const tokensBefore = record.state.usage.inputTokens
    const replacedCount = record.state.messages.length
    const preserveFrom = choosePreserveFrom(record.state.messages)
    const compactedPrefix = prepareCompactionInput(record.state.messages.slice(0, preserveFrom))
    const preservedTail = record.state.messages.slice(preserveFrom)
    const compact = await summarize(deps, sessionId, compactedPrefix)
    // No provider gives a reliable prompt-token count for the summary alone
    // before it's used. Estimate cheaply: 4 chars ≈ 1 token. Refined on the
    // next real LLM call where usage.inputTokens is reported by the provider.
    const tokensAfter = Math.max(
      0,
      Math.round(compact.summary.length / 4) + estimateTokens(preservedTail),
    )
    const validation = validateCompactionSummary(compact.summary)
    await maybeWriteCompactionSummaryValidation(deps, sessionId, trigger, validation, compact.summary)
    await dispatchOne(
      deps,
      sessionId,
      {
        kind: 'compact_replaced',
        trigger,
        preserveFrom,
        request: compact.request,
        ...(compact.usage ? { responseUsage: compact.usage } : {}),
        summary: compact.summary,
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

async function maybeWriteCompactionSummaryValidation(
  deps: HostLoopDeps,
  sessionId: string,
  trigger: 'manual' | 'auto' | 'preflight',
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

async function summarize(
  deps: HostLoopDeps,
  sessionId: string,
  messages: readonly Message[],
): Promise<{
  summary: string
  request: NonNullable<Extract<AgentEvent, { kind: 'compact_replaced' }>['request']>
  usage?: NonNullable<Extract<AgentEvent, { kind: 'compact_replaced' }>['responseUsage']>
}> {
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
    summary: text.trim() || '[compact produced empty summary]',
    request,
    ...(res.usage ? { usage: res.usage } : {}),
  }
}

function hasCompactableContent(messages: readonly Message[]): boolean {
  return messages.some((m) => m.role !== 'system')
}

function isPreflightCompactable(
  trigger: 'manual' | 'auto' | 'preflight',
  state: { status: string; pendingCalls: readonly unknown[] },
): boolean {
  return trigger === 'preflight' && state.status === 'thinking' && state.pendingCalls.length === 0
}

function prepareCompactionInput(messages: readonly Message[]): Message[] {
  return messages.map((message) => ({
    ...message,
    content: message.content.map((content) => {
      if (content.type !== 'tool_result') return content
      if (content.content.length <= MAX_COMPACT_TOOL_RESULT_CHARS) return content
      return {
        ...content,
        content: compactToolResult(content.content, MAX_COMPACT_TOOL_RESULT_CHARS),
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

function choosePreserveFrom(messages: readonly Message[]): number {
  let candidate = messages.length
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role !== 'user') continue
    if (!hasCompactableContent(messages.slice(0, i))) continue
    candidate = i
    const tail = messages.slice(i)
    if (estimateTokens(tail) <= TARGET_RECENT_TAIL_TOKENS) return i
  }
  return candidate
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
