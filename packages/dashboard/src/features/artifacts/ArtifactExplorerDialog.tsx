import { useEffect, useMemo, useState, type FormEvent, type InputHTMLAttributes } from 'react'
import { CheckCircle2, Dices, FileText, RefreshCw, XCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '../../components/ui/button.js'
import { Input } from '../../components/ui/input.js'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog.js'
import { ScrollArea } from '../../components/ui/scroll-area.js'
import { JsonBlock } from '../../components/ui/json-block.js'
import { cn } from '../../lib/utils.js'

export type ArtifactManifestEntry = {
  path: string
  kind: string
  mediaType: string
  bytes: number
  mtime: string
  sha256?: string
  hashSkippedReason?: string
}

export type ArtifactManifest = {
  schemaVersion: 1
  generatedAt: string
  rootDir: string
  entries: ArtifactManifestEntry[]
  summary: {
    entryCount: number
    totalBytes: number
    hashedCount: number
    hashSkippedCount: number
    kinds: Record<string, number>
  }
}

type Props = {
  open: boolean
  initialMode?: ViewMode
  onOpenChange(open: boolean): void
  onOpenSession?(sessionId: string): void
}

type ViewMode = 'artifacts' | 'eval' | 'profiles' | 'memory' | 'ops'

type ArtifactContentResponse = {
  path: string
  mediaType: string
  body: unknown
}

type EvalRunSummary = {
  experimentId?: string
  dataset?: string
  model?: string
  trialCount?: number
  resolved?: number
  failed?: number
  timedOut?: number
  failureCounts?: Record<string, number>
  metrics?: Record<string, unknown>
  subagentUsage?: EvalSubAgentUsage
}

type EvalSubAgentUsage = {
  totalCount?: number
  trialsWithSubagents?: number
  maxDepth?: number
  perTrialMean?: number
  resolvedWithSubagents?: number
  unresolvedWithSubagents?: number
}

type EvalInstanceProgress = {
  instanceId?: string
  status?: string
  durationMs?: number
  failureLabel?: string
  artifactRefs?: readonly EvalTrialArtifactRef[]
  metrics?: Record<string, unknown>
}

type EvalRunProgress = {
  schemaVersion?: number
  runId?: string
  dataset?: string
  split?: string
  model?: string
  status?: string
  startedAt?: string
  updatedAt?: string
  finishedAt?: string
  selectedCount?: number
  queuedCount?: number
  runningCount?: number
  skippedCount?: number
  completedCount?: number
  failedCount?: number
  timedOutCount?: number
  maxWorkers?: number
  instances?: readonly EvalInstanceProgress[]
}

type EvalRunRow = {
  key: string
  root: string
  summaryPath?: string
  progressPath?: string
  summary?: EvalRunSummary
  progress?: EvalRunProgress
}

type EvalSummaryContentRow = {
  path: string
  summary: EvalRunSummary
}

type EvalProgressContentRow = {
  path: string
  progress: EvalRunProgress
}

type EvalTrialArtifactRef = {
  kind?: string
  uri?: string
  bytes?: number
  mediaType?: string
}

type EvalTrial = {
  trialId?: string
  experimentId?: string
  instanceId?: string
  sessionId?: string
  status?: string
  resolved?: boolean
  failureLabel?: string
  artifacts?: readonly EvalTrialArtifactRef[]
  metrics?: Record<string, unknown>
}

type EvalTrialRow = {
  path: string
  trial: EvalTrial
}

type EvalRunComparison = {
  baseline?: { experimentId?: string; resolved?: number; failed?: number; timedOut?: number }
  candidate?: { experimentId?: string; resolved?: number; failed?: number; timedOut?: number }
  deltas?: { resolved?: number; failed?: number; timedOut?: number; passRate?: number }
  failureDeltas?: Record<string, number>
  subagentUsageDelta?: {
    baseline: EvalSubAgentUsage | null
    candidate: EvalSubAgentUsage | null
    totalCount: number
    trialsWithSubagents: number
    maxDepth: number
    perTrialMean: number
    resolvedWithSubagents: number
    unresolvedWithSubagents: number
  }
}

type EvalComparisonRow = {
  path: string
  comparison: EvalRunComparison
}

type EvalScoreSummary = {
  instanceId?: string
  resolved?: boolean
  failureLabel?: string
  score?: number
  results?: readonly { scorer?: string; passed?: boolean; label?: string; score?: number; explanation?: string }[]
}

type EvalScoreRow = {
  path: string
  summary: EvalScoreSummary
}

type EvalJudgeTrace = {
  scorer?: string
  judgeModel?: string
  inputRef?: string
  parsed?: { score?: number; passed?: boolean; label?: string; explanation?: string }
}

type EvalJudgeRow = {
  path: string
  trace: EvalJudgeTrace
}

type EvalWorkerPlan = {
  runId?: string
  dataset?: string
  split?: string
  model?: string
  selectedCount?: number
  maxWorkers?: number
  shards?: readonly { workerId?: number; instanceCount?: number; instanceIds?: readonly string[] }[]
  resourceHints?: {
    dockerRequired?: boolean
    workspaceIsolation?: string
    maxConcurrentWorkspaces?: number
    repoCacheDir?: string
    timeoutMs?: number
  }
  warnings?: readonly string[]
}

type EvalWorkerPlanRow = {
  path: string
  plan: EvalWorkerPlan
}

type SweBenchPlanResponse = {
  planPath?: string
  registryPath?: string
  runId?: string
  selectedCount?: number
  maxWorkers?: number
  shardCount?: number
  warnings?: readonly string[]
}

type EnhancementActionResponse = Record<string, unknown> & { action?: string; error?: string }

type TextEnhancementActionField = {
  kind?: 'text'
  key: string
  label: string
  placeholder?: string
  required?: boolean
  defaultValue?: string
  numeric?: boolean
  boolean?: boolean
  list?: boolean
}

type UploadEnhancementActionField = {
  kind: 'upload'
  key: string
  label: string
  contentKey: string
  accept?: string
  maxBytes?: number
  placeholder?: string
  required?: boolean
}

type SessionEnhancementActionField = {
  kind: 'session'
  key: string
  label: string
  contentKey?: string
  required?: boolean
  placeholder?: string
}

type EnhancementActionField =
  | TextEnhancementActionField
  | UploadEnhancementActionField
  | SessionEnhancementActionField

type EnhancementActionConfig = {
  action: string
  label: string
  fields: readonly EnhancementActionField[]
}

type SessionProfile = {
  sessionId?: string
  llmCalls?: number
  toolCalls?: number
  failedToolResults?: number
  llmTraceMissingCalls?: number
  totalInputTokens?: number
  totalOutputTokens?: number
  totalCacheReadTokens?: number
  totalCacheCreationTokens?: number
  models?: readonly string[]
  wallTimeMs?: number
  llmLatencyCalls?: number
  averageLlmDurationMs?: number
  p95LlmDurationMs?: number
  averageTimeToFirstChunkMs?: number
  p95TimeToFirstChunkMs?: number
}

type ProfileRow = {
  path: string
  profile: SessionProfile
}

type MemoryIndexEntry = {
  scope?: 'workspace' | 'global'
  key?: string
  path?: string
  bytes?: number
  status?: 'active' | 'tombstoned'
  name?: string
  description?: string
  type?: string
  source?: string
  confidence?: number
  generatedAt?: string
  sessionId?: string
  deletedAt?: string
  archivedPath?: string
}

type MemoryStaleWarning = {
  scope?: 'workspace' | 'global'
  key?: string
  path?: string
  generatedAt?: string
  ageDays?: number
  reasonCode?: string
}

type MemoryConflictWarning = {
  reasonCode?: string
  key?: string
  name?: string
  entries?: readonly { scope?: string; key?: string; path?: string }[]
}

type MemoryIndex = {
  generatedAt?: string
  entries?: readonly MemoryIndexEntry[]
  warnings?: readonly string[]
  staleWarnings?: readonly MemoryStaleWarning[]
  conflictWarnings?: readonly MemoryConflictWarning[]
}

type MemoryIndexRow = {
  path: string
  index: MemoryIndex
}

type OpsArtifactKind =
  | 'reliability_audit'
  | 'reliability_chaos'
  | 'rl_rollout_sidecar'
  | 'rl_token_segments'
  | 'rl_adapter'
  | 'subagent_graph'
  | 'trace'
  | 'message_assembly'
  | 'router_decision'
  | 'tool_catalog'

type OpsArtifactRow = {
  path: string
  kind: OpsArtifactKind
  body: Record<string, unknown>
}

type ArtifactDetailRequest = {
  path: string
  label: string
}

type TrialArtifactItem = {
  artifact: EvalTrialArtifactRef
  category: TrialArtifactCategory
  path: string | null
  title: string
  meta: string
}

type TrialArtifactCategory = 'patch' | 'trace' | 'harness' | 'log' | 'prompt' | 'metadata' | 'other'

type TrialArtifactGroup = {
  category: TrialArtifactCategory
  label: string
  items: readonly TrialArtifactItem[]
}

export function ArtifactExplorerDialog({ open, initialMode = 'artifacts', onOpenChange, onOpenSession }: Props): JSX.Element {
  const { t } = useTranslation()
  const [manifest, setManifest] = useState<ArtifactManifest | null>(null)
  const [mode, setMode] = useState<ViewMode>(initialMode)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reloadToken, setReloadToken] = useState(0)
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
  const [profileRows, setProfileRows] = useState<readonly ProfileRow[]>([])
  const [profileError, setProfileError] = useState<string | null>(null)
  const [memoryRows, setMemoryRows] = useState<readonly MemoryIndexRow[]>([])
  const [memoryError, setMemoryError] = useState<string | null>(null)
  const [opsRows, setOpsRows] = useState<readonly OpsArtifactRow[]>([])
  const [opsError, setOpsError] = useState<string | null>(null)
  const [artifactDetail, setArtifactDetail] = useState<ArtifactDetailRequest | null>(null)

  useEffect(() => {
    if (!open) return
    setMode(initialMode)
    let cancelled = false
    setLoading(true)
    setError(null)
    void fetch('/artifacts/manifest', { cache: 'no-store' })
      .then(async (res) => {
        if (res.ok) return (await res.json()) as ArtifactManifest
        const body = await res.json().catch(() => null) as { error?: string } | null
        throw new Error(body?.error ?? `artifact manifest request failed: ${res.status}`)
      })
      .then((next) => {
        if (cancelled) return
        setManifest(next)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
        setManifest(null)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, initialMode, reloadToken])

  const kindRows = useMemo(() => {
    if (!manifest) return []
    return Object.entries(manifest.summary.kinds).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  }, [manifest])

  useEffect(() => {
    if (!open || mode !== 'eval' || !manifest) return
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
        if (!cancelled) setEvalRows(rows)
        if (!cancelled) setEvalComparisons(comparisonRows)
        if (!cancelled) setEvalWorkerPlans(workerPlanRows.sort((a, b) => a.path.localeCompare(b.path)))
        if (!cancelled) setEvalScores(scoreRows.sort((a, b) => a.path.localeCompare(b.path)))
        if (!cancelled) setEvalJudges(judgeRows.sort((a, b) => a.path.localeCompare(b.path)))
        if (!cancelled) setSelectedEvalRunPath((current) => current && rows.some((row: EvalRunRow) => row.key === current) ? current : rows[0]?.key ?? null)
      })
      .catch((err: unknown) => {
        if (!cancelled) setEvalError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [open, mode, manifest])

  useEffect(() => {
    if (!open || mode !== 'eval' || !manifest || !selectedEvalRunPath) {
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
  }, [open, mode, manifest, selectedEvalRunPath])

  useEffect(() => {
    if (!open || mode !== 'profiles' || !manifest) return
    const profiles = manifest.entries.filter((entry) => entry.kind === 'profile' || entry.path.endsWith('/profile.json'))
    let cancelled = false
    setProfileError(null)
    setProfileRows([])
    void Promise.all(profiles.map(async (entry): Promise<ProfileRow> => {
      const content = await fetchArtifactContent(entry.path)
      return { path: entry.path, profile: content.body as SessionProfile }
    }))
      .then((rows) => {
        if (!cancelled) setProfileRows(rows.sort((a, b) => a.path.localeCompare(b.path)))
      })
      .catch((err: unknown) => {
        if (!cancelled) setProfileError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [open, mode, manifest])

  useEffect(() => {
    if (!open || mode !== 'memory' || !manifest) return
    const memoryIndexes = manifest.entries.filter((entry) => entry.kind === 'memory_index' || entry.path.endsWith('/memory-index.json'))
    let cancelled = false
    setMemoryError(null)
    setMemoryRows([])
    void Promise.all(memoryIndexes.map(async (entry): Promise<MemoryIndexRow> => {
      const content = await fetchArtifactContent(entry.path)
      return { path: entry.path, index: content.body as MemoryIndex }
    }))
      .then((rows) => {
        if (!cancelled) setMemoryRows(rows.sort((a, b) => a.path.localeCompare(b.path)))
      })
      .catch((err: unknown) => {
        if (!cancelled) setMemoryError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [open, mode, manifest])

  useEffect(() => {
    if (!open || mode !== 'ops' || !manifest) return
    const opsArtifacts = manifest.entries.filter((entry) => isOpsArtifactKind(entry.kind))
    let cancelled = false
    setOpsError(null)
    setOpsRows([])
    void Promise.all(opsArtifacts.map(async (entry): Promise<OpsArtifactRow> => {
      const content = await fetchArtifactContent(entry.path)
      return { path: entry.path, kind: entry.kind as OpsArtifactKind, body: asRecord(content.body) }
    }))
      .then((rows) => {
        if (!cancelled) setOpsRows(rows.sort((a, b) => opsKindOrder(a.kind) - opsKindOrder(b.kind) || a.path.localeCompare(b.path)))
      })
      .catch((err: unknown) => {
        if (!cancelled) setOpsError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [open, mode, manifest])

  return (
    <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(760px,86dvh)] w-[min(1040px,94vw)] max-w-none flex-col overflow-hidden p-0 gap-0" data-testid="artifact-dialog">
        <DialogHeader className="border-b border-border px-4 py-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <DialogTitle>{t(`artifacts.modes.${mode}`)}</DialogTitle>
              <DialogDescription>{mode === 'eval' ? t('artifacts.descriptions.eval') : mode === 'ops' ? t('artifacts.descriptions.ops') : t('artifacts.descriptions.default')}</DialogDescription>
            </div>
            <div className="flex items-center gap-2">
              <div className="inline-flex rounded-md border border-border bg-muted/30 p-0.5 text-xs">
                <button type="button" className={tabClass(mode === 'artifacts')} onClick={() => setMode('artifacts')} data-testid="artifact-mode-artifacts">{t('artifacts.modes.artifacts')}</button>
                <button type="button" className={tabClass(mode === 'eval')} onClick={() => setMode('eval')} data-testid="artifact-mode-eval">{t('artifacts.modes.eval')}</button>
                <button type="button" className={tabClass(mode === 'profiles')} onClick={() => setMode('profiles')} data-testid="artifact-mode-profiles">{t('artifacts.modes.profiles')}</button>
                <button type="button" className={tabClass(mode === 'memory')} onClick={() => setMode('memory')} data-testid="artifact-mode-memory">{t('artifacts.modes.memory')}</button>
                <button type="button" className={tabClass(mode === 'ops')} onClick={() => setMode('ops')} data-testid="artifact-mode-ops">{t('artifacts.modes.ops')}</button>
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setReloadToken((value) => value + 1)}
                disabled={loading}
              >
                <RefreshCw className={cn('mr-2 h-3.5 w-3.5', loading && 'animate-spin')} aria-hidden="true" />
                Refresh
              </Button>
            </div>
          </div>
        </DialogHeader>
        {mode === 'artifacts' ? (
          <ArtifactInventory manifest={manifest} kindRows={kindRows} error={error} loading={loading} />
        ) : mode === 'eval' ? (
          <EvalRunsView
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
            onArtifactActionComplete={() => setReloadToken((token) => token + 1)}
          />
        ) : mode === 'profiles' ? (
          <ProfilesView
            manifest={manifest}
            rows={profileRows}
            error={error ?? profileError}
            loading={loading}
            onArtifactActionComplete={() => setReloadToken((token) => token + 1)}
          />
        ) : mode === 'memory' ? (
          <MemoryView
            manifest={manifest}
            rows={memoryRows}
            error={error ?? memoryError}
            loading={loading}
            onArtifactActionComplete={() => setReloadToken((token) => token + 1)}
          />
        ) : (
          <OpsView
            manifest={manifest}
            rows={opsRows}
            error={error ?? opsError}
            loading={loading}
            onOpenArtifact={setArtifactDetail}
            onArtifactActionComplete={() => setReloadToken((token) => token + 1)}
          />
        )}
      </DialogContent>
    </Dialog>
    <ArtifactContentDialog request={artifactDetail} onOpenChange={(nextOpen) => !nextOpen && setArtifactDetail(null)} />
    </>
  )
}

function ArtifactInventory({
  manifest,
  kindRows,
  error,
  loading,
}: {
  manifest: ArtifactManifest | null
  kindRows: readonly [string, number][]
  error: string | null
  loading: boolean
}): JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="grid min-h-0 flex-1 grid-cols-[260px_minmax(0,1fr)] gap-0 max-md:grid-cols-1">
          <aside className="min-h-0 border-r border-border bg-muted/25 p-3 max-md:border-b max-md:border-r-0">
            {manifest ? (
              <div className="grid gap-2 text-xs">
                <Stat label={t('artifacts.inventory.files')} value={String(manifest.summary.entryCount)} />
                <Stat label={t('artifacts.inventory.bytes')} value={formatBytes(manifest.summary.totalBytes)} />
                <Stat label={t('artifacts.inventory.hashed')} value={`${manifest.summary.hashedCount}/${manifest.summary.entryCount}`} />
                <div className="mt-2 rounded-md border border-border bg-background/70 p-2">
                  <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t('artifacts.inventory.kinds')}</div>
                  <div className="grid gap-1">
                    {kindRows.map(([kind, count]) => (
                      <div key={kind} className="flex items-center justify-between gap-2 font-mono text-[11px]">
                        <span className="truncate">{kind}</span>
                        <span className="text-muted-foreground">{count}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ) : (
              <div className="text-xs text-muted-foreground">{t('artifacts.inventory.noManifest')}</div>
            )}
          </aside>
          <div className="min-h-0 p-3">
            {error ? (
              <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
                {error}
              </div>
            ) : null}
            {loading && !manifest ? (
              <div className="text-xs text-muted-foreground">{t('artifacts.inventory.loadingManifest')}</div>
            ) : null}
            {manifest ? (
              <ScrollArea className="h-full rounded-md border border-border">
                <div className="min-w-[720px] divide-y divide-border text-xs">
                  <div className="grid grid-cols-[1.4fr_150px_100px_170px] gap-3 bg-muted/40 px-3 py-2 font-medium text-muted-foreground">
                    <div>{t('artifacts.inventory.path')}</div>
                    <div>{t('artifacts.inventory.kind')}</div>
                    <div>{t('artifacts.inventory.size')}</div>
                    <div>{t('artifacts.inventory.integrity')}</div>
                  </div>
                  {manifest.entries.map((entry) => (
                    <div key={entry.path} className="grid grid-cols-[1.4fr_150px_100px_170px] gap-3 px-3 py-2">
                      <div className="min-w-0">
                        <div className="truncate font-mono text-[11px]" title={entry.path}>{entry.path}</div>
                        <div className="mt-0.5 text-[11px] text-muted-foreground">{entry.mediaType}</div>
                      </div>
                      <div className="font-mono text-[11px] text-muted-foreground">{entry.kind}</div>
                      <div className="font-mono text-[11px]">{formatBytes(entry.bytes)}</div>
                      <div className="min-w-0 font-mono text-[11px] text-muted-foreground">
                        {entry.sha256 ? (
                          <span title={entry.sha256}>{entry.sha256.slice(0, 12)}</span>
                        ) : (
                          <span title={entry.hashSkippedReason}>{t('artifacts.inventory.hashSkipped')}</span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            ) : null}
          </div>
        </div>
  )
}

function EvalRunsView({
  manifest,
  rows,
  comparisons,
  scores,
  judges,
  workerPlans,
  selectedRunPath,
  onSelectRun,
  trials,
  selectedTrialId,
  onSelectTrial,
  trialsLoading,
  trialsError,
  error,
  loading,
  onOpenArtifact,
  onOpenSession,
  onArtifactActionComplete,
}: {
  manifest: ArtifactManifest | null
  rows: readonly EvalRunRow[]
  comparisons: readonly EvalComparisonRow[]
  scores: readonly EvalScoreRow[]
  judges: readonly EvalJudgeRow[]
  workerPlans: readonly EvalWorkerPlanRow[]
  selectedRunPath: string | null
  onSelectRun(path: string): void
  trials: readonly EvalTrialRow[]
  selectedTrialId: string | null
  onSelectTrial(id: string): void
  trialsLoading: boolean
  trialsError: string | null
  error: string | null
  loading: boolean
  onOpenArtifact(request: ArtifactDetailRequest): void
  onOpenSession?(sessionId: string): void
  onArtifactActionComplete(): void
}): JSX.Element {
  const { t } = useTranslation()
  const comparisonCount = comparisons.length
  const selectedRun = rows.find((row) => row.key === selectedRunPath)
  const selectedTrial = trials.find((row) => trialStableId(row) === selectedTrialId)
  return (
    <div className="grid min-h-0 flex-1 grid-cols-[260px_minmax(0,1fr)] gap-0 max-md:grid-cols-1">
      <aside className="min-h-0 border-r border-border bg-muted/25 p-3 max-md:border-b max-md:border-r-0">
        <div className="grid gap-2 text-xs">
          <Stat label={t('artifacts.eval.runs')} value={String(rows.length)} />
          <Stat label={t('artifacts.eval.trials')} value={String(trials.length)} />
          <Stat label={t('artifacts.eval.comparisons')} value={String(comparisonCount)} />
          <Stat label={t('artifacts.eval.workerPlans')} value={String(workerPlans.length)} />
          <Stat label={t('artifacts.eval.scores')} value={String(scores.length)} />
          <Stat label={t('artifacts.eval.judges')} value={String(judges.length)} />
          <Stat label={t('common.artifacts')} value={String(manifest?.summary.entryCount ?? 0)} />
        </div>
      </aside>
      <div className="grid min-h-0 grid-rows-[minmax(150px,0.55fr)_auto_auto_minmax(220px,1fr)_auto_auto] gap-3 overflow-y-auto p-3 max-lg:grid-rows-none" data-testid="eval-right-pane">
        {error ? (
          <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
            {error}
          </div>
        ) : null}
        {loading && !manifest ? <div className="text-xs text-muted-foreground">{t('artifacts.inventory.loadingManifest')}</div> : null}
        {manifest && rows.length === 0 && comparisons.length === 0 && !error ? <div className="text-xs text-muted-foreground">{t('artifacts.eval.noSummaries')}</div> : null}
        <EvalScorecard rows={rows} selectedRun={selectedRun} />
        <RunBenchmarkWizard onArtifactActionComplete={onArtifactActionComplete} />
        <EnhancementActionPanel title={t('artifacts.eval.actions')} actions={evalActionConfigs} onComplete={onArtifactActionComplete} />
        <div className="min-h-0 overflow-hidden rounded-md border border-border">
          {rows.length > 0 ? (
          <ScrollArea className="h-full">
            <div className="min-w-[760px] divide-y divide-border text-xs">
              <div className="grid grid-cols-[1.15fr_1fr_120px_90px_90px_90px_90px] gap-3 bg-muted/40 px-3 py-2 font-medium text-muted-foreground">
                <div>{t('artifacts.eval.columns.run')}</div>
                <div>{t('artifacts.eval.columns.dataset')}</div>
                <div>{t('artifacts.eval.columns.model')}</div>
                <div>{t('artifacts.eval.columns.trials')}</div>
                <div>{t('artifacts.eval.columns.resolved')}</div>
                <div>{t('artifacts.eval.columns.failed')}</div>
                <div>{t('artifacts.eval.columns.passRate')}</div>
              </div>
              {rows.map((row) => (
                <button
                  key={row.key}
                  type="button"
                  className={cn(
                    'grid w-full grid-cols-[1.15fr_1fr_120px_90px_90px_90px_90px] gap-3 px-3 py-2 text-left transition-colors hover:bg-muted/30',
                    selectedRunPath === row.key && 'bg-primary/10 dark:bg-primary/10',
                  )}
                  onClick={() => onSelectRun(row.key)}
                >
                  <div className="min-w-0">
                    <div className="truncate font-mono text-[11px]">{row.summary?.experimentId ?? row.progress?.runId ?? row.key}</div>
                  </div>
                  <div className="truncate">{row.summary?.dataset ?? row.progress?.dataset ?? 'unknown'}</div>
                  <div className="truncate font-mono text-[11px] text-muted-foreground">{row.summary?.model ?? row.progress?.model ?? 'unknown'}</div>
                  <div className="font-mono text-[11px]">{row.summary?.trialCount ?? row.progress?.selectedCount ?? 0}</div>
                  <div className="font-mono text-[11px]">{row.summary?.resolved ?? 0}</div>
                  <div className="font-mono text-[11px]">{row.summary?.failed ?? row.progress?.failedCount ?? 0}</div>
                  <div className="font-mono text-[11px]">{formatPercent(row.summary?.metrics?.passRate)}</div>
                </button>
              ))}
            </div>
          </ScrollArea>
          ) : null}
        </div>
        {selectedRun ? (
          <div className="contents" key={selectedRun.key}>
          <EvalProgressStrip run={selectedRun} />
          <FailureBreakdown run={selectedRun} />
          <SubAgentUsagePanel run={selectedRun} />
          <EvalTrialDetail
            run={selectedRun}
            trials={trials}
            selectedTrial={selectedTrial}
            selectedTrialId={selectedTrialId}
            onSelectTrial={onSelectTrial}
            loading={trialsLoading}
            error={trialsError}
            onOpenArtifact={onOpenArtifact}
            onOpenSession={onOpenSession}
          />
          </div>
        ) : null}
        {comparisons.length > 0 ? (
          <div className="min-h-0 rounded-md border border-border">
            <div className="border-b border-border bg-muted/40 px-3 py-2 text-xs font-medium text-muted-foreground">{t('artifacts.eval.comparisons')}</div>
            <div className="max-h-48 divide-y divide-border overflow-auto text-xs">
              {comparisons.map((row) => (
                <div key={row.path} className="grid gap-2 px-3 py-2">
                  <div className="grid grid-cols-[1fr_1fr_90px_90px_90px_90px_minmax(150px,0.7fr)] gap-3 max-lg:grid-cols-[1fr_1fr_80px_80px]">
                    <div className="min-w-0">
                      <div className="truncate font-mono text-[11px]">{row.comparison.baseline?.experimentId ?? 'baseline'}</div>
                      <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{row.path}</div>
                    </div>
                    <div className="truncate font-mono text-[11px]">{row.comparison.candidate?.experimentId ?? 'candidate'}</div>
                    <Delta label="resolved" value={row.comparison.deltas?.resolved} />
                    <Delta label="failed" value={row.comparison.deltas?.failed} invert />
                    <Delta label="timeout" value={row.comparison.deltas?.timedOut} invert />
                    <Delta label="pass" value={row.comparison.deltas?.passRate} percent />
                    <FailureDeltaChips deltas={row.comparison.failureDeltas} />
                  </div>
                  <ComparisonDeltaBars comparison={row.comparison} />
                  <SubAgentUsageDeltaPanel delta={row.comparison.subagentUsageDelta} />
                </div>
              ))}
            </div>
          </div>
        ) : null}
        {workerPlans.length > 0 ? (
          <EvalWorkerPlansPanel plans={workerPlans} onOpenArtifact={onOpenArtifact} />
        ) : null}
        {scores.length > 0 || judges.length > 0 ? (
          <EvalScoresPanel scores={scores} judges={judges} onOpenArtifact={onOpenArtifact} />
        ) : null}
      </div>
    </div>
  )
}

type WizardStepId = 'plan' | 'infer' | 'grade' | 'ingest' | 'review'

type WizardStepStatus = 'idle' | 'active' | 'done' | 'error'

type WizardStepState = {
  status: WizardStepStatus
  message?: string
}

type WizardShared = {
  runId: string
  dataset: string
  split: string
  model: string
  instancesJsonl: string
  patchesDir: string
  predictionsPath: string
  resultsDir: string
  maxWorkers: string
  agentCommand: string
}

function initialWizardShared(): WizardShared {
  return {
    runId: '',
    dataset: 'princeton-nlp/SWE-bench_Lite',
    split: 'test',
    model: '',
    instancesJsonl: '',
    patchesDir: '',
    predictionsPath: '',
    resultsDir: '',
    maxWorkers: '1',
    agentCommand: '',
  }
}

type PlanCounts = { instances: number; shards: number }
type InferCounts = { total: number; completed: number; failed: number; errored: number }
type IngestCounts = { total: number; resolved: number }

const DEFAULT_AGENT_COMMAND = 'claude --dangerously-skip-permissions --print "$(cat "$AGENT_KERNEL_SWEBENCH_PROMPT_FILE")"'

const WIZARD_STEPS: readonly { id: WizardStepId; label: string }[] = [
  { id: 'plan', label: 'Plan' },
  { id: 'infer', label: 'Predictions' },
  { id: 'grade', label: 'Grade' },
  { id: 'ingest', label: 'Ingest' },
  { id: 'review', label: 'Review' },
]

function RunBenchmarkWizard({ onArtifactActionComplete }: { onArtifactActionComplete(): void }): JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [shared, setShared] = useState<WizardShared>(initialWizardShared)
  const [current, setCurrent] = useState<WizardStepId>('plan')
  const [stepState, setStepState] = useState<Record<WizardStepId, WizardStepState>>({
    plan: { status: 'active' },
    infer: { status: 'idle' },
    grade: { status: 'idle' },
    ingest: { status: 'idle' },
    review: { status: 'idle' },
  })
  const [gradeCommand, setGradeCommand] = useState<string | null>(null)
  const [planPath, setPlanPath] = useState<string | null>(null)
  const [registryPath, setRegistryPath] = useState<string | null>(null)
  const [ingestSummary, setIngestSummary] = useState<string | null>(null)
  const [planCounts, setPlanCounts] = useState<PlanCounts | null>(null)
  const [inferCounts, setInferCounts] = useState<InferCounts | null>(null)
  const [inferProgress, setInferProgress] = useState<{ completed: number; total: number; current?: string } | null>(null)
  const [ingestCounts, setIngestCounts] = useState<IngestCounts | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const currentIndex = WIZARD_STEPS.findIndex((step) => step.id === current)

  function markStep(step: WizardStepId, next: WizardStepState): void {
    setStepState((prev) => ({ ...prev, [step]: next }))
  }

  function goto(step: WizardStepId): void {
    setCurrent(step)
    markStep(step, { status: 'active', message: stepState[step].message })
  }

  function advance(from: WizardStepId, message?: string): void {
    markStep(from, { status: 'done', message })
    const nextIndex = WIZARD_STEPS.findIndex((step) => step.id === from) + 1
    const next = WIZARD_STEPS[nextIndex]
    if (next) {
      setCurrent(next.id)
      markStep(next.id, { status: 'active' })
    }
  }

  async function submitPlan(): Promise<void> {
    if (!shared.runId.trim() || !shared.model.trim() || !shared.instancesJsonl.trim()) {
      setError('Run ID, Model, and Instances JSONL are required.')
      markStep('plan', { status: 'error', message: 'missing required fields' })
      return
    }
    setSubmitting(true)
    setError(null)
    const payload = compactFormPayload({
      runId: shared.runId,
      dataset: shared.dataset,
      split: shared.split,
      model: shared.model,
      instancesJsonl: shared.instancesJsonl,
      maxWorkers: shared.maxWorkers,
    })
    try {
      const res = await fetch('/eval/swebench/plan', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const body = await res.json().catch(() => null) as (SweBenchPlanResponse & { error?: string }) | null
      if (!res.ok) throw new Error(body?.error ?? `SWE-bench plan failed: ${res.status}`)
      const path = body?.planPath ?? null
      setPlanPath(path)
      setRegistryPath(body?.registryPath ?? null)
      const instances = typeof body?.selectedCount === 'number' ? body.selectedCount : 0
      const shards = typeof body?.shardCount === 'number' ? body.shardCount : 0
      setPlanCounts({ instances, shards })
      onArtifactActionComplete()
      advance('plan', t('artifacts.eval.wizard.planReady', { instances, shards }))
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      markStep('plan', { status: 'error', message })
    } finally {
      setSubmitting(false)
    }
  }

  async function submitInfer(): Promise<void> {
    const agentCommand = shared.agentCommand.trim()
    setSubmitting(true)
    setError(null)
    setInferProgress({ completed: 0, total: planCounts?.instances ?? 0 })
    const payload: Record<string, unknown> = {
      action: 'swebench-run-agent-infer',
      runId: shared.runId.trim(),
      dataset: shared.dataset.trim(),
      model: shared.model.trim(),
    }
    if (agentCommand) payload.agentCommand = agentCommand
    if (shared.split.trim()) payload.split = shared.split.trim()
    if (shared.maxWorkers.trim()) payload.maxWorkers = Number(shared.maxWorkers.trim())
    const runId = shared.runId.trim()
    let cancelled = false
    async function pollProgress(): Promise<void> {
      while (!cancelled) {
        try {
          const res = await fetch('/enhancement/action', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'swebench-read-progress', runId }),
          })
          if (res.ok) {
            const parsed = await res.json().catch(() => null) as { total?: number; completed?: number; currentInstance?: string; status?: string } | null
            if (parsed) {
              setInferProgress({
                completed: parsed.completed ?? 0,
                total: parsed.total ?? planCounts?.instances ?? 0,
                ...(parsed.currentInstance ? { current: parsed.currentInstance } : {}),
              })
              if (parsed.status === 'completed' || parsed.status === 'failed') break
            }
          }
        } catch {
          // best-effort poll; ignore transient errors
        }
        await new Promise((resolve) => setTimeout(resolve, 1500))
      }
    }
    const pollTask = pollProgress()
    try {
      const res = await fetch('/enhancement/action', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const body = await res.json().catch(() => null) as EnhancementActionResponse | null
      if (!res.ok) throw new Error(body?.error ?? `predictions run failed: ${res.status}`)
      const completed = typeof body?.passed === 'number' ? body.passed : 0
      const failed = typeof body?.failed === 'number' ? body.failed : 0
      const errored = typeof body?.errored === 'number' ? body.errored : 0
      const total = typeof body?.totalInstances === 'number' ? body.totalInstances : completed + failed + errored
      const predictionsPath = typeof body?.predictionsPath === 'string' ? body.predictionsPath : ''
      if (predictionsPath) setShared((prev) => ({ ...prev, predictionsPath }))
      setInferCounts({ total, completed, failed, errored })
      onArtifactActionComplete()
      advance('infer', t('artifacts.eval.wizard.inferReady', { completed, failed, errored, total }))
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      markStep('infer', { status: 'error', message })
    } finally {
      cancelled = true
      await pollTask
      setSubmitting(false)
    }
  }

  async function submitInferUpload(): Promise<void> {
    if (!shared.patchesDir.trim()) {
      setError(t('artifacts.eval.wizard.errorPatchesRequired'))
      markStep('infer', { status: 'error', message: 'missing patches' })
      return
    }
    setSubmitting(true)
    setError(null)
    const payload: Record<string, unknown> = {
      action: 'swebench-infer-patches',
      runId: shared.runId.trim(),
      dataset: shared.dataset.trim(),
      model: shared.model.trim(),
      instancesJsonl: shared.instancesJsonl.trim(),
      patchesDir: shared.patchesDir.trim(),
    }
    if (shared.split.trim()) payload.split = shared.split.trim()
    try {
      const res = await fetch('/enhancement/action', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const body = await res.json().catch(() => null) as EnhancementActionResponse | null
      if (!res.ok) throw new Error(body?.error ?? `predictions inference failed: ${res.status}`)
      const predictionsPath = typeof body?.predictionsPath === 'string' ? body.predictionsPath : ''
      if (predictionsPath) setShared((prev) => ({ ...prev, predictionsPath }))
      const trialCount = typeof body?.trialCount === 'number' ? body.trialCount : 0
      setInferCounts({ total: trialCount, completed: trialCount, failed: 0, errored: 0 })
      onArtifactActionComplete()
      advance('infer', t('artifacts.eval.wizard.inferUploadReady', { count: trialCount }))
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      markStep('infer', { status: 'error', message })
    } finally {
      setSubmitting(false)
    }
  }

  async function submitGrade(): Promise<void> {
    setSubmitting(true)
    setError(null)
    const payload: Record<string, unknown> = {
      action: 'swebench-grade-command',
      runId: shared.runId.trim(),
      dataset: shared.dataset.trim(),
    }
    if (shared.predictionsPath.trim()) payload.predictionsPath = shared.predictionsPath.trim()
    if (shared.maxWorkers.trim()) payload.maxWorkers = Number(shared.maxWorkers.trim())
    try {
      const res = await fetch('/enhancement/action', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const body = await res.json().catch(() => null) as EnhancementActionResponse | null
      if (!res.ok) throw new Error(body?.error ?? `grade command generation failed: ${res.status}`)
      const command = typeof body?.shellCommand === 'string' ? body.shellCommand : ''
      const resultsDir = typeof body?.resultsDir === 'string' ? body.resultsDir : ''
      setGradeCommand(command || null)
      if (resultsDir) setShared((prev) => ({ ...prev, resultsDir }))
      onArtifactActionComplete()
      markStep('grade', {
        status: 'done',
        message: command ? t('artifacts.eval.wizard.gradeReady') : t('artifacts.eval.wizard.gradeCommandGenerated'),
      })
      markStep('ingest', { status: stepState.ingest.status === 'idle' ? 'idle' : stepState.ingest.status })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      markStep('grade', { status: 'error', message })
    } finally {
      setSubmitting(false)
    }
  }

  async function submitIngest(): Promise<void> {
    setSubmitting(true)
    setError(null)
    const payload: Record<string, unknown> = {
      action: 'swebench-ingest-results',
      runId: shared.runId.trim(),
    }
    if (shared.resultsDir.trim()) payload.resultsDir = shared.resultsDir.trim()
    try {
      const res = await fetch('/enhancement/action', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const body = await res.json().catch(() => null) as EnhancementActionResponse | null
      if (!res.ok) throw new Error(body?.error ?? `ingest failed: ${res.status}`)
      const summaryPath = typeof body?.summaryPath === 'string' ? body.summaryPath : ''
      const trialCount = typeof body?.trialCount === 'number' ? body.trialCount : 0
      const resolved = typeof body?.resolved === 'number' ? body.resolved : 0
      setIngestSummary(summaryPath || null)
      setIngestCounts({ total: trialCount, resolved })
      onArtifactActionComplete()
      advance('ingest', t('artifacts.eval.wizard.ingestReady', { resolved, total: trialCount }))
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      markStep('ingest', { status: 'error', message })
    } finally {
      setSubmitting(false)
    }
  }

  function reset(): void {
    setShared(initialWizardShared())
    setStepState({
      plan: { status: 'active' },
      infer: { status: 'idle' },
      grade: { status: 'idle' },
      ingest: { status: 'idle' },
      review: { status: 'idle' },
    })
    setCurrent('plan')
    setGradeCommand(null)
    setPlanPath(null)
    setRegistryPath(null)
    setIngestSummary(null)
    setPlanCounts(null)
    setInferCounts(null)
    setInferProgress(null)
    setIngestCounts(null)
    setError(null)
  }

  return (
    <div className="mb-3 rounded-md border border-border bg-background/70" data-testid="run-benchmark-wizard">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-xs hover:bg-muted/30"
        onClick={() => setOpen((value) => !value)}
        data-testid="run-benchmark-wizard-toggle"
      >
        <span className="font-medium">{t('artifacts.eval.wizard.runGuided')}</span>
        <span className="font-mono text-[11px] text-muted-foreground">{open ? t('artifacts.eval.wizard.hide') : t('artifacts.eval.wizard.show')}</span>
      </button>
      {open ? (
        <div className="grid gap-3 border-t border-border p-3 text-xs">
          <WizardProgressRail steps={WIZARD_STEPS} stepState={stepState} current={current} onSelect={goto} />
          {current === 'plan' ? (
            <WizardPlanStep
              shared={shared}
              setShared={setShared}
              submitting={submitting}
              onSubmit={() => void submitPlan()}
              planCounts={planCounts}
            />
          ) : null}
          {current === 'infer' ? (
            <WizardInferStep
              shared={shared}
              setShared={setShared}
              submitting={submitting}
              onSubmit={() => void submitInfer()}
              onSubmitUpload={() => void submitInferUpload()}
              inferCounts={inferCounts}
              inferProgress={inferProgress}
            />
          ) : null}
          {current === 'grade' ? (
            <WizardGradeStep
              shared={shared}
              setShared={setShared}
              submitting={submitting}
              onSubmit={() => void submitGrade()}
              command={gradeCommand}
            />
          ) : null}
          {current === 'ingest' ? (
            <WizardIngestStep
              shared={shared}
              setShared={setShared}
              submitting={submitting}
              onSubmit={() => void submitIngest()}
              ingestCounts={ingestCounts}
              onSkipToReview={() => {
                markStep('ingest', { status: 'done', message: 'skipped' })
                setCurrent('review')
                markStep('review', { status: 'active' })
              }}
            />
          ) : null}
          {current === 'review' ? (
            <WizardReviewStep
              shared={shared}
              planCounts={planCounts}
              inferCounts={inferCounts}
              ingestCounts={ingestCounts}
              onReset={reset}
            />
          ) : null}
          {error ? (
            <div
              className="rounded border border-rose-200 bg-rose-50 px-2 py-1 text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300"
              data-testid="run-benchmark-wizard-error"
            >
              {error}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function WizardProgressRail({
  steps,
  stepState,
  current,
  onSelect,
}: {
  steps: readonly { id: WizardStepId; label: string }[]
  stepState: Record<WizardStepId, WizardStepState>
  current: WizardStepId
  onSelect(step: WizardStepId): void
}): JSX.Element {
  const { t } = useTranslation()
  return (
    <ol className="flex flex-wrap items-center gap-2 text-[11px]" data-testid="run-benchmark-wizard-rail">
      {steps.map((step, index) => {
        const state = stepState[step.id]
        const isCurrent = step.id === current
        return (
          <li key={step.id} className="flex items-center gap-2">
            <button
              type="button"
              className={cn(
                'flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono',
                isCurrent && 'border-primary bg-primary/10 text-primary',
                !isCurrent && state.status === 'done' && 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300',
                !isCurrent && state.status === 'error' && 'border-rose-300 bg-rose-50 text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300',
                !isCurrent && state.status === 'idle' && 'border-border text-muted-foreground',
              )}
              onClick={() => onSelect(step.id)}
              data-testid={`run-benchmark-wizard-step-${step.id}`}
              data-status={state.status}
            >
              <span>{index + 1}.</span>
              <span>{t(`artifacts.eval.wizard.steps.${step.id}`)}</span>
            </button>
            {index < steps.length - 1 ? <span className="text-muted-foreground">→</span> : null}
          </li>
        )
      })}
    </ol>
  )
}

function WizardPlanStep({
  shared,
  setShared,
  submitting,
  onSubmit,
  planCounts,
}: {
  shared: WizardShared
  setShared: (updater: (prev: WizardShared) => WizardShared) => void
  submitting: boolean
  onSubmit(): void
  planCounts: PlanCounts | null
}): JSX.Element {
  const { t } = useTranslation()
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit()
      }}
      className="grid gap-2"
      data-testid="run-benchmark-wizard-plan"
    >
      <div className="text-muted-foreground">
        {t('artifacts.eval.wizard.chooseShape')}
      </div>
      <BenchmarkBoundaryNote />
      <div className="grid grid-cols-2 gap-2 max-lg:grid-cols-1">
        <LabeledRunIdInput label={t('artifacts.eval.wizard.runId')} value={shared.runId} onChange={(value) => setShared((prev) => ({ ...prev, runId: value }))} required placeholder="swebench-smoke" data-testid="run-benchmark-wizard-run-id" generateLabel={t('artifacts.eval.wizard.generateRunId')} />
        <LabeledInput label={t('artifacts.eval.columns.model')} value={shared.model} onChange={(value) => setShared((prev) => ({ ...prev, model: value }))} required placeholder="gpt-5.5" data-testid="run-benchmark-wizard-model" />
        <LabeledInput label={t('artifacts.eval.columns.dataset')} value={shared.dataset} onChange={(value) => setShared((prev) => ({ ...prev, dataset: value }))} required data-testid="run-benchmark-wizard-dataset" />
        <LabeledInput label={t('artifacts.eval.wizard.split')} value={shared.split} onChange={(value) => setShared((prev) => ({ ...prev, split: value }))} data-testid="run-benchmark-wizard-split" />
        <LabeledInput label={t('artifacts.eval.wizard.maxWorkers')} value={shared.maxWorkers} onChange={(value) => setShared((prev) => ({ ...prev, maxWorkers: value }))} inputMode="numeric" data-testid="run-benchmark-wizard-max-workers" />
      </div>
      <InstancesSourcePanel shared={shared} setShared={setShared} />
      {planCounts ? (
        <div className="text-[11px] text-emerald-700 dark:text-emerald-300" data-testid="run-benchmark-wizard-plan-summary">
          {t('artifacts.eval.wizard.planReady', { instances: planCounts.instances, shards: planCounts.shards })}
        </div>
      ) : null}
      <div className="flex justify-end">
        <Button type="submit" size="sm" disabled={submitting || !shared.instancesJsonl.trim()} data-testid="run-benchmark-wizard-plan-submit">
          {submitting ? t('artifacts.eval.wizard.creating') : t('artifacts.eval.wizard.createPlan')}
        </Button>
      </div>
    </form>
  )
}

type InstancesTab = 'dataset' | 'upload' | 'paste'

type DatasetPreset = 'lite' | 'verified' | 'full' | 'custom'

const DATASET_PRESETS: Record<DatasetPreset, { label: string; repo: string }> = {
  lite: { label: 'SWE-bench Lite (300 tasks)', repo: 'princeton-nlp/SWE-bench_Lite' },
  verified: { label: 'SWE-bench Verified (500 tasks)', repo: 'princeton-nlp/SWE-bench_Verified' },
  full: { label: 'SWE-bench (2294 tasks)', repo: 'princeton-nlp/SWE-bench' },
  custom: { label: 'Custom HuggingFace repo', repo: '' },
}

function InstancesSourcePanel({
  shared,
  setShared,
}: {
  shared: WizardShared
  setShared: (updater: (prev: WizardShared) => WizardShared) => void
}): JSX.Element {
  const { t } = useTranslation()
  const [tab, setTab] = useState<InstancesTab>('dataset')
  const [datasetPreset, setDatasetPreset] = useState<DatasetPreset>('lite')
  const [customRepo, setCustomRepo] = useState('')
  const [datasetSplit, setDatasetSplit] = useState('test')
  const [datasetLimit, setDatasetLimit] = useState('5')
  const [hfToken, setHfToken] = useState('')
  const [uploadContent, setUploadContent] = useState('')
  const [uploadName, setUploadName] = useState<string | null>(null)
  const [pasteContent, setPasteContent] = useState('')
  const [resolving, setResolving] = useState(false)
  const [resolveError, setResolveError] = useState<string | null>(null)
  const [resolveSummary, setResolveSummary] = useState<string | null>(null)

  const datasetRepo = datasetPreset === 'custom' ? customRepo.trim() : DATASET_PRESETS[datasetPreset].repo

  const canResolve = (() => {
    if (resolving) return false
    if (!shared.runId.trim()) return false
    if (tab === 'dataset') return datasetRepo.length > 0
    if (tab === 'upload') return uploadContent.length > 0
    return pasteContent.trim().length > 0
  })()

  const disabledReason = (() => {
    if (!shared.runId.trim()) return 'Set Run ID above first.'
    if (tab === 'dataset' && datasetRepo.length === 0) return 'Enter a HuggingFace dataset repo.'
    if (tab === 'upload' && uploadContent.length === 0) return 'Choose a .jsonl file to upload.'
    if (tab === 'paste' && pasteContent.trim().length === 0) return 'Paste at least one JSON line.'
    return null
  })()

  async function handleFile(file: File): Promise<void> {
    setResolveError(null)
    if (file.size > 20 * 1024 * 1024) {
      setResolveError('File too large (max 20MB).')
      return
    }
    try {
      const text = await file.text()
      setUploadContent(text)
      setUploadName(file.name)
    } catch (err) {
      setResolveError(err instanceof Error ? err.message : String(err))
    }
  }

  async function resolveInstances(): Promise<void> {
    setResolving(true)
    setResolveError(null)
    setResolveSummary(null)
    try {
      const body: Record<string, unknown> = {
        action: 'swebench-resolve-instances',
        runId: shared.runId.trim(),
      }
      if (tab === 'dataset') {
        body.source = 'huggingface'
        body.datasetRef = datasetRepo
        if (datasetSplit.trim()) body.datasetSplit = datasetSplit.trim()
        const limitStr = datasetLimit.trim()
        if (limitStr.length > 0) {
          const limitNum = Number(limitStr)
          if (!Number.isFinite(limitNum) || limitNum <= 0) {
            throw new Error('Limit must be a positive number (leave blank for all).')
          }
          body.datasetLimit = limitNum
        }
        if (hfToken.trim()) body.hfToken = hfToken.trim()
      } else {
        body.source = 'inline'
        body.inlineContent = tab === 'upload' ? uploadContent : pasteContent
      }
      const res = await fetch('/enhancement/action', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const parsed = await res.json().catch(() => null) as { instancesJsonlPath?: string; rowCount?: number; error?: string } | null
      if (!res.ok) throw new Error(parsed?.error ?? `resolve failed: HTTP ${res.status}`)
      const path = parsed?.instancesJsonlPath
      if (!path) throw new Error('resolve response missing instancesJsonlPath')
      setShared((prev) => ({ ...prev, instancesJsonl: path }))
      setResolveSummary(t('artifacts.eval.wizard.instancesWritten', { count: parsed?.rowCount ?? 0, path }))
    } catch (err) {
      setResolveError(err instanceof Error ? err.message : String(err))
    } finally {
      setResolving(false)
    }
  }

  return (
    <div className="rounded-md border border-border bg-muted/20 p-3" data-testid="instances-source-panel">
      <div className="mb-2 text-xs font-medium text-foreground">{t('artifacts.eval.wizard.instances')}</div>
      <div className="mb-2 grid grid-cols-3 gap-1 rounded bg-card p-0.5 ring-1 ring-border/50">
        {(['dataset', 'upload', 'paste'] as InstancesTab[]).map((kind) => (
          <button
            key={kind}
            type="button"
            data-testid={`instances-source-tab-${kind}`}
            aria-pressed={tab === kind}
            onClick={() => {
              setTab(kind)
              setResolveError(null)
            }}
            className={cn(
              'rounded px-3 py-1.5 text-xs font-medium transition-colors',
              tab === kind ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted',
            )}
          >
            {kind === 'dataset' ? t('artifacts.eval.wizard.datasetTab') : kind === 'upload' ? t('artifacts.eval.wizard.uploadTab') : t('artifacts.eval.wizard.pasteTab')}
          </button>
        ))}
      </div>
      {tab === 'dataset' ? (
        <div className="grid grid-cols-2 gap-2 max-lg:grid-cols-1">
          <label className="grid gap-1 text-xs">
            <span className="text-muted-foreground">{t('artifacts.eval.columns.dataset')}</span>
            <select
              data-testid="instances-dataset-select"
              value={datasetPreset}
              onChange={(event) => setDatasetPreset(event.target.value as DatasetPreset)}
              className="h-8 rounded border border-border bg-background px-2 text-xs"
            >
              {(['lite', 'verified', 'full', 'custom'] as DatasetPreset[]).map((preset) => (
                <option key={preset} value={preset}>{DATASET_PRESETS[preset].label}</option>
              ))}
            </select>
          </label>
          {datasetPreset === 'custom' ? (
            <LabeledInput label={t('artifacts.eval.wizard.customRepo')} value={customRepo} onChange={setCustomRepo} placeholder="myorg/my-swebench-fork" data-testid="instances-dataset-repo" />
          ) : (
            <div className="grid gap-1 text-xs">
              <span className="text-muted-foreground">{t('artifacts.eval.wizard.repo')}</span>
              <div className="h-8 rounded border border-dashed border-border bg-background/70 px-2 py-1.5 font-mono text-[11px] text-muted-foreground" data-testid="instances-dataset-repo-display">{datasetRepo}</div>
            </div>
          )}
          <LabeledInput label={t('artifacts.eval.wizard.split')} value={datasetSplit} onChange={setDatasetSplit} placeholder="test" data-testid="instances-dataset-split" />
          <LabeledInput label={t('artifacts.eval.wizard.limitAll')} value={datasetLimit} onChange={setDatasetLimit} inputMode="numeric" placeholder="5" data-testid="instances-dataset-limit" />
          <label className="col-span-2 grid gap-1 text-xs max-lg:col-span-1">
            <span className="text-muted-foreground">{t('artifacts.eval.wizard.hfToken')}</span>
            <input
              type="password"
              data-testid="instances-dataset-token"
              value={hfToken}
              onChange={(event) => setHfToken(event.target.value)}
              placeholder="hf_..."
              className="h-8 rounded border border-border bg-background px-2 text-xs"
              autoComplete="off"
            />
          </label>
        </div>
      ) : null}
      {tab === 'upload' ? (
        <div className="grid gap-2">
          <input
            type="file"
            accept=".jsonl,.json,.txt"
            data-testid="instances-upload-file"
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) void handleFile(file)
            }}
            className="text-xs"
          />
          {uploadName ? (
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <span data-testid="instances-upload-filename">{t('artifacts.eval.wizard.selectedFile', { name: uploadName, bytes: uploadContent.length })}</span>
              <button
                type="button"
                onClick={() => {
                  setUploadContent('')
                  setUploadName(null)
                }}
                className="rounded border border-border px-2 py-0.5 text-[10px] hover:bg-muted"
              >
                {t('artifacts.eval.wizard.clear')}
              </button>
            </div>
          ) : null}
          <p className="text-[11px] text-muted-foreground">{t('artifacts.eval.wizard.uploadHelp')}</p>
        </div>
      ) : null}
      {tab === 'paste' ? (
        <div className="grid gap-2">
          <details className="rounded-md border border-border bg-background/60 px-3 py-2 text-[11px]" data-testid="run-benchmark-wizard-instances-help">
            <summary className="cursor-pointer font-medium text-foreground">{t('artifacts.eval.wizard.jsonlFormat')}</summary>
            <div className="mt-2 space-y-1 text-muted-foreground">
              <p>{t('artifacts.eval.wizard.jsonlHelp')}</p>
              <pre className="mt-1 overflow-x-auto rounded bg-background/70 p-2 font-mono">{`{"instance_id":"astropy__astropy-12907","repo":"astropy/astropy","base_commit":"abc123"}
{"instance_id":"django__django-11815","repo":"django/django","base_commit":"def456"}`}</pre>
            </div>
          </details>
          <textarea
            data-testid="instances-paste-textarea"
            value={pasteContent}
            onChange={(event) => setPasteContent(event.target.value)}
            rows={8}
            placeholder='{"instance_id":"astropy__astropy-12907"}'
            className="w-full rounded border border-border bg-background px-2 py-1 font-mono text-[11px]"
          />
        </div>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <div className="text-[11px] text-muted-foreground">
          {shared.instancesJsonl ? (
            <span data-testid="instances-current-path">{t('artifacts.eval.wizard.instancesReady')}</span>
          ) : (
            <span>{t('artifacts.eval.wizard.noInstances')}</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {disabledReason ? <span className="text-[11px] text-muted-foreground">{disabledReason}</span> : null}
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!canResolve}
            onClick={() => { void resolveInstances() }}
            data-testid="instances-resolve-button"
          >
            {resolving ? t('artifacts.eval.wizard.resolving') : t('artifacts.eval.wizard.resolveInstances')}
          </Button>
        </div>
      </div>
      {resolveSummary ? (
        <div className="mt-2 rounded border border-emerald-200 bg-emerald-50 px-2 py-1 text-[11px] text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300" data-testid="instances-resolve-summary">
          {resolveSummary}
        </div>
      ) : null}
      {resolveError ? (
        <div className="mt-2 rounded border border-red-200 bg-red-50 px-2 py-1 text-[11px] text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300" data-testid="instances-resolve-error">
          {resolveError}
        </div>
      ) : null}
    </div>
  )
}

type UploadTab = 'upload' | 'paste'

function PatchesUploadPanel({
  shared,
  setShared,
}: {
  shared: WizardShared
  setShared: (updater: (prev: WizardShared) => WizardShared) => void
}): JSX.Element {
  const { t } = useTranslation()
  const [tab, setTab] = useState<UploadTab>('paste')
  const [uploadContent, setUploadContent] = useState('')
  const [uploadName, setUploadName] = useState<string | null>(null)
  const [pasteContent, setPasteContent] = useState('')
  const [resolving, setResolving] = useState(false)
  const [resolveError, setResolveError] = useState<string | null>(null)
  const [resolveSummary, setResolveSummary] = useState<string | null>(null)

  const canResolve = (() => {
    if (resolving) return false
    if (!shared.runId.trim()) return false
    if (tab === 'upload') return uploadContent.length > 0
    return pasteContent.trim().length > 0
  })()

  const disabledReason = (() => {
    if (!shared.runId.trim()) return t('artifacts.eval.wizard.needRunId')
    if (tab === 'upload' && uploadContent.length === 0) return t('artifacts.eval.wizard.patchesUploadFile')
    if (tab === 'paste' && pasteContent.trim().length === 0) return t('artifacts.eval.wizard.patchesUploadPaste')
    return null
  })()

  async function handleFile(file: File): Promise<void> {
    setResolveError(null)
    if (file.size > 20 * 1024 * 1024) {
      setResolveError('File too large (max 20MB).')
      return
    }
    try {
      const text = await file.text()
      setUploadContent(text)
      setUploadName(file.name)
    } catch (err) {
      setResolveError(err instanceof Error ? err.message : String(err))
    }
  }

  function parsePatches(raw: string): Record<string, string> {
    const trimmed = raw.trim()
    if (trimmed.length === 0) throw new Error('empty patches payload')
    const parsed = JSON.parse(trimmed) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('patches must be a JSON object mapping instance_id → diff')
    }
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== 'string') {
        throw new Error(`patch value for "${key}" must be a string`)
      }
      out[key] = value
    }
    return out
  }

  async function resolvePatches(): Promise<void> {
    setResolving(true)
    setResolveError(null)
    setResolveSummary(null)
    try {
      const source = tab === 'upload' ? uploadContent : pasteContent
      const patches = parsePatches(source)
      const body = {
        action: 'swebench-upload-patches',
        runId: shared.runId.trim(),
        patches,
      }
      const res = await fetch('/enhancement/action', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const parsed = await res.json().catch(() => null) as { patchesDir?: string; instanceCount?: number; error?: string } | null
      if (!res.ok) throw new Error(parsed?.error ?? `upload failed: HTTP ${res.status}`)
      const path = parsed?.patchesDir
      if (!path) throw new Error('response missing patchesDir')
      setShared((prev) => ({ ...prev, patchesDir: path }))
      setResolveSummary(t('artifacts.eval.wizard.patchesUploadSummary', { count: parsed?.instanceCount ?? 0, path }))
    } catch (err) {
      setResolveError(err instanceof Error ? err.message : String(err))
    } finally {
      setResolving(false)
    }
  }

  return (
    <div className="rounded-md border border-border bg-muted/20 p-3" data-testid="patches-upload-panel">
      <div className="mb-2 text-xs font-medium text-foreground">{t('artifacts.eval.wizard.patchesUploadTitle')}</div>
      <div className="mb-2 grid grid-cols-2 gap-1 rounded bg-card p-0.5 ring-1 ring-border/50">
        {(['upload', 'paste'] as UploadTab[]).map((kind) => (
          <button
            key={kind}
            type="button"
            data-testid={`patches-source-tab-${kind}`}
            aria-pressed={tab === kind}
            onClick={() => {
              setTab(kind)
              setResolveError(null)
            }}
            className={cn(
              'rounded px-3 py-1.5 text-xs font-medium transition-colors',
              tab === kind ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted',
            )}
          >
            {kind === 'upload' ? t('artifacts.eval.wizard.uploadTab') : t('artifacts.eval.wizard.pasteTab')}
          </button>
        ))}
      </div>
      {tab === 'upload' ? (
        <div className="grid gap-2">
          <input
            type="file"
            accept=".json,.txt"
            data-testid="patches-upload-file"
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) void handleFile(file)
            }}
            className="text-xs"
          />
          {uploadName ? (
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <span data-testid="patches-upload-filename">{t('artifacts.eval.wizard.selectedFile', { name: uploadName, bytes: uploadContent.length })}</span>
              <button
                type="button"
                onClick={() => {
                  setUploadContent('')
                  setUploadName(null)
                }}
                className="rounded border border-border px-2 py-0.5 text-[10px] hover:bg-muted"
              >
                {t('artifacts.eval.wizard.clear')}
              </button>
            </div>
          ) : null}
          <p className="text-[11px] text-muted-foreground">{t('artifacts.eval.wizard.patchesUploadHelp')}</p>
        </div>
      ) : (
        <div className="grid gap-2">
          <p className="text-[11px] text-muted-foreground">{t('artifacts.eval.wizard.patchesUploadHelp')}</p>
          <textarea
            data-testid="patches-paste-textarea"
            value={pasteContent}
            onChange={(event) => setPasteContent(event.target.value)}
            rows={10}
            placeholder={'{\n  "astropy__astropy-12907": "diff --git a/x b/x\\n+one\\n",\n  "django__django-11039": "diff --git a/y b/y\\n+two\\n"\n}'}
            className="w-full rounded border border-border bg-background px-2 py-1 font-mono text-[11px]"
          />
        </div>
      )}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <div className="text-[11px] text-muted-foreground">
          {shared.patchesDir ? (
            <span data-testid="patches-current-path">{t('artifacts.eval.wizard.patchesReady')}</span>
          ) : (
            <span>{t('artifacts.eval.wizard.noPatches')}</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {disabledReason ? <span className="text-[11px] text-muted-foreground">{disabledReason}</span> : null}
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!canResolve}
            onClick={() => { void resolvePatches() }}
            data-testid="patches-resolve-button"
          >
            {resolving ? t('artifacts.eval.wizard.resolving') : t('artifacts.eval.wizard.patchesUploadResolve')}
          </Button>
        </div>
      </div>
      {resolveSummary ? (
        <div className="mt-2 rounded border border-emerald-200 bg-emerald-50 px-2 py-1 text-[11px] text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300" data-testid="patches-resolve-summary">
          {resolveSummary}
        </div>
      ) : null}
      {resolveError ? (
        <div className="mt-2 rounded border border-red-200 bg-red-50 px-2 py-1 text-[11px] text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300" data-testid="patches-resolve-error">
          {resolveError}
        </div>
      ) : null}
    </div>
  )
}

function ResultsUploadPanel({
  shared,
  setShared,
}: {
  shared: WizardShared
  setShared: (updater: (prev: WizardShared) => WizardShared) => void
}): JSX.Element {
  const { t } = useTranslation()
  const [tab, setTab] = useState<UploadTab>('paste')
  const [uploadContent, setUploadContent] = useState('')
  const [uploadName, setUploadName] = useState<string | null>(null)
  const [pasteContent, setPasteContent] = useState('')
  const [resolving, setResolving] = useState(false)
  const [resolveError, setResolveError] = useState<string | null>(null)
  const [resolveSummary, setResolveSummary] = useState<string | null>(null)

  const canResolve = (() => {
    if (resolving) return false
    if (!shared.runId.trim()) return false
    if (tab === 'upload') return uploadContent.length > 0
    return pasteContent.trim().length > 0
  })()

  const disabledReason = (() => {
    if (!shared.runId.trim()) return t('artifacts.eval.wizard.needRunId')
    if (tab === 'upload' && uploadContent.length === 0) return t('artifacts.eval.wizard.resultsUploadFile')
    if (tab === 'paste' && pasteContent.trim().length === 0) return t('artifacts.eval.wizard.resultsUploadPaste')
    return null
  })()

  async function handleFile(file: File): Promise<void> {
    setResolveError(null)
    if (file.size > 20 * 1024 * 1024) {
      setResolveError('File too large (max 20MB).')
      return
    }
    try {
      const text = await file.text()
      setUploadContent(text)
      setUploadName(file.name)
    } catch (err) {
      setResolveError(err instanceof Error ? err.message : String(err))
    }
  }

  function parseResultsFiles(raw: string): Record<string, string> {
    const trimmed = raw.trim()
    if (trimmed.length === 0) throw new Error('empty results payload')
    const parsed = JSON.parse(trimmed) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('results must be a JSON object mapping fileName → content')
    }
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== 'string') {
        throw new Error(`results value for "${key}" must be a string`)
      }
      out[key] = value
    }
    return out
  }

  async function resolveResults(): Promise<void> {
    setResolving(true)
    setResolveError(null)
    setResolveSummary(null)
    try {
      const source = tab === 'upload' ? uploadContent : pasteContent
      const resultsFiles = parseResultsFiles(source)
      const body = {
        action: 'swebench-upload-results',
        runId: shared.runId.trim(),
        resultsFiles,
      }
      const res = await fetch('/enhancement/action', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const parsed = await res.json().catch(() => null) as { resultsDir?: string; fileCount?: number; error?: string } | null
      if (!res.ok) throw new Error(parsed?.error ?? `upload failed: HTTP ${res.status}`)
      const path = parsed?.resultsDir
      if (!path) throw new Error('response missing resultsDir')
      setShared((prev) => ({ ...prev, resultsDir: path }))
      setResolveSummary(t('artifacts.eval.wizard.resultsUploadSummary', { count: parsed?.fileCount ?? 0, path }))
    } catch (err) {
      setResolveError(err instanceof Error ? err.message : String(err))
    } finally {
      setResolving(false)
    }
  }

  return (
    <div className="rounded-md border border-border bg-muted/20 p-3" data-testid="results-upload-panel">
      <div className="mb-2 text-xs font-medium text-foreground">{t('artifacts.eval.wizard.resultsUploadTitle')}</div>
      <div className="mb-2 grid grid-cols-2 gap-1 rounded bg-card p-0.5 ring-1 ring-border/50">
        {(['upload', 'paste'] as UploadTab[]).map((kind) => (
          <button
            key={kind}
            type="button"
            data-testid={`results-source-tab-${kind}`}
            aria-pressed={tab === kind}
            onClick={() => {
              setTab(kind)
              setResolveError(null)
            }}
            className={cn(
              'rounded px-3 py-1.5 text-xs font-medium transition-colors',
              tab === kind ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted',
            )}
          >
            {kind === 'upload' ? t('artifacts.eval.wizard.uploadTab') : t('artifacts.eval.wizard.pasteTab')}
          </button>
        ))}
      </div>
      {tab === 'upload' ? (
        <div className="grid gap-2">
          <input
            type="file"
            accept=".json,.txt"
            data-testid="results-upload-file"
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) void handleFile(file)
            }}
            className="text-xs"
          />
          {uploadName ? (
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <span data-testid="results-upload-filename">{t('artifacts.eval.wizard.selectedFile', { name: uploadName, bytes: uploadContent.length })}</span>
              <button
                type="button"
                onClick={() => {
                  setUploadContent('')
                  setUploadName(null)
                }}
                className="rounded border border-border px-2 py-0.5 text-[10px] hover:bg-muted"
              >
                {t('artifacts.eval.wizard.clear')}
              </button>
            </div>
          ) : null}
          <p className="text-[11px] text-muted-foreground">{t('artifacts.eval.wizard.resultsUploadHelp')}</p>
        </div>
      ) : (
        <div className="grid gap-2">
          <p className="text-[11px] text-muted-foreground">{t('artifacts.eval.wizard.resultsUploadHelp')}</p>
          <textarea
            data-testid="results-paste-textarea"
            value={pasteContent}
            onChange={(event) => setPasteContent(event.target.value)}
            rows={10}
            placeholder={'{\n  "instance_results.jsonl": "{\\"instance_id\\":\\"a\\",\\"resolved\\":true}\\n",\n  "summary.json": "{\\"total\\":1}"\n}'}
            className="w-full rounded border border-border bg-background px-2 py-1 font-mono text-[11px]"
          />
        </div>
      )}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <div className="text-[11px] text-muted-foreground">
          {shared.resultsDir ? (
            <span data-testid="results-current-path">{t('artifacts.eval.wizard.resultsReady')}</span>
          ) : (
            <span>{t('artifacts.eval.wizard.noResults')}</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {disabledReason ? <span className="text-[11px] text-muted-foreground">{disabledReason}</span> : null}
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!canResolve}
            onClick={() => { void resolveResults() }}
            data-testid="results-resolve-button"
          >
            {resolving ? t('artifacts.eval.wizard.resolving') : t('artifacts.eval.wizard.resultsUploadResolve')}
          </Button>
        </div>
      </div>
      {resolveSummary ? (
        <div className="mt-2 rounded border border-emerald-200 bg-emerald-50 px-2 py-1 text-[11px] text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300" data-testid="results-resolve-summary">
          {resolveSummary}
        </div>
      ) : null}
      {resolveError ? (
        <div className="mt-2 rounded border border-red-200 bg-red-50 px-2 py-1 text-[11px] text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300" data-testid="results-resolve-error">
          {resolveError}
        </div>
      ) : null}
    </div>
  )
}

function WizardInferStep({
  shared,
  setShared,
  submitting,
  onSubmit,
  onSubmitUpload,
  inferCounts,
  inferProgress,
}: {
  shared: WizardShared
  setShared: (updater: (prev: WizardShared) => WizardShared) => void
  submitting: boolean
  onSubmit(): void
  onSubmitUpload(): void
  inferCounts: InferCounts | null
  inferProgress: { completed: number; total: number; current?: string } | null
}): JSX.Element {
  const { t } = useTranslation()
  const [useCustomCommand, setUseCustomCommand] = useState(false)
  return (
    <div className="grid gap-2" data-testid="run-benchmark-wizard-infer">
      <div className="text-muted-foreground">
        {t('artifacts.eval.wizard.inferDescription')}
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          onSubmit()
        }}
        className="grid gap-2 rounded-md border border-border bg-muted/10 p-3"
      >
        <div className="grid gap-1">
          <span className="text-[11px] font-medium text-muted-foreground">{t('artifacts.eval.wizard.agentRecipe')}</span>
          <select
            data-testid="run-benchmark-wizard-agent-recipe"
            value={useCustomCommand ? 'custom' : 'default'}
            onChange={(event) => {
              const next = event.currentTarget.value === 'custom'
              setUseCustomCommand(next)
              if (!next) setShared((prev) => ({ ...prev, agentCommand: '' }))
            }}
            className="rounded border border-border bg-background px-2 py-1 text-xs"
          >
            <option value="default">{t('artifacts.eval.wizard.recipeDefault')}</option>
            <option value="custom">{t('artifacts.eval.wizard.recipeCustom')}</option>
          </select>
        </div>
        {useCustomCommand ? (
          <label className="grid gap-1">
            <span className="text-[11px] font-medium text-muted-foreground">{t('artifacts.eval.wizard.customCommand')}</span>
            <textarea
              data-testid="run-benchmark-wizard-agent-command"
              value={shared.agentCommand}
              onChange={(event) => setShared((prev) => ({ ...prev, agentCommand: event.target.value }))}
              rows={3}
              placeholder={DEFAULT_AGENT_COMMAND}
              className="w-full rounded border border-border bg-background px-2 py-1 font-mono text-[11px]"
            />
            <span className="text-[10px] text-muted-foreground">{t('artifacts.eval.wizard.customCommandHelp')}</span>
          </label>
        ) : null}
        {inferProgress && submitting ? (
          <div className="text-[11px] text-muted-foreground" data-testid="run-benchmark-wizard-infer-progress">
            {t('artifacts.eval.wizard.runningProgress', {
              completed: inferProgress.completed,
              total: inferProgress.total,
              current: inferProgress.current ?? '',
            })}
          </div>
        ) : null}
        {inferCounts ? (
          <div className="text-[11px] text-emerald-700 dark:text-emerald-300" data-testid="run-benchmark-wizard-infer-summary">
            {t('artifacts.eval.wizard.runSummary', inferCounts)}
          </div>
        ) : null}
        <div className="flex justify-end">
          <Button type="submit" size="sm" disabled={submitting} data-testid="run-benchmark-wizard-infer-submit">
            {submitting ? t('artifacts.eval.wizard.running') : t('artifacts.eval.wizard.runPredictions')}
          </Button>
        </div>
      </form>
      <details className="rounded-md border border-border bg-background/60 px-3 py-2 text-[11px]" data-testid="run-benchmark-wizard-infer-advanced">
        <summary className="cursor-pointer font-medium text-foreground">{t('artifacts.eval.wizard.advancedRanExternally')}</summary>
        <div className="mt-2 grid gap-2">
          <PatchesUploadPanel shared={shared} setShared={setShared} />
          <div className="flex justify-end">
            <Button type="button" size="sm" variant="outline" disabled={submitting || !shared.patchesDir.trim()} onClick={onSubmitUpload} data-testid="run-benchmark-wizard-infer-upload-submit">
              {submitting ? t('artifacts.eval.wizard.building') : t('artifacts.eval.wizard.buildPredictions')}
            </Button>
          </div>
        </div>
      </details>
    </div>
  )
}

function WizardGradeStep({
  shared,
  setShared,
  submitting,
  onSubmit,
  command,
}: {
  shared: WizardShared
  setShared: (updater: (prev: WizardShared) => WizardShared) => void
  submitting: boolean
  onSubmit(): void
  command: string | null
}): JSX.Element {
  const { t } = useTranslation()
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit()
      }}
      className="grid gap-2"
      data-testid="run-benchmark-wizard-grade"
    >
      <div className="text-muted-foreground">
        {t('artifacts.eval.wizard.gradeDescription')}
      </div>
      <BenchmarkBoundaryNote compact />
      <details className="rounded-md border border-border bg-background/60 px-3 py-2 text-[11px]" data-testid="run-benchmark-wizard-grade-advanced">
        <summary className="cursor-pointer font-medium text-foreground">{t('artifacts.eval.wizard.advanced')}</summary>
        <div className="mt-2 grid grid-cols-2 gap-2 max-lg:grid-cols-1">
          <LabeledInput label={t('artifacts.eval.wizard.maxWorkers')} value={shared.maxWorkers} onChange={(value) => setShared((prev) => ({ ...prev, maxWorkers: value }))} inputMode="numeric" data-testid="run-benchmark-wizard-grade-max-workers" />
        </div>
      </details>
      {command ? (
        <div className="rounded border border-emerald-200 bg-emerald-50 px-2 py-1 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300" data-testid="run-benchmark-wizard-grade-command">
          <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-emerald-800 dark:text-emerald-300">{t('artifacts.eval.wizard.copyAndRun')}</div>
          <div className="mb-1 text-[11px] text-emerald-800/80 dark:text-emerald-200/80" data-testid="run-benchmark-wizard-grade-note">{t('artifacts.eval.wizard.gradeCommandNote')}</div>
          <pre className="whitespace-pre-wrap font-mono text-[11px]">{command}</pre>
        </div>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button type="submit" size="sm" disabled={submitting} data-testid="run-benchmark-wizard-grade-submit">
          {submitting ? t('artifacts.eval.wizard.generating') : command ? t('artifacts.eval.wizard.regenerateCommand') : t('artifacts.eval.wizard.generateCommand')}
        </Button>
      </div>
    </form>
  )
}

function BenchmarkBoundaryNote({ compact = false }: { compact?: boolean }): JSX.Element {
  const { t } = useTranslation()
  return (
    <div
      className={cn(
        'rounded-md border border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900/70 dark:bg-amber-950/30 dark:text-amber-100',
        compact ? 'px-2 py-1 text-[11px]' : 'px-3 py-2 text-[11px]',
      )}
      data-testid="run-benchmark-wizard-harness-boundary"
    >
      <div className="font-medium">{t('artifacts.eval.wizard.officialHarnessBoundaryTitle')}</div>
      <div className="mt-0.5 text-amber-900/80 dark:text-amber-100/80">{t('artifacts.eval.wizard.officialHarnessBoundaryBody')}</div>
    </div>
  )
}

function WizardIngestStep({
  shared,
  setShared,
  submitting,
  onSubmit,
  ingestCounts,
  onSkipToReview,
}: {
  shared: WizardShared
  setShared: (updater: (prev: WizardShared) => WizardShared) => void
  submitting: boolean
  onSubmit(): void
  ingestCounts: IngestCounts | null
  onSkipToReview(): void
}): JSX.Element {
  const { t } = useTranslation()
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit()
      }}
      className="grid gap-2"
      data-testid="run-benchmark-wizard-ingest"
    >
      <div className="text-muted-foreground">
        {t('artifacts.eval.wizard.ingestDescription')}
      </div>
      <ResultsUploadPanel shared={shared} setShared={setShared} />
      {ingestCounts ? (
        <div className="text-[11px] text-emerald-700 dark:text-emerald-300" data-testid="run-benchmark-wizard-ingest-summary">
          {t('artifacts.eval.wizard.ingestReady', { resolved: ingestCounts.resolved, total: ingestCounts.total })}
        </div>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="outline" onClick={onSkipToReview} data-testid="run-benchmark-wizard-ingest-skip">
          {t('artifacts.eval.wizard.skipToReview')}
        </Button>
        <Button type="submit" size="sm" disabled={submitting} data-testid="run-benchmark-wizard-ingest-submit">
          {submitting ? t('artifacts.eval.wizard.ingesting') : t('artifacts.eval.wizard.ingestResults')}
        </Button>
      </div>
    </form>
  )
}

function WizardReviewStep({
  shared,
  planCounts,
  inferCounts,
  ingestCounts,
  onReset,
}: {
  shared: WizardShared
  planCounts: PlanCounts | null
  inferCounts: InferCounts | null
  ingestCounts: IngestCounts | null
  onReset(): void
}): JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="grid gap-2" data-testid="run-benchmark-wizard-review">
      <div className="text-muted-foreground">
        {t('artifacts.eval.wizard.reviewDescription')}
      </div>
      <ul className="grid gap-1 text-[11px]">
        <li>
          {t('artifacts.eval.wizard.reviewRunId')}: <span className="text-foreground font-mono">{shared.runId || '(unset)'}</span>
        </li>
        <li>
          {t('artifacts.eval.columns.dataset')}: <span className="text-foreground font-mono">{shared.dataset || '(unset)'}</span>
        </li>
        <li>
          {t('artifacts.eval.columns.model')}: <span className="text-foreground font-mono">{shared.model || '(unset)'}</span>
        </li>
        {planCounts ? (
          <li>
            {t('artifacts.eval.wizard.reviewPlan')}: <span className="text-foreground">{t('artifacts.eval.wizard.planReady', planCounts)}</span>
          </li>
        ) : null}
        {inferCounts ? (
          <li>
            {t('artifacts.eval.wizard.reviewPredictions')}: <span className="text-foreground">{t('artifacts.eval.wizard.runSummary', inferCounts)}</span>
          </li>
        ) : null}
        {ingestCounts ? (
          <li>
            {t('artifacts.eval.wizard.reviewGrading')}: <span className="text-foreground">{t('artifacts.eval.wizard.ingestReady', { resolved: ingestCounts.resolved, total: ingestCounts.total })}</span>
          </li>
        ) : null}
      </ul>
      <div className="flex justify-end">
        <Button type="button" size="sm" variant="outline" onClick={onReset} data-testid="run-benchmark-wizard-reset">
          {t('artifacts.eval.wizard.resetWizard')}
        </Button>
      </div>
    </div>
  )
}

function LabeledInput({ label, value, onChange, ...props }: { label: string; value: string; onChange(value: string): void } & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>): JSX.Element {
  return (
    <label className="grid gap-1">
      <span className="text-[11px] font-medium text-muted-foreground">{label}</span>
      <Input value={value} onChange={(event) => onChange(event.currentTarget.value)} {...props} />
    </label>
  )
}

const RUN_ID_ADJECTIVES = ['brisk', 'sunny', 'silent', 'bold', 'clever', 'bright', 'mellow', 'swift', 'gentle', 'lucky', 'quiet', 'ruby', 'amber', 'cobalt', 'jade', 'nimble', 'quirky', 'plucky', 'zesty', 'happy']
const RUN_ID_NOUNS = ['otter', 'falcon', 'meadow', 'canyon', 'harbor', 'lantern', 'comet', 'ember', 'willow', 'fjord', 'orchid', 'panda', 'ridge', 'spruce', 'tiger', 'valley', 'aurora', 'quartz', 'zephyr', 'maple']

function generateRunId(): string {
  const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(Math.random() * arr.length)]!
  const suffix = Math.floor(Math.random() * 1000).toString().padStart(3, '0')
  return `${pick(RUN_ID_ADJECTIVES)}-${pick(RUN_ID_NOUNS)}-${suffix}`
}

function LabeledRunIdInput({ label, value, onChange, generateLabel, ...props }: { label: string; value: string; onChange(value: string): void; generateLabel: string } & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>): JSX.Element {
  const testId = (props as { 'data-testid'?: string })['data-testid']
  return (
    <label className="grid gap-1">
      <span className="text-[11px] font-medium text-muted-foreground">{label}</span>
      <div className="flex items-center gap-1">
        <Input value={value} onChange={(event) => onChange(event.currentTarget.value)} {...props} />
        <Button
          type="button"
          size="icon"
          variant="outline"
          className="h-8 w-8 shrink-0"
          onClick={() => onChange(generateRunId())}
          aria-label={generateLabel}
          title={generateLabel}
          data-testid={testId ? `${testId}-generate` : undefined}
        >
          <Dices className="h-4 w-4" />
        </Button>
      </div>
    </label>
  )
}

function compactFormPayload(values: Record<string, string>): Record<string, unknown> {
  const payload: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(values)) {
    const trimmed = value.trim()
    if (!trimmed) continue
    if (key === 'limit' || key === 'maxWorkers' || key === 'timeoutMs') payload[key] = Number(trimmed)
    else if (key === 'instanceIds') payload[key] = trimmed.split(',').map((item) => item.trim()).filter(Boolean)
    else payload[key] = trimmed
  }
  return payload
}

const DEFAULT_UPLOAD_MAX_BYTES = 20 * 1024 * 1024

type UploadFieldValue = {
  mode: 'paste' | 'upload'
  content: string
  filename?: string
  path?: string
}

const EMPTY_UPLOAD: UploadFieldValue = { mode: 'paste', content: '' }

function EnhancementActionPanel({ title, actions, onComplete }: { title: string; actions: readonly EnhancementActionConfig[]; onComplete(): void }): JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [selectedAction, setSelectedAction] = useState(actions[0]?.action ?? '')
  const [values, setValues] = useState<Record<string, string>>({})
  const [uploads, setUploads] = useState<Record<string, UploadFieldValue>>({})
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<EnhancementActionResponse | null>(null)
  const config = actions.find((action) => action.action === selectedAction) ?? actions[0]
  const configAction = config?.action
  const testIdPrefix = `enhancement-action-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`

  useEffect(() => {
    if (!config) return
    const next: Record<string, string> = {}
    const nextUploads: Record<string, UploadFieldValue> = {}
    for (const field of config.fields) {
      if (isUploadField(field)) nextUploads[field.key] = { ...EMPTY_UPLOAD }
      else if (isTextField(field)) next[field.key] = field.defaultValue ?? ''
      else next[field.key] = ''
    }
    setValues(next)
    setUploads(nextUploads)
    setError(null)
    setResult(null)
  }, [configAction])

  if (!config) return <></>

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    const activeConfig = config
    if (!activeConfig) return
    setSubmitting(true)
    setError(null)
    setResult(null)
    const payload: Record<string, unknown> = { action: activeConfig.action }
    for (const field of activeConfig.fields) {
      if (isUploadField(field)) {
        const upload = uploads[field.key] ?? EMPTY_UPLOAD
        if (upload.path && upload.path.trim()) {
          payload[field.key] = upload.path.trim()
        } else if (upload.content && upload.content.length > 0) {
          const max = field.maxBytes ?? DEFAULT_UPLOAD_MAX_BYTES
          const bytes = new Blob([upload.content]).size
          if (bytes > max) {
            setError(t('artifacts.actionPanel.uploadTooLarge', { field: field.label, max: formatBytes(max) }))
            setSubmitting(false)
            return
          }
          payload[field.contentKey] = upload.content
        } else if (field.required) {
          setError(t('artifacts.actionPanel.uploadRequired', { field: field.label }))
          setSubmitting(false)
          return
        }
        continue
      }
      const raw = values[field.key]?.trim() ?? ''
      if (!raw) continue
      if (isTextField(field) && field.boolean) payload[field.key] = raw === 'true'
      else if (isTextField(field) && field.numeric) payload[field.key] = Number(raw)
      else if (isTextField(field) && field.list) payload[field.key] = raw.split(',').map((item) => item.trim()).filter(Boolean)
      else payload[field.key] = raw
    }
    try {
      const res = await fetch('/enhancement/action', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const body = await res.json().catch(() => null) as EnhancementActionResponse | null
      if (!res.ok) throw new Error(body?.error ?? `enhancement action failed: ${res.status}`)
      setResult(body ?? {})
      onComplete()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="mb-3 rounded-md border border-border bg-background/70" data-testid={`enhancement-action-panel-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}>
      <button type="button" className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-xs hover:bg-muted/30" onClick={() => setOpen((value) => !value)} data-testid={`${testIdPrefix}-toggle`}>
        <span className="font-medium">{title}</span>
        <span className="font-mono text-[11px] text-muted-foreground">{open ? t('artifacts.actionPanel.hide') : t('artifacts.actionPanel.show')}</span>
      </button>
      {open ? (
        <form onSubmit={(event) => void submit(event)} className="grid gap-3 border-t border-border p-3 text-xs" data-testid={`${testIdPrefix}-form`}>
          <label className="grid gap-1">
            <span className="text-[11px] font-medium text-muted-foreground">{t('artifacts.actionPanel.action')}</span>
            <select className="h-8 rounded border border-input bg-background px-2 text-sm" value={selectedAction} onChange={(event) => setSelectedAction(event.currentTarget.value)} data-testid={`${testIdPrefix}-select`}>
              {actions.map((action) => <option key={action.action} value={action.action}>{action.label}</option>)}
            </select>
          </label>
          <div className="grid grid-cols-2 gap-2 max-lg:grid-cols-1">
            {config.fields.map((field) => {
              if (isUploadField(field)) {
                return (
                  <UploadFieldControl
                    key={`${config.action}:${field.key}`}
                    field={field}
                    value={uploads[field.key] ?? EMPTY_UPLOAD}
                    onChange={(next) => setUploads((current) => ({ ...current, [field.key]: next }))}
                    testId={`${testIdPrefix}-upload-${field.key}`}
                  />
                )
              }
              const textField = field as TextEnhancementActionField
              return (
                <LabeledInput
                  key={`${config.action}:${field.key}`}
                  label={textField.label}
                  value={values[textField.key] ?? textField.defaultValue ?? ''}
                  onChange={(value) => setValues((current) => ({ ...current, [textField.key]: value }))}
                  required={textField.required}
                  placeholder={textField.placeholder}
                  inputMode={textField.numeric ? 'numeric' : undefined}
                  data-testid={`${testIdPrefix}-field-${textField.key}`}
                />
              )
            })}
          </div>
          {error ? <div className="rounded border border-rose-200 bg-rose-50 px-2 py-1 text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300" data-testid={`${testIdPrefix}-error`}>{error}</div> : null}
          {result ? <div className="rounded border border-emerald-200 bg-emerald-50 px-2 py-1 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300" data-testid={`${testIdPrefix}-result`}>{typeof result.shellCommand === 'string' ? t('artifacts.actionPanel.generated') : t('artifacts.actionPanel.created')}</div> : null}
          <div className="flex justify-end">
            <Button type="submit" size="sm" disabled={submitting} data-testid={`${testIdPrefix}-submit`}>{submitting ? t('artifacts.actionPanel.running') : t('artifacts.actionPanel.runAction')}</Button>
          </div>
        </form>
      ) : null}
    </div>
  )
}

function isUploadField(field: EnhancementActionField): field is UploadEnhancementActionField {
  return (field as { kind?: string }).kind === 'upload'
}

function isTextField(field: EnhancementActionField): field is TextEnhancementActionField {
  const kind = (field as { kind?: string }).kind
  return kind === undefined || kind === 'text'
}

function UploadFieldControl({ field, value, onChange, testId }: { field: UploadEnhancementActionField; value: UploadFieldValue; onChange(next: UploadFieldValue): void; testId: string }): JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="grid gap-1 rounded border border-border bg-background/50 p-2" data-testid={testId}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-medium text-muted-foreground">{field.label}{field.required ? ' *' : ''}</span>
        <div className="flex gap-1">
          <button
            type="button"
            className={`h-6 rounded px-2 text-[11px] ${value.mode === 'paste' ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}`}
            aria-pressed={value.mode === 'paste'}
            onClick={() => onChange({ mode: 'paste', content: value.content, filename: undefined, path: value.path })}
            data-testid={`${testId}-mode-paste`}
          >
            {t('artifacts.actionPanel.uploadPasteTab')}
          </button>
          <button
            type="button"
            className={`h-6 rounded px-2 text-[11px] ${value.mode === 'upload' ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}`}
            aria-pressed={value.mode === 'upload'}
            onClick={() => onChange({ mode: 'upload', content: value.mode === 'upload' ? value.content : '', filename: value.filename, path: value.path })}
            data-testid={`${testId}-mode-upload`}
          >
            {t('artifacts.actionPanel.uploadFileTab')}
          </button>
        </div>
      </div>
      {value.mode === 'paste' ? (
        <textarea
          className="min-h-[60px] w-full rounded border border-input bg-background px-2 py-1 font-mono text-[11px]"
          rows={3}
          placeholder={field.placeholder ?? t('artifacts.actionPanel.uploadPastePlaceholder')}
          value={value.content}
          onChange={(event) => onChange({ mode: 'paste', content: event.currentTarget.value })}
          data-testid={`${testId}-textarea`}
        />
      ) : (
        <div className="grid gap-1">
          <input
            type="file"
            accept={field.accept}
            className="text-[11px]"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0]
              if (!file) {
                onChange({ mode: 'upload', content: '', filename: undefined })
                return
              }
              const reader = new FileReader()
              reader.onload = () => {
                const text = typeof reader.result === 'string' ? reader.result : ''
                onChange({ mode: 'upload', content: text, filename: file.name })
              }
              reader.readAsText(file)
            }}
            data-testid={`${testId}-file`}
          />
          {value.filename ? <span className="font-mono text-[11px] text-muted-foreground" data-testid={`${testId}-filename`}>{value.filename} ({formatBytes(new Blob([value.content]).size)})</span> : null}
        </div>
      )}
    </div>
  )
}

function enhancementResultLabel(result: EnhancementActionResponse): string {
  const keys = ['profilePath', 'auditPath', 'reportPath', 'indexPath', 'graphPath', 'comparisonPath', 'scoresPath', 'adapterPath', 'sidecarPath', 'predictionsPath', 'experimentPath', 'summaryPath', 'resultsPath']
  for (const key of keys) {
    const value = result[key]
    if (typeof value === 'string') return value
  }
  const artifact = asRecord(result.artifact)
  if (typeof artifact.uri === 'string') return artifact.uri
  const trace = asRecord(result.traceArtifact)
  if (typeof trace.uri === 'string') return trace.uri
  if (typeof result.shellCommand === 'string') return result.shellCommand
  return result.action ?? 'artifact'
}

const sessionFields: readonly EnhancementActionField[] = [
  { key: 'sessionId', label: 'Session ID', placeholder: 'current or target session id' },
  { kind: 'upload', key: 'sessionLogPath', contentKey: 'sessionLogContent', label: 'Session Log', accept: '.jsonl,.json,.txt', placeholder: 'paste JSONL or upload file (optional if Session ID set)' },
]

const evalActionConfigs: readonly EnhancementActionConfig[] = [
  { action: 'eval-score-session', label: 'Score session', fields: [...sessionFields, { key: 'instanceId', label: 'Instance ID' }, { kind: 'upload', key: 'patchPath', contentKey: 'patchContent', label: 'Patch', accept: '.diff,.patch,.txt' }, { key: 'requireDone', label: 'Require Done', placeholder: 'true or false', boolean: true }] },
  { action: 'eval-judge-score', label: 'Parse judge score', fields: [{ kind: 'upload', key: 'promptPath', contentKey: 'promptContent', label: 'Prompt', accept: '.txt,.md,.json', required: true }, { kind: 'upload', key: 'responsePath', contentKey: 'responseContent', label: 'Response', accept: '.txt,.md,.json', required: true }, { key: 'judgeModel', label: 'Judge Model', required: true }, { key: 'scorer', label: 'Scorer' }, { key: 'instanceId', label: 'Instance ID' }, { key: 'threshold', label: 'Threshold', numeric: true }, { key: 'inputRef', label: 'Input Ref' }] },
  { action: 'eval-compare-runs', label: 'Compare eval runs', fields: [{ kind: 'upload', key: 'baselineSummaryPath', contentKey: 'baselineSummaryContent', label: 'Baseline Summary', accept: '.json', required: true }, { kind: 'upload', key: 'candidateSummaryPath', contentKey: 'candidateSummaryContent', label: 'Candidate Summary', accept: '.json', required: true }] },
  { action: 'eval-regression-gate', label: 'Regression gate', fields: [{ kind: 'upload', key: 'baselineSummaryPath', contentKey: 'baselineSummaryContent', label: 'Baseline Summary', accept: '.json', required: true }, { kind: 'upload', key: 'candidateSummaryPath', contentKey: 'candidateSummaryContent', label: 'Candidate Summary', accept: '.json', required: true }, { key: 'minPassRate', label: 'Min Pass Rate', numeric: true }, { key: 'maxPassRateDrop', label: 'Max Pass Rate Drop', numeric: true }, { key: 'maxFailedIncrease', label: 'Max Failed Increase', numeric: true }, { key: 'maxTimeoutIncrease', label: 'Max Timeout Increase', numeric: true }, { key: 'maxResolvedDrop', label: 'Max Resolved Drop', numeric: true }, { key: 'outputFilename', label: 'Output Filename' }] },
  { action: 'swebench-export-session', label: 'SWE-bench export session', fields: [...sessionFields, { key: 'runId', label: 'Run ID', required: true }, { key: 'dataset', label: 'Dataset', required: true, defaultValue: 'SWE-bench/SWE-bench_Verified' }, { key: 'split', label: 'Split' }, { key: 'model', label: 'Model', required: true }, { key: 'instanceId', label: 'Instance ID', required: true }, { kind: 'upload', key: 'modelPatchPath', contentKey: 'modelPatchContent', label: 'Model Patch', accept: '.diff,.patch,.txt', required: true }] },
]

const profileActionConfigs: readonly EnhancementActionConfig[] = [
  { action: 'profile-session', label: 'Profile session', fields: sessionFields },
  { action: 'profile-aggregate', label: 'Aggregate profiles', fields: [{ kind: 'upload', key: 'summaryPath', contentKey: 'summaryContent', label: 'Summary', accept: '.json' }, { key: 'outputFilename', label: 'Output Filename' }] },
  { action: 'profile-budget', label: 'Budget check', fields: [
    { kind: 'upload', key: 'profilePath', contentKey: 'profileContent', label: 'Profile', accept: '.json', required: true },
    { key: 'maxInputTokens', label: 'Max Input Tokens', numeric: true },
    { key: 'maxOutputTokens', label: 'Max Output Tokens', numeric: true },
    { key: 'maxTotalTokens', label: 'Max Total Tokens', numeric: true },
    { key: 'maxLlmCalls', label: 'Max LLM Calls', numeric: true },
    { key: 'maxToolCalls', label: 'Max Tool Calls', numeric: true },
    { key: 'maxToolErrors', label: 'Max Tool Errors', numeric: true },
    { key: 'maxWallTimeMs', label: 'Max Wall Time (ms)', numeric: true },
    { key: 'maxP95LlmDurationMs', label: 'Max P95 LLM Duration (ms)', numeric: true },
    { key: 'maxP95TimeToFirstChunkMs', label: 'Max P95 TTFT (ms)', numeric: true },
    { key: 'maxAverageLlmDurationMs', label: 'Max Avg LLM Duration (ms)', numeric: true },
    { key: 'maxAverageTimeToFirstChunkMs', label: 'Max Avg TTFT (ms)', numeric: true },
    { key: 'maxMissingUsageCalls', label: 'Max Missing Usage Calls', numeric: true },
    { key: 'maxLlmTraceMissingCalls', label: 'Max Missing Trace Calls', numeric: true },
    { key: 'outputFilename', label: 'Output Filename' },
  ] },
]

const memoryActionConfigs: readonly EnhancementActionConfig[] = [
  { action: 'memory-index', label: 'Build memory index', fields: [{ key: 'includeGlobal', label: 'Include Global', placeholder: 'true or false', boolean: true }] },
  { action: 'memory-retrieve', label: 'Retrieve memory (lexical)', fields: [
    { key: 'query', label: 'Query', required: true },
    { key: 'includeGlobal', label: 'Include Global', placeholder: 'true or false', boolean: true },
    { key: 'maxTokens', label: 'Max Tokens', placeholder: '2048', numeric: true },
    { key: 'maxHits', label: 'Max Hits', placeholder: '8', numeric: true },
    { key: 'outputFilename', label: 'Output Filename' },
  ] },
]

const opsActionConfigs: readonly EnhancementActionConfig[] = [
  { action: 'reliability-audit-session', label: 'Audit session reliability', fields: sessionFields },
  { action: 'reliability-chaos-replay', label: 'Replay reliability chaos', fields: [{ key: 'sessionLogPaths', label: 'Session Log Paths', required: true, placeholder: 'comma separated paths', list: true }] },
  { action: 'reliability-gate', label: 'Reliability gate', fields: [
    { kind: 'upload', key: 'chaosReportPath', contentKey: 'chaosReportContent', label: 'Chaos Report', accept: '.json' },
    { key: 'sessionLogPaths', label: 'Session Log Paths', placeholder: 'comma separated (if no chaos report)', list: true },
    { key: 'maxDanglingCount', label: 'Max Dangling Count', numeric: true },
    { key: 'minRecoverableRatio', label: 'Min Recoverable Ratio', numeric: true },
    { key: 'maxRecoveryEventCount', label: 'Max Recovery Event Count', numeric: true },
    { key: 'requireStatusIn', label: 'Require Status In', placeholder: 'comma separated (e.g. idle,done)', list: true },
    { key: 'outputFilename', label: 'Output Filename' },
  ] },
  { action: 'reliability-classify', label: 'Crash-kill classify', fields: [
    ...sessionFields,
    { kind: 'upload', key: 'heartbeatPath', contentKey: 'heartbeatContent', label: 'Heartbeat', accept: '.jsonl', required: true },
    { key: 'wedgedThresholdMs', label: 'Wedged Threshold (ms)', numeric: true },
    { key: 'outputFilename', label: 'Output Filename' },
  ] },
  { action: 'tool-catalog-diff', label: 'Tool catalog diff', fields: [
    { kind: 'upload', key: 'baselineCatalogPath', contentKey: 'baselineCatalogContent', label: 'Baseline Catalog', accept: '.json,.jsonl', required: true },
    { kind: 'upload', key: 'candidateCatalogPath', contentKey: 'candidateCatalogContent', label: 'Candidate Catalog', accept: '.json,.jsonl', required: true },
    { key: 'outputFilename', label: 'Output Filename' },
  ] },
  { action: 'executor-capabilities-snapshot', label: 'Executor capabilities snapshot', fields: [
    { key: 'outputFilename', label: 'Output Filename' },
  ] },
  { action: 'trace-export-session', label: 'Export trace', fields: [...sessionFields, { key: 'runId', label: 'Run ID' }, { key: 'evalInstanceId', label: 'Eval Instance ID' }] },
  { action: 'rollout-export-segments', label: 'Export rollout segments', fields: [...sessionFields, { key: 'runId', label: 'Run ID' }, { key: 'evalInstanceId', label: 'Eval Instance ID' }] },
  { action: 'rollout-export-session', label: 'Export rollout sidecar', fields: [...sessionFields, { key: 'taskId', label: 'Task ID', required: true }, { key: 'frameworkTarget', label: 'Framework', required: true, placeholder: 'slime, verl, trl, openrlhf, unknown' }, { key: 'model', label: 'Model' }, { key: 'weightVersion', label: 'Weight Version' }, { kind: 'upload', key: 'rewardPath', contentKey: 'rewardContent', label: 'Reward', accept: '.json' }, { kind: 'upload', key: 'tokenSegmentsPath', contentKey: 'tokenSegmentsContent', label: 'Token Segments', accept: '.jsonl,.json' }] },
  { action: 'rollout-export-adapter', label: 'Export rollout adapter', fields: [{ kind: 'upload', key: 'sidecarPath', contentKey: 'sidecarContent', label: 'Sidecar', accept: '.json', required: true }, { key: 'frameworkTarget', label: 'Framework', placeholder: 'slime, verl, trl, openrlhf, unknown' }] },
  { action: 'rollout-verify-reward', label: 'Verify rollout reward', fields: [
    { kind: 'upload', key: 'trialPath', contentKey: 'trialContent', label: 'Trial', accept: '.json', placeholder: 'or provide score below' },
    { kind: 'upload', key: 'scorePath', contentKey: 'scoreContent', label: 'Score', accept: '.json', placeholder: 'or provide trial above' },
    { key: 'taskId', label: 'Task ID', placeholder: 'defaults to instance id' },
    { key: 'sessionId', label: 'Session ID' },
  ] },
  { action: 'subagents-graph', label: 'Export subagent graph', fields: [] },
  { action: 'trace-export-otlp', label: 'Export OTLP trace', fields: [
    ...sessionFields,
    { key: 'runId', label: 'Run ID' },
    { key: 'evalInstanceId', label: 'Eval Instance ID' },
    { key: 'endpoint', label: 'OTLP Endpoint', placeholder: 'https://collector.example.com/v1/traces (blank writes bundle only)' },
    { key: 'headers', label: 'Headers', placeholder: 'e.g. authorization=Bearer xyz, X-Team=ml (comma separated key=value)' },
    { kind: 'upload', key: 'headersFilePath', contentKey: 'headersFileContent', label: 'Headers File', accept: '.json' },
    { key: 'retries', label: 'Retries', numeric: true },
    { key: 'retryDelayMs', label: 'Retry Delay (ms)', numeric: true },
    { key: 'timeoutMs', label: 'Timeout (ms)', numeric: true },
    { key: 'serviceName', label: 'Service Name' },
    { key: 'hostVersion', label: 'Host Version' },
    { key: 'outputFilename', label: 'Output Filename' },
  ] },
  { action: 'artifacts-manifest', label: 'Rebuild artifact manifest', fields: [
    { key: 'maxHashBytes', label: 'Max Hash Bytes', numeric: true, placeholder: 'default 25 MiB' },
  ] },
  { action: 'artifacts-prune', label: 'Prune artifact retention', fields: [
    { key: 'olderThanDays', label: 'Older Than (days)', numeric: true },
    { key: 'maxTotalBytes', label: 'Max Total Bytes', numeric: true, placeholder: 'oldest-first eviction' },
    { key: 'kinds', label: 'Kinds', placeholder: 'comma separated (e.g. profile,rollout,score)', list: true },
    { key: 'dryRun', label: 'Dry Run', placeholder: 'true or false', boolean: true },
  ] },
]

function EvalWorkerPlansPanel({ plans, onOpenArtifact }: { plans: readonly EvalWorkerPlanRow[]; onOpenArtifact(request: ArtifactDetailRequest): void }): JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="min-h-0 rounded-md border border-border">
      <div className="border-b border-border bg-muted/40 px-3 py-2 text-xs font-medium text-muted-foreground">{t('artifacts.eval.details.workerPlans')}</div>
      <div className="max-h-52 divide-y divide-border overflow-auto text-xs">
        {plans.map((row) => {
          const shards = row.plan.shards ?? []
          const warnings = row.plan.warnings ?? []
          const hints = row.plan.resourceHints ?? {}
          return (
            <button key={row.path} type="button" onClick={() => onOpenArtifact({ path: row.path, label: row.path })} className="grid w-full grid-cols-[1fr_110px_120px_1.1fr] gap-3 px-3 py-2 text-left hover:bg-muted/30 max-lg:grid-cols-[1fr_100px]">
              <div className="min-w-0">
                <div className="truncate font-mono text-[11px]">{row.plan.runId ?? row.path}</div>
                <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{row.plan.dataset ?? 'dataset unknown'} / {row.plan.model ?? 'model unknown'}</div>
              </div>
              <div className="font-mono text-[11px]">{t('artifacts.eval.wizard.instancesCount', { count: row.plan.selectedCount ?? 0 })}</div>
              <div className="font-mono text-[11px]">{t('artifacts.eval.wizard.workersShards', { workers: row.plan.maxWorkers ?? shards.length, shards: shards.length })}</div>
              <div className="min-w-0">
                <div className="truncate font-mono text-[11px]">{hints.workspaceIsolation ?? 'isolation unknown'} / max {hints.maxConcurrentWorkspaces ?? '-'}</div>
                <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{warnings.length > 0 ? warnings.join(', ') : hints.dockerRequired ? t('artifacts.eval.details.dockerRequired') : row.path}</div>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function EvalScoresPanel({ scores, judges, onOpenArtifact }: { scores: readonly EvalScoreRow[]; judges: readonly EvalJudgeRow[]; onOpenArtifact(request: ArtifactDetailRequest): void }): JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="min-h-0 rounded-md border border-border">
      <div className="border-b border-border bg-muted/40 px-3 py-2 text-xs font-medium text-muted-foreground">{t('artifacts.eval.details.scoreArtifacts')}</div>
      <div className="max-h-52 divide-y divide-border overflow-auto text-xs">
        {scores.map((row) => (
          <button key={row.path} type="button" onClick={() => onOpenArtifact({ path: row.path, label: row.path })} className="grid w-full grid-cols-[1fr_90px_90px_1fr] gap-3 px-3 py-2 text-left hover:bg-muted/30">
            <div className="min-w-0">
              <div className="truncate font-mono text-[11px]">{row.summary.instanceId ?? row.path}</div>
              <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{row.path}</div>
            </div>
            <ResultPill resolved={row.summary.resolved} />
            <div className="font-mono text-[11px]">{formatPercent(row.summary.score)}</div>
            <div className="truncate font-mono text-[11px] text-muted-foreground">{row.summary.failureLabel ?? row.summary.results?.[0]?.scorer ?? '-'}</div>
          </button>
        ))}
        {judges.map((row) => (
          <button key={row.path} type="button" onClick={() => onOpenArtifact({ path: row.path, label: row.path })} className="grid w-full grid-cols-[1fr_120px_90px_1fr] gap-3 px-3 py-2 text-left hover:bg-muted/30">
            <div className="min-w-0">
              <div className="truncate font-mono text-[11px]">{row.trace.scorer ?? row.path}</div>
              <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{row.path}</div>
            </div>
            <div className="truncate font-mono text-[11px]">{row.trace.judgeModel ?? 'judge'}</div>
            <div className="font-mono text-[11px]">{formatPercent(row.trace.parsed?.score)}</div>
            <div className="truncate text-[11px] text-muted-foreground">{row.trace.parsed?.explanation ?? row.trace.inputRef ?? '-'}</div>
          </button>
        ))}
      </div>
    </div>
  )
}

function ComparisonDeltaBars({ comparison }: { comparison: EvalRunComparison }): JSX.Element {
  const { t } = useTranslation()
  const deltas = [
    { label: t('artifacts.eval.details.delta.resolved'), value: comparison.deltas?.resolved ?? 0, invert: false, percent: false },
    { label: t('artifacts.eval.details.delta.failed'), value: comparison.deltas?.failed ?? 0, invert: true, percent: false },
    { label: t('artifacts.eval.details.delta.timeout'), value: comparison.deltas?.timedOut ?? 0, invert: true, percent: false },
    { label: t('artifacts.eval.details.delta.passRate'), value: comparison.deltas?.passRate ?? 0, invert: false, percent: true },
  ]
  const max = Math.max(0.01, ...deltas.map((delta) => Math.abs(delta.value)))
  return (
    <div className="grid grid-cols-4 gap-2 max-lg:grid-cols-2" aria-label={t('artifacts.eval.details.comparisonDeltaChart')}>
      {deltas.map((delta) => {
        const good = delta.invert ? delta.value < 0 : delta.value > 0
        const bad = delta.invert ? delta.value > 0 : delta.value < 0
        return (
          <div key={delta.label} className="min-w-0 rounded border border-border bg-background/60 px-2 py-1">
            <div className="mb-1 flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
              <span className="truncate">{delta.label}</span>
              <span className={cn('font-mono', good && 'text-emerald-600 dark:text-emerald-300', bad && 'text-rose-600 dark:text-rose-300')}>
                {formatDeltaValue(delta.value, delta.percent)}
              </span>
            </div>
            <div className="relative h-1.5 overflow-hidden rounded bg-muted">
              <div className="absolute left-1/2 top-0 h-full w-px bg-border" />
              <div
                className={cn('absolute top-0 h-full', good ? 'bg-emerald-500' : bad ? 'bg-rose-500' : 'bg-muted-foreground/40')}
                style={delta.value >= 0
                  ? { left: '50%', width: `${Math.min(50, (Math.abs(delta.value) / max) * 50)}%` }
                  : { right: '50%', width: `${Math.min(50, (Math.abs(delta.value) / max) * 50)}%` }}
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}

function EvalScorecard({ rows, selectedRun }: { rows: readonly EvalRunRow[]; selectedRun: EvalRunRow | undefined }): JSX.Element | null {
  const { t } = useTranslation()
  if (rows.length === 0) return null
  const totals = rows.reduce((acc, row) => {
    acc.trials += row.summary?.trialCount ?? row.progress?.selectedCount ?? 0
    acc.resolved += row.summary?.resolved ?? 0
    acc.failed += row.summary?.failed ?? row.progress?.failedCount ?? 0
    acc.timedOut += row.summary?.timedOut ?? row.progress?.timedOutCount ?? 0
    return acc
  }, { trials: 0, resolved: 0, failed: 0, timedOut: 0 })
  const selectedPassRate = selectedRun ? selectedRun.summary?.metrics?.passRate : undefined
  return (
    <div className="grid grid-cols-5 gap-2 text-xs max-xl:grid-cols-3 max-md:grid-cols-2">
      <Stat label={t('artifacts.eval.scorecard.runs')} value={String(rows.length)} />
      <Stat label={t('artifacts.eval.scorecard.trials')} value={formatInteger(totals.trials)} />
      <Stat label={t('artifacts.eval.scorecard.resolved')} value={formatInteger(totals.resolved)} />
      <Stat label={t('artifacts.eval.scorecard.failed')} value={formatInteger(totals.failed + totals.timedOut)} />
      <Stat label={t('artifacts.eval.scorecard.selectedPass')} value={formatPercent(selectedPassRate)} />
    </div>
  )
}

function FailureDeltaChips({ deltas }: { deltas: Record<string, number> | undefined }): JSX.Element {
  const { t } = useTranslation()
  const entries = deltas
    ? Object.entries(deltas).filter(([, value]) => typeof value === 'number' && Number.isFinite(value) && value !== 0)
      .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]) || a[0].localeCompare(b[0]))
      .slice(0, 3)
    : []
  if (entries.length === 0) return <div className="truncate text-[11px] text-muted-foreground">{t('artifacts.eval.details.noFailureDeltas')}</div>
  return (
    <div className="flex min-w-0 flex-wrap gap-1">
      {entries.map(([label, value]) => (
        <span key={label} className={cn('max-w-full truncate rounded border px-1.5 py-0.5 font-mono text-[10px]', value < 0 ? 'border-emerald-200 text-emerald-700 dark:border-emerald-900 dark:text-emerald-300' : 'border-rose-200 text-rose-700 dark:border-rose-900 dark:text-rose-300')} title={`${label} ${value > 0 ? '+' : ''}${value}`}>
          {label} {value > 0 ? '+' : ''}{value}
        </span>
      ))}
    </div>
  )
}

function EvalTrialDetail({
  run,
  trials,
  selectedTrial,
  selectedTrialId,
  onSelectTrial,
  loading,
  error,
  onOpenArtifact,
  onOpenSession,
}: {
  run: EvalRunRow
  trials: readonly EvalTrialRow[]
  selectedTrial: EvalTrialRow | undefined
  selectedTrialId: string | null
  onSelectTrial(id: string): void
  loading: boolean
  error: string | null
  onOpenArtifact(request: ArtifactDetailRequest): void
  onOpenSession?(sessionId: string): void
}): JSX.Element {
  const { t } = useTranslation()
  const artifactGroups = selectedTrial
    ? groupTrialArtifacts(run.root, selectedTrial.trial.artifacts ?? [])
    : []
  const primaryArtifacts = artifactGroups
    .flatMap((group) => group.items)
    .filter((item) => item.category === 'patch' || item.category === 'trace' || item.category === 'harness')
  return (
    <div className="grid min-h-0 grid-cols-[minmax(0,1fr)_280px] overflow-hidden rounded-md border border-border max-xl:grid-cols-1">
      <div className="min-h-0 border-r border-border max-xl:border-b max-xl:border-r-0">
        <div className="flex items-center justify-between gap-2 border-b border-border bg-muted/40 px-3 py-2 text-xs">
          <div className="min-w-0">
            <div className="font-medium">{t('artifacts.eval.details.trialDetail')}</div>
          </div>
          {loading ? <div className="text-[11px] text-muted-foreground">{t('artifacts.eval.details.loading')}</div> : null}
        </div>
        {error ? <div className="m-3 rounded-md border border-rose-200 bg-rose-50 p-2 text-xs text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">{error}</div> : null}
        {!loading && trials.length === 0 && !error ? <div className="p-3 text-xs text-muted-foreground">{t('artifacts.eval.noTrials')}</div> : null}
        {trials.length > 0 ? (
          <ScrollArea className="h-full">
            <div className="min-w-[720px] divide-y divide-border text-xs">
              <div className="grid grid-cols-[1.2fr_110px_90px_120px_90px_80px] gap-3 bg-muted/20 px-3 py-2 font-medium text-muted-foreground">
                <div>{t('artifacts.eval.columns.instance')}</div>
                <div>{t('artifacts.eval.columns.status')}</div>
                <div>{t('artifacts.eval.columns.result')}</div>
                <div>{t('artifacts.eval.columns.failure')}</div>
                <div>{t('artifacts.eval.columns.duration')}</div>
                <div>{t('artifacts.eval.columns.patch')}</div>
              </div>
              {trials.map((row) => {
                const id = trialStableId(row)
                return (
                  <button
                    key={row.path}
                    type="button"
                    className={cn('grid w-full grid-cols-[1.2fr_110px_90px_120px_90px_80px] gap-3 px-3 py-2 text-left transition-colors hover:bg-muted/30', selectedTrialId === id && 'bg-primary/10 dark:bg-primary/10')}
                    onClick={() => onSelectTrial(id)}
                  >
                    <div className="min-w-0">
                      <div className="truncate font-mono text-[11px]">{trialInstanceId(row)}</div>
                      <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{row.path}</div>
                    </div>
                    <div className="truncate font-mono text-[11px]">{row.trial.status ?? 'unknown'}</div>
                    <ResultPill resolved={row.trial.resolved} />
                    <div className="truncate font-mono text-[11px] text-muted-foreground">{row.trial.failureLabel ?? '-'}</div>
                    <div className="font-mono text-[11px]">{formatDuration(row.trial.metrics?.durationMs)}</div>
                    <div className="font-mono text-[11px]">{formatBytesMetric(row.trial.metrics?.patchBytes)}</div>
                  </button>
                )
              })}
            </div>
          </ScrollArea>
        ) : null}
      </div>
      <aside className="min-h-0 bg-muted/20 p-3">
        {selectedTrial ? (
          <div className="grid gap-3 text-xs">
            <div>
              <div className="mb-1 text-[11px] font-medium uppercase text-muted-foreground">{t('artifacts.eval.details.selectedInstance')}</div>
              <div className="break-all font-mono text-[11px]">{trialInstanceId(selectedTrial)}</div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Stat label={t('artifacts.eval.details.artifacts')} value={String(selectedTrial.trial.artifacts?.length ?? 0)} />
              <Stat label="Session" value={selectedTrial.trial.sessionId ? 'linked' : 'none'} />
            </div>
            {selectedTrial.trial.sessionId ? (
              <button
                type="button"
                onClick={() => onOpenSession?.(selectedTrial.trial.sessionId!)}
                disabled={!onOpenSession}
                className="min-w-0 rounded-md border border-border bg-background px-2 py-1.5 text-left transition-colors hover:bg-muted/40 disabled:cursor-default disabled:opacity-60 disabled:hover:bg-background"
              >
                <div className="text-[11px] font-medium uppercase text-muted-foreground">{t('artifacts.eval.details.linkedSession')}</div>
                <div className="truncate font-mono text-[11px]" title={selectedTrial.trial.sessionId}>{selectedTrial.trial.sessionId}</div>
              </button>
            ) : null}
            {primaryArtifacts.length > 0 ? (
              <div className="grid grid-cols-2 gap-1.5">
                {primaryArtifacts.slice(0, 4).map((item) => (
                  <button
                    key={`${item.path ?? item.title}-primary`}
                    type="button"
                    disabled={!item.path}
                    onClick={() => item.path && onOpenArtifact({ path: item.path, label: item.title })}
                    className="min-w-0 rounded-md border border-border bg-background px-2 py-1.5 text-left text-[11px] transition-colors hover:bg-muted/40 disabled:cursor-default disabled:opacity-60 disabled:hover:bg-background"
                  >
                    <div className="truncate font-medium">{trialArtifactCategoryLabel(item.category)}</div>
                    <div className="truncate font-mono text-muted-foreground" title={item.title}>{item.title}</div>
                  </button>
                ))}
              </div>
            ) : null}
            <div className="rounded-md border border-border bg-background/70">
              <div className="border-b border-border px-2 py-1.5 text-[11px] font-medium uppercase text-muted-foreground">{t('artifacts.eval.details.artifacts')}</div>
              <div className="max-h-64 overflow-auto p-2">
                {artifactGroups.length > 0 ? (
                  <div className="grid gap-2">
                    {artifactGroups.map((group) => (
                      <div key={group.category} className="grid gap-1">
                        <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                          <span className="font-medium uppercase">{group.label}</span>
                          <span className="font-mono">{group.items.length}</span>
                        </div>
                        <div className="grid gap-1.5">
                          {group.items.map((item, index) => (
                            <button
                              key={`${item.path ?? item.title}-${index}`}
                              type="button"
                              disabled={!item.path}
                              onClick={() => item.path && onOpenArtifact({ path: item.path, label: item.title })}
                              className="min-w-0 rounded border border-border bg-muted/20 px-2 py-1 text-left transition-colors hover:bg-muted/40 disabled:cursor-default disabled:hover:bg-muted/20"
                            >
                              <div className="flex items-center gap-1.5">
                                <FileText className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
                                <span className="truncate font-mono text-[11px]" title={item.title}>{item.title}</span>
                              </div>
                              <div className="mt-0.5 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                                <span className="truncate">{item.meta}</span>
                                <span>{typeof item.artifact.bytes === 'number' ? formatBytes(item.artifact.bytes) : ''}</span>
                              </div>
                            </button>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : <div className="text-[11px] text-muted-foreground">{t('artifacts.eval.details.noArtifactRefs')}</div>}
              </div>
            </div>
          </div>
        ) : <div className="text-xs text-muted-foreground">{t('artifacts.eval.details.selectTrial')}</div>}
      </aside>
    </div>
  )
}

function EvalProgressStrip({ run }: { run: EvalRunRow }): JSX.Element | null {
  const { t } = useTranslation()
  const progress = run.progress
  if (!progress) return null
  const total = progress.selectedCount ?? progress.instances?.length ?? 0
  return (
    <div className="rounded-md border border-border bg-muted/20 p-2 text-xs">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="font-medium">{t('artifacts.eval.details.progress')}</div>
        </div>
        <div className={cn('rounded border px-2 py-0.5 font-mono text-[11px]', progress.status === 'failed' ? 'border-rose-200 text-rose-700 dark:border-rose-900 dark:text-rose-300' : 'border-border text-muted-foreground')}>
          {progress.status ?? 'unknown'}
        </div>
      </div>
      <div className="grid grid-cols-4 gap-2 max-lg:grid-cols-2">
        <Stat label="Selected" value={String(total)} />
        <Stat label="Running" value={String(progress.runningCount ?? 0)} />
        <Stat label="Skipped" value={String(progress.skippedCount ?? 0)} />
        <Stat label="Workers" value={String(progress.maxWorkers ?? 1)} />
      </div>
      <ProgressBar
        total={total}
        completed={progress.completedCount ?? 0}
        failed={progress.failedCount ?? 0}
        timedOut={progress.timedOutCount ?? 0}
        skipped={progress.skippedCount ?? 0}
      />
    </div>
  )
}

function ProgressBar({
  total,
  completed,
  failed,
  timedOut,
  skipped,
}: {
  total: number
  completed: number
  failed: number
  timedOut: number
  skipped: number
}): JSX.Element {
  const denominator = Math.max(1, total)
  const segments = [
    { key: 'completed', value: completed, className: 'bg-emerald-500' },
    { key: 'failed', value: failed, className: 'bg-rose-500' },
    { key: 'timedOut', value: timedOut, className: 'bg-amber-500' },
    { key: 'skipped', value: skipped, className: 'bg-slate-400' },
  ]
  return (
    <div className="mt-2 h-2 overflow-hidden rounded bg-muted">
      <div className="flex h-full w-full">
        {segments.map((segment) => segment.value > 0 ? (
          <div key={segment.key} className={segment.className} style={{ width: `${Math.max(4, (segment.value / denominator) * 100)}%` }} />
        ) : null)}
      </div>
    </div>
  )
}

function FailureBreakdown({ run }: { run: EvalRunRow }): JSX.Element | null {
  const { t } = useTranslation()
  const counts = run.summary?.failureCounts
  const entries: Array<[string, number]> = counts
    ? Object.entries(counts)
      .filter(([, count]) => typeof count === 'number' && Number.isFinite(count) && count > 0)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    : []
  if (entries.length === 0) return null
  const total = entries.reduce((sum, [, count]) => sum + count, 0)
  return (
    <div className="rounded-md border border-border bg-muted/20 p-2 text-xs">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="font-medium">{t('artifacts.eval.details.failureBreakdown')}</div>
        <div className="font-mono text-[11px] text-muted-foreground">{total} labeled</div>
      </div>
      <div className="grid gap-1.5">
        {entries.slice(0, 6).map(([label, count]) => (
          <div key={label} className="grid grid-cols-[140px_minmax(0,1fr)_52px] items-center gap-2">
            <div className="truncate font-mono text-[11px]" title={label}>{label}</div>
            <div className="h-1.5 overflow-hidden rounded bg-muted">
              <div className="h-full bg-rose-500" style={{ width: `${Math.max(5, (count / Math.max(1, total)) * 100)}%` }} />
            </div>
            <div className="text-right font-mono text-[11px] text-muted-foreground">{count}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

function SubAgentUsagePanel({ run }: { run: EvalRunRow }): JSX.Element | null {
  const { t } = useTranslation()
  const usage = run.summary?.subagentUsage
  if (!usage) return null
  const total = usage.totalCount ?? 0
  if (total <= 0 && (usage.trialsWithSubagents ?? 0) <= 0) return null
  const passRate =
    usage.trialsWithSubagents && usage.trialsWithSubagents > 0
      ? (usage.resolvedWithSubagents ?? 0) / usage.trialsWithSubagents
      : undefined
  return (
    <div
      className="rounded-md border border-border bg-muted/20 p-2 text-xs"
      data-testid="eval-subagent-usage"
    >
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="font-medium">{t('artifacts.eval.details.subAgentUsage')}</div>
        <div className="font-mono text-[11px] text-muted-foreground">{total} spawned</div>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <UsageStat label="trials w/ sub" value={String(usage.trialsWithSubagents ?? 0)} />
        <UsageStat label="max depth" value={String(usage.maxDepth ?? 0)} />
        <UsageStat label="mean / trial" value={(usage.perTrialMean ?? 0).toFixed(2)} />
        <UsageStat
          label="resolved w/ sub"
          value={
            passRate === undefined
              ? `${usage.resolvedWithSubagents ?? 0}`
              : `${usage.resolvedWithSubagents ?? 0} (${Math.round(passRate * 100)}%)`
          }
        />
      </div>
    </div>
  )
}

function UsageStat({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="rounded border border-border/60 bg-background/60 px-2 py-1">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="font-mono text-[12px]">{value}</div>
    </div>
  )
}

function SubAgentUsageDeltaPanel({
  delta,
}: {
  delta: EvalRunComparison['subagentUsageDelta']
}): JSX.Element | null {
  const { t } = useTranslation()
  if (!delta) return null
  const noUsageOnEitherSide = delta.baseline === null && delta.candidate === null
  if (noUsageOnEitherSide) return null
  const baselineCount = delta.baseline?.totalCount ?? 0
  const candidateCount = delta.candidate?.totalCount ?? 0
  return (
    <div
      className="rounded-md border border-border bg-muted/20 p-2 text-xs"
      data-testid="eval-subagent-usage-delta"
    >
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="font-medium">{t('artifacts.eval.details.subAgentUsageDelta')}</div>
        <div className="font-mono text-[11px] text-muted-foreground">
          {baselineCount} → {candidateCount}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <DeltaStat label="spawned Δ" value={delta.totalCount} />
        <DeltaStat label="trials w/ sub Δ" value={delta.trialsWithSubagents} />
        <DeltaStat label="max depth Δ" value={delta.maxDepth} />
        <DeltaStat label="resolved w/ sub Δ" value={delta.resolvedWithSubagents} />
      </div>
    </div>
  )
}

function DeltaStat({ label, value }: { label: string; value: number }): JSX.Element {
  const arrow = value > 0 ? '+' : value < 0 ? '' : ''
  const tone = value > 0 ? 'text-emerald-500' : value < 0 ? 'text-rose-500' : 'text-muted-foreground'
  return (
    <div className="rounded border border-border/60 bg-background/60 px-2 py-1">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={`font-mono text-[12px] ${tone}`}>
        {arrow}
        {value}
      </div>
    </div>
  )
}

function ArtifactContentDialog({
  request,
  onOpenChange,
}: {
  request: ArtifactDetailRequest | null
  onOpenChange(open: boolean): void
}): JSX.Element {
  const { t } = useTranslation()
  const [content, setContent] = useState<ArtifactContentResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!request) return
    let cancelled = false
    setLoading(true)
    setError(null)
    setContent(null)
    void fetchArtifactContent(request.path)
      .then((next) => {
        if (!cancelled) setContent(next)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [request])

  return (
    <Dialog open={Boolean(request)} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(720px,86dvh)] w-[min(980px,94vw)] max-w-none flex-col overflow-hidden p-0 gap-0">
        <DialogHeader className="border-b border-border px-4 py-3">
          <DialogTitle>{t('artifacts.detail.title')}</DialogTitle>
          <DialogDescription className="truncate font-mono text-xs">{request?.label ?? ''}</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 p-3">
          {loading ? <div className="text-xs text-muted-foreground">{t('artifacts.detail.loading')}</div> : null}
          {error ? <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">{error}</div> : null}
          {content ? <ArtifactBody content={content} /> : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function ArtifactBody({ content }: { content: ArtifactContentResponse }): JSX.Element {
  if (content.mediaType.startsWith('application/json')) {
    return <JsonBlock label={content.path} value={content.body} collapsed={2} className="h-full [&>div:last-child]:max-h-[calc(86dvh-150px)] [&_[data-radix-scroll-area-viewport]]:max-h-[calc(86dvh-150px)]" />
  }
  return (
    <ScrollArea className="h-full rounded-md border border-border bg-muted/30">
      <pre className="whitespace-pre-wrap break-words p-3 font-mono text-xs leading-relaxed">{String(content.body)}</pre>
    </ScrollArea>
  )
}

function ProfilesView({
  manifest,
  rows,
  error,
  loading,
  onArtifactActionComplete,
}: {
  manifest: ArtifactManifest | null
  rows: readonly ProfileRow[]
  error: string | null
  loading: boolean
  onArtifactActionComplete(): void
}): JSX.Element {
  const { t } = useTranslation()
  const totals = rows.reduce((acc, row) => {
    acc.llmCalls += row.profile.llmCalls ?? 0
    acc.toolCalls += row.profile.toolCalls ?? 0
    acc.inputTokens += row.profile.totalInputTokens ?? 0
    acc.outputTokens += row.profile.totalOutputTokens ?? 0
    acc.latencyCalls += row.profile.llmLatencyCalls ?? 0
    return acc
  }, { llmCalls: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, latencyCalls: 0 })
  return (
    <div className="grid min-h-0 flex-1 grid-cols-[260px_minmax(0,1fr)] gap-0 max-md:grid-cols-1">
      <aside className="min-h-0 border-r border-border bg-muted/25 p-3 max-md:border-b max-md:border-r-0">
        <div className="grid gap-2 text-xs">
          <Stat label={t('artifacts.profiles.profiles')} value={String(rows.length)} />
          <Stat label="LLM calls" value={String(totals.llmCalls)} />
          <Stat label="Tool calls" value={String(totals.toolCalls)} />
          <Stat label="Input tokens" value={formatInteger(totals.inputTokens)} />
          <Stat label="Output tokens" value={formatInteger(totals.outputTokens)} />
          <Stat label="Latency calls" value={String(totals.latencyCalls)} />
          <Stat label="Artifacts" value={String(manifest?.summary.entryCount ?? 0)} />
        </div>
      </aside>
      <div className="min-h-0 p-3">
        {error ? (
          <div className="mb-3 rounded-md border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
            {error}
          </div>
        ) : null}
        {loading && !manifest ? <div className="text-xs text-muted-foreground">{t('artifacts.inventory.loadingManifest')}</div> : null}
        <EnhancementActionPanel title={t('artifacts.profiles.actions')} actions={profileActionConfigs} onComplete={onArtifactActionComplete} />
        {manifest && rows.length === 0 && !error ? <div className="text-xs text-muted-foreground">{t('artifacts.profiles.none')}</div> : null}
        {rows.length > 0 ? (
          <ScrollArea className="h-full rounded-md border border-border">
            <div className="min-w-[980px] divide-y divide-border text-xs">
              <div className="grid grid-cols-[1.25fr_70px_70px_95px_95px_85px_85px_85px_85px] gap-3 bg-muted/40 px-3 py-2 font-medium text-muted-foreground">
                <div>{t('artifacts.profiles.columns.profile')}</div>
                <div>{t('artifacts.profiles.columns.llm')}</div>
                <div>{t('artifacts.profiles.columns.tools')}</div>
                <div>{t('artifacts.profiles.columns.input')}</div>
                <div>{t('artifacts.profiles.columns.output')}</div>
                <div>{t('artifacts.profiles.columns.avgDur')}</div>
                <div>{t('artifacts.profiles.columns.p95Dur')}</div>
                <div>{t('artifacts.profiles.columns.avgTtft')}</div>
                <div>{t('artifacts.profiles.columns.p95Ttft')}</div>
              </div>
              {rows.map((row) => (
                <div key={row.path} className="grid grid-cols-[1.25fr_70px_70px_95px_95px_85px_85px_85px_85px] gap-3 px-3 py-2">
                  <div className="min-w-0">
                    <div className="truncate font-mono text-[11px]">{row.profile.sessionId ?? row.path}</div>
                    <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{row.path} · {(row.profile.models ?? []).join(', ') || 'unknown'} · missing {row.profile.llmTraceMissingCalls ?? 0}</div>
                  </div>
                  <div className="font-mono text-[11px]">{row.profile.llmCalls ?? 0}</div>
                  <div className="font-mono text-[11px]">{row.profile.toolCalls ?? 0}</div>
                  <div className="font-mono text-[11px]">{formatInteger(row.profile.totalInputTokens)}</div>
                  <div className="font-mono text-[11px]">{formatInteger(row.profile.totalOutputTokens)}</div>
                  <div className="font-mono text-[11px]">{formatDurationMetric(row.profile.averageLlmDurationMs)}</div>
                  <div className="font-mono text-[11px]">{formatDurationMetric(row.profile.p95LlmDurationMs)}</div>
                  <div className="font-mono text-[11px]">{formatDurationMetric(row.profile.averageTimeToFirstChunkMs)}</div>
                  <div className="font-mono text-[11px]">{formatDurationMetric(row.profile.p95TimeToFirstChunkMs)}</div>
                </div>
              ))}
            </div>
          </ScrollArea>
        ) : null}
      </div>
    </div>
  )
}

function MemoryView({
  manifest,
  rows,
  error,
  loading,
  onArtifactActionComplete,
}: {
  manifest: ArtifactManifest | null
  rows: readonly MemoryIndexRow[]
  error: string | null
  loading: boolean
  onArtifactActionComplete(): void
}): JSX.Element {
  const { t } = useTranslation()
  const entries = rows.flatMap((row) => (row.index.entries ?? []).map((entry) => ({ row, entry })))
  const totals = entries.reduce((acc, item) => {
    if (item.entry.scope === 'global') acc.global += 1
    else acc.workspace += 1
    if (item.entry.status === 'tombstoned') acc.tombstoned += 1
    else acc.active += 1
    return acc
  }, { active: 0, tombstoned: 0, workspace: 0, global: 0 })
  const warningCount = rows.reduce((sum, row) => sum + (row.index.warnings?.length ?? 0), 0)
  const staleCount = rows.reduce((sum, row) => sum + (row.index.staleWarnings?.length ?? 0), 0)
  const conflictCount = rows.reduce((sum, row) => sum + (row.index.conflictWarnings?.length ?? 0), 0)
  return (
    <div className="grid min-h-0 flex-1 grid-cols-[260px_minmax(0,1fr)] gap-0 max-md:grid-cols-1">
      <aside className="min-h-0 border-r border-border bg-muted/25 p-3 max-md:border-b max-md:border-r-0">
        <div className="grid gap-2 text-xs">
          <Stat label="Indexes" value={String(rows.length)} />
          <Stat label="Active" value={String(totals.active)} />
          <Stat label="Tombstoned" value={String(totals.tombstoned)} />
          <Stat label="Workspace" value={String(totals.workspace)} />
          <Stat label="Global" value={String(totals.global)} />
          <Stat label="Warnings" value={String(warningCount)} />
          <Stat label="Stale" value={String(staleCount)} />
          <Stat label="Conflicts" value={String(conflictCount)} />
          <Stat label="Artifacts" value={String(manifest?.summary.entryCount ?? 0)} />
        </div>
      </aside>
      <div className="min-h-0 p-3">
        {error ? (
          <div className="mb-3 rounded-md border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
            {error}
          </div>
        ) : null}
        {loading && !manifest ? <div className="text-xs text-muted-foreground">{t('artifacts.inventory.loadingManifest')}</div> : null}
        <EnhancementActionPanel title={t('artifacts.memory.actions')} actions={memoryActionConfigs} onComplete={onArtifactActionComplete} />
        {manifest && rows.length === 0 && !error ? <div className="text-xs text-muted-foreground">{t('artifacts.memory.none')}</div> : null}
        {entries.length > 0 ? (
          <ScrollArea className="h-full rounded-md border border-border">
            <div className="min-w-[980px] divide-y divide-border text-xs">
              <div className="grid grid-cols-[110px_110px_1fr_1.4fr_90px_130px_1fr] gap-3 bg-muted/40 px-3 py-2 font-medium text-muted-foreground">
                <div>{t('artifacts.memory.columns.scope')}</div>
                <div>{t('artifacts.memory.columns.status')}</div>
                <div>{t('artifacts.memory.columns.key')}</div>
                <div>{t('artifacts.memory.columns.description')}</div>
                <div>{t('artifacts.memory.columns.confidence')}</div>
                <div>{t('artifacts.memory.columns.session')}</div>
                <div>{t('artifacts.memory.columns.provenance')}</div>
              </div>
              {entries.map(({ row, entry }, index) => (
                <div key={`${row.path}:${entry.scope ?? 'unknown'}:${entry.key ?? index}`} className="grid grid-cols-[110px_110px_1fr_1.4fr_90px_130px_1fr] gap-3 px-3 py-2">
                  <div className="font-mono text-[11px]">{entry.scope ?? 'unknown'}</div>
                  <MemoryStatus status={entry.status} />
                  <div className="min-w-0">
                    <div className="truncate font-mono text-[11px]" title={entry.key}>{entry.key ?? 'unknown'}</div>
                    <div className="mt-0.5 truncate text-[11px] text-muted-foreground" title={row.path}>{row.path}</div>
                  </div>
                  <div className="min-w-0">
                    <div className="truncate" title={entry.description ?? entry.name}>{entry.description ?? entry.name ?? '-'}</div>
                    <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">{entry.type ?? 'memory'}</div>
                  </div>
                  <div className="font-mono text-[11px]">{formatConfidence(entry.confidence)}</div>
                  <div className="truncate font-mono text-[11px] text-muted-foreground" title={entry.sessionId}>{entry.sessionId ?? '-'}</div>
                  <div className="min-w-0">
                    <div className="truncate font-mono text-[11px]" title={entry.path}>{entry.status === 'tombstoned' ? entry.deletedAt ?? 'deleted' : entry.source ?? 'unknown'}</div>
                    <div className="mt-0.5 truncate text-[11px] text-muted-foreground" title={entry.archivedPath ?? entry.path}>{entry.archivedPath ?? entry.path ?? '-'}</div>
                  </div>
                </div>
              ))}
            </div>
          </ScrollArea>
        ) : null}
      </div>
    </div>
  )
}

function MemoryStatus({ status }: { status: MemoryIndexEntry['status'] | undefined }): JSX.Element {
  const { t } = useTranslation()
  if (status === 'tombstoned') return <div className="font-mono text-[11px] text-amber-700 dark:text-amber-300">{t('artifacts.memory.status.tombstoned')}</div>
  if (status === 'active') return <div className="font-mono text-[11px] text-emerald-700 dark:text-emerald-300">{t('artifacts.memory.status.active')}</div>
  return <div className="font-mono text-[11px] text-muted-foreground">{t('artifacts.memory.status.unknown')}</div>
}

function OpsView({
  manifest,
  rows,
  error,
  loading,
  onOpenArtifact,
  onArtifactActionComplete,
}: {
  manifest: ArtifactManifest | null
  rows: readonly OpsArtifactRow[]
  error: string | null
  loading: boolean
  onOpenArtifact(request: ArtifactDetailRequest): void
  onArtifactActionComplete(): void
}): JSX.Element {
  const { t } = useTranslation()
  const groups = groupOpsRows(rows)
  const reliabilityIssues = rows.reduce((sum, row) => sum + opsIssueCount(row), 0)
  const rolloutReady = rows.filter((row) => row.kind === 'rl_adapter' && stringField(row.body, 'status') === 'ready').length
  const rolloutBlocked = rows.filter((row) => row.kind === 'rl_adapter' && stringField(row.body, 'status') === 'blocked').length
  const traceCount = rows.filter((row) => row.kind === 'trace' || row.kind === 'message_assembly').length
  const routerCount = rows.filter((row) => row.kind === 'router_decision' || row.kind === 'tool_catalog').length
  return (
    <div className="grid min-h-0 flex-1 grid-cols-[260px_minmax(0,1fr)] gap-0 max-md:grid-cols-1">
      <aside className="min-h-0 border-r border-border bg-muted/25 p-3 max-md:border-b max-md:border-r-0">
        <div className="grid gap-2 text-xs">
          <Stat label={t('artifacts.ops.artifacts')} value={String(rows.length)} />
          <Stat label="Reliability issues" value={String(reliabilityIssues)} />
          <Stat label="Rollout ready" value={String(rolloutReady)} />
          <Stat label="Rollout blocked" value={String(rolloutBlocked)} />
          <Stat label="Trace context" value={String(traceCount)} />
          <Stat label="Router/tool" value={String(routerCount)} />
          <Stat label="Artifacts" value={String(manifest?.summary.entryCount ?? 0)} />
        </div>
      </aside>
      <div className="min-h-0 p-3">
        {error ? (
          <div className="mb-3 rounded-md border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
            {error}
          </div>
        ) : null}
        {loading && !manifest ? <div className="text-xs text-muted-foreground">{t('artifacts.inventory.loadingManifest')}</div> : null}
        <EnhancementActionPanel title={t('artifacts.ops.actions')} actions={opsActionConfigs} onComplete={onArtifactActionComplete} />
        {manifest && rows.length === 0 && !error ? <div className="text-xs text-muted-foreground">{t('artifacts.ops.none')}</div> : null}
        {rows.length > 0 ? (
          <ScrollArea className="h-full rounded-md border border-border">
            <div className="min-w-[980px] divide-y divide-border text-xs">
              {groups.map((group) => (
                <div key={group.label} className="grid gap-2 p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="font-medium">{group.label}</div>
                    <div className="font-mono text-[11px] text-muted-foreground">{group.rows.length}</div>
                  </div>
                  <div className="grid gap-1.5">
                    {group.rows.map((row) => (
                      <button
                        key={row.path}
                        type="button"
                        onClick={() => onOpenArtifact({ path: row.path, label: row.path })}
                        className="grid grid-cols-[170px_minmax(0,1fr)_minmax(220px,0.8fr)] gap-3 rounded border border-border bg-background/70 px-2 py-2 text-left transition-colors hover:bg-muted/40"
                      >
                        <div className="min-w-0">
                          <div className="truncate font-mono text-[11px]">{opsKindLabel(row.kind)}</div>
                          <div className="mt-0.5 truncate text-[11px] text-muted-foreground" title={row.path}>{row.path}</div>
                        </div>
                        <div className="min-w-0">
                          <div className="truncate font-medium">{opsPrimary(row)}</div>
                          <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">{opsSecondary(row)}</div>
                        </div>
                        <div className="min-w-0">
                          <div className="truncate font-mono text-[11px]">{opsMetricLine(row)}</div>
                          <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{opsStatusLine(row)}</div>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </ScrollArea>
        ) : null}
      </div>
    </div>
  )
}

function groupOpsRows(rows: readonly OpsArtifactRow[]): Array<{ label: string; rows: OpsArtifactRow[] }> {
  const groups = new Map<string, OpsArtifactRow[]>()
  for (const row of rows) {
    const label = opsGroupLabel(row.kind)
    const existing = groups.get(label) ?? []
    existing.push(row)
    groups.set(label, existing)
  }
  return [...groups.entries()].map(([label, groupRows]) => ({ label, rows: groupRows }))
}

function isOpsArtifactKind(kind: string): kind is OpsArtifactKind {
  return kind === 'reliability_audit' || kind === 'reliability_chaos' || kind === 'rl_rollout_sidecar' || kind === 'rl_token_segments' || kind === 'rl_adapter' || kind === 'subagent_graph' || kind === 'trace' || kind === 'message_assembly' || kind === 'router_decision' || kind === 'tool_catalog'
}

function opsKindOrder(kind: OpsArtifactKind): number {
  return ['reliability_audit', 'reliability_chaos', 'rl_rollout_sidecar', 'rl_token_segments', 'rl_adapter', 'subagent_graph', 'trace', 'message_assembly', 'router_decision', 'tool_catalog'].indexOf(kind)
}

function opsGroupLabel(kind: OpsArtifactKind): string {
  if (kind === 'reliability_audit' || kind === 'reliability_chaos') return 'Reliability'
  if (kind === 'rl_rollout_sidecar' || kind === 'rl_token_segments' || kind === 'rl_adapter') return 'Agentic RL'
  if (kind === 'subagent_graph') return 'Subagents'
  if (kind === 'trace' || kind === 'message_assembly') return 'Trace and Context'
  return 'Router and Tools'
}

function opsKindLabel(kind: OpsArtifactKind): string {
  return kind.replace(/_/g, ' ')
}

function opsPrimary(row: OpsArtifactRow): string {
  if (row.kind === 'reliability_audit') return stringField(row.body, 'sessionId') ?? 'session audit'
  if (row.kind === 'reliability_chaos') return `${numberField(row.body, 'sessionCount') ?? 0} sessions`
  if (row.kind === 'rl_rollout_sidecar') return stringField(row.body, 'rollout_id') ?? 'rollout sidecar'
  if (row.kind === 'rl_token_segments') return stringField(row.body, 'sessionId') ?? 'token segments'
  if (row.kind === 'rl_adapter') return `${stringField(row.body, 'frameworkTarget') ?? stringField(row.body, 'framework_target') ?? 'adapter'} ${stringField(row.body, 'status') ?? ''}`.trim()
  if (row.kind === 'subagent_graph') return `${arrayLength(row.body.nodes)} nodes / ${arrayLength(row.body.edges)} edges`
  if (row.kind === 'message_assembly') return stringField(row.body, 'sessionId') ?? 'message assembly'
  if (row.kind === 'router_decision') return stringField(row.body, 'selectedModel') ?? 'router decision'
  if (row.kind === 'tool_catalog') return `${numberField(row.body, 'toolCount') ?? arrayLength(row.body.tools)} tools`
  return stringField(row.body, 'sessionId') ?? 'trace'
}

function opsSecondary(row: OpsArtifactRow): string {
  if (row.kind === 'reliability_audit') return `status ${stringField(row.body, 'status') ?? 'unknown'} / dangling ${booleanField(row.body, 'dangling') ? stringField(row.body, 'danglingKind') ?? 'yes' : 'no'}`
  if (row.kind === 'reliability_chaos') return `${numberField(row.body, 'danglingCount') ?? 0} dangling / ${numberField(row.body, 'recoveryEventCount') ?? 0} recovery events`
  if (row.kind === 'rl_rollout_sidecar') return `${stringField(row.body, 'task_id') ?? 'task'} / ${stringField(row.body, 'framework_target') ?? 'framework'}`
  if (row.kind === 'rl_token_segments') return `${arrayLength(row.body.segments)} segments / token ids ${booleanField(row.body, 'tokenIdsCaptured') ? 'captured' : 'not captured'}`
  if (row.kind === 'rl_adapter') return stringField(row.body, 'reason') ?? stringField(row.body, 'entrypoint') ?? 'adapter artifact'
  if (row.kind === 'subagent_graph') return `${arrayLength(row.body.warnings)} warnings`
  if (row.kind === 'message_assembly') return `${numberField(row.body, 'messageCount') ?? 0} messages / ${numberField(row.body, 'toolCount') ?? 0} tools`
  if (row.kind === 'router_decision') return `${stringField(row.body, 'selectedProvider') ?? 'provider unknown'} / ${(arrayField(row.body, 'reasonCodes') ?? []).join(', ')}`
  if (row.kind === 'tool_catalog') return `${arrayLength(row.body.tools)} registered tools`
  return `${arrayLength(row.body.spans)} spans`
}

function opsMetricLine(row: OpsArtifactRow): string {
  if (row.kind === 'reliability_audit') return `${opsIssueCount(row)} integrity issues`
  if (row.kind === 'rl_token_segments') return `${numberField(asRecord(row.body.topology), 'compactionCount') ?? 0} compactions / ${numberField(asRecord(row.body.topology), 'subAgentCallCount') ?? 0} subagents`
  if (row.kind === 'router_decision') {
    const policy = asRecord(row.body.toolPolicy)
    return `${numberField(policy, 'toolCount') ?? 0} tools / ${numberField(policy, 'skillBackedCount') ?? 0} skill-backed`
  }
  if (row.kind === 'message_assembly') return `${numberField(row.body, 'estimatedTokens') ?? 0} est tokens`
  if (row.kind === 'tool_catalog') return `${arrayField(row.body, 'tools')?.filter((tool) => asRecord(tool).skillBacked === true).length ?? 0} skill-backed`
  return `${formatBytesMetric(numberField(row.body, 'bytes'))}`
}

function opsStatusLine(row: OpsArtifactRow): string {
  if (row.kind === 'rl_adapter') return stringField(row.body, 'status') ?? 'unknown'
  if (row.kind === 'reliability_audit') return arrayLength(row.body.recoveryEventDetails) > 0 ? 'recovered' : 'no recovery events'
  if (row.kind === 'subagent_graph') return 'derived parent-child graph'
  if (row.kind === 'trace') return 'OpenInference trace artifact'
  return row.path
}

function opsIssueCount(row: OpsArtifactRow): number {
  if (row.kind === 'reliability_chaos') return numberField(row.body, 'danglingCount') ?? 0
  if (row.kind !== 'reliability_audit') return 0
  const integrity = asRecord(row.body.integrity)
  return arrayLength(integrity.duplicateToolCallIds) + arrayLength(integrity.duplicateToolResultIds) + arrayLength(integrity.toolResultsWithoutCall) + arrayLength(integrity.toolCallsWithoutResult)
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' ? value : undefined
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function booleanField(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key]
  return typeof value === 'boolean' ? value : undefined
}

function arrayField(record: Record<string, unknown>, key: string): readonly unknown[] | undefined {
  const value = record[key]
  return Array.isArray(value) ? value : undefined
}

function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0
}

function ResultPill({ resolved }: { resolved: boolean | undefined }): JSX.Element {
  const { t } = useTranslation()
  if (resolved === true) {
    return <div className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-300"><CheckCircle2 className="h-3 w-3" aria-hidden="true" />{t('artifacts.eval.result.resolved')}</div>
  }
  if (resolved === false) {
    return <div className="inline-flex items-center gap-1 text-rose-600 dark:text-rose-300"><XCircle className="h-3 w-3" aria-hidden="true" />{t('artifacts.eval.result.failed')}</div>
  }
  return <div className="text-muted-foreground">{t('artifacts.eval.result.unknown')}</div>
}

function Delta({ label, value, percent, invert }: { label: string; value: number | undefined; percent?: boolean; invert?: boolean }): JSX.Element {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? value : 0
  const good = invert ? numeric < 0 : numeric > 0
  const bad = invert ? numeric > 0 : numeric < 0
  return (
    <div className={cn('font-mono text-[11px]', good && 'text-emerald-600 dark:text-emerald-300', bad && 'text-rose-600 dark:text-rose-300')}>
      <span className="text-muted-foreground">{label} </span>{numeric > 0 ? '+' : ''}{percent ? `${Math.round(numeric * 100)}%` : numeric}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-background/70 px-2 py-1.5">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono">{value}</span>
    </div>
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function tabClass(active: boolean): string {
  return cn(
    'rounded px-2.5 py-1 transition-colors',
    active ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
  )
}

function formatPercent(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${Math.round(value * 100)}%` : 'n/a'
}

function evalRunRoot(summaryPath: string): string {
  if (summaryPath.endsWith('/summary.json')) return summaryPath.slice(0, -'/summary.json'.length)
  if (summaryPath.endsWith('/progress.json')) return summaryPath.slice(0, -'/progress.json'.length)
  return summaryPath.replace(/\/[^/]+$/, '')
}

function resolveTrialArtifactPath(runRoot: string, uri: string): string {
  if (uri.startsWith('/') || uri.includes('://')) return uri
  if (uri === runRoot || uri.startsWith(`${runRoot}/`)) return uri
  return `${runRoot}/${uri}`
}

function groupTrialArtifacts(runRoot: string, artifacts: readonly EvalTrialArtifactRef[]): TrialArtifactGroup[] {
  const byCategory = new Map<TrialArtifactCategory, TrialArtifactItem[]>()
  for (const artifact of artifacts) {
    const uri = artifact.uri
    const path = uri ? resolveTrialArtifactPath(runRoot, uri) : null
    const category = classifyTrialArtifact(artifact)
    const title = uri ?? '(inline artifact)'
    const meta = [artifact.kind ?? 'artifact', artifact.mediaType].filter(Boolean).join(' / ')
    const items = byCategory.get(category) ?? []
    items.push({ artifact, category, path, title, meta })
    byCategory.set(category, items)
  }
  return trialArtifactCategoryOrder
    .map((category) => {
      const items = byCategory.get(category) ?? []
      return { category, label: trialArtifactCategoryLabel(category), items }
    })
    .filter((group) => group.items.length > 0)
}

const trialArtifactCategoryOrder: readonly TrialArtifactCategory[] = ['patch', 'trace', 'harness', 'log', 'prompt', 'metadata', 'other']

function classifyTrialArtifact(artifact: EvalTrialArtifactRef): TrialArtifactCategory {
  const kind = (artifact.kind ?? '').toLowerCase()
  const uri = (artifact.uri ?? '').toLowerCase()
  const mediaType = (artifact.mediaType ?? '').toLowerCase()
  if (kind === 'diff' || uri.endsWith('.diff') || uri.endsWith('.patch') || mediaType.includes('diff')) return 'patch'
  if (kind === 'trace' || uri.includes('trace') || uri.includes('openinference')) return 'trace'
  if (uri.includes('/harness/') || uri.includes('swebench-result')) return 'harness'
  if (uri.endsWith('prompt.txt') || uri.includes('/prompt.')) return 'prompt'
  if (kind === 'log' || uri.endsWith('.log') || uri.includes('stdout') || uri.includes('stderr') || mediaType.startsWith('text/plain')) return 'log'
  if (kind === 'metadata' || mediaType.includes('json')) return 'metadata'
  return 'other'
}

function trialArtifactCategoryLabel(category: TrialArtifactCategory): string {
  switch (category) {
    case 'patch': return 'Final Patch'
    case 'trace': return 'Trace'
    case 'harness': return 'Harness Evidence'
    case 'log': return 'Agent Logs'
    case 'prompt': return 'Prompt'
    case 'metadata': return 'Metadata'
    case 'other': return 'Other'
  }
}

function mergeEvalRuns(
  summaries: readonly EvalSummaryContentRow[],
  progresses: readonly EvalProgressContentRow[],
): EvalRunRow[] {
  const byRoot = new Map<string, EvalRunRow>()
  for (const row of summaries) {
    const root = evalRunRoot(row.path)
    byRoot.set(root, { ...(byRoot.get(root) ?? { key: root, root }), summaryPath: row.path, summary: row.summary })
  }
  for (const row of progresses) {
    const root = evalRunRoot(row.path)
    byRoot.set(root, { ...(byRoot.get(root) ?? { key: root, root }), progressPath: row.path, progress: row.progress })
  }
  return [...byRoot.values()].sort((a, b) => {
    const aTime = a.progress?.updatedAt ?? a.progress?.startedAt ?? a.summaryPath ?? a.key
    const bTime = b.progress?.updatedAt ?? b.progress?.startedAt ?? b.summaryPath ?? b.key
    return bTime.localeCompare(aTime)
  })
}

function trialStableId(row: EvalTrialRow): string {
  return row.trial.trialId ?? row.trial.instanceId ?? row.path
}

function trialInstanceId(row: EvalTrialRow): string {
  return row.trial.instanceId ?? row.trial.trialId ?? row.path.split('/').pop()?.replace(/\.json$/, '') ?? row.path
}

function formatDuration(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'n/a'
  if (value < 1000) return `${Math.round(value)}ms`
  if (value < 60_000) return `${(value / 1000).toFixed(1)}s`
  return `${Math.round(value / 60_000)}m`
}

function formatBytesMetric(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? formatBytes(value) : 'n/a'
}

function formatInteger(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value).toLocaleString('en-US') : '0'
}

function formatDurationMetric(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${Math.round(value)}ms` : 'n/a'
}

function formatDeltaValue(value: number, percent: boolean): string {
  const prefix = value > 0 ? '+' : ''
  return percent ? `${prefix}${Math.round(value * 100)}%` : `${prefix}${value}`
}

function formatConfidence(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${Math.round(value * 100)}%` : 'n/a'
}

async function fetchArtifactContent(path: string): Promise<ArtifactContentResponse> {
  const res = await fetch(`/artifacts/content?path=${encodeURIComponent(path)}`, { cache: 'no-store' })
  if (res.ok) return (await res.json()) as ArtifactContentResponse
  const body = await res.json().catch(() => null) as { error?: string } | null
  throw new Error(body?.error ?? `artifact content request failed: ${res.status}`)
}
