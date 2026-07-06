/**
 * Context compaction.
 *
 * When `state.contextPressureLevel === 'hard'` (auto) or the user fires
 * `/compact` (manual), summarise the entire message history down to one
 * synthetic system message and reset `usage.inputTokens`. The reducer does
 * the actual message replacement in response to a `compact_replaced` event
 *  -  this module drives the LLM call that produces the summary and then
 * dispatches that event through the normal loop path.
 */

import type { AgentEvent, Message } from '@agent-kernel/kernel'

import type { HostLoopDeps, LoopHandle } from './loop.js'
import { dispatchOne } from './loop.js'

/**
 * Fixed instruction fed to the summarizer LLM call. The output replaces the
 * session's message list, so preserving every decision / file path / open
 * TODO matters more than prose polish.
 */
const SUMMARIZER_PROMPT =
  'You are a summarizer. Compress the conversation above into a single, dense summary under 800 tokens. Preserve every decision, file path, tool result, and open task. Do not add commentary. Reply with ONLY the summary text.'
const COMPACT_TIMEOUT_MS = 60_000

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
  trigger: 'manual' | 'auto',
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
    const compact = await summarize(deps, sessionId, record.state.messages)
    // No provider gives a reliable prompt-token count for the summary alone
    // before it's used. Estimate cheaply: 4 chars  -  1 token. Refined on the
    // next real LLM call where usage.inputTokens is reported by the provider.
    const tokensAfter = Math.max(0, Math.round(compact.summary.length / 4))
    await dispatchOne(
      deps,
      sessionId,
      {
        kind: 'compact_replaced',
        trigger,
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
