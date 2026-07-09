import { useEffect, useState } from 'react'
import { AlertTriangle, Check, Clock, Loader2, Wrench } from 'lucide-react'

import type { AgentState } from '@agent-kernel/kernel'

import { formatElapsed, formatTokens } from '../../lib/format.js'
import { cn } from '../../lib/utils.js'

export type CompactStatus =
  | { kind: 'idle' }
  | { kind: 'running'; startedAt: number; tokensBefore: number }
  | { kind: 'done' }
  | { kind: 'empty'; message: string }
  | { kind: 'error'; message: string }

type Props = {
  state: AgentState | null
  compactStatus: CompactStatus
}

export function ActivityBar({ state, compactStatus }: Props): JSX.Element | null {
  const now = useActivityClock(compactStatus.kind === 'running')
  const activity = activityFor(state, compactStatus, now)
  const Icon = activity.icon
  return (
    <div
      className={cn(
        'px-3 py-2 text-xs flex items-center gap-2 min-w-0',
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
          className="truncate text-muted-foreground dark:text-muted-foreground"
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
    </div>
  )
}

function activityFor(
  state: AgentState | null,
  compactStatus: CompactStatus,
  now: number,
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
      label: 'Compacting conversation...',
      detail: `(${formatElapsed(now - compactStatus.startedAt)} · ↑ ${formatTokens(compactStatus.tokensBefore, { thousands: 'compact', millionSuffix: 'm' })} tokens)`,
      icon: Loader2,
      spin: true,
      pulse: true,
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
        'bg-muted text-foreground dark:bg-card/60 dark:text-foreground',
    }
  }
  if (!state) {
    return {
      label: 'Agent unavailable',
      detail: 'waiting for session state',
      icon: Clock,
      className:
        'bg-muted text-foreground dark:bg-card/60 dark:text-foreground',
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
      'bg-muted text-foreground dark:bg-card/60 dark:text-foreground',
  }
}

function useActivityClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [active])
  return now
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
