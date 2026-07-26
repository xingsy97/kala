import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
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

type BreakdownSegment = {
  key: string
  label: string
  tokens: number
  className: string
  percent: number
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
  const [breakdownExpanded, setBreakdownExpanded] = useState(false)
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
  const totalContextWindow = contextSnapshot ? contextSnapshot.contextWindow.tokens : modelInfo?.contextWindow ?? config?.contextLimit ?? null
  const userContextWindow = evaluation.limitTokens
  const contextSource = contextSnapshot ? contextSnapshot.contextWindow.source : modelInfo?.contextWindow ? 'model_registry' : config?.contextLimit ? 'manual_config' : 'unknown'
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

  // Breakdown segments for the stacked usage bar. Widths are % of the user
  // context window so they visually add up to `visualRatio` when combined.
  const breakdownSegments = useMemo<ReadonlyArray<BreakdownSegment>>(() => {
    const b = contextSnapshot?.breakdown
    const window = userContextWindow ?? 0
    if (!b || window <= 0) return []
    const raw: ReadonlyArray<Omit<BreakdownSegment, 'percent'>> = [
      { key: 'system', label: t('chat.runtimeMetrics.systemReserve'), tokens: b.system, className: 'bg-sky-500' },
      { key: 'tools', label: t('chat.runtimeMetrics.toolDefinitions'), tokens: b.tools, className: 'bg-indigo-500' },
      { key: 'transcript', label: t('chat.runtimeMetrics.messages'), tokens: b.transcript, className: 'bg-emerald-500' },
      { key: 'memory', label: t('chat.runtimeMetrics.memory'), tokens: b.memory, className: 'bg-teal-500' },
      { key: 'attachments', label: t('chat.runtimeMetrics.attachments'), tokens: b.attachments, className: 'bg-amber-500' },
      { key: 'pendingUserInput', label: t('chat.runtimeMetrics.pendingInput'), tokens: b.pendingUserInput, className: 'bg-rose-500' },
    ]
    return raw
      .filter((seg) => seg.tokens > 0)
      .map((seg) => ({ ...seg, percent: (seg.tokens / window) * 100 }))
  }, [contextSnapshot, t, userContextWindow])

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
        {isSimple ? null : (
          <span className={cn(
            'flex-none whitespace-nowrap font-mono text-[10px] leading-none text-foreground',
            evaluation.tone === 'ok' && 'hidden sm:inline',
          )}>
            {percent !== null ? `${percent}%` : '?'}
          </span>
        )}
      </button>
      {open ? (
        <div
          className="ak-motion-popover fixed inset-x-2 bottom-[5.5rem] z-30 max-w-[calc(100vw-1rem)] overflow-x-hidden rounded-lg border border-border/70 bg-popover p-4 text-sm shadow-xl sm:absolute sm:inset-x-auto sm:bottom-full sm:right-0 sm:mb-2 sm:w-[min(24rem,calc(100vw-1rem))]"
          data-testid="context-pressure-popover"
        >
          <div className="text-lg font-semibold tracking-tight text-foreground">{t('chat.runtimeMetrics.contextWindow')}</div>

          <div className="mt-3 flex items-baseline justify-between gap-3">
            <span className="text-sm text-foreground">
              {contextSnapshot?.estimator.total.confidence === 'exact' ? '' : '~'}{formatTokens(contextTokens)} / {userContextWindow ? formatTokens(userContextWindow) : t('chat.runtimeMetrics.unknown')} {t('chat.runtimeMetrics.tokens')}
            </span>
            <span className={cn('text-sm font-medium', tone)}>{percent !== null ? `${percent}%` : '?'}</span>
          </div>
          {totalContextWindow && userContextWindow && totalContextWindow !== userContextWindow ? (
            <div className="mt-2 text-xs text-muted-foreground">
              {t('chat.runtimeMetrics.effectiveModel', { effective: formatTokens(userContextWindow), model: formatTokens(totalContextWindow) })}
            </div>
          ) : null}
          <div className="relative mt-3 h-2 overflow-hidden rounded-full border border-border bg-muted">
            {breakdownSegments.length > 0 ? (
              <div className="absolute inset-y-0 left-0 right-0 flex">
                {breakdownSegments.map((seg) => (
                  <span
                    key={seg.key}
                    className={cn('h-full', seg.className)}
                    style={{ width: `${Math.max(0.5, Math.min(100, seg.percent))}%` }}
                    title={`${seg.label}: ${formatTokens(seg.tokens)} (${Math.round(seg.percent)}%)`}
                    aria-label={`${seg.label} ${Math.round(seg.percent)}%`}
                  />
                ))}
              </div>
            ) : (
              <div className="absolute inset-y-0 left-0 rounded-full bg-sky-500" style={{ width: usedWidth }} />
            )}
            <div
              className="absolute inset-y-0 text-muted-foreground opacity-60"
              style={{
                left: reservedStart,
                width: reservedWidth,
                backgroundImage: 'repeating-linear-gradient(135deg, currentColor 0 4px, transparent 4px 8px)',
              }}
            />
          </div>
          {breakdownSegments.length > 0 ? (
            <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground" data-testid="context-breakdown-legend">
              {breakdownSegments.map((seg) => (
                <span key={seg.key} className="inline-flex items-center gap-1.5">
                  <span className={cn('h-2 w-2 flex-none rounded-sm', seg.className)} aria-hidden="true" />
                  <span>{seg.label}</span>
                  <span className="tabular-nums text-foreground/80">{Math.round(seg.percent)}%</span>
                </span>
              ))}
              <span className="inline-flex items-center gap-1.5">
                <span
                  className="h-2 w-4 flex-none text-muted-foreground opacity-60"
                  style={{ backgroundImage: 'repeating-linear-gradient(135deg, currentColor 0 3px, transparent 3px 6px)' }}
                  aria-hidden="true"
                />
                <span>{t('chat.runtimeMetrics.reserved')}</span>
              </span>
            </div>
          ) : (
            <div className="mt-4 flex items-center gap-3 text-muted-foreground">
              <span
                className="h-4 w-7 flex-none text-sky-500"
                style={{ backgroundImage: 'repeating-linear-gradient(135deg, currentColor 0 4px, transparent 4px 8px)' }}
                aria-hidden="true"
              />
              <span>{t('chat.runtimeMetrics.reservedForResponse')}</span>
            </div>
          )}

          <button
            type="button"
            onClick={() => setBreakdownExpanded((v) => !v)}
            aria-expanded={breakdownExpanded}
            data-testid="context-breakdown-toggle"
            className="mt-4 flex w-full items-center justify-between gap-2 rounded-md border border-border/60 px-2 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <span>{breakdownExpanded ? t('chat.runtimeMetrics.hideBreakdown') : t('chat.runtimeMetrics.showBreakdown')}</span>
            {breakdownExpanded ? (
              <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
            ) : (
              <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
            )}
          </button>
          {breakdownExpanded ? (
            <div data-testid="context-breakdown-details">
              <SectionTitle>{t('chat.runtimeMetrics.system')}</SectionTitle>
              <MetricRow label={t('chat.runtimeMetrics.systemReserve')} value={formatTokens(contextSnapshot?.breakdown.system ?? 0)} />
              <MetricRow label={t('chat.runtimeMetrics.toolDefinitions')} value={formatTokens(contextSnapshot?.breakdown.tools ?? 0)} />

              <SectionTitle>{t('chat.runtimeMetrics.userContext')}</SectionTitle>
              <MetricRow label={t('chat.runtimeMetrics.messages')} value={formatTokens(contextSnapshot?.breakdown.transcript ?? 0)} />
              {contextSnapshot?.breakdown.transcriptBreakdown ? (
                <div className="mt-1 border-l border-border/50 pl-3">
                  <MetricRow label={t('chat.runtimeMetrics.userMessages')} value={formatTokens(contextSnapshot.breakdown.transcriptBreakdown.userMessages)} muted />
                  <MetricRow label={t('chat.runtimeMetrics.assistantMessages')} value={formatTokens(contextSnapshot.breakdown.transcriptBreakdown.assistantMessages)} muted />
                  <MetricRow label={t('chat.runtimeMetrics.toolResults')} value={formatTokens(contextSnapshot.breakdown.transcriptBreakdown.toolResults)} muted />
                </div>
              ) : null}
              <MetricRow label={t('chat.runtimeMetrics.memory')} value={formatTokens(contextSnapshot?.breakdown.memory ?? 0)} />
              <MetricRow label={t('chat.runtimeMetrics.attachments')} value={formatTokens(contextSnapshot?.breakdown.attachments ?? 0)} />
              <MetricRow label={t('chat.runtimeMetrics.pendingInput')} value={formatTokens(contextSnapshot?.breakdown.pendingUserInput ?? 0)} />

              {totalContextWindow || contextSnapshot ? (
                <>
                  <SectionTitle>{t('chat.runtimeMetrics.diagnostics')}</SectionTitle>
                  {totalContextWindow ? (
                    <MetricRow label={t('chat.runtimeMetrics.modelContext')} value={formatTokens(totalContextWindow)} />
                  ) : null}
                  <MetricRow
                    label={t('chat.runtimeMetrics.source')}
                    value={`${contextSource}${contextSnapshot?.model.ref ? ` (${contextSnapshot.model.ref})` : ''}`}
                  />
                  {contextSnapshot ? (
                    <>
                      <MetricRow
                        label={t('chat.runtimeMetrics.totalEstimator')}
                        value={`${contextSnapshot.estimator.total.kind} / ${contextSnapshot.estimator.total.confidence}`}
                      />
                      <MetricRow
                        label={t('chat.runtimeMetrics.breakdownEstimator')}
                        value={`${contextSnapshot.estimator.breakdown.kind} / ${contextSnapshot.estimator.breakdown.confidence}`}
                      />
                    </>
                  ) : null}
                </>
              ) : null}
            </div>
          ) : null}

          <button
            type="button"
            className="mt-4 flex h-9 w-full items-center justify-center rounded-md border border-border bg-transparent px-3 text-xs text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!onCompact || compactDisabled}
            onClick={() => {
              onCompact?.()
              setOpen(false)
            }}
            data-testid="context-compact-conversation"
          >
            {t('chat.runtimeMetrics.compactConversation')}
          </button>
        </div>
      ) : null}
    </div>
  )
}

function SectionTitle({ children }: { children: ReactNode }): JSX.Element {
  return <div className="mt-4 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{children}</div>
}

function MetricRow({ label, value, muted }: { label: string; value: string; muted?: boolean }): JSX.Element {
  return (
    <div className={cn('flex items-center justify-between gap-3', muted ? 'mt-1 text-[11px]' : 'mt-2 text-xs')}>
      <span className={cn('min-w-0 truncate', muted ? 'text-muted-foreground' : 'text-foreground/90')}>{label}</span>
      <span className="flex-none font-mono text-muted-foreground">{value}</span>
    </div>
  )
}
