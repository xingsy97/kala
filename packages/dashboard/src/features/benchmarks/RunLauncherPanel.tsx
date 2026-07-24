import { useTranslation } from 'react-i18next'
import { Button } from '../../components/ui/button.js'
import type { BenchmarkRunSummary } from './types.js'

export function RunLauncherPanel({
  run,
  onLaunchSwebench,
  onLaunchTerminalBench,
  onLaunchProgramBench,
  onLaunchSweMarathon,
  onLaunchTerminalBench21,
}: {
  run: BenchmarkRunSummary | null
  onLaunchSwebench(): void
  onLaunchTerminalBench(): void
  onLaunchProgramBench(): void
  onLaunchSweMarathon(): void
  onLaunchTerminalBench21(): void
}): JSX.Element {
  const { t } = useTranslation()
  const nextStep = run ? nextStepFor(run) : null
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="benchmarks-launcher">
      <div className="border-b border-border/50 px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {run ? t('benchmarks.actions.title') : t('benchmarks.page.columns.launcher')}
        </span>
      </div>
      <div className="flex min-h-0 flex-col gap-3 overflow-auto p-3">
        {run ? (
          <div className="rounded border border-border bg-card p-3" data-testid="benchmarks-next-step">
            <div className="text-sm font-medium">{t(`benchmarks.actions.steps.${nextStep}`)}</div>
            <p className="mt-1 text-xs text-muted-foreground">
              {t(`benchmarks.actions.stepHints.${nextStep}`)}
            </p>
            <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
              <Metric label={t('benchmarks.detail.overview.status')} value={t(`benchmarks.runList.status.${run.status}`)} />
              <Metric label={t('benchmarks.detail.overview.selected')} value={t('benchmarks.runList.selectedCount', { count: run.selectedCount })} />
            </div>
          </div>
        ) : null}
        <p className="text-xs text-muted-foreground">
          {run ? t('benchmarks.actions.newRunHint') : t('benchmarks.launcher.pickKind')}
        </p>
        <div className="flex flex-col gap-2">
          <button
            type="button"
            className="rounded border border-border bg-card p-3 text-left hover:bg-accent/40"
            onClick={onLaunchSwebench}
            data-testid="benchmarks-launcher-swebench"
          >
            <div className="text-sm font-medium">{t('benchmarks.launcher.startSwebench')}</div>
            <div className="mt-1 text-xs text-muted-foreground">
              {t('benchmarks.launcher.startSwebenchHint')}
            </div>
          </button>
          <button
            type="button"
            className="rounded border border-border bg-card p-3 text-left hover:bg-accent/40"
            onClick={onLaunchTerminalBench}
            data-testid="benchmarks-launcher-terminal-bench"
          >
            <div className="text-sm font-medium">{t('benchmarks.launcher.startTerminalBench')}</div>
            <div className="mt-1 text-xs text-muted-foreground">
              {t('benchmarks.launcher.startTerminalBenchHint')}
            </div>
          </button>
          <button
            type="button"
            className="rounded border border-border bg-card p-3 text-left hover:bg-accent/40"
            onClick={onLaunchTerminalBench21}
            data-testid="benchmarks-launcher-terminal-bench-2_1"
          >
            <div className="text-sm font-medium">{t('benchmarks.launcher.startTerminalBench21')}</div>
            <div className="mt-1 text-xs text-muted-foreground">
              {t('benchmarks.launcher.startTerminalBench21Hint')}
            </div>
          </button>
          <button
            type="button"
            className="rounded border border-border bg-card p-3 text-left hover:bg-accent/40"
            onClick={onLaunchProgramBench}
            data-testid="benchmarks-launcher-program-bench"
          >
            <div className="text-sm font-medium">{t('benchmarks.launcher.startProgramBench')}</div>
            <div className="mt-1 text-xs text-muted-foreground">
              {t('benchmarks.launcher.startProgramBenchHint')}
            </div>
          </button>
          <button
            type="button"
            className="rounded border border-border bg-card p-3 text-left hover:bg-accent/40"
            onClick={onLaunchSweMarathon}
            data-testid="benchmarks-launcher-swe-marathon"
          >
            <div className="text-sm font-medium">{t('benchmarks.launcher.startSweMarathon')}</div>
            <div className="mt-1 text-xs text-muted-foreground">
              {t('benchmarks.launcher.startSweMarathonHint')}
            </div>
          </button>
        </div>
        <div className="mt-2 flex flex-col gap-1">
          <Button type="button" variant="ghost" size="sm" onClick={onLaunchSwebench} data-testid="benchmarks-launcher-open">
            {t('benchmarks.launcher.openWizard')}
          </Button>
          <span className="text-[10px] text-muted-foreground">{t('benchmarks.launcher.swebenchWizardMoved')}</span>
        </div>
      </div>
    </div>
  )
}

function nextStepFor(run: BenchmarkRunSummary): 'plan' | 'infer' | 'grade' | 'ingest' | 'review' | 'inspect' {
  if (run.status === 'pending') return 'plan'
  if (run.status === 'running') return 'infer'
  if (run.status === 'failed') return 'inspect'
  if (typeof run.resolved === 'number' && typeof run.totalInstances === 'number') return 'review'
  if (run.kind === 'swebench' || run.kind === 'swe-bench') return 'ingest'
  return 'review'
}

function Metric({ label, value }: { label: string; value: string | number }): JSX.Element {
  return (
    <div className="min-w-0 rounded border border-border/60 px-2 py-1">
      <div className="truncate text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="truncate font-medium">{value}</div>
    </div>
  )
}
