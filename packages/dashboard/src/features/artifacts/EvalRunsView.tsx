import { useEffect, useState } from 'react'

import {
  EvalRunsView as EvalRunsViewInternal,
  ArtifactContentDialog,
  fetchArtifactContent,
  mergeEvalRuns,
  trialStableId,
  trialInstanceId,
  type ArtifactDetailRequest,
  type EvalComparisonRow,
  type EvalJudgeRow,
  type EvalJudgeTrace,
  type EvalProgressContentRow,
  type EvalRunComparison,
  type EvalRunProgress,
  type EvalRunRow,
  type EvalRunSummary,
  type EvalScoreRow,
  type EvalScoreSummary,
  type EvalSummaryContentRow,
  type EvalTrial,
  type EvalTrialRow,
  type EvalWorkerPlan,
  type EvalWorkerPlanRow,
} from './shared/internals.js'
import { useArtifactManifest } from './shared/useArtifactManifest.js'

export function EvalRunsView({
  onOpenSession,
}: {
  onOpenSession?(sessionId: string): void
} = {}): JSX.Element {
  const { manifest, loading, error, reload, reloadToken } = useArtifactManifest()
  const [evalRows, setEvalRows] = useState<readonly EvalRunRow[]>([])
  const [evalComparisons, setEvalComparisons] = useState<readonly EvalComparisonRow[]>([])
  const [evalScores, setEvalScores] = useState<readonly EvalScoreRow[]>([])
  const [evalJudges, setEvalJudges] = useState<readonly EvalJudgeRow[]>([])
  const [evalWorkerPlans, setEvalWorkerPlans] = useState<readonly EvalWorkerPlanRow[]>([])
  const [evalError, setEvalError] = useState<string | null>(null)
  const [selectedEvalRunPath, setSelectedEvalRunPath] = useState<string | null>(null)
  const [evalTrials, setEvalTrials] = useState<readonly EvalTrialRow[]>([])
  const [selectedTrialId, setSelectedTrialId] = useState<string | null>(null)
  const [evalTrialsLoading, setEvalTrialsLoading] = useState(false)
  const [evalTrialsError, setEvalTrialsError] = useState<string | null>(null)
  const [artifactDetail, setArtifactDetail] = useState<ArtifactDetailRequest | null>(null)

  useEffect(() => {
    if (!manifest) return
    const summaries = manifest.entries.filter((entry) => entry.kind === 'eval_summary' || entry.path.endsWith('/summary.json'))
    const progresses = manifest.entries.filter((entry) => entry.kind === 'eval_progress' || entry.path.endsWith('/progress.json'))
    const comparisons = manifest.entries.filter((entry) => entry.kind === 'eval_comparison' || entry.path.endsWith('/eval-comparison.json'))
    const workerPlans = manifest.entries.filter((entry) => entry.kind === 'eval_worker_plan' || entry.path.endsWith('/worker-plan.json'))
    const scores = manifest.entries.filter((entry) => entry.kind === 'eval_score' || entry.path.endsWith('/scores.json'))
    const judges = manifest.entries.filter((entry) => entry.kind === 'eval_judge' || entry.path.endsWith('/judge-trace.json'))
    let cancelled = false
    setEvalError(null)
    setEvalRows([])
    setEvalComparisons([])
    setEvalScores([])
    setEvalJudges([])
    setEvalWorkerPlans([])
    void Promise.all([
      Promise.all(summaries.map(async (entry): Promise<EvalSummaryContentRow> => {
        const content = await fetchArtifactContent(entry.path)
        return { path: entry.path, summary: content.body as EvalRunSummary }
      })),
      Promise.all(comparisons.map(async (entry): Promise<EvalComparisonRow> => {
        const content = await fetchArtifactContent(entry.path)
        return { path: entry.path, comparison: content.body as EvalRunComparison }
      })),
      Promise.all(progresses.map(async (entry): Promise<EvalProgressContentRow> => {
        const content = await fetchArtifactContent(entry.path)
        return { path: entry.path, progress: content.body as EvalRunProgress }
      })),
      Promise.all(workerPlans.map(async (entry): Promise<EvalWorkerPlanRow> => {
        const content = await fetchArtifactContent(entry.path)
        return { path: entry.path, plan: content.body as EvalWorkerPlan }
      })),
      Promise.all(scores.map(async (entry): Promise<EvalScoreRow> => {
        const content = await fetchArtifactContent(entry.path)
        return { path: entry.path, summary: content.body as EvalScoreSummary }
      })),
      Promise.all(judges.map(async (entry): Promise<EvalJudgeRow> => {
        const content = await fetchArtifactContent(entry.path)
        return { path: entry.path, trace: content.body as EvalJudgeTrace }
      })),
    ])
      .then(([summaryRows, comparisonRows, progressRows, workerPlanRows, scoreRows, judgeRows]) => {
        const rows = mergeEvalRuns(summaryRows, progressRows)
        if (cancelled) return
        setEvalRows(rows)
        setEvalComparisons(comparisonRows)
        setEvalWorkerPlans(workerPlanRows.sort((a, b) => a.path.localeCompare(b.path)))
        setEvalScores(scoreRows.sort((a, b) => a.path.localeCompare(b.path)))
        setEvalJudges(judgeRows.sort((a, b) => a.path.localeCompare(b.path)))
        setSelectedEvalRunPath((current) => current && rows.some((row) => row.key === current) ? current : rows[0]?.key ?? null)
      })
      .catch((err: unknown) => {
        if (!cancelled) setEvalError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [manifest, reloadToken])

  useEffect(() => {
    if (!manifest || !selectedEvalRunPath) {
      setEvalTrials([])
      setSelectedTrialId(null)
      setEvalTrialsError(null)
      setEvalTrialsLoading(false)
      return
    }
    const root = selectedEvalRunPath
    const trialEntries = manifest.entries.filter((entry) => entry.kind === 'eval_trial' && entry.path.startsWith(`${root}/trials/`))
    let cancelled = false
    setEvalTrialsLoading(true)
    setEvalTrialsError(null)
    void Promise.all(trialEntries.map(async (entry): Promise<EvalTrialRow> => {
      const content = await fetchArtifactContent(entry.path)
      return { path: entry.path, trial: content.body as EvalTrial }
    }))
      .then((rows) => {
        const sorted = rows.sort((a, b) => trialInstanceId(a).localeCompare(trialInstanceId(b)))
        if (cancelled) return
        setEvalTrials(sorted)
        setSelectedTrialId((current) => current && sorted.some((row) => trialStableId(row) === current) ? current : sorted[0] ? trialStableId(sorted[0]) : null)
      })
      .catch((err: unknown) => {
        if (!cancelled) setEvalTrialsError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setEvalTrialsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [manifest, selectedEvalRunPath])

  return (
    <>
      <div className="flex h-full min-h-0 flex-col" data-testid="eval-inline-panel">
        <EvalRunsViewInternal
          manifest={manifest}
          rows={evalRows}
          comparisons={evalComparisons}
          scores={evalScores}
          judges={evalJudges}
          workerPlans={evalWorkerPlans}
          selectedRunPath={selectedEvalRunPath}
          onSelectRun={setSelectedEvalRunPath}
          trials={evalTrials}
          selectedTrialId={selectedTrialId}
          onSelectTrial={setSelectedTrialId}
          trialsLoading={evalTrialsLoading}
          trialsError={evalTrialsError}
          error={error ?? evalError}
          loading={loading}
          onOpenArtifact={setArtifactDetail}
          onOpenSession={onOpenSession}
          onArtifactActionComplete={reload}
        />
      </div>
      <ArtifactContentDialog request={artifactDetail} onOpenChange={(nextOpen) => !nextOpen && setArtifactDetail(null)} />
    </>
  )
}
