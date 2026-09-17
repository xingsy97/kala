import { useEffect, useRef, useState } from 'react'
import { Activity, ChevronDown, ChevronUp } from 'lucide-react'
import type { HumanAttentionLevel, HumanAttentionTimeline } from '@agent-kernel/shared'
import { useTranslation } from 'react-i18next'

import { cn } from '../../lib/utils.js'

type Props = {
  timeline: HumanAttentionTimeline
  density?: 'default' | 'simple'
}

const DIMENSIONS: ReadonlyArray<keyof NonNullable<HumanAttentionTimeline['latest']>['dimensions']> =
  ['inputQuality', 'reviewDepth', 'correctionQuality', 'riskAwareness', 'continuity', 'riskExposure']

export function HumanAttentionIndicator({ timeline, density = 'default' }: Props): JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [reasonsExpanded, setReasonsExpanded] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)
  const latest = timeline.latest
  const isSimple = density === 'simple'
  const scoreText = latest ? String(latest.score) : '--'
  const title = latest
    ? t('humanAttention.title', { score: latest.score, level: t(`humanAttention.levels.${latest.level}`) })
    : t('humanAttention.unavailable')

  useEffect(() => {
    if (!open) return
    const onDocClick = (event: MouseEvent): void => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="relative flex-none" ref={ref}>
      <button
        type="button"
        className={cn(
          'flex flex-none items-center gap-1.5 text-[0.6875rem] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
          latest && levelTone(latest.level),
          open && 'bg-accent text-foreground',
          isSimple ? 'h-9 min-w-9 rounded-full px-2' : 'h-8 rounded px-1.5',
        )}
        title={title}
        aria-label={title}
        aria-expanded={open}
        aria-haspopup="dialog"
        data-testid="human-attention-indicator"
        onClick={() => setOpen((value) => !value)}
      >
        <Activity className="h-4 w-4 flex-none" aria-hidden="true" />
        {isSimple ? null : (
          <span className={cn(
            'flex-none whitespace-nowrap font-mono text-[0.625rem] leading-none text-foreground',
            latest && (latest.level === 'engaged' || latest.level === 'watching') && 'hidden sm:inline',
          )}>
            {scoreText}
          </span>
        )}
      </button>
      {open ? (
        <div
          role="dialog"
          aria-label={t('humanAttention.heading')}
          className="ak-motion-popover fixed inset-x-2 bottom-[5.5rem] z-30 max-w-[calc(100vw-1rem)] overflow-x-hidden rounded-lg border border-border/70 bg-popover p-4 text-sm shadow-xl sm:absolute sm:inset-x-auto sm:bottom-full sm:right-0 sm:mb-2 sm:w-[min(26rem,calc(100vw-1rem))]"
          data-testid="human-attention-popover"
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="text-lg font-semibold tracking-tight text-foreground">{t('humanAttention.heading')}</div>
              <div className="mt-1 text-xs text-muted-foreground">{t('humanAttention.sessionEstimate')}</div>
            </div>
            <div className="text-right">
              <div className={cn('font-mono text-2xl leading-none', latest ? scoreTextTone(latest.level) : 'text-muted-foreground')}>
                {scoreText}
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                {latest ? t(`humanAttention.levels.${latest.level}`) : t('humanAttention.noData')}
              </div>
            </div>
          </div>

          {latest ? (
            <>
              <AttentionChart timeline={timeline} />
              <div className="mt-4 grid gap-2">
                {DIMENSIONS.map((key) => (
                  <DimensionBar key={key} label={t(`humanAttention.dimensions.${key}`)} value={latest.dimensions[key]} reverse={key === 'riskExposure'} />
                ))}
              </div>
              <div className="mt-4 flex items-center justify-between gap-3 text-xs text-muted-foreground">
                <span>{t('humanAttention.cursor', { cursor: latest.messageCursor })}</span>
                <span>{t('humanAttention.confidence', { percent: Math.round(latest.confidence * 100) })}</span>
              </div>
              {latest.reasons.length > 0 ? (
                <div className="mt-3">
                  <button
                    type="button"
                    onClick={() => setReasonsExpanded((v) => !v)}
                    aria-expanded={reasonsExpanded}
                    data-testid="human-attention-reasons-toggle"
                    className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  >
                    <span>{reasonsExpanded ? t('humanAttention.hideReasons') : t('humanAttention.showReasons', { count: latest.reasons.length })}</span>
                    {reasonsExpanded ? (
                      <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
                    ) : (
                      <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
                    )}
                  </button>
                  {reasonsExpanded ? (
                    <ul className="mt-2 space-y-1.5 text-xs" data-testid="human-attention-reasons">
                      {latest.reasons.map((reason, index) => (
                        <li key={`${reason.kind}-${index}`} className={cn('rounded-md px-2 py-1.5', reasonTone(reason.severity))}>
                          <span className="font-medium">{reason.message}</span>
                          {reason.evidence ? <span className="ml-1 opacity-80">{reason.evidence}</span> : null}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : (
            <div className="mt-4 rounded-md border border-border/60 bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              {t('humanAttention.empty')}
            </div>
          )}
        </div>
      ) : null}
    </div>
  )
}

export function shouldShowLowAttentionHint(timeline: HumanAttentionTimeline): boolean {
  const latest = timeline.latest
  if (latest?.level !== 'absent') return false
  if (latest.dimensions.riskExposure >= 35) return true
  if (latest.reasons.some((reason) => reason.kind === 'high_agent_activity' || reason.kind === 'high_risk_action' || reason.kind === 'stale_review')) return true
  const recentPoints = timeline.points.slice(-6)
  const continueOnlyWarnings = recentPoints.filter((point) => point.reasons.some((reason) => reason.kind === 'continue_only')).length
  return recentPoints.length >= 4 && continueOnlyWarnings >= 2
}

function AttentionChart({ timeline }: { timeline: HumanAttentionTimeline }): JSX.Element {
  const { t } = useTranslation()
  const points = timeline.points.slice(-40)
  const width = 320
  const height = 96
  const padding = 10
  const minCursor = points[0]?.messageCursor ?? 0
  const maxCursor = points.at(-1)?.messageCursor ?? minCursor
  const cursorSpan = Math.max(1, maxCursor - minCursor)
  const path = points.map((point) => {
    const x = padding + ((point.messageCursor - minCursor) / cursorSpan) * (width - padding * 2)
    const y = padding + ((100 - point.score) / 100) * (height - padding * 2)
    return `${roundCoord(x)},${roundCoord(y)}`
  }).join(' ')

  return (
    <div className="mt-4 rounded-md border border-border/60 bg-background/50 p-2" data-testid="human-attention-chart">
      <svg viewBox={`0 0 ${width} ${height}`} className="h-24 w-full text-sky-500" role="img" aria-label={t('humanAttention.timeline')}>
        <line x1={padding} y1={padding} x2={padding} y2={height - padding} className="stroke-border" strokeWidth="1" />
        <line x1={padding} y1={height - padding} x2={width - padding} y2={height - padding} className="stroke-border" strokeWidth="1" />
        <line x1={padding} y1={padding + (height - padding * 2) * 0.7} x2={width - padding} y2={padding + (height - padding * 2) * 0.7} className="stroke-rose-300/70 dark:stroke-rose-800/80" strokeDasharray="4 4" strokeWidth="1" />
        {path ? <polyline points={path} fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" /> : null}
        {points.map((point) => {
          const x = padding + ((point.messageCursor - minCursor) / cursorSpan) * (width - padding * 2)
          const y = padding + ((100 - point.score) / 100) * (height - padding * 2)
          return <circle key={point.messageCursor} cx={roundCoord(x)} cy={roundCoord(y)} r="2.2" className={scoreFill(point.level)} />
        })}
      </svg>
      <div className="mt-1 flex justify-between text-[0.625rem] text-muted-foreground">
        <span>{minCursor}</span>
        <span>{t('humanAttention.messageCursor')}</span>
        <span>{maxCursor}</span>
      </div>
    </div>
  )
}

function DimensionBar({ label, value, reverse }: { label: string; value: number; reverse?: boolean }): JSX.Element {
  return (
    <div className="grid grid-cols-[7rem_minmax(0,1fr)_2.5rem] items-center gap-2 text-xs">
      <span className="truncate text-muted-foreground">{label}</span>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div className={cn('h-full rounded-full', reverse ? riskBarTone(value) : qualityBarTone(value))} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
      </div>
      <span className="text-right font-mono text-[0.6875rem] text-foreground">{value}</span>
    </div>
  )
}

function levelTone(level: HumanAttentionLevel): string {
  if (level === 'engaged') return 'text-emerald-700 dark:text-emerald-300'
  if (level === 'watching') return 'text-sky-700 dark:text-sky-300'
  if (level === 'drifting') return 'text-amber-700 dark:text-amber-300'
  return 'text-rose-700 dark:text-rose-300'
}

function scoreTextTone(level: HumanAttentionLevel): string {
  if (level === 'engaged') return 'text-emerald-600 dark:text-emerald-300'
  if (level === 'watching') return 'text-sky-600 dark:text-sky-300'
  if (level === 'drifting') return 'text-amber-600 dark:text-amber-300'
  return 'text-rose-600 dark:text-rose-300'
}

function scoreFill(level: HumanAttentionLevel): string {
  if (level === 'engaged') return 'fill-emerald-500'
  if (level === 'watching') return 'fill-sky-500'
  if (level === 'drifting') return 'fill-amber-500'
  return 'fill-rose-500'
}

function qualityBarTone(value: number): string {
  if (value >= 70) return 'bg-emerald-500'
  if (value >= 45) return 'bg-sky-500'
  if (value >= 25) return 'bg-amber-500'
  return 'bg-rose-500'
}

function riskBarTone(value: number): string {
  if (value >= 70) return 'bg-rose-500'
  if (value >= 40) return 'bg-amber-500'
  return 'bg-emerald-500'
}

function reasonTone(severity: 'info' | 'warning' | 'critical'): string {
  if (severity === 'critical') return 'bg-rose-50 text-rose-800 dark:bg-rose-950/40 dark:text-rose-200'
  if (severity === 'warning') return 'bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-200'
  return 'bg-muted/60 text-muted-foreground'
}

function roundCoord(value: number): number {
  return Math.round(value * 10) / 10
}
