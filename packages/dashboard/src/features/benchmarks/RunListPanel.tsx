import { useTranslation } from 'react-i18next'
import { cn } from '../../lib/utils.js'
import { Typewriter } from '../../components/Typewriter.js'
import type { BenchmarkRunSummary } from './types.js'

export function RunListPanel({
  runs,
  loading,
  error,
  selectedRunId,
  onSelect,
  onRefresh,
}: {
  runs: readonly BenchmarkRunSummary[]
  loading: boolean
  error: string | null
  selectedRunId: string | null
  onSelect(runId: string): void
  onRefresh(): void
}): JSX.Element {
  const { t } = useTranslation()
  const grouped = new Map<string, BenchmarkRunSummary[]>()
  for (const r of runs) {
    const list = grouped.get(r.kind) ?? []
    list.push(r)
    grouped.set(r.kind, list)
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="benchmarks-run-list">
      <div className="flex items-center justify-between border-b border-border/50 px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t('benchmarks.page.columns.runs')}
        </span>
        <button
          type="button"
          className="text-xs text-muted-foreground underline hover:text-foreground"
          onClick={onRefresh}
          data-testid="benchmarks-run-list-refresh"
        >
          {t('benchmarks.runList.refresh')}
        </button>
      </div>

      {error ? (
        <div className="m-2 rounded border border-destructive/40 bg-destructive/10 px-2 py-1 text-xs text-destructive" data-testid="benchmarks-run-list-error">
          {t('benchmarks.runList.error', { message: error })}
        </div>
      ) : null}

      {loading ? (
        <div className="p-3 text-xs text-muted-foreground" data-testid="benchmarks-run-list-loading">
          {t('benchmarks.runList.loading')}
        </div>
      ) : null}

      {!loading && !error && runs.length === 0 ? (
        <div className="p-3 text-xs text-muted-foreground" data-testid="benchmarks-run-list-empty">
          <Typewriter text={t('benchmarks.page.emptyRuns')} charMs={22} />
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-auto">
        {[...grouped.entries()].map(([kind, list]) => (
          <section key={kind} className="mb-2" data-testid={`benchmarks-run-group-${kind}`}>
            <header className="sticky top-0 z-10 bg-card/95 px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground backdrop-blur">
              {t(`benchmarks.runList.groups.${kind}`, { defaultValue: kind })}
            </header>
            <ul className="flex flex-col">
              {list.map((run) => {
                const active = run.runId === selectedRunId
                return (
                  <li key={run.runId}>
                    <button
                      type="button"
                      onClick={() => onSelect(run.runId)}
                      data-testid={`benchmarks-run-row-${run.runId}`}
                      className={cn(
                        'flex w-full flex-col items-start gap-1 border-b border-border/30 px-3 py-2 text-left text-xs hover:bg-accent/40',
                        active && 'bg-primary/10 text-primary',
                      )}
                      aria-current={active ? 'true' : undefined}
                    >
                      <span className="w-full truncate font-medium">{run.label}</span>
                      <span className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                        <span className="rounded bg-muted px-1 py-0.5">{run.kind}</span>
                        <span
                          className={cn(
                            'rounded px-1 py-0.5',
                            run.status === 'complete' && 'bg-emerald-500/10 text-emerald-600',
                            run.status === 'running' && 'bg-amber-500/10 text-amber-600',
                            run.status === 'failed' && 'bg-rose-500/10 text-rose-600',
                            run.status === 'pending' && 'bg-muted text-muted-foreground',
                          )}
                          data-testid={`benchmarks-run-status-${run.runId}`}
                        >
                          {t(`benchmarks.runList.status.${run.status}`)}
                        </span>
                        <time dateTime={run.updatedAt}>{formatTimestamp(run.updatedAt)}</time>
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </section>
        ))}
      </div>
    </div>
  )
}

function formatTimestamp(iso: string): string {
  // Shortened locale time  -  full ISO would surface a path-like feel we want
  // to keep out of the compact list; users can hover the <time> for detail.
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return ''
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}
