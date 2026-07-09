import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AgentConfig, AgentState } from '@agent-kernel/kernel'
import type { ModelInfo } from '@agent-kernel/shared'

import { formatTokens } from '../../lib/format.js'
import { cn } from '../../lib/utils.js'
import { NumberTicker } from '../../components/ui/number-ticker.js'

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
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!open) return
    const onDocClick = (event: MouseEvent): void => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [open])
  const inputTokens = state?.usage.inputTokens ?? 0
  const outputTokens = state?.usage.outputTokens ?? 0
  const cachedTokens = (state?.usage.cacheReadTokens ?? 0) + (state?.usage.cacheCreationTokens ?? 0)
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
    ? t('chat.runtimeMetrics.title', {
      input: formatTokens(inputTokens),
      userWindow: formatTokens(userContextWindow),
      percent,
      totalWindow: totalContextWindow ? formatTokens(totalContextWindow) : t('chat.runtimeMetrics.unknown'),
    })
    : t('chat.runtimeMetrics.unavailableTitle', { input: formatTokens(inputTokens) })

  return (
    <div className="relative flex-none" ref={ref}>
    <button
      type="button"
      className="flex h-8 flex-none items-center gap-1.5 rounded px-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      title={title}
      aria-label={title}
      aria-expanded={open}
      data-testid="context-usage-indicator"
      onClick={() => setOpen((value) => !value)}
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
    </button>
    {open ? (
      <div
        className="absolute bottom-full right-0 z-30 mb-2 w-72 rounded-lg border border-border/60 bg-popover p-3 text-xs shadow-lg"
        data-testid="context-pressure-popover"
      >
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="font-medium text-foreground">{t('chat.runtimeMetrics.contextPressure')}</span>
          <span className={cn('rounded px-1.5 py-0.5 font-mono text-[10px]', tone, 'bg-background/70')}>
            {state?.contextPressureLevel ?? 'none'}
          </span>
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          <MetricNumber label={t('chat.runtimeMetrics.input')} value={inputTokens} format={formatTokens} />
          <MetricNumber label={t('chat.runtimeMetrics.output')} value={outputTokens} format={formatTokens} />
          <Metric label={t('chat.runtimeMetrics.userWindow')} value={userContextWindow ? formatTokens(userContextWindow) : t('chat.runtimeMetrics.unknown')} />
          <Metric label={t('chat.runtimeMetrics.modelWindow')} value={totalContextWindow ? formatTokens(totalContextWindow) : t('chat.runtimeMetrics.unknown')} />
          <MetricNumber label={t('chat.runtimeMetrics.queued')} value={queuedMessages} format={(n) => String(Math.round(n))} />
          <MetricNumber label={t('chat.runtimeMetrics.cached')} value={cachedTokens} format={(n) => (n > 0 ? formatTokens(n) : '0')} />
        </div>
        <div className="mt-2 rounded bg-muted/50 px-2 py-1.5 text-[11px] leading-relaxed text-muted-foreground">
          {t('chat.runtimeMetrics.contributorNote')}
        </div>
      </div>
    ) : null}
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="rounded bg-background/70 px-2 py-1 ring-1 ring-border/40">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-0.5 truncate font-mono text-[11px] text-foreground" title={value}>{value}</div>
    </div>
  )
}

function MetricNumber({
  label,
  value,
  format,
}: {
  label: string
  value: number
  format: (n: number) => string
}): JSX.Element {
  const title = format(value)
  return (
    <div className="rounded bg-background/70 px-2 py-1 ring-1 ring-border/40">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-0.5 truncate font-mono text-[11px] text-foreground" title={title}>
        <NumberTicker value={value} formatValue={format} />
      </div>
    </div>
  )
}
