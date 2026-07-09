import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { BadCasesView } from '../artifacts/BadCasesView.js'
import { RunListPanel } from './RunListPanel.js'
import { RunDetailPanel } from './RunDetailPanel.js'
import { RunLauncherPanel } from './RunLauncherPanel.js'
import { RunTerminalBenchWizard } from './RunTerminalBenchWizard.js'
import { RunBenchmarkWizardModal } from './RunBenchmarkWizardModal.js'
import { EvalWorkspacePanel } from './EvalWorkspacePanel.js'
import type { BenchmarkRunSummary } from './types.js'

export function BenchmarksPage({
  onOpenSession,
}: {
  onOpenSession?(sessionId: string): void
}): JSX.Element {
  const { t } = useTranslation()
  const [runs, setRuns] = useState<readonly BenchmarkRunSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [terminalWizardOpen, setTerminalWizardOpen] = useState(false)
  const [wizardModalOpen, setWizardModalOpen] = useState(false)

  const loadRuns = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/enhancement/action', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'run-registry-list' }),
      })
      const body = (await res.json().catch(() => null)) as
        | { runs?: BenchmarkRunSummary[]; error?: string }
        | null
      if (!res.ok) throw new Error(body?.error ?? `status ${res.status}`)
      setRuns(body?.runs ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadRuns()
  }, [loadRuns])

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
              onRefresh={() => { void loadRuns() }}
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
          void loadRuns()
        }}
      />
      <RunBenchmarkWizardModal
        open={wizardModalOpen}
        onOpenChange={setWizardModalOpen}
        onCompleted={() => { void loadRuns() }}
      />
    </div>
  )
}
