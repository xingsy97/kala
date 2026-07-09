import { AlertTriangle, Check, Clock, Loader2, Wrench } from 'lucide-react'

import type { AgentState } from '@agent-kernel/kernel'

import { cn } from '../../lib/utils.js'

export type CompactStatus =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'done' }
  | { kind: 'empty'; message: string }
  | { kind: 'error'; message: string }

type Props = {
  state: AgentState | null
  compactStatus: CompactStatus
}

export function ActivityBar({ state, compactStatus }: Props): JSX.Element | null {
  const activity = activityFor(state, compactStatus)
  const Icon = activity.icon
  return (
    <div
      className={cn(
        'border-t px-3 py-2 text-xs flex items-center gap-2 min-w-0',
        activity.className,
      )}
      data-testid="activity-bar"
      role="status"
      aria-live="polite"
    >
      <Icon
        className={cn('h-3.5 w-3.5 flex-none', activity.spin ? 'animate-spin' : '')}
      />
      <span className="font-medium" data-testid="activity-label">
        {activity.label}
      </span>
      {activity.detail ? (
        <span
          className="truncate text-slate-600 dark:text-slate-300"
          data-testid="activity-detail"
        >
          {activity.detail}
        </span>
      ) : null}
      {activity.pulse ? (
        <span className="ml-auto flex items-center gap-1" aria-hidden="true">
          <span className="h-1.5 w-1.5 rounded-full bg-current animate-pulse" />
          <span className="h-1.5 w-1.5 rounded-full bg-current animate-pulse [animation-delay:150ms]" />
          <span className="h-1.5 w-1.5 rounded-full bg-current animate-pulse [animation-delay:300ms]" />
        </span>
      ) : null}
      <RuntimeSummary state={state} />
    </div>
  )
}

function activityFor(
  state: AgentState | null,
  compactStatus: CompactStatus,
): {
  label: string
  detail?: string
  icon: typeof Loader2
  spin?: boolean
  pulse?: boolean
  className: string
} {
  if (compactStatus.kind === 'running') {
    return {
      label: 'Compacting context',
      detail: 'waiting for summarizer response',
      icon: Loader2,
      spin: true,
      className:
        'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200',
    }
  }
  if (compactStatus.kind === 'done') {
    return {
      label: 'Context compacted',
      icon: Check,
      className:
        'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/35 dark:text-emerald-200',
    }
  }
  if (compactStatus.kind === 'error') {
    return {
      label: 'Compact failed',
      detail: compactStatus.message,
      icon: AlertTriangle,
      className:
        'border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-200',
    }
  }
  if (compactStatus.kind === 'empty') {
    return {
      label: 'Nothing to compact',
      detail: compactStatus.message,
      icon: Check,
      className:
        'border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-800 dark:bg-slate-900/60 dark:text-slate-200',
    }
  }
  if (!state) {
    return {
      label: 'Agent unavailable',
      detail: 'waiting for session state',
      icon: Clock,
      className:
        'border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-800 dark:bg-slate-900/60 dark:text-slate-200',
    }
  }
  if (state.status === 'thinking') {
    return {
      label: 'Waiting for LLM response',
      detail: 'assistant is generating',
      icon: Loader2,
      spin: true,
      pulse: true,
      className:
        'border-sky-200 bg-sky-50 text-sky-800 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-200',
    }
  }
  if (state.status === 'executing_tools') {
    const tools = state.pendingCalls.map((c) => c.name).join(', ')
    return {
      label: 'Running tool',
      detail: tools || 'waiting for executor result',
      icon: Wrench,
      pulse: true,
      className:
        'border-violet-200 bg-violet-50 text-violet-800 dark:border-violet-900 dark:bg-violet-950/40 dark:text-violet-200',
    }
  }
  if (state.status === 'awaiting_approval') {
    return {
      label: 'Waiting for approval',
      detail: 'review the approval card below',
      icon: Clock,
      pulse: true,
      className:
        'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200',
    }
  }
  return {
    label: `Agent ${agentStatusLabel(state.status)}`,
    icon: Check,
    className:
      'border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-800 dark:bg-slate-900/60 dark:text-slate-200',
  }
}

function RuntimeSummary({ state }: { state: AgentState | null }): JSX.Element | null {
  if (!state) return null
  return (
    <div
      className="ml-auto hidden min-w-0 shrink-0 items-center gap-1 text-[11px] text-slate-600 dark:text-slate-300 2xl:flex"
      data-testid="runtime-summary"
    >
      <SummaryItem label="Cursor" value={String(state.cursor)} />
      <SummaryItem
        label="Pending tools"
        value={String(state.pendingCalls.length)}
        tone={state.pendingCalls.length > 0 ? 'amber' : undefined}
      />
      <SummaryItem
        label="Tokens in/out"
        value={`${formatTokens(state.usage.inputTokens)} / ${formatTokens(state.usage.outputTokens)}`}
      />
    </div>
  )
}

function SummaryItem({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone?: 'amber'
}): JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex h-6 min-w-max items-center gap-1 rounded border px-2 leading-none whitespace-nowrap',
        tone === 'amber'
          ? 'border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-200'
          : 'border-slate-300/60 bg-white/55 dark:border-slate-700/80 dark:bg-slate-950/45',
      )}
      title={`${label}: ${value}`}
    >
      <span className="opacity-75">{label}</span>
      <span className="font-mono text-slate-900 dark:text-slate-100">{value}</span>
    </span>
  )
}

function agentStatusLabel(status: AgentState['status']): string {
  switch (status) {
    case 'idle':
      return 'Ready'
    case 'done':
      return 'Done'
    case 'thinking':
      return 'Waiting for LLM'
    case 'executing_tools':
      return 'Running tools'
    case 'awaiting_approval':
      return 'Needs approval'
    case 'error':
      return 'Error'
  }
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}
