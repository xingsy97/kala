import { Check, Clock, Loader2, Wrench } from 'lucide-react'

import type { AgentState } from '@agent-kernel/kernel'

import { cn } from '../../lib/utils.js'

export type CompactStatus = 'idle' | 'running' | 'done'

type Props = {
  state: AgentState | null
  compactStatus: CompactStatus
}

export function ActivityBar({ state, compactStatus }: Props): JSX.Element | null {
  const activity = activityFor(state, compactStatus)
  if (!activity) return null
  const Icon = activity.icon
  return (
    <div
      className={cn(
        'border-t px-3 py-2 text-xs flex items-center gap-2',
        activity.className,
      )}
      data-testid="activity-bar"
      role="status"
      aria-live="polite"
    >
      <Icon
        className={cn('h-3.5 w-3.5 flex-none', activity.spin ? 'animate-spin' : '')}
      />
      <span className="font-medium">{activity.label}</span>
      {activity.detail ? (
        <span className="truncate text-slate-600 dark:text-slate-300">
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
): {
  label: string
  detail?: string
  icon: typeof Loader2
  spin?: boolean
  pulse?: boolean
  className: string
} | null {
  if (compactStatus === 'running') {
    return {
      label: 'Compacting context',
      detail: 'waiting for summarizer response',
      icon: Loader2,
      spin: true,
      className:
        'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200',
    }
  }
  if (compactStatus === 'done') {
    return {
      label: 'Context compacted',
      icon: Check,
      className:
        'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/35 dark:text-emerald-200',
    }
  }
  if (!state) return null
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
  return null
}
