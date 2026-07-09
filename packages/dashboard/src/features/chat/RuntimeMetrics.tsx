import type { AgentConfig, AgentState } from '@agent-kernel/kernel'
import type { ModelInfo } from '@agent-kernel/shared'

import { formatTokens } from '../../lib/format.js'
import { cn } from '../../lib/utils.js'

type Props = {
  state: AgentState | null
  config: AgentConfig | null
  modelInfo: ModelInfo | null
  queuedMessages: number
}

export function RuntimeMetrics({
  state,
  config,
  modelInfo,
  queuedMessages,
}: Props): JSX.Element {
  const inputTokens = state?.usage.inputTokens ?? 0
  const outputTokens = state?.usage.outputTokens ?? 0
  const cacheReadTokens = state?.usage.cacheReadTokens ?? 0
  const cacheCreationTokens = state?.usage.cacheCreationTokens ?? 0
  const totalContextWindow = modelInfo?.contextWindow ?? config?.contextLimit ?? null
  const userContextWindow = config?.contextLimit ?? totalContextWindow
  const ratio = userContextWindow && userContextWindow > 0
    ? Math.min(1, Math.max(0, inputTokens / userContextWindow))
    : 0
  const percent = Math.round(ratio * 100)
  const circumference = 2 * Math.PI * 8
  const dash = userContextWindow && userContextWindow > 0 ? circumference * ratio : 0
  const tone = state?.contextPressureLevel === 'hard'
    ? 'text-rose-600 dark:text-rose-300'
    : state?.contextPressureLevel === 'soft'
      ? 'text-amber-600 dark:text-amber-300'
      : 'text-sky-600 dark:text-sky-300'
  const title = userContextWindow && userContextWindow > 0
    ? `Context window: ${formatTokens(inputTokens)} of ${formatTokens(userContextWindow)} user tokens (${percent}%). Total model context window: ${totalContextWindow ? formatTokens(totalContextWindow) : 'unknown'} tokens. User context window: ${formatTokens(userContextWindow)} tokens.`
    : `Context window usage unavailable. Input tokens seen: ${formatTokens(inputTokens)}.`

  return (
    <div
      className="flex min-w-[16rem] flex-1 items-center gap-1.5 overflow-hidden rounded-md border border-border bg-secondary px-2 py-1 text-[11px] text-secondary-foreground"
      title={title}
      aria-label={title}
      data-testid="context-usage-indicator"
    >
      <svg viewBox="0 0 20 20" className="h-5 w-5 flex-none" aria-hidden="true">
        <circle
          cx="10"
          cy="10"
          r="8"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className="text-border"
        />
        <circle
          cx="10"
          cy="10"
          r="8"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={`${dash} ${circumference - dash}`}
          transform="rotate(-90 10 10)"
          className={tone}
        />
      </svg>
      <span className="min-w-0 flex-none whitespace-nowrap">
        {userContextWindow && userContextWindow > 0 ? `${percent}% context` : 'context n/a'}
      </span>
      <Metric
        label="Events"
        value={String(state?.cursor ?? 0)}
        title="Event log position: how many session events have been recorded so far."
        className="hidden lg:inline-flex"
      />
      <Metric
        label="Tools"
        value={String(state?.pendingCalls.length ?? 0)}
        title="Pending tool calls: tools requested by the assistant that are still waiting for approval or results."
        tone={(state?.pendingCalls.length ?? 0) > 0 ? 'amber' : undefined}
        className="hidden lg:inline-flex"
      />
      <Metric
        label="Tokens"
        value={`${formatTokens(inputTokens)} / ${formatTokens(outputTokens)}`}
        title="Token usage: input tokens sent to the model / output tokens received from the model."
        className="hidden 2xl:inline-flex"
      />
      {cacheReadTokens > 0 || cacheCreationTokens > 0 ? (
        <Metric
          label="Cache"
          value={formatTokens(cacheReadTokens)}
          title={`Prompt cache — hits: ${formatTokens(cacheReadTokens)} tokens read from cache, ${formatTokens(cacheCreationTokens)} tokens written to cache.`}
          tone="sky"
          className="hidden 2xl:inline-flex"
        />
      ) : null}
      {queuedMessages > 0 ? (
        <Metric
          label="Queued"
          value={String(queuedMessages)}
          title="Queued messages: messages that will be sent after the current turn finishes."
          tone="sky"
        />
      ) : null}
    </div>
  )
}

function Metric({
  label,
  value,
  title,
  tone,
  className,
}: {
  label: string
  value: string
  title: string
  tone?: 'amber' | 'sky'
  className?: string
}): JSX.Element {
  return (
    <span
      className={cn(
        'min-w-0 items-center gap-1 whitespace-nowrap border-l pl-1.5',
        tone === 'amber'
          ? 'border-amber-300 text-amber-700 dark:border-amber-800 dark:text-amber-300'
          : tone === 'sky'
            ? 'border-sky-300 text-sky-700 dark:border-sky-800 dark:text-sky-300'
            : 'border-border',
        className,
      )}
      title={`${title} Current value: ${value}.`}
    >
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono text-foreground">{value}</span>
    </span>
  )
}
