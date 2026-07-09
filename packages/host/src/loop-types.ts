/**
 * Shared type surface for the host loop.
 *
 * These are the pure type definitions that the loop and its extensions
 * (`extensions/compaction.ts`, `extensions/agent-tool.ts`,
 * `extensions/hooks-runner.ts`, `extensions/memory-consolidation.ts`) all
 * need. They live here — a leaf module with no runtime logic — so that an
 * extension can depend on the loop's *contract* (`HostLoopDeps`, `LoopHandle`,
 * …) without importing `loop.ts` itself and forming an import cycle. The
 * runtime re-entry point `dispatchOne` stays in `loop.ts`; extensions import
 * that one value directly.
 *
 * `loop.ts` re-exports every type from here, so `import type { HostLoopDeps }
 * from './loop.js'` continues to resolve for existing consumers.
 */

import type {
  AgentEvent,
  AgentState,
  CallToolEffect,
  Effect,
  PendingToolCall,
  RequestApprovalEffect,
} from '@agent-kernel/kernel'
import type { CompactionMetadata, CompactStatusEvent, LLMTrace } from '@agent-kernel/shared'

import type { LLMAdapter } from './llm/adapter.js'
import type { HookConfig, HookRunner } from './extensions/hooks.js'
import type { SkillManager, SkillRegistry } from './extensions/skills.js'
import type { SessionStore } from './store/session.js'

export type LoopBroadcast = {
  onEvent(
    sessionId: string,
    seq: number,
    event: AgentEvent,
    effects: readonly Effect[],
    state: AgentState,
    llmTrace?: LLMTrace,
    model?: string,
    extras?: EventBroadcastExtras,
  ): void
  onApprovalRequired(sessionId: string, eff: RequestApprovalEffect): void
  onError(sessionId: string, message: string): void
  /**
   * Streaming text token from the adapter, forwarded to dashboards.
   * Optional — non-streaming adapters never invoke it and the wire event
   * simply doesn't fire.
   */
  onTokenDelta?(sessionId: string, text: string): void
  /**
   * A sub-agent (via the `agent` builtin) has just been created. Fired into
   * the parent's dashboard room so the SubAgentCard can transition from
   * "spawning" to "running" and open a subscription to the child's own room
   * before the child starts streaming. Optional so hosts without a dashboard
   * can drop it.
   */
  onSubAgentStarted?(payload: SubAgentStartedPayload): void
  /**
   * The sub-agent's inner loop returned (success or failure). Fired into the
   * parent's dashboard room just before `runAgentTool()` returns the wrapped
   * envelope as the tool_result — arrives ahead of the parent's
   * `event:appended` for that tool_result, so the card can freeze its timer
   * without waiting for the parent turn to advance.
   */
  onSubAgentFinished?(payload: SubAgentFinishedPayload): void
  /**
   * Compaction lifecycle. Fired at three points around every attempt so
   * every attached dashboard sees the same state and can render the
   * "Compacting…" row / final result without originating the request.
   *
   * Payload contract: {@link CompactStatusEvent}.
   */
  onCompactStatus?(payload: CompactStatusEvent): void
}

export type CompactStatusPayload = CompactStatusEvent

/**
 * Optional broadcast-time enrichments that don't belong on the kernel event
 * itself. `dispatchOne` accepts these and forwards them to
 * {@link LoopBroadcast.onEvent}, which then decorates the wire
 * `event:appended` payload. Today only the compaction extension supplies
 * this — surfacing `trigger`/token deltas that live in runtime metadata,
 * not in the kernel `messages_replaced` event.
 */
export type EventBroadcastExtras = {
  compactionMetadata?: CompactionMetadata
}

export type SubAgentStartedPayload = {
  parentSessionId: string
  parentCallId: string
  childSessionId: string
  agentType?: string
  prompt: string
  model?: string
  startedAt: string
}

export type SubAgentFinishedPayload = {
  parentSessionId: string
  parentCallId: string
  childSessionId: string
  status: 'completed' | 'failed' | 'cancelled'
  turns: number
  durationMs: number
  finishedAt: string
  error?: string
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
  contextWindow?(sessionId: string): number | undefined
}

export type HostLoopDeps = {
  store: SessionStore
  llm: LLMAdapter
  tools: ToolDispatcher
  broadcast: LoopBroadcast
  models?: ModelResolver
  hooks?: readonly HookConfig[]
  hookRunner?: HookRunner
  skills?: SkillRegistry | SkillManager
  artifactRootDir?: string
}

export type LoopHandle = {
  dispatch(sessionId: string, event: AgentEvent, options?: DispatchOptions): Promise<void>
  compact(sessionId: string, trigger?: 'manual' | 'auto' | 'preflight' | 'tool_result'): Promise<void>
  hasActiveLlmCall(sessionId: string): boolean
  recoverInterruptedLlm(sessionId: string): Promise<boolean>
  beginDrain(mode: LoopDrainMode): void
  endDrain(): void
  drainSnapshot(sessionId: string): LoopDrainSessionSnapshot
  waitForCheckpoint(sessionId: string): Promise<LoopDrainSessionSnapshot>
  resumeSession(sessionId: string): Promise<boolean>
  /**
   * Abort the in-flight LLM call for a session, if any. Any streamed text
   * so far becomes the final assistant message with a `[cancelled]` suffix,
   * so the event log always sees a complete `llm_response` — never a
   * dangling call. No-op when nothing is streaming.
   */
  cancelStream(sessionId: string): void
}

export type LoopDrainMode = 'none' | 'checkpoint' | 'idle'

export type LoopDrainSessionSnapshot = {
  sessionId: string
  status: AgentState['status'] | 'missing'
  safe: boolean
  waiting: 'none' | 'llm' | 'tool' | 'idle'
  pendingCalls: readonly PendingToolCall[]
  cursor?: number
}

export type DispatchOptions = {
  model?: string
}

/**
 * Threaded through `dispatchOne` → `performEffect` so compaction-preflight and
 * the post-compaction loop guard can re-enter the loop and consult per-session
 * guard state. Internal to the loop machinery; extensions don't construct it.
 */
export type LoopRuntime = {
  handle: LoopHandle
  loopGuard: Map<string, PostCompactionLoopGuard>
  model?: string
  drain?: () => LoopDrainMode
  toolStarted?(sessionId: string, callId: string): void
  toolSettled?(sessionId: string, callId: string): void
}

export type PostCompactionLoopGuard = {
  remainingCalls: number
  seen: Map<string, number>
}
