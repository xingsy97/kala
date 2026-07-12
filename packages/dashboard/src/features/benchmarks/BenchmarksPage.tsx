import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import { BadCasesView } from '../artifacts/BadCasesView.js'
import { RunListPanel } from './RunListPanel.js'
import { RunDetailPanel } from './RunDetailPanel.js'
import { RunLauncherPanel } from './RunLauncherPanel.js'
import { RunTerminalBenchWizard } from './RunTerminalBenchWizard.js'
import { RunBenchmarkWizardModal } from './RunBenchmarkWizardModal.js'
import { EvalWorkspacePanel } from './EvalWorkspacePanel.js'
import { RlReadinessPanel } from './RlReadinessPanel.js'
import type { BenchmarkRunSummary } from './types.js'

export function BenchmarksPage({
  onOpenSession,
}: {
  onOpenSession?(sessionId: string): void
}): JSX.Element {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [terminalWizardOpen, setTerminalWizardOpen] = useState(false)
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
      <header className="sticky top-0 z-20 border-b border-border/60 bg-background/95 px-4 py-2 backdrop-blur">
        <h1 className="text-sm font-semibold" data-testid="benchmarks-page-title">
          {t('benchmarks.page.title')}
        </h1>
        <p className="text-xs text-muted-foreground">{t('benchmarks.page.subtitle')}</p>
      </header>
      <div className="flex-1 min-h-0 overflow-auto">
        <div className="grid min-h-[300px] grid-cols-[minmax(220px,1fr)_minmax(0,3fr)_minmax(240px,1fr)]">
          <div className="min-h-0 border-r border-border/50">
            <RunListPanel
              runs={runs}
              loading={loading}
              error={error}
              selectedRunId={selectedRunId}
              onSelect={setSelectedRunId}
              onRefresh={() => { loadRuns() }}
            />
          </div>
          <div className="min-h-0">
            <RunDetailPanel run={selectedRun} />
          </div>
          <div className="min-h-0 border-l border-border/50">
            <RunLauncherPanel
              onLaunchSwebench={openWizardModal}
              onLaunchTerminalBench={() => setTerminalWizardOpen(true)}
            />
          </div>
        </div>
        <section className="border-t border-border/60 min-h-[600px]" data-testid="eval-workspace-section">
          <EvalWorkspacePanel onOpenSession={onOpenSession} />
        </section>
        <RlReadinessPanel />
        <section className="border-t border-border/60 min-h-[420px]" data-testid="benchmarks-badcases-panel">
          <div className="border-b border-border/60 px-4 py-2">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('benchmarks.badcasesTitle')}
            </h2>
            <p className="text-[11px] text-muted-foreground">{t('benchmarks.badcasesSubtitle')}</p>
          </div>
          <BadCasesView />
        </section>
      </div>
      <RunTerminalBenchWizard
        open={terminalWizardOpen}
        onOpenChange={setTerminalWizardOpen}
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
