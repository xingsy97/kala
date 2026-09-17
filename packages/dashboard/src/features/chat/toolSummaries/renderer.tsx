import type { ToolCallContent, ToolResultContent } from '@agent-kernel/kernel'
import type { LucideIcon } from 'lucide-react'
import { CheckCircle2, Clock3, LoaderCircle, Wrench, XCircle } from 'lucide-react'

import { cn } from '../../../lib/utils.js'

export type SummaryDelta = {
  kind: 'delta'
  additions: number
  deletions: number
}

export type SummarySecondary = string | SummaryDelta

export type SummaryRow = {
  callId: string
  primary: string
  secondary?: SummarySecondary
  ok: boolean
}

export type GroupedToolRenderer = (args: {
  calls: readonly ToolCallContent[]
  results: ReadonlyMap<string, ToolResultContent>
}) => SummaryRow[]

export const genericRenderer: GroupedToolRenderer = ({ calls, results }) => {
  return calls.map((c) => {
    const r = results.get(c.callId)
    const preview = Object.entries(c.input)
      .slice(0, 2)
      .map(([k, v]) => `${k}=${truncate(previewValue(v), 40)}`)
      .join(' · ')
    return {
      callId: c.callId,
      primary: preview || c.callId,
      ok: r ? r.ok : true,
    }
  })
}

export function previewValue(v: unknown): string {
  if (v == null) return String(v)
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) return `[${v.length} item${v.length === 1 ? '' : 's'}]`
  if (typeof v === 'object') {
    const keys = Object.keys(v as object)
    return `{${keys.length} field${keys.length === 1 ? '' : 's'}}`
  }
  return String(v)
}

export function truncate(s: string, n: number): string {
  if (s.length <= n) return s
  return `${s.slice(0, n - 1)}…`
}

export function firstLine(s: string): string {
  const idx = s.indexOf('\n')
  return idx === -1 ? s : s.slice(0, idx)
}

export function countLines(s: string): number {
  if (s.length === 0) return 0
  let n = 1
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++
  return n
}

export type ToolIconRenderer = {
  Icon: LucideIcon
  toneClass: string
}

export function toolStatusIcon(ok: boolean): ToolIconRenderer {
  return ok
    ? {
        Icon: CheckCircle2,
        toneClass: 'text-emerald-600 dark:text-emerald-400',
      }
    : {
        Icon: XCircle,
        toneClass: 'text-rose-600 dark:text-rose-400',
      }
}

export function GroupSummaryRow({
  row,
  toolName,
  status,
  intent,
  fallbackSummary,
  hideTechnicalSummary = false,
  onClick,
}: {
  row: SummaryRow
  toolName: string
  status?: 'succeeded' | 'failed' | 'approval' | 'running'
  intent?: string
  fallbackSummary?: string
  hideTechnicalSummary?: boolean
  onClick: () => void
}): JSX.Element {
  const fallback = toolStatusIcon(row.ok)
  const Icon = status === 'running' ? LoaderCircle : status === 'approval' ? Clock3 : fallback.Icon
  const toneClass = status === 'running'
    ? 'animate-spin text-violet-600 dark:text-violet-300'
    : status === 'approval'
      ? 'animate-pulse text-amber-600 dark:text-amber-400'
      : fallback.toneClass
  const delta = typeof row.secondary === 'object' && row.secondary.kind === 'delta' ? row.secondary : null
  const text = typeof row.secondary === 'string' ? row.secondary : null
  const missingIntentLabel = status === 'failed'
    ? 'Failed operation'
    : status === 'approval'
      ? 'Approval required'
      : status === 'running'
        ? 'Running operation'
        : undefined
  const semanticSummary = intent ?? fallbackSummary ?? missingIntentLabel
  return (
    <button
      type="button"
      onClick={onClick}
      className="group/summary grid w-full min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-x-2 gap-y-1 rounded-lg px-2 py-2 text-left text-xs transition-colors hover:bg-muted/70 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:gap-y-0.5"
      data-testid={`grouped-tool-row-${row.callId}`}
    >
      <Icon className={cn('h-3 w-3 flex-none', toneClass)} aria-hidden="true" />
      <span className="min-w-0">
        <span className="flex min-w-0 items-baseline gap-1.5 text-muted-foreground">
          <span className="flex-none font-mono text-[0.625rem] font-medium">{toolName}</span>
          <span className="flex-none text-muted-foreground/60" aria-hidden="true">·</span>
          {hideTechnicalSummary ? (
            semanticSummary ? (
              <span className={cn('min-w-0 whitespace-pre-wrap break-words text-[0.6875rem] leading-5 text-foreground', !intent && 'truncate')} title={intent ?? undefined}>
                {semanticSummary}
              </span>
            ) : null
          ) : (
            <span className="min-w-0 truncate font-mono text-[0.625rem]" title={row.primary}>
              {row.primary}
            </span>
          )}
        </span>
        {semanticSummary ? (
          <span className="mt-0.5 block min-w-0 truncate text-[0.6875rem] leading-4 text-foreground/90" title={semanticSummary} data-testid={`grouped-tool-primary-${row.callId}`}>
            {semanticSummary}
          </span>
        ) : null}
        {!hideTechnicalSummary && text ? (
          <span className="mt-0.5 block truncate text-[0.625rem] leading-4 text-muted-foreground sm:hidden" title={text}>{text}</span>
        ) : null}
      </span>
      {delta ? (
        <span className="col-start-2 inline-flex h-5 w-fit flex-none items-center overflow-hidden rounded border border-border/50 bg-background/70 text-[0.6875rem] leading-none sm:col-start-3 sm:row-start-1" aria-label={`${delta.additions} additions, ${delta.deletions} deletions`}>
          <span className="inline-flex h-5 items-center gap-1 border-r border-border/50 px-1.5 font-mono font-semibold text-emerald-700 dark:text-emerald-300">
            <span className="text-[0.625rem] text-emerald-600/80 dark:text-emerald-300/80">+</span>
            {delta.additions}
          </span>
          <span className="inline-flex h-5 items-center gap-1 px-1.5 font-mono font-semibold text-rose-700 dark:text-rose-300">
            <span className="text-[0.625rem] text-rose-600/80 dark:text-rose-300/80">-</span>
            {delta.deletions}
          </span>
        </span>
      ) : !hideTechnicalSummary && text ? (
        <span className="hidden h-5 max-w-36 flex-none items-center truncate rounded bg-background/70 px-1.5 text-[0.6875rem] leading-none text-muted-foreground sm:inline-flex" title={text}>
          {text}
        </span>
      ) : null}
      {intent ? <span className="sr-only" data-testid={`grouped-tool-intent-${row.callId}`}>{intent}</span> : null}
    </button>
  )
}

export function GroupSummaryPreview({
  row,
  status,
}: {
  row: SummaryRow
  status: 'succeeded' | 'failed' | 'approval' | 'running' | 'orphaned'
}): JSX.Element {
  const fallback = toolStatusIcon(row.ok)
  const Icon = status === 'running'
    ? LoaderCircle
    : status === 'approval'
      ? Clock3
      : fallback.Icon
  const toneClass = status === 'running'
    ? 'animate-spin text-muted-foreground'
    : status === 'approval'
      ? 'animate-pulse text-amber-600 dark:text-amber-400'
      : status === 'orphaned'
        ? 'text-muted-foreground/70'
        : fallback.toneClass
  const delta = typeof row.secondary === 'object' && row.secondary.kind === 'delta' ? row.secondary : null
  const secondaryText = typeof row.secondary === 'string' ? row.secondary : null

  return (
    <div
      className="ak-expand-in grid min-h-7 w-full min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-md bg-muted/40 px-2 py-1 text-left text-xs"
      data-testid={`tool-card-preview-${row.callId}`}
    >
      <Icon className={cn('h-3 w-3 flex-none', toneClass)} aria-hidden="true" />
      <span className="min-w-0 truncate font-mono text-[0.6875rem] text-foreground [overflow-wrap:anywhere]" title={row.primary}>
        {row.primary}
      </span>
      {delta ? (
        <span className="col-start-2 inline-flex h-5 w-fit flex-none items-center overflow-hidden rounded border border-border/50 bg-background/70 text-[0.6875rem] leading-none sm:col-start-3 sm:row-start-1" aria-label={`${delta.additions} additions, ${delta.deletions} deletions`}>
          <span className="inline-flex h-5 items-center gap-1 border-r border-border/50 px-1.5 font-mono font-semibold text-emerald-700 dark:text-emerald-300">
            <span className="text-[0.625rem] text-emerald-600/80 dark:text-emerald-300/80">+</span>
            {delta.additions}
          </span>
          <span className="inline-flex h-5 items-center gap-1 px-1.5 font-mono font-semibold text-rose-700 dark:text-rose-300">
            <span className="text-[0.625rem] text-rose-600/80 dark:text-rose-300/80">-</span>
            {delta.deletions}
          </span>
        </span>
      ) : secondaryText ? (
        <span className="inline-flex h-5 max-w-36 flex-none items-center truncate rounded bg-background/70 px-1.5 text-[0.6875rem] leading-none text-muted-foreground" title={secondaryText}>
          {secondaryText}
        </span>
      ) : null}
    </div>
  )
}

export function GroupHeaderIcon(): JSX.Element {
  return <Wrench className="h-3.5 w-3.5 flex-none text-muted-foreground" aria-hidden="true" />
}
