/**
 * A row that renders a single `agent` tool_call inline in the parent's
 * transcript. Four modes, chosen from `lifecycle.status`:
 *
 *   pending   — the parent LLM emitted the tool_call but no child session
 *               has spawned yet (waiting for `server:control_update`)
 *   running   — child is live; [[NestedTranscript]] mirrors its
 *               state.messages in a slim, bubble-free layout
 *   completed — envelope arrived and parsed; header shows agent_type,
 *               turn count, elapsed
 *   failed    — same header, plus the error body from `<error>`
 *
 * The card intercepts the `agent` toolName in ChatPanel's group dispatcher;
 * see [[sub-agent-envelope]] for the parser that reads terminal state from
 * `tool_result.content` on replay.
 */

import { memo, useEffect, useState } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Cpu,
  Loader2,
  Shield,
  Square,
  Workflow,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'

import type { Message, ToolCallContent } from '@agent-kernel/kernel'
import type { ApprovalRequiredEvent, ToolCardMode } from '@agent-kernel/shared'

import { cn } from '../../lib/utils.js'
import { BorderBeam } from '../../components/ui/border-beam.js'
import { withViewTransition } from '../../lib/viewTransition.js'
import type { DashboardSocket } from '../../session.js'
import type { ToolCallGroup } from './grouping.js'
import { NestedTranscript } from './NestedTranscript.js'
import { parseSubAgentEnvelope } from './subAgentEnvelope.js'
import {
  useSubAgentSession,
  type SubAgentLifecycle,
} from './useSubAgentSession.js'
import { useSubAgentPolicy, type SubAgentPolicyView } from './useSubAgentPolicy.js'

type Props = {
  parentSessionId: string
  socket: DashboardSocket | null
  group: ToolCallGroup
  approvalByCallId: ReadonlyMap<string, ApprovalRequiredEvent>
  toolCardMode?: ToolCardMode
}

export function SubAgentCard(props: Props): JSX.Element {
  const calls = props.group.calls
  if (calls.length >= 2) {
    return (
      <div
        className="grid min-w-0 items-start gap-2 sm:grid-cols-2"
        data-testid={`sub-agent-matrix-${props.group.firstCallId}`}
      >
        {calls.map((call) => (
          <SubAgentRow
            key={call.callId}
            compact
            call={call}
            parentSessionId={props.parentSessionId}
            socket={props.socket}
            result={props.group.results.get(call.callId) ?? null}
            approval={props.approvalByCallId.get(call.callId) ?? null}
            dotsMode={props.toolCardMode === 'dots'}
          />
        ))}
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-2">
      {calls.map((call) => (
        <SubAgentRow
          key={call.callId}
          call={call}
          parentSessionId={props.parentSessionId}
          socket={props.socket}
          result={props.group.results.get(call.callId) ?? null}
          approval={props.approvalByCallId.get(call.callId) ?? null}
          dotsMode={props.toolCardMode === 'dots'}
        />
      ))}
    </div>
  )
}

type RowProps = {
  call: ToolCallContent
  parentSessionId: string
  socket: DashboardSocket | null
  result:
    | import('@agent-kernel/kernel').ToolResultContent
    | null
  approval: ApprovalRequiredEvent | null
  /**
   * Matrix mode: shrink the nested transcript and default-collapse
   * completed rows so a grid of 4 stays readable.
   */
  compact?: boolean
  dotsMode?: boolean
}

const SubAgentRow = memo(function SubAgentRow({
  call,
  parentSessionId,
  socket,
  result,
  compact = false,
  dotsMode = false,
}: RowProps): JSX.Element {
  const { t } = useTranslation()
  const envelope = result ? parseSubAgentEnvelope(result.content) : null
  const promptInput = readPrompt(call)
  const agentTypeInput = readAgentType(call)
  const modelInput = readModel(call)
  const roleInput = readRole(call)

  const seededLifecycle: SubAgentLifecycle | undefined = envelope
    ? envelope.status === 'completed' || envelope.status === 'timed_out_with_partial_result'
      ? {
          status: 'completed',
          childSessionId: envelope.sessionId,
          turns: envelope.turns,
          durationMs: envelope.durationMs,
          finishedAt: '',
        }
      : {
          status: envelope.status,
          childSessionId: envelope.sessionId,
          error: envelope.body || 'sub-agent failed',
          turns: envelope.turns,
          durationMs: envelope.durationMs,
          finishedAt: '',
        }
    : undefined

  const view = useSubAgentSession({
    socket,
    parentSessionId,
    parentCallId: call.callId,
    ...(envelope ? { initialChildSessionId: envelope.sessionId } : {}),
    ...(seededLifecycle ? { initialLifecycle: seededLifecycle } : {}),
    ...(envelope?.agentType ? { initialAgentType: envelope.agentType } : {}),
  })

  const policy = useSubAgentPolicy({
    parentSessionId,
    parentCallId: call.callId,
    enabled: roleInput !== undefined,
  })

  const status = view.lifecycle.status
  const runningChildSessionId = view.lifecycle.status === 'running' ? view.lifecycle.childSessionId : null
  const agentType = view.agentType ?? agentTypeInput
  const prompt = view.prompt ?? promptInput
  const model = view.model ?? modelInput

  const startedAtMs = startedAtOf(view.lifecycle)
  const elapsedMs = useElapsedMs(status === 'running' ? startedAtMs : null)
  const totalMs =
    status === 'completed' || status === 'failed' ? view.lifecycle.durationMs : elapsedMs
  const turns =
    status === 'completed' || status === 'failed' ? view.lifecycle.turns : view.messages.length

  const failureText =
    status === 'failed' || status === 'cancelled'
      ? view.lifecycle.error
      : envelope?.status === 'failed' || envelope?.status === 'cancelled'
        ? envelope.body
        : null
  const displayedMessages: readonly Message[] = view.messages.length > 0
    ? view.messages
    : envelope?.body && (envelope.status === 'completed' || envelope.status === 'timed_out_with_partial_result')
      ? [{ role: 'assistant', content: [{ type: 'text', text: envelope.body }] }]
      : []
  const terminal = status === 'completed' || status === 'failed' || status === 'cancelled'
  const useCompactTranscript = terminal && displayedMessages.length <= 12

  // Default open for live rows and for failed ones (so the error is
  // visible without a click). Completed rows collapse to the header to
  // keep long parent timelines skimmable; in compact/matrix mode we
  // collapse *all* rows other than the still-running one so a grid of
  // 4 stays browsable.
  const [open, setOpen] = useState(
    compact
      ? status === 'running' || status === 'idle'
      : status === 'running' || status === 'idle' || status === 'failed' || status === 'cancelled',
  )
  useEffect(() => {
    if (!compact && (status === 'running' || status === 'failed' || status === 'cancelled')) setOpen(true)
    if (compact && status === 'running') setOpen(true)
  }, [status, compact])

  if (dotsMode && !open && terminal) {
    const label = `${t('chat.subAgent.label')}${agentType ? ` · ${agentType}` : ''} · ${statusLabel(status, t)}${turns > 0 ? ` · ${t('chat.subAgent.turn', { count: turns })}` : ''}`
    return (
      <div className="w-fit" data-testid={`sub-agent-row-${call.callId}`} data-sub-agent-status={status}>
        <button
          type="button"
          onClick={() => withViewTransition(() => setOpen(true))}
          className={cn(
            'inline-flex h-8 w-8 items-center justify-center rounded-full bg-background ring-1 ring-border/70 ring-offset-1 ring-offset-background transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            status === 'completed' ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400',
          )}
          title={label}
          aria-label={label}
          data-testid={`sub-agent-dot-${call.callId}`}
          data-sub-agent-toggle={call.callId}
        >
          {status === 'completed' ? <Workflow className="h-4 w-4" aria-hidden="true" /> : <AlertCircle className="h-4 w-4" aria-hidden="true" />}
        </button>
      </div>
    )
  }

  return (
    <div
      className={cn(
        'relative min-w-0 max-w-full overflow-hidden rounded-lg border transition-colors',
        status === 'failed'
          ? 'border-rose-300/60 bg-rose-50/40 dark:border-rose-500/40 dark:bg-rose-950/20'
          : status === 'completed'
            ? 'border-emerald-300/40 bg-emerald-50/30 dark:border-emerald-500/30 dark:bg-emerald-950/10'
            : status === 'running'
              ? 'border-sky-300/50 bg-sky-50/40 dark:border-sky-500/40 dark:bg-sky-950/20'
              : 'border-border/60 bg-muted/40',
      )}
      data-testid={`sub-agent-row-${call.callId}`}
      data-sub-agent-status={status}
    >
      {status === 'running' ? <BorderBeam /> : null}
      <div className="flex min-w-0 items-center rounded-lg text-xs text-foreground transition-colors hover:bg-muted/60">
        <button
          type="button"
          onClick={() => withViewTransition(() => setOpen((v) => !v))}
          className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left"
          data-testid={`sub-agent-toggle-${call.callId}`}
        >
          {open ? (
            <ChevronDown className="h-3.5 w-3.5 flex-none text-muted-foreground" aria-hidden="true" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 flex-none text-muted-foreground" aria-hidden="true" />
          )}
          <StatusIcon status={status} />
          <span className="flex-none rounded bg-background/80 px-1.5 py-0.5 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
            {t('chat.subAgent.label')}
          </span>
          {agentType ? (
            <span className="flex-none rounded bg-background/80 px-1.5 py-0.5 font-mono text-[11px]">
              {agentType}
            </span>
          ) : null}
          <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground [overflow-wrap:anywhere]">
            {prompt ?? t('chat.subAgent.noPrompt')}
          </span>
          {model ? (
            <span
              className="hidden flex-none items-center gap-1 rounded bg-background/80 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground sm:flex"
              title={`model=${model}`}
            >
              <Cpu className="h-3 w-3" aria-hidden="true" />
              {model}
            </span>
          ) : null}
        </button>
        {runningChildSessionId && socket ? (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation()
              socket.emit('client:interrupt_sub_agent', {
                parentSessionId,
                parentCallId: call.callId,
                childSessionId: runningChildSessionId,
              })
            }}
            className="mr-1 inline-flex h-6 w-6 flex-none items-center justify-center rounded bg-background/80 text-muted-foreground ring-1 ring-border/50 hover:bg-rose-50 hover:text-rose-700 dark:hover:bg-rose-950/40 dark:hover:text-rose-300"
            title={t('chat.subAgent.interrupt')}
            aria-label={t('chat.subAgent.interrupt')}
            data-testid={`sub-agent-interrupt-${call.callId}`}
          >
            <Square className="h-3 w-3" aria-hidden="true" />
          </button>
        ) : null}
        <div className="pr-3">
          <StatusBadge status={status} turns={turns} durationMs={totalMs} />
        </div>
      </div>

      {open ? (
        <div className="border-t border-border/50 bg-background/60">
          {policy ? <SubAgentPolicyPanel policy={policy} callId={call.callId} /> : null}
          {failureText ? (
            <div className="border-b border-rose-200/60 bg-rose-50/60 px-3 py-2 text-[11px] text-rose-800 dark:border-rose-500/30 dark:bg-rose-950/30 dark:text-rose-200">
              <strong className="font-semibold">{status === 'cancelled' ? t('chat.subAgent.cancelled') : t('chat.subAgent.failed')}</strong> {failureText}
            </div>
          ) : null}
          {displayedMessages.length > 0 ? (
            <div
              className={cn(
                'flex min-h-0 flex-col',
                useCompactTranscript
                  ? compact ? 'max-h-56 overflow-y-auto' : 'max-h-80 overflow-y-auto'
                  : compact ? 'h-56' : 'h-[min(28rem,55dvh)]',
              )}
              data-testid={`sub-agent-transcript-frame-${call.callId}`}
              data-layout={useCompactTranscript ? 'content' : 'viewport'}
            >
              <NestedTranscript
                messages={displayedMessages}
                compact={compact}
                virtualized={!useCompactTranscript}
              />
            </div>
          ) : (
            <EmptyChild status={status} />
          )}
        </div>
      ) : null}
    </div>
  )
})

function EmptyChild({ status }: { status: SubAgentLifecycle['status'] }): JSX.Element {
  const { t } = useTranslation()
  const label =
    status === 'idle'
      ? t('chat.subAgent.waiting')
      : status === 'running'
        ? t('chat.subAgent.starting')
        : t('chat.subAgent.noMessages')
  return (
    <div className="px-3 py-4 text-center text-[11px] italic text-muted-foreground">
      {label}
    </div>
  )
}

function StatusIcon({ status }: { status: SubAgentLifecycle['status'] }): JSX.Element {
  if (status === 'running' || status === 'idle')
    return (
      <Loader2
        className={cn(
          'h-3.5 w-3.5 flex-none',
          status === 'running'
            ? 'animate-spin text-sky-600 dark:text-sky-400'
            : 'text-muted-foreground',
        )}
        aria-hidden="true"
      />
    )
  if (status === 'completed')
    return (
      <CheckCircle2
        className="h-3.5 w-3.5 flex-none text-emerald-600 dark:text-emerald-400"
        aria-hidden="true"
      />
    )
  return (
    <AlertCircle
      className="h-3.5 w-3.5 flex-none text-rose-600 dark:text-rose-400"
      aria-hidden="true"
    />
  )
}

function StatusBadge({
  status,
  turns,
  durationMs,
}: {
  status: SubAgentLifecycle['status']
  turns: number
  durationMs: number
}): JSX.Element {
  const { t } = useTranslation()
  const label = statusLabel(status, t)
  const suffix = suffixFor(status, turns, durationMs, t)
  return (
    <span
      className={cn(
        'flex-none rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider',
        badgeClassFor(status),
      )}
      data-testid="sub-agent-status-badge"
    >
      {label}
      {suffix ? <span className="ml-1 opacity-80">{suffix}</span> : null}
    </span>
  )
}

function badgeClassFor(status: SubAgentLifecycle['status']): string {
  switch (status) {
    case 'completed':
      return 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
    case 'failed':
      return 'bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300'
    case 'cancelled':
      return 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300'
    case 'running':
      return 'bg-sky-50 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300'
    default:
      return 'bg-background/80 text-muted-foreground'
  }
}

function statusLabel(status: SubAgentLifecycle['status'], t: ReturnType<typeof useTranslation>['t']): string {
  switch (status) {
    case 'completed':
      return t('chat.subAgent.completed')
    case 'failed':
      return t('chat.subAgent.failed').replace(/:$/, '')
    case 'cancelled':
      return t('chat.subAgent.cancelled').replace(/:$/, '')
    case 'running':
      return t('chat.subAgent.running')
    default:
      return t('chat.subAgent.pending')
  }
}

function suffixFor(
  status: SubAgentLifecycle['status'],
  turns: number,
  durationMs: number,
  t: ReturnType<typeof useTranslation>['t'],
): string | null {
  if (status === 'idle') return null
  const parts: string[] = []
  if (turns > 0) parts.push(t('chat.subAgent.turn', { count: turns }))
  if (durationMs > 0) parts.push(formatDuration(durationMs))
  return parts.length > 0 ? `· ${parts.join(' · ')}` : null
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`
  const m = Math.floor(s / 60)
  const rem = Math.round(s - m * 60)
  return `${m}m ${rem}s`
}

function startedAtOf(lifecycle: SubAgentLifecycle): number | null {
  if (lifecycle.status !== 'running') return null
  const t = Date.parse(lifecycle.startedAt)
  return Number.isFinite(t) ? t : null
}

function useElapsedMs(startedAtMs: number | null): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (startedAtMs === null) return
    const handle = window.setInterval(() => setNow(Date.now()), 500)
    return () => window.clearInterval(handle)
  }, [startedAtMs])
  return startedAtMs === null ? 0 : Math.max(0, now - startedAtMs)
}

function readPrompt(call: ToolCallContent): string | undefined {
  const raw = (call.input as Record<string, unknown>)['prompt']
  return typeof raw === 'string' ? raw : undefined
}

function readAgentType(call: ToolCallContent): string | undefined {
  const raw = (call.input as Record<string, unknown>)['agent_type']
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined
}

function readModel(call: ToolCallContent): string | undefined {
  const raw = (call.input as Record<string, unknown>)['model']
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined
}

function readRole(call: ToolCallContent): string | undefined {
  const raw = (call.input as Record<string, unknown>)['role']
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined
}

function SubAgentPolicyPanel({
  policy,
  callId,
}: {
  policy: SubAgentPolicyView
  callId: string
}): JSX.Element {
  const { t } = useTranslation()
  return (
    <div
      className="border-b border-border/50 bg-muted/40 px-3 py-2 text-[11px] text-muted-foreground"
      data-testid={`sub-agent-policy-${callId}`}
    >
      <div className="mb-1 flex items-center gap-1.5 font-medium uppercase tracking-wider text-foreground/80">
        <Shield className="h-3 w-3" aria-hidden="true" />
        {t('chat.subAgent.policy')}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 [overflow-wrap:anywhere]">
        {policy.role ? (
          <PolicyChip label={t('chat.subAgent.role')} value={policy.role} />
        ) : null}
        {policy.maxTurns !== undefined ? (
          <PolicyChip label={t('chat.subAgent.maxTurns')} value={String(policy.maxTurns)} />
        ) : null}
        {policy.idleTimeoutMs !== undefined ? (
          <PolicyChip label="idle" value={formatPolicyDuration(policy.idleTimeoutMs)} />
        ) : null}
        {policy.toolIdleTimeoutMs !== undefined ? (
          <PolicyChip label="tool idle" value={formatPolicyDuration(policy.toolIdleTimeoutMs)} />
        ) : null}
        {policy.timeoutMs !== undefined ? (
          <PolicyChip label="absolute" value={formatPolicyDuration(policy.timeoutMs)} />
        ) : null}
        {policy.gracePeriodMs !== undefined ? (
          <PolicyChip label="grace" value={formatPolicyDuration(policy.gracePeriodMs)} />
        ) : null}
        {policy.maxDepth !== undefined ? (
          <PolicyChip
            label={t('chat.subAgent.depth')}
            value={
              policy.resolvedDepth !== undefined
                ? `${policy.resolvedDepth}/${policy.maxDepth}`
                : String(policy.maxDepth)
            }
          />
        ) : null}
        {policy.maxFanOut !== undefined ? (
          <PolicyChip
            label={t('chat.subAgent.fanOut')}
            value={
              policy.concurrentSiblingCount !== undefined
                ? `${policy.concurrentSiblingCount}/${policy.maxFanOut}`
                : String(policy.maxFanOut)
            }
          />
        ) : null}
        {policy.allowedTools && policy.allowedTools.length > 0 ? (
          <PolicyChip label={t('chat.subAgent.tools')} value={policy.allowedTools.join(', ')} />
        ) : null}
      </div>
      {policy.objective ? (
        <div className="mt-1 text-[11px]">
          <span className="font-medium text-foreground/80">{t('chat.subAgent.objective')}</span>{' '}
          <span className="italic">{policy.objective}</span>
        </div>
      ) : null}
      {policy.expectedOutput ? (
        <div className="mt-1 text-[11px]">
          <span className="font-medium text-foreground/80">{t('chat.subAgent.expectedOutput')}</span>{' '}
          <span className="italic">{policy.expectedOutput}</span>
        </div>
      ) : null}
      {policy.reasons.length > 0 ? (
        <div className="mt-1 flex flex-wrap gap-1">
          {policy.reasons.map((reason) => (
            <span
              key={reason}
              className="rounded bg-background/80 px-1.5 py-0.5 font-mono text-[10px] ring-1 ring-border/50"
            >
              {reason}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function formatPolicyDuration(ms: number): string {
  if (ms % 60_000 === 0) return `${ms / 60_000}m`
  return `${Math.round(ms / 1000)}s`
}

function PolicyChip({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <span className="inline-flex items-baseline gap-1">
      <span className="uppercase tracking-wider text-[10px] text-muted-foreground/80">{label}</span>
      <span className="font-mono text-[11px] text-foreground">{value}</span>
    </span>
  )
}
