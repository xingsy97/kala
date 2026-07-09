import { useTranslation } from 'react-i18next'
import { Button } from '../../components/ui/button.js'

export function RunLauncherPanel({
  onLaunchSwebench,
  onLaunchTerminalBench,
}: {
  onLaunchSwebench(): void
  onLaunchTerminalBench(): void
}): JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="benchmarks-launcher">
      <div className="border-b border-border/50 px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t('benchmarks.page.columns.launcher')}
        </span>
      </div>
      <div className="flex flex-col gap-3 p-3">
        <p className="text-xs text-muted-foreground">{t('benchmarks.launcher.pickKind')}</p>
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
