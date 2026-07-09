/**
 * A single inline "what is the agent doing right now" row rendered at the tail
 * of the message flow. Reads `state.status` from the kernel — no invented
 * pseudo-statuses. During `thinking` a lightweight breathing dot animates
 * until the stream begins (at which point the streaming assistant bubble takes
 * over).
 * During `executing_tools` the currently-running tool calls are summarised
 * with an expandable parameter view. `awaiting_approval` renders a static
 * amber hint pointing to the approval card below. All other statuses render
 * nothing.
 *
 * A separate compact-feedback row (running / done / empty / error) is a
 * distinct concern that lives beside this component, not inside it: compact
 * is not an AgentStatus but a UI-level operation reporter.
 */

import { useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, Loader2, TriangleAlert, Wrench } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import type { AgentState, PendingToolCall } from '@agent-kernel/kernel'

import { cn } from '../../lib/utils.js'

export type CompactStatus =
  | { kind: 'idle' }
  | { kind: 'queued' }
  | { kind: 'running'; startedAt: number; tokensBefore: number }
  | { kind: 'done' }
  | { kind: 'empty'; message: string }
  | { kind: 'error'; message: string }

type Props = {
  state: AgentState | null
  fallbackStatus?: AgentState['status']
  streamingActive: boolean
  toolExecutionStartedAt?: number | null
  awaitingAck?: boolean
}

export function InlineStatusRow({ state, fallbackStatus, streamingActive, toolExecutionStartedAt, awaitingAck }: Props): JSX.Element | null {
  const status = state?.status ?? fallbackStatus
  if (status) {
    switch (status) {
      case 'thinking':
        if (streamingActive) return null
        return <ThinkingRow />
      case 'executing_tools':
        return <ToolsRow calls={state?.pendingCalls ?? []} startedAt={toolExecutionStartedAt} />
      case 'awaiting_approval':
        return <AwaitingApprovalRow />
    }
  }
  // Bridge the socket round-trip between user submit and the kernel's first
  // `thinking` status push — otherwise the transcript looks frozen.
  if (awaitingAck && !streamingActive) return <ThinkingRow />
  return null
}

function ThinkingRow(): JSX.Element {
  const { t } = useTranslation()
  return (
    <div
      className="ak-thinking-row mb-3 inline-flex items-center gap-2 overflow-hidden rounded-full border border-border/70 bg-white/90 px-3 py-1.5 text-xs text-foreground shadow-sm ring-1 ring-white/80 dark:bg-zinc-950/90 dark:ring-white/10"
      data-testid="inline-status-thinking"
      role="status"
      aria-live="polite"
    >
      <span className="relative z-[1] flex h-3 w-3 flex-none items-center justify-center text-primary" aria-hidden="true">
        <span className="absolute h-3 w-3 rounded-full bg-current opacity-20 ak-thinking-dot" />
        <span className="relative h-1.5 w-1.5 rounded-full bg-current shadow-[0_0_10px_hsl(var(--primary)/0.55)]" />
      </span>
      <span className="relative z-[1] font-medium">{t('chatStatus.thinking')}</span>
    </div>
  )
}

function ToolsRow({
  calls,
  startedAt,
}: {
  calls: readonly PendingToolCall[]
  startedAt?: number | null
}): JSX.Element {
  const { t } = useTranslation()
  const elapsed = useElapsedSeconds(true, startedAt)
  const active = calls.filter((c) => c.status === 'dispatched' || c.status === 'approved')
  const list = active.length > 0 ? active : calls
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const toggle = (callId: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(callId)) next.delete(callId)
      else next.add(callId)
      return next
    })
  }
  const summary = list.length === 1
    ? t('chatStatus.runningTool', { name: list[0]!.name, args: summariseArgs(list[0]!, t) })
    : t('chatStatus.runningTools', { count: list.length, names: list.map((c) => c.name).join(', ') })
  return (
    <div
      className="rounded-md border border-violet-200 bg-violet-50/70 px-3 py-2 text-xs text-violet-800 dark:border-violet-900 dark:bg-violet-950/30 dark:text-violet-200"
      data-testid="inline-status-tools"
      role="status"
      aria-live="polite"
    >
      <div className="flex items-center gap-2">
        <Wrench className="h-3.5 w-3.5 flex-none animate-[spin_2s_linear_infinite]" />
        <span className="font-medium truncate">{summary}</span>
        <span className="ml-auto flex items-center gap-2">
          <span className="tabular-nums text-violet-700/70 dark:text-violet-300/70">↳ {elapsed.toFixed(1)}s</span>
        </span>
      </div>
      <ul className="mt-1.5 flex flex-col gap-1">
        {list.map((call) => (
          <li key={call.callId}>
            <button
              type="button"
              onClick={() => toggle(call.callId)}
              className="flex w-full items-start gap-1.5 rounded px-1 py-0.5 text-left font-mono text-[11px] hover:bg-violet-100/60 dark:hover:bg-violet-900/30"
              data-testid={`inline-status-tool-${call.name}`}
            >
              {expanded.has(call.callId) ? (
                <ChevronDown className="mt-0.5 h-3 w-3 flex-none" />
              ) : (
                <ChevronRight className="mt-0.5 h-3 w-3 flex-none" />
              )}
              <span className="flex-1 truncate">
                <span className="font-semibold">{call.name}</span>
                <span className="text-violet-700/70 dark:text-violet-300/70"> · {summariseArgs(call, t)}</span>
              </span>
            </button>
            {expanded.has(call.callId) ? (
              <pre className="mt-1 ml-4 overflow-x-auto rounded border border-violet-200/60 bg-violet-100/40 px-2 py-1 font-mono text-[11px] text-violet-900 dark:border-violet-900/60 dark:bg-violet-950/50 dark:text-violet-100">
                {formatArgs(call.input)}
              </pre>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  )
}

function AwaitingApprovalRow(): JSX.Element {
  const { t } = useTranslation()
  return (
    <div
      className="flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50/70 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200"
      data-testid="inline-status-approval"
      role="status"
      aria-live="polite"
    >
      <TriangleAlert className="h-3.5 w-3.5 flex-none" />
      <span className="font-medium">{t('chatStatus.awaitingApproval')}</span>
    </div>
  )
}

export function CompactFeedbackRow({
  kind,
  message,
  startedAt,
  tokensBefore,
  onDismiss,
}: {
  kind: 'queued' | 'running' | 'done' | 'empty' | 'error'
  message?: string
  startedAt?: number
  tokensBefore?: number
  onDismiss?: () => void
}): JSX.Element {
  const { t } = useTranslation()
  const isRunning = kind === 'running'
  const elapsedMs = useElapsedMs(isRunning, startedAt)
  if (kind === 'queued') {
    return (
      <div
        className="flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50/70 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200"
        data-testid="inline-compact-queued"
        role="status"
      >
        <span className="relative flex h-2 w-2 flex-none items-center justify-center">
          <span className="absolute inline-flex h-full w-full rounded-full bg-amber-400/60 opacity-75 animate-ping" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-amber-500 dark:bg-amber-400" />
        </span>
        <span className="font-medium">{t('chatStatus.compactQueued')}</span>
        <span className="truncate text-amber-700/70 dark:text-amber-300/70">
          {t('chatStatus.compactQueuedHint')}
        </span>
      </div>
    )
  }
  if (kind === 'running') {
    return (
      <div
        className="flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50/70 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200"
        data-testid="inline-compact-running"
        role="status"
      >
        <Loader2 className="h-3.5 w-3.5 flex-none animate-spin" />
        <span className="font-medium">{t('chatStatus.compacting')}</span>
        <span className="ml-auto tabular-nums text-amber-700/70 dark:text-amber-300/70">
          ↳ {(elapsedMs / 1000).toFixed(1)}s
          {typeof tokensBefore === 'number' ? ` · ↑ ${formatTokensShort(tokensBefore)}` : ''}
        </span>
      </div>
    )
  }
  const palette =
    kind === 'error'
      ? 'border-rose-200 bg-rose-50/70 text-rose-800 dark:border-rose-900 dark:bg-rose-950/30 dark:text-rose-200'
      : 'border-emerald-200 bg-emerald-50/70 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-200'
  return (
    <div
      className={cn('flex items-center gap-2 rounded-md border px-3 py-2 text-xs', palette)}
      data-testid={`inline-compact-${kind}`}
      role="status"
    >
      <span className="font-medium">
        {kind === 'done' && t('chatStatus.compactDone')}
        {kind === 'error' && t('chatStatus.compactFailed')}
        {kind === 'empty' && t('chatStatus.nothingToCompact')}
      </span>
      {message ? <span className="truncate opacity-80">· {message}</span> : null}
      {onDismiss ? (
        <button
          type="button"
          onClick={onDismiss}
          className="ml-auto rounded px-1 opacity-70 hover:opacity-100 focus:outline-none focus-visible:ring-1 focus-visible:ring-current"
          aria-label={t('chatStatus.dismiss')}
        >
          ×
        </button>
      ) : null}
    </div>
  )
}

function summariseArgs(call: PendingToolCall, t: ReturnType<typeof useTranslation>['t']): string {
  const input = call.input ?? {}
  const primary = pickPrimaryArg(call.name, input)
  if (primary === null) return t('chatStatus.noArgs')
  const truncated = primary.length > 80 ? primary.slice(0, 77) + '...' : primary
  return truncated
}

export function pickPrimaryArg(name: string, input: Record<string, unknown>): string | null {
  const candidates = ARG_PRIORITY[name] ?? DEFAULT_ARG_PRIORITY
  for (const key of candidates) {
    const v = input[key]
    if (typeof v === 'string' && v.length > 0) return v
    if (typeof v === 'number') return String(v)
  }
  const first = Object.entries(input).find(([, v]) => typeof v === 'string' || typeof v === 'number')
  if (first) return String(first[1])
  return null
}

const DEFAULT_ARG_PRIORITY: readonly string[] = ['path', 'command', 'query', 'pattern', 'url']
const ARG_PRIORITY: Record<string, readonly string[]> = {
  bash: ['command'],
  read: ['file_path', 'path'],
  write: ['file_path', 'path'],
  edit: ['file_path', 'path'],
  grep: ['pattern'],
  glob: ['pattern'],
  ls: ['path'],
}

function formatArgs(input: Record<string, unknown>): string {
  try {
    return JSON.stringify(input, null, 2)
  } catch {
    return String(input)
  }
}

function formatTokensShort(tokens: number): string {
  if (tokens < 1000) return `${tokens} tokens`
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}k tokens`
  return `${(tokens / 1_000_000).toFixed(1)}m tokens`
}

function useElapsedSeconds(active: boolean, startedAt?: number | null): number {
  const [fallbackStart] = useState(() => Date.now())
  const [now, setNow] = useState(fallbackStart)
  useEffect(() => {
    if (!active) return
    const t = window.setInterval(() => setNow(Date.now()), 100)
    return () => window.clearInterval(t)
  }, [active])
  return Math.max(0, (now - (startedAt ?? fallbackStart)) / 1000)
}

function useElapsedMs(active: boolean, startedAt?: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const t = window.setInterval(() => setNow(Date.now()), 100)
    return () => window.clearInterval(t)
  }, [active])
  if (!startedAt) return 0
  return Math.max(0, now - startedAt)
}
