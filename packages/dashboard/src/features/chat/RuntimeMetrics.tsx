import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { AgentConfig, AgentState } from '@agent-kernel/kernel'
import type { ModelInfo } from '@agent-kernel/shared'
import type { ContextUsageSnapshot } from '@agent-kernel/shared/context-usage'

import { formatTokens } from '../../lib/format.js'
import { cn } from '../../lib/utils.js'
import type { TimelineEntry } from '../../session.js'
import { evaluateDashboardContextPressure } from '../../domain/context-pressure.js'

type Props = {
  state: AgentState | null
  config: AgentConfig | null
  contextSnapshot: ContextUsageSnapshot | null
  modelInfo: ModelInfo | null
  queuedMessages: number
  timeline?: readonly TimelineEntry[]
  density?: 'default' | 'simple'
  onCompact?: () => void
  compactDisabled?: boolean
}

export function RuntimeMetrics({
  state,
  config,
  contextSnapshot,
  modelInfo,
  queuedMessages: _queuedMessages,
  timeline = [],
  density = 'default',
  onCompact,
  compactDisabled,
}: Props): JSX.Element {
  const { t } = useTranslation()
  const ringGradientId = useId()
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

  const contextTokens = contextSnapshot?.usage.inputTokens ?? 0
  const evaluation = evaluateDashboardContextPressure({
    snapshot: contextSnapshot,
    config,
    fallbackModelContextWindow: modelInfo?.contextWindow ?? null,
  })
  const totalContextWindow = contextSnapshot?.contextWindow.tokens ?? modelInfo?.contextWindow ?? config?.contextLimit ?? null
  const userContextWindow = evaluation.limitTokens
  const contextSource = contextSnapshot?.contextWindow.source ?? (modelInfo?.contextWindow ? 'model_registry' : config?.contextLimit ? 'manual_config' : 'unknown')
  const ratio = evaluation.ratio ?? 0
  const percent = evaluation.percent
  const visualRatio = Math.min(1, ratio)
  const tone = evaluation.tone === 'error'
    ? 'text-rose-600 dark:text-rose-300'
    : evaluation.tone === 'warn'
      ? 'text-amber-600 dark:text-amber-300'
      : 'text-sky-600 dark:text-sky-300'
  const title = userContextWindow && userContextWindow > 0
    ? t('chat.runtimeMetrics.title', {
      input: formatTokens(contextTokens),
      userWindow: formatTokens(userContextWindow),
      percent: percent ?? 0,
      totalWindow: totalContextWindow ? formatTokens(totalContextWindow) : t('chat.runtimeMetrics.unknown'),
    })
    : t('chat.runtimeMetrics.unavailableTitle', { input: formatTokens(contextTokens) })
  const reservedRatio = Math.max(0, Math.min(1, 1 - (config?.hardThreshold ?? 0.92)))
  const ringRadius = 7
  const ringCircumference = 2 * Math.PI * ringRadius
  const ringOffset = ringCircumference * (1 - visualRatio)
  const usedWidth = userContextWindow && userContextWindow > 0 ? `${Math.min(100, visualRatio * 100)}%` : '0%'
  const reservedStart = `${Math.max(0, Math.min(100, (1 - reservedRatio) * 100))}%`
  const reservedWidth = `${Math.max(0, Math.min(100, reservedRatio * 100))}%`
  const isSimple = density === 'simple'

  return (
    <div className="relative flex-none" ref={ref}>
      <button
        type="button"
        className={cn(
          'flex flex-none items-center gap-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
          isSimple ? 'h-9 min-w-9 rounded-full px-2' : 'h-8 rounded px-1',
        )}
        title={title}
        aria-label={title}
        aria-expanded={open}
        data-testid="context-usage-indicator"
        onClick={() => setOpen((value) => !value)}
      >
        <svg
          viewBox="0 0 20 20"
          className="h-5 w-5 flex-none -rotate-90"
          aria-hidden="true"
        >
          <defs>
            <linearGradient id={ringGradientId} x1="0" y1="0" x2="20" y2="20" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stopColor="currentColor" stopOpacity="0.95" />
              <stop offset="100%" stopColor="currentColor" stopOpacity="0.5" />
            </linearGradient>
          </defs>
          <circle
            cx="10"
            cy="10"
            r={ringRadius}
            className="stroke-border"
            fill="none"
            strokeWidth="3"
          />
          <circle
            cx="10"
            cy="10"
            r={ringRadius}
            className={tone}
            fill="none"
            stroke={`url(#${ringGradientId})`}
            strokeWidth="3"
            strokeLinecap="round"
            strokeDasharray={ringCircumference}
            strokeDashoffset={ringOffset}
          />
        </svg>
        <span className="flex-none whitespace-nowrap font-mono text-[10px] leading-none text-foreground">
          {percent !== null ? `${percent}%` : '?'}
        </span>
      </button>
      {open ? (
        <div
          className="absolute bottom-full right-0 z-30 mb-2 w-[min(24rem,calc(100vw-2rem))] rounded-lg border border-border/70 bg-popover p-4 text-sm shadow-xl"
          data-testid="context-pressure-popover"
        >
          <div className="text-lg font-semibold tracking-tight text-foreground">Session Info</div>

          <div className="mt-4 flex items-center justify-between gap-4 text-base">
            <span className="text-foreground/90">Session Cost</span>
            <span className="font-semibold text-foreground">—</span>
          </div>

          <SectionTitle>Context Window</SectionTitle>
          <div className="mt-3 flex items-baseline justify-between gap-4">
            <span className="text-lg text-foreground">
              {contextSnapshot?.estimator.total.confidence === 'exact' ? '' : '~'}{formatTokens(contextTokens)} / {userContextWindow ? formatTokens(userContextWindow) : t('chat.runtimeMetrics.unknown')} tokens
            </span>
            <span className={cn('text-lg', tone)}>{percent !== null ? `${percent}%` : '?'}</span>
          </div>
          {totalContextWindow && userContextWindow && totalContextWindow !== userContextWindow ? (
            <div className="mt-2 text-xs text-muted-foreground">
              Effective {formatTokens(userContextWindow)} / model {formatTokens(totalContextWindow)}
            </div>
          ) : totalContextWindow ? (
            <div className="mt-2 text-xs text-muted-foreground">
              Model context {formatTokens(totalContextWindow)}
            </div>
          ) : null}
          <div className="mt-1 text-xs text-muted-foreground">
            Source: {contextSource}{contextSnapshot?.model.ref ? ` (${contextSnapshot.model.ref})` : ''}
          </div>
          {contextSnapshot ? (
            <div className="mt-1 text-xs text-muted-foreground">
              Total estimator: {contextSnapshot.estimator.total.kind} / {contextSnapshot.estimator.total.confidence}. Breakdown: {contextSnapshot.estimator.breakdown.kind} / {contextSnapshot.estimator.breakdown.confidence}.
            </div>
          ) : null}
          <div className="relative mt-3 h-2 overflow-hidden rounded-full border border-border bg-muted">
            <div className="absolute inset-y-0 left-0 rounded-full bg-sky-500" style={{ width: usedWidth }} />
            <div
              className="absolute inset-y-0 text-sky-500 opacity-90"
              style={{
                left: reservedStart,
                width: reservedWidth,
                backgroundImage: 'repeating-linear-gradient(135deg, currentColor 0 4px, transparent 4px 8px)',
              }}
            />
          </div>
          <div className="mt-4 flex items-center gap-3 text-muted-foreground">
            <span
              className="h-4 w-7 flex-none text-sky-500"
              style={{ backgroundImage: 'repeating-linear-gradient(135deg, currentColor 0 4px, transparent 4px 8px)' }}
              aria-hidden="true"
            />
            <span>Reserved for response</span>
          </div>

          <SectionTitle>System</SectionTitle>
          <MetricRow label="System / reserve" value={formatTokens(contextSnapshot?.breakdown.system ?? 0)} />
          <MetricRow label="Tool Definitions" value={formatTokens(contextSnapshot?.breakdown.tools ?? 0)} />

          <SectionTitle>User Context</SectionTitle>
          <MetricRow label="Messages" value={formatTokens(contextSnapshot?.breakdown.transcript ?? 0)} />
          <MetricRow label="Memory" value={formatTokens(contextSnapshot?.breakdown.memory ?? 0)} />
          <MetricRow label="Attachments" value={formatTokens(contextSnapshot?.breakdown.attachments ?? 0)} />
          <MetricRow label="Pending input" value={formatTokens(contextSnapshot?.breakdown.pendingUserInput ?? 0)} />

          <button
            type="button"
            className="mt-5 flex h-10 w-full items-center justify-center rounded-md border border-border bg-transparent px-3 text-base text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!onCompact || compactDisabled}
            onClick={() => {
              onCompact?.()
              setOpen(false)
            }}
            data-testid="context-compact-conversation"
          >
            Compact Conversation
          </button>
        </div>
      ) : null}
    </div>
  )
}

function SectionTitle({ children }: { children: ReactNode }): JSX.Element {
  return <div className="mt-5 text-base font-semibold text-muted-foreground">{children}</div>
}

function MetricRow({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="mt-3 flex items-center justify-between gap-4 text-base">
      <span className="min-w-0 truncate text-foreground/90">{label}</span>
      <span className="flex-none font-mono text-muted-foreground">{value}</span>
    </div>
  )
}
