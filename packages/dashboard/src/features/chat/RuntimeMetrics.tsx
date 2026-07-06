import type { AgentConfig, AgentState } from '@agent-kernel/kernel'
import type { ModelInfo } from '@agent-kernel/shared'

import { formatTokens } from '../../lib/format.js'

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
  queuedMessages: _queuedMessages,
}: Props): JSX.Element {
  const inputTokens = state?.usage.inputTokens ?? 0
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
      className="flex h-8 flex-none items-center gap-1.5 text-[11px] text-muted-foreground"
      title={title}
      aria-label={title}
      data-testid="context-usage-indicator"
    >
      <svg viewBox="0 0 20 20" className="h-4 w-4 flex-none" aria-hidden="true">
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
      <span className="flex-none whitespace-nowrap font-mono text-[10px] leading-none text-foreground">
        {userContextWindow && userContextWindow > 0 ? `${percent}%` : 'n/a'}
      </span>
    </div>
  )
}
