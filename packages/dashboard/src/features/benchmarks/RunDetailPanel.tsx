import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '../../lib/utils.js'
import { BadCasesTab } from '../artifacts/BadCasesTab.js'
import type { BenchmarkRunSummary } from './types.js'

type DetailTab = 'overview' | 'artifacts' | 'badcases'

const TABS: readonly DetailTab[] = ['overview', 'artifacts', 'badcases']

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

  // Per docs/meta/principles.md A3: only surface `resolved` after import is done
  // (i.e., summary contains resolved+total). Before that, we deliberately
  // show status only — no invented metrics.
  const officialTerm = run.kind === 'terminal-bench'
    ? 'resolved (Terminal-Bench parser)'
    : run.kind === 'program-bench'
      ? 'resolved (ProgramBench compile.sh → executable)'
      : run.kind === 'swe-marathon'
        ? 'reward == 1 (SWE-Marathon verifier)'
        : 'resolved'
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

      <div role="tablist" className="flex min-w-0 items-center gap-1 overflow-x-auto border-b border-border/40 px-3 py-1" data-testid="benchmarks-detail-tabs">
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
          <div className="grid gap-4 p-4" data-testid="benchmarks-detail-overview">
            <dl className="grid grid-cols-1 gap-3 text-xs sm:grid-cols-2 xl:grid-cols-3">
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
            <Lifecycle run={run} />
          </div>
        ) : null}

        {tab === 'artifacts' ? (
          <div className="grid gap-3 p-4 text-xs" data-testid="benchmarks-detail-artifacts">
            <p className="text-muted-foreground">{t('benchmarks.detail.artifacts.description')}</p>
            <div className="grid gap-2 sm:grid-cols-2">
              {artifactHintsFor(run).map((artifact) => (
                <div key={artifact} className="min-w-0 rounded border border-border/60 bg-card px-3 py-2">
                  <div className="truncate font-mono text-[11px] text-foreground">{artifact}</div>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {tab === 'badcases' ? (
          <BadCasesTab initialRunId={run.runId} />
        ) : null}

      </div>
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string | number }): JSX.Element {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded border border-border/50 bg-card px-3 py-2">
      <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="break-words font-medium [overflow-wrap:anywhere]">{value}</dd>
    </div>
  )
}

function Lifecycle({ run }: { run: BenchmarkRunSummary }): JSX.Element {
  const { t } = useTranslation()
  const current = lifecycleStep(run)
  const steps = ['plan', 'infer', 'grade', 'ingest', 'review'] as const
  const currentIndex = steps.indexOf(current)
  return (
    <div className="rounded border border-border/60 bg-card p-3" data-testid="benchmarks-detail-lifecycle">
      <div className="mb-2 text-xs font-semibold text-foreground">{t('benchmarks.detail.lifecycle.title')}</div>
      <ol className="grid gap-2 text-xs sm:grid-cols-5">
        {steps.map((step, index) => (
          <li
            key={step}
            className={cn(
              'rounded border px-2 py-1.5',
              index < currentIndex && 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
              index === currentIndex && 'border-primary/40 bg-primary/10 text-primary',
              index > currentIndex && 'border-border/60 text-muted-foreground',
            )}
          >
            {t(`benchmarks.detail.lifecycle.steps.${step}`)}
          </li>
        ))}
      </ol>
    </div>
  )
}

function lifecycleStep(run: BenchmarkRunSummary): 'plan' | 'infer' | 'grade' | 'ingest' | 'review' {
  if (run.status === 'pending') return 'plan'
  if (run.status === 'running') return 'infer'
  if (run.status === 'complete' && typeof run.resolved === 'number' && typeof run.totalInstances === 'number') return 'review'
  if (run.kind === 'swebench' || run.kind === 'swe-bench') return 'ingest'
  return 'review'
}

function artifactHintsFor(run: BenchmarkRunSummary): string[] {
  const root = run.kind === 'terminal-bench'
    ? `runs/terminal-bench/${run.runId}`
    : run.kind === 'program-bench'
      ? `program-bench/runs/${run.runId}`
      : run.kind === 'swe-marathon'
        ? `swe-marathon/runs/${run.runId}`
        : `runs/swebench/${run.runId}`
  return [
    `${root}/summary.json`,
    `${root}/progress.json`,
    `${root}/worker-plan.json`,
    `${root}/trials/<instance>.json`,
  ]
}
