import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'

import { cn } from '../../lib/utils.js'

type ArtifactEntry = {
  path: string
  kind: string
  bytes: number
  mtime: string
}

type ArtifactManifest = {
  entries?: ArtifactEntry[]
}

type RlRolloutResult = {
  rolloutId?: string
  taskId?: string
  sessionId?: string
  status?: string
  readiness?: string
  blockedReason?: string
  tokenCaptureRefs?: unknown[]
  rewardRef?: unknown
  trajectoryRef?: unknown
  sampleValidationRef?: unknown
  completedAt?: string
}

type Row = {
  path: string
  result: RlRolloutResult | null
  error?: string
}

const PRIVATE_PATH_PATTERN = /(?:\/home\/[^\s"']+|\/tmp\/[^\s"']+|[A-Za-z]:\\[^\s"']+)/gu
const ENOENT_PATTERN = /ENOENT:[^\n"']+/gu

export function RlReadinessPanel(): JSX.Element {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState<string | null>(null)
  const query = useQuery({
    queryKey: ['rl-readiness-artifacts'],
    queryFn: loadRows,
    staleTime: 10_000,
  })
  const rows = query.data ?? []
  const summary = useMemo(() => summarize(rows), [rows])

  return (
    <section className="border-t border-border/60" data-testid="rl-readiness-panel">
      <div className="flex items-center justify-between gap-3 border-b border-border/50 px-4 py-2">
        <div>
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('benchmarks.rlReadiness.title')}
          </h2>
          <p className="text-[11px] text-muted-foreground">{t('benchmarks.rlReadiness.subtitle')}</p>
        </div>
        <button
          type="button"
          className="h-7 rounded border border-border px-2 text-xs hover:bg-muted"
          onClick={() => void query.refetch()}
          data-testid="rl-readiness-refresh"
        >
          {t('benchmarks.rlReadiness.refresh')}
        </button>
      </div>
      <div className="grid grid-cols-4 gap-2 px-4 py-3 text-xs" data-testid="rl-readiness-summary">
        <Metric label={t('benchmarks.rlReadiness.metrics.rollouts')} value={summary.total} />
        <Metric label={t('benchmarks.rlReadiness.metrics.ready')} value={summary.ready} />
        <Metric label={t('benchmarks.rlReadiness.metrics.blocked')} value={summary.blocked} />
        <Metric label={t('benchmarks.rlReadiness.metrics.tokenCaptured')} value={summary.tokenCaptured} />
      </div>
      {query.isLoading ? (
        <div className="px-4 pb-4 text-xs text-muted-foreground" data-testid="rl-readiness-loading">
          {t('benchmarks.rlReadiness.loading')}
        </div>
      ) : null}
      {query.error ? (
        <div className="px-4 pb-4 text-xs text-muted-foreground" data-testid="rl-readiness-error">
          {t('benchmarks.rlReadiness.empty')}
        </div>
      ) : null}
      {!query.isLoading && !query.error && rows.length === 0 ? (
        <div className="px-4 pb-4 text-xs text-muted-foreground" data-testid="rl-readiness-empty">
          {t('benchmarks.rlReadiness.empty')}
        </div>
      ) : null}
      {rows.length > 0 ? (
        <div className="divide-y divide-border/50" data-testid="rl-readiness-list">
          {rows.map((row) => {
            const result = row.result
            const id = result?.rolloutId ?? row.path
            const isOpen = expanded === row.path
            return (
              <article key={row.path} className="px-4 py-2 text-xs" data-testid={`rl-readiness-row-${sanitizeTestId(id)}`}>
                <button type="button" className="flex w-full items-center justify-between gap-3 text-left" onClick={() => setExpanded(isOpen ? null : row.path)}>
                  <div className="min-w-0">
                    <div className="truncate font-medium">{result?.rolloutId ?? safeDisplayPath(row.path)}</div>
                    <div className="truncate text-muted-foreground">{result?.taskId ?? t('benchmarks.rlReadiness.unknownTask')}</div>
                  </div>
                  <StatusPill value={row.error ? 'blocked' : result?.readiness ?? 'metadata-only'} />
                </button>
                <div className="mt-2 grid grid-cols-4 gap-2 text-[11px] text-muted-foreground">
                  <span>{t('benchmarks.rlReadiness.fields.status')}: {result?.status ?? 'unknown'}</span>
                  <span>{t('benchmarks.rlReadiness.fields.tokens')}: {result?.tokenCaptureRefs?.length ?? 0}</span>
                  <span>{t('benchmarks.rlReadiness.fields.reward')}: {result?.rewardRef ? t('common.yes') : t('common.no')}</span>
                  <span>{t('benchmarks.rlReadiness.fields.sample')}: {result?.sampleValidationRef ? t('common.yes') : t('common.no')}</span>
                </div>
                {isOpen ? (
                  <pre className="mt-2 max-h-56 overflow-auto rounded border border-border bg-muted/30 p-2 text-[11px]" data-testid="rl-readiness-detail">
                    {JSON.stringify(row.error ? { path: safeDisplayPath(row.path), error: safeError(row.error) } : redactDetail(result), null, 2)}
                  </pre>
                ) : null}
              </article>
            )
          })}
        </div>
      ) : null}
    </section>
  )
}

async function loadRows(): Promise<Row[]> {
  const manifestRes = await fetch('/artifacts/manifest', { cache: 'no-store' })
  if (!manifestRes.ok) return []
  const manifest = (await manifestRes.json().catch(() => ({}))) as ArtifactManifest
  const entries = (manifest.entries ?? [])
    .filter((entry) => entry.kind === 'rl_rollout_result' || entry.path.includes('/rl-rollouts/') || entry.path.startsWith('rl-rollouts/'))
    .sort((a, b) => b.mtime.localeCompare(a.mtime))
    .slice(0, 20)
  const rows = await Promise.all(entries.map(async (entry): Promise<Row> => {
    const contentRes = await fetch(`/artifacts/content?path=${encodeURIComponent(entry.path)}`, { cache: 'no-store' })
    if (!contentRes.ok) return { path: entry.path, result: null, error: `artifact content unavailable: status ${contentRes.status}` }
    const body = (await contentRes.json().catch(() => null)) as { body?: unknown; content?: unknown; error?: string } | null
    if (!body || body.error) return { path: entry.path, result: null, error: safeError(body?.error ?? 'invalid artifact content') }
    try {
      const payload = body.body ?? body.content
      const content = typeof payload === 'string' ? JSON.parse(payload) as RlRolloutResult : payload as RlRolloutResult
      return { path: entry.path, result: content }
    } catch {
      return { path: entry.path, result: null, error: 'artifact content is not valid JSON' }
    }
  }))
  return rows
}

function summarize(rows: readonly Row[]): { total: number; ready: number; blocked: number; tokenCaptured: number } {
  return {
    total: rows.length,
    ready: rows.filter((row) => row.result?.readiness === 'slime-sample-ready').length,
    blocked: rows.filter((row) => row.error || row.result?.status === 'blocked' || row.result?.readiness === 'blocked').length,
    tokenCaptured: rows.filter((row) => (row.result?.tokenCaptureRefs?.length ?? 0) > 0).length,
  }
}

function Metric({ label, value }: { label: string; value: number }): JSX.Element {
  return (
    <div className="rounded border border-border/60 px-2 py-1">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="font-semibold">{value}</div>
    </div>
  )
}

function StatusPill({ value }: { value: string }): JSX.Element {
  return (
    <span className={cn(
      'shrink-0 rounded px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide',
      value === 'slime-sample-ready' ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' :
        value === 'blocked' ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground',
    )}>
      {value}
    </span>
  )
}

function sanitizeTestId(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]+/g, '-')
}

function safeDisplayPath(path: string): string {
  const parts = path.split(/[\\/]+/u).filter(Boolean)
  return parts.slice(-2).join('/') || 'artifact'
}

function safeError(error: string): string {
  return error.replace(ENOENT_PATTERN, 'artifact content unavailable').replace(PRIVATE_PATH_PATTERN, '[redacted-path]')
}

function redactDetail(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(PRIVATE_PATH_PATTERN, '[redacted-path]').replace(ENOENT_PATTERN, 'artifact content unavailable')
  if (Array.isArray(value)) return value.map(redactDetail)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, raw] of Object.entries(value)) {
      out[key] = redactDetail(raw)
    }
    return out
  }
  return value
}
