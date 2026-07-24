import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import { RunListPanel } from './RunListPanel.js'
import { RunDetailPanel } from './RunDetailPanel.js'
import { RunLauncherPanel } from './RunLauncherPanel.js'
import { RunTerminalBenchWizard } from './RunTerminalBenchWizard.js'
import { RunBenchmarkWizardModal } from './RunBenchmarkWizardModal.js'
import type { BenchmarkRunSummary } from './types.js'

export function BenchmarksPage({
  onOpenSession: _onOpenSession,
}: {
  onOpenSession?(sessionId: string): void
}): JSX.Element {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [terminalWizardOpen, setTerminalWizardOpen] = useState(false)
  const [wizardVariant, setWizardVariant] = useState<'terminal-bench' | 'program-bench' | 'swe-marathon' | 'terminal-bench-2_1'>('terminal-bench')
  const [wizardModalOpen, setWizardModalOpen] = useState(false)

  const runsQuery = useQuery({
    queryKey: ['benchmark-runs'],
    queryFn: async (): Promise<readonly BenchmarkRunSummary[]> => {
      const res = await fetch('/enhancement/action', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'run-registry-list' }),
      })
      const body = (await res.json().catch(() => null)) as
        | { runs?: BenchmarkRunSummary[]; error?: string }
        | null
      if (!res.ok) throw new Error(body?.error ?? `status ${res.status}`)
      return body?.runs ?? []
    },
    staleTime: 15_000,
  })
  const runs = runsQuery.data ?? []
  const loading = runsQuery.isFetching
  const error = runsQuery.error ? (runsQuery.error as Error).message : null

  const loadRuns = useCallback((): void => {
    void queryClient.invalidateQueries({ queryKey: ['benchmark-runs'] })
  }, [queryClient])

  const selectedRun = runs.find((r) => r.runId === selectedRunId) ?? null

  const openWizardModal = useCallback((): void => {
    setWizardModalOpen(true)
  }, [])

  return (
    <div className="flex h-full min-h-0 flex-col bg-background" data-testid="benchmarks-page">
      <header className="sticky top-0 z-20 flex flex-col gap-2 border-b border-border/60 bg-background/95 px-4 py-2 backdrop-blur sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-sm font-semibold" data-testid="benchmarks-page-title">
            {t('benchmarks.page.title')}
          </h1>
          <p className="text-xs text-muted-foreground">{t('benchmarks.page.subtitle')}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            className="h-7 rounded border border-border px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={() => { loadRuns() }}
            data-testid="benchmarks-page-refresh"
          >
            {t('benchmarks.runList.refresh')}
          </button>
          <button
            type="button"
            className="h-7 rounded bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90"
            onClick={openWizardModal}
            data-testid="benchmarks-page-new-run"
          >
            {t('benchmarks.page.newRun')}
          </button>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-hidden">
        <div className="grid h-full min-h-0 grid-cols-1 overflow-hidden md:grid-cols-[minmax(220px,0.85fr)_minmax(0,2.4fr)] xl:grid-cols-[minmax(240px,0.85fr)_minmax(0,2.2fr)_minmax(260px,0.8fr)]">
          <div className="min-h-0 border-b border-border/50 md:border-b-0 md:border-r">
            <RunListPanel
              runs={runs}
              loading={loading}
              error={error}
              selectedRunId={selectedRunId}
              onSelect={setSelectedRunId}
              onRefresh={() => { loadRuns() }}
            />
          </div>
          <div className="min-h-0 min-w-0 overflow-hidden">
            <RunDetailPanel run={selectedRun} />
          </div>
          <div className="min-h-0 border-t border-border/50 md:hidden xl:block xl:border-l xl:border-t-0">
            <RunLauncherPanel
              run={selectedRun}
              onLaunchSwebench={openWizardModal}
              onLaunchTerminalBench={() => { setWizardVariant('terminal-bench'); setTerminalWizardOpen(true) }}
              onLaunchTerminalBench21={() => { setWizardVariant('terminal-bench-2_1'); setTerminalWizardOpen(true) }}
              onLaunchProgramBench={() => { setWizardVariant('program-bench'); setTerminalWizardOpen(true) }}
              onLaunchSweMarathon={() => { setWizardVariant('swe-marathon'); setTerminalWizardOpen(true) }}
            />
          </div>
        </div>
      </div>
      <RunTerminalBenchWizard
        open={terminalWizardOpen}
        onOpenChange={setTerminalWizardOpen}
        variant={wizardVariant}
        onRunRegistered={(runId) => {
          setSelectedRunId(runId)
          loadRuns()
        }}
      />
      <RunBenchmarkWizardModal
        open={wizardModalOpen}
        onOpenChange={setWizardModalOpen}
        onCompleted={() => { loadRuns() }}
      />
    </div>
  )
}
