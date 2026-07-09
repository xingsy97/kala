import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '../../lib/utils.js'
import { BadCasesTab } from '../artifacts/BadCasesTab.js'
import type { BenchmarkRunSummary } from './types.js'

type DetailTab = 'overview' | 'trials' | 'badcases' | 'compare'

const TABS: readonly DetailTab[] = ['overview', 'trials', 'badcases', 'compare']

export function RunDetailPanel({ run }: { run: BenchmarkRunSummary | null }): JSX.Element {
  const { t } = useTranslation()
  const [tab, setTab] = useState<DetailTab>('overview')

  if (!run) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground" data-testid="benchmarks-detail-empty">
        {t('benchmarks.page.selectRunHint')}
      </div>
    )
  }

  // Per docs/principles.md A3: only surface `resolved` after import is done
  // (i.e., summary contains resolved+total). Before that, we deliberately
  // show status only — no invented metrics.
  const officialTerm = run.kind === 'terminal-bench' ? 'resolved (Terminal-Bench parser)' : 'resolved'
  const hasScore = typeof run.resolved === 'number' && typeof run.totalInstances === 'number' && run.status === 'complete'
  const accuracyPct = hasScore && run.totalInstances! > 0
    ? Number(((run.resolved! / run.totalInstances!) * 100).toFixed(1))
    : null

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="benchmarks-detail-panel">
      <header className="border-b border-border/50 px-4 py-3">
        <div className="flex items-center gap-2">
          <h2 className="text-base font-semibold" data-testid="benchmarks-detail-run-label">
            {run.label}
          </h2>
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide">
            {run.kind}
          </span>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          {hasScore ? (
            <span data-testid="benchmarks-detail-resolved-metric">
              {t('benchmarks.detail.resolvedMetric', {
                term: officialTerm,
                resolved: run.resolved,
                total: run.totalInstances,
              })}
            </span>
          ) : (
            <span data-testid="benchmarks-detail-no-summary">
              {t('benchmarks.detail.noSummary')}
            </span>
          )}
          {accuracyPct !== null ? (
            <span data-testid="benchmarks-detail-accuracy">
              {t('benchmarks.detail.accuracyMetric', { value: accuracyPct })}
            </span>
          ) : null}
        </div>
      </header>

      <div role="tablist" className="flex items-center gap-1 border-b border-border/40 px-3 py-1" data-testid="benchmarks-detail-tabs">
        {TABS.map((id) => {
          const active = tab === id
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setTab(id)}
              data-testid={`benchmarks-detail-tab-${id}`}
              className={cn(
                'h-7 rounded px-2 text-xs',
                active ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {t(`benchmarks.detail.tabs.${id}`)}
            </button>
          )
        })}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {tab === 'overview' ? (
          <dl className="grid grid-cols-2 gap-3 p-4 text-xs" data-testid="benchmarks-detail-overview">
            <Metric label={t('benchmarks.detail.overview.dataset')} value={run.dataset} />
            <Metric label={t('benchmarks.detail.overview.model')} value={run.model} />
            <Metric
              label={t('benchmarks.detail.overview.status')}
              value={t(`benchmarks.runList.status.${run.status}`)}
            />
            <Metric
              label={t('benchmarks.detail.overview.selected')}
              value={t('benchmarks.runList.selectedCount', { count: run.selectedCount })}
            />
            <Metric label={t('benchmarks.detail.overview.createdAt')} value={run.createdAt} />
            <Metric label={t('benchmarks.detail.overview.updatedAt')} value={run.updatedAt} />
          </dl>
        ) : null}

        {tab === 'trials' ? (
          <div className="p-4 text-xs text-muted-foreground" data-testid="benchmarks-detail-trials">
            {t('benchmarks.detail.trials.placeholder')}
          </div>
        ) : null}

        {tab === 'badcases' ? (
          <BadCasesTab initialRunId={run.runId} />
        ) : null}

        {tab === 'compare' ? (
          <div className="p-4 text-xs text-muted-foreground" data-testid="benchmarks-detail-compare">
            {t('benchmarks.detail.compare.placeholder')}
          </div>
        ) : null}
      </div>
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string | number }): JSX.Element {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  )
}
