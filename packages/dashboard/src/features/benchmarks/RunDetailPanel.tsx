import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '../../lib/utils.js'
import { BadCasesTab } from '../artifacts/BadCasesTab.js'
import { Button } from '../../components/ui/button.js'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../components/ui/dialog.js'
import type { BenchmarkRunSummary } from './types.js'

type DetailTab = 'overview' | 'backends' | 'badcases' | 'artifacts'

const TABS: readonly DetailTab[] = ['overview', 'backends', 'badcases', 'artifacts']

export function RunDetailPanel({ run, onDeleted }: { run: BenchmarkRunSummary | null; onDeleted?(): void }): JSX.Element {
  const { t } = useTranslation()
  const [tab, setTab] = useState<DetailTab>('overview')
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [impact, setImpact] = useState<{ files: number; bytes: number; targets: string[] } | null>(null)
  const [confirmText, setConfirmText] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  useEffect(() => { setDeleteOpen(false); setImpact(null); setConfirmText('') }, [run?.runId])

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
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide">{run.kind}</span>
          <button type="button" className="ml-auto rounded border border-destructive/40 px-2 py-1 text-xs text-destructive hover:bg-destructive/10" onClick={() => { setDeleteOpen(true); setDeleteError(null); void loadDeleteImpact(run.runId, setImpact, setDeleteError) }} data-testid="benchmarks-delete-open">{t('benchmarks.detail.delete.button')}</button>
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
          {run.evidenceLevel ? (
            <span className="rounded border border-border/60 px-1.5 py-0.5 font-medium" data-testid="benchmarks-detail-evidence-level">{run.evidenceLevel}</span>
          ) : null}
        </div>
      </header>
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}><DialogContent data-testid="benchmarks-delete-dialog"><DialogHeader><DialogTitle>{t('benchmarks.detail.delete.title')}</DialogTitle><DialogDescription>{t('benchmarks.detail.delete.description')}</DialogDescription></DialogHeader>{impact ? <div className="space-y-3 text-sm"><div className="rounded border border-destructive/30 bg-destructive/5 p-3">{t('benchmarks.detail.delete.impact', { files: impact.files, bytes: formatBytes(impact.bytes) })}</div><ul className="max-h-32 list-disc overflow-auto pl-5 font-mono text-xs">{impact.targets.map((target) => <li key={target}>{target}</li>)}</ul><label className="grid gap-1"><span>{t('benchmarks.detail.delete.confirm', { runId: run.runId })}</span><input className="h-9 rounded border border-border bg-background px-2 font-mono" value={confirmText} onChange={(event) => setConfirmText(event.target.value)} data-testid="benchmarks-delete-confirm" /></label></div> : <div className="text-sm text-muted-foreground">{t('common.loading')}</div>}{deleteError ? <div className="text-sm text-destructive">{deleteError}</div> : null}<DialogFooter><Button variant="outline" onClick={() => setDeleteOpen(false)}>{t('common.cancel')}</Button><Button variant="destructive" disabled={!impact || confirmText !== run.runId || deleting} onClick={() => void permanentlyDeleteRun(run.runId, setDeleting, setDeleteError, () => { setDeleteOpen(false); onDeleted?.() })} data-testid="benchmarks-delete-confirm-button">{deleting ? t('benchmarks.detail.delete.deleting') : t('benchmarks.detail.delete.confirmButton')}</Button></DialogFooter></DialogContent></Dialog>

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
            {run.comparison ? (
              <section className="border-t border-border/50 pt-4" data-testid="benchmarks-detail-comparison">
                <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('benchmarks.detail.comparison.title')}</div>
                <div className="mt-3 flex flex-wrap items-baseline gap-x-8 gap-y-3"><ComparisonValue label={t('benchmarks.detail.comparison.agentRunLab')} value={run.comparison.agentRunLabResolved ?? 0} /><ComparisonValue label={t('benchmarks.detail.comparison.claudeCode')} value={run.comparison.claudeCodeResolved ?? 0} />{run.badCaseCount !== undefined ? <ComparisonValue label={t('benchmarks.detail.comparison.badcasesLabel')} value={run.badCaseCount} /> : null}</div>
              </section>
            ) : null}
            <Lifecycle run={run} />
          </div>
        ) : null}

        {tab === 'backends' ? (
          <div className="grid gap-3 p-4" data-testid="benchmarks-detail-backends">
            <p className="text-sm text-muted-foreground">{t('benchmarks.detail.backends.description')}</p>
            {(run.backends ?? legacyBackends(run)).map((backend) => (
              <section key={backend.key} className="rounded-lg border border-border/60 bg-card p-4">
                <div className="flex items-center justify-between gap-3"><h3 className="text-base font-semibold">{backend.backendId}</h3><span className="rounded-full bg-muted px-2 py-1 text-xs">{backend.state}</span></div>
                <div className="mt-1 text-sm text-muted-foreground">{backend.model}</div>
                {backend.resolved !== undefined ? <div className="mt-3 text-2xl font-semibold tabular-nums">{backend.resolved} / {backend.total ?? 0} <span className="text-sm font-normal text-muted-foreground">resolved</span></div> : backend.total !== undefined ? <div className="mt-3 text-sm">{t('benchmarks.detail.backends.summary', { completed: backend.completed ?? 0, total: backend.total, failed: backend.failed ?? 0, timedOut: backend.timedOut ?? 0 })}</div> : null}
                {backend.error ? <div className="mt-2 text-sm text-destructive">{backend.error}</div> : null}
              </section>
            ))}
            {!run.backends?.length && !run.comparison ? <div className="text-sm text-muted-foreground">{t('benchmarks.detail.backends.empty')}</div> : null}
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
          <BadCasesTab key={run.runId} initialRunId={run.runId} lockedRun />
        ) : null}

      </div>
    </div>
  )
}

function ComparisonValue({ label, value }: { label: string; value: number }): JSX.Element {
  return <div><div className="text-2xl font-semibold tabular-nums">{value}</div><div className="mt-0.5 text-xs text-muted-foreground">{label}</div></div>
}

function legacyBackends(run: BenchmarkRunSummary): NonNullable<BenchmarkRunSummary['backends']> {
  if (!run.comparison) return []
  return [
    { key: 'legacy-agent-runlab', backendId: 'agent-runlab', model: 'historical', state: 'official', total: run.totalInstances, completed: run.totalInstances, resolved: run.comparison.agentRunLabResolved, failed: (run.totalInstances ?? 0) - (run.comparison.agentRunLabResolved ?? 0) },
    { key: 'legacy-claude-code', backendId: 'claude-code', model: 'historical', state: 'official', total: run.totalInstances, completed: run.totalInstances, resolved: run.comparison.claudeCodeResolved, failed: (run.totalInstances ?? 0) - (run.comparison.claudeCodeResolved ?? 0) },
  ]
}

async function callBenchmarkDelete(payload: Record<string, unknown>): Promise<any> {
  const response = await fetch('/enhancement/action', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
  const body = await response.json().catch(() => null) as { error?: string } | null
  if (!response.ok) throw new Error(body?.error ?? `status ${response.status}`)
  return body
}

async function loadDeleteImpact(runId: string, setImpact: (value: { files: number; bytes: number; targets: string[] }) => void, setError: (value: string | null) => void): Promise<void> {
  try { setImpact(await callBenchmarkDelete({ action: 'benchmark-run-delete-impact', runId })); setError(null) } catch (error) { setError(error instanceof Error ? error.message : String(error)) }
}

async function permanentlyDeleteRun(runId: string, setDeleting: (value: boolean) => void, setError: (value: string | null) => void, done: () => void): Promise<void> {
  setDeleting(true)
  try { await callBenchmarkDelete({ action: 'benchmark-run-delete', runId, confirmRunId: runId, confirmPermanent: true }); done() } catch (error) { setError(error instanceof Error ? error.message : String(error)) } finally { setDeleting(false) }
}

function formatBytes(bytes: number): string { return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB` }

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
