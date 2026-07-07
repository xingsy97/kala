/**
 * A row that renders a single `agent` tool_call inline in the parent's
 * transcript. Four modes, chosen from `lifecycle.status`:
 *
 *   pending    -  the parent LLM emitted the tool_call but no child session
 *               has spawned yet (waiting for `server:sub_agent_started`)
 *   running    -  child is live; [[NestedTranscript]] mirrors its
 *               state.messages in a slim, bubble-free layout
 *   completed  -  envelope arrived and parsed; header shows agent_type,
 *               turn count, elapsed
 *   failed     -  same header, plus the error body from `<error>`
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
} from 'lucide-react'

import type { ToolCallContent } from '@agent-kernel/kernel'
import type { ApprovalRequiredEvent } from '@agent-kernel/shared'

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

type Props = {
  parentSessionId: string
  socket: DashboardSocket | null
  group: ToolCallGroup
  approvalByCallId: ReadonlyMap<string, ApprovalRequiredEvent>
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
}

const SubAgentRow = memo(function SubAgentRow({
  call,
  parentSessionId,
  socket,
  result,
  compact = false,
}: RowProps): JSX.Element {
  const envelope = result ? parseSubAgentEnvelope(result.content) : null
  const promptInput = readPrompt(call)
  const agentTypeInput = readAgentType(call)
  const modelInput = readModel(call)

  const seededLifecycle: SubAgentLifecycle | undefined = envelope
    ? envelope.status === 'completed'
      ? {
          status: 'completed',
          childSessionId: envelope.sessionId,
          turns: envelope.turns,
          durationMs: envelope.durationMs,
          finishedAt: '',
        }
      : {
          status: 'failed',
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

  const status = view.lifecycle.status
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
    status === 'failed' ? view.lifecycle.error : envelope?.status === 'failed' ? envelope.body : null

  // Default open for live rows and for failed ones (so the error is
  // visible without a click). Completed rows collapse to the header to
  // keep long parent timelines skimmable; in compact/matrix mode we
  // collapse *all* rows other than the still-running one so a grid of
  // 4 stays browsable.
  const [open, setOpen] = useState(
    compact
      ? status === 'running' || status === 'idle'
      : status === 'running' || status === 'idle' || status === 'failed',
  )
  useEffect(() => {
    if (!compact && (status === 'running' || status === 'failed')) setOpen(true)
    if (compact && status === 'running') setOpen(true)
  }, [status, compact])

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
      <button
        type="button"
        onClick={() => withViewTransition(() => setOpen((v) => !v))}
        className="flex w-full min-w-0 items-center gap-2 rounded-lg px-3 py-2 text-left text-xs text-foreground transition-colors hover:bg-muted/60"
        data-testid={`sub-agent-toggle-${call.callId}`}
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 flex-none text-muted-foreground" aria-hidden="true" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 flex-none text-muted-foreground" aria-hidden="true" />
        )}
        <StatusIcon status={status} />
        <span className="flex-none rounded bg-background/80 px-1.5 py-0.5 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
          sub-agent
        </span>
        {agentType ? (
          <span className="flex-none rounded bg-background/80 px-1.5 py-0.5 font-mono text-[11px]">
            {agentType}
          </span>
        ) : null}
        <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground [overflow-wrap:anywhere]">
          {prompt ?? '(no prompt)'}
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
        <StatusBadge status={status} turns={turns} durationMs={totalMs} />
      </button>

      {open ? (
        <div className="border-t border-border/50 bg-background/60">
          {failureText ? (
            <div className="border-b border-rose-200/60 bg-rose-50/60 px-3 py-2 text-[11px] text-rose-800 dark:border-rose-500/30 dark:bg-rose-950/30 dark:text-rose-200">
              <strong className="font-semibold">Failed:</strong> {failureText}
            </div>
          ) : null}
          {view.messages.length > 0 ? (
            <div className={cn('flex min-h-0 flex-col', compact ? 'h-56' : 'h-[28rem]')}>
              <NestedTranscript messages={view.messages} compact={compact} />
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
  const label =
    status === 'idle'
      ? 'Waiting for the child session to start - '
      : status === 'running'
        ? 'Child session is starting - '
        : 'No messages recorded.'
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
  const label = statusLabel(status)
  const suffix = suffixFor(status, turns, durationMs)
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
    case 'running':
      return 'bg-sky-50 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300'
    default:
      return 'bg-background/80 text-muted-foreground'
  }
}

function statusLabel(status: SubAgentLifecycle['status']): string {
  switch (status) {
    case 'completed':
      return 'Completed'
    case 'failed':
      return 'Failed'
    case 'running':
      return 'Running'
    default:
      return 'Pending'
  }
}

function suffixFor(
  status: SubAgentLifecycle['status'],
  turns: number,
  durationMs: number,
): string | null {
  if (status === 'idle') return null
  const parts: string[] = []
  if (turns > 0) parts.push(`${turns} turn${turns === 1 ? '' : 's'}`)
  if (durationMs > 0) parts.push(formatDuration(durationMs))
  return parts.length > 0 ? ` -  ${parts.join('  -  ')}` : null
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
