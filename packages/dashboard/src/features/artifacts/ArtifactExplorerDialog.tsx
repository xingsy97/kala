import { useEffect, useMemo, useState, type FormEvent, type InputHTMLAttributes } from 'react'
import { CheckCircle2, FileText, RefreshCw, XCircle } from 'lucide-react'

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
  runId?: string
  selectedCount?: number
  maxWorkers?: number
  shardCount?: number
  warnings?: readonly string[]
}

type EnhancementActionResponse = Record<string, unknown> & { action?: string; error?: string }

type EnhancementActionField = {
  key: string
  label: string
  placeholder?: string
  required?: boolean
  defaultValue?: string
  numeric?: boolean
  boolean?: boolean
  list?: boolean
}

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
  costStatus?: string
  estimatedCostUsd?: number
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

type MemoryIndex = {
  generatedAt?: string
  entries?: readonly MemoryIndexEntry[]
  warnings?: readonly string[]
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
      <DialogContent className="flex h-[min(760px,86dvh)] w-[min(1040px,94vw)] max-w-none flex-col overflow-hidden p-0 gap-0">
        <DialogHeader className="border-b border-border px-4 py-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <DialogTitle>{mode === 'eval' ? 'Eval' : mode === 'profiles' ? 'Profiles' : mode === 'memory' ? 'Memory' : mode === 'ops' ? 'Ops' : 'Artifacts'}</DialogTitle>
              <DialogDescription>{mode === 'eval' ? 'Benchmark run summaries, progress, comparisons, and trial evidence.' : mode === 'ops' ? 'Reliability, rollout, trace, router, and sub-agent artifacts.' : 'Run output index from the host artifact store.'}</DialogDescription>
            </div>
            <div className="flex items-center gap-2">
              <div className="inline-flex rounded-md border border-border bg-muted/30 p-0.5 text-xs">
                <button type="button" className={tabClass(mode === 'artifacts')} onClick={() => setMode('artifacts')}>Artifacts</button>
                <button type="button" className={tabClass(mode === 'eval')} onClick={() => setMode('eval')}>Eval</button>
                <button type="button" className={tabClass(mode === 'profiles')} onClick={() => setMode('profiles')}>Profiles</button>
                <button type="button" className={tabClass(mode === 'memory')} onClick={() => setMode('memory')}>Memory</button>
                <button type="button" className={tabClass(mode === 'ops')} onClick={() => setMode('ops')}>Ops</button>
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
  return (
    <div className="grid min-h-0 flex-1 grid-cols-[260px_minmax(0,1fr)] gap-0 max-md:grid-cols-1">
          <aside className="min-h-0 border-r border-border bg-muted/25 p-3 max-md:border-b max-md:border-r-0">
            {manifest ? (
              <div className="grid gap-2 text-xs">
                <Stat label="Files" value={String(manifest.summary.entryCount)} />
                <Stat label="Bytes" value={formatBytes(manifest.summary.totalBytes)} />
                <Stat label="Hashed" value={`${manifest.summary.hashedCount}/${manifest.summary.entryCount}`} />
                <div className="mt-2 rounded-md border border-border bg-background/70 p-2">
                  <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Kinds</div>
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
              <div className="text-xs text-muted-foreground">No manifest loaded.</div>
            )}
          </aside>
          <div className="min-h-0 p-3">
            {error ? (
              <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
                {error}
              </div>
            ) : null}
            {loading && !manifest ? (
              <div className="text-xs text-muted-foreground">Loading artifact manifest...</div>
            ) : null}
            {manifest ? (
              <ScrollArea className="h-full rounded-md border border-border">
                <div className="min-w-[720px] divide-y divide-border text-xs">
                  <div className="grid grid-cols-[1.4fr_150px_100px_170px] gap-3 bg-muted/40 px-3 py-2 font-medium text-muted-foreground">
                    <div>Path</div>
                    <div>Kind</div>
                    <div>Size</div>
                    <div>Integrity</div>
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
                          <span title={entry.hashSkippedReason}>hash skipped</span>
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
  const comparisonCount = comparisons.length
  const selectedRun = rows.find((row) => row.key === selectedRunPath)
  const selectedTrial = trials.find((row) => trialStableId(row) === selectedTrialId)
  return (
    <div className="grid min-h-0 flex-1 grid-cols-[260px_minmax(0,1fr)] gap-0 max-md:grid-cols-1">
      <aside className="min-h-0 border-r border-border bg-muted/25 p-3 max-md:border-b max-md:border-r-0">
        <div className="grid gap-2 text-xs">
          <Stat label="Eval runs" value={String(rows.length)} />
          <Stat label="Trials" value={String(trials.length)} />
          <Stat label="Comparisons" value={String(comparisonCount)} />
          <Stat label="Worker plans" value={String(workerPlans.length)} />
          <Stat label="Scores" value={String(scores.length)} />
          <Stat label="Judges" value={String(judges.length)} />
          <Stat label="Artifacts" value={String(manifest?.summary.entryCount ?? 0)} />
        </div>
      </aside>
      <div className="grid min-h-0 grid-rows-[minmax(150px,0.55fr)_auto_auto_minmax(220px,1fr)_auto_auto] gap-3 p-3 max-lg:grid-rows-none">
        {error ? (
          <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
            {error}
          </div>
        ) : null}
        {loading && !manifest ? <div className="text-xs text-muted-foreground">Loading artifact manifest...</div> : null}
        {manifest && rows.length === 0 && comparisons.length === 0 && !error ? <div className="text-xs text-muted-foreground">No eval summaries found.</div> : null}
        <EvalScorecard rows={rows} selectedRun={selectedRun} />
        <SweBenchPlanPanel onCreated={onArtifactActionComplete} />
        <EnhancementActionPanel title="Eval Artifact Actions" actions={evalActionConfigs} onComplete={onArtifactActionComplete} />
        <div className="min-h-0 overflow-hidden rounded-md border border-border">
          {rows.length > 0 ? (
          <ScrollArea className="h-full">
            <div className="min-w-[760px] divide-y divide-border text-xs">
              <div className="grid grid-cols-[1.15fr_1fr_120px_90px_90px_90px_90px] gap-3 bg-muted/40 px-3 py-2 font-medium text-muted-foreground">
                <div>Run</div>
                <div>Dataset</div>
                <div>Model</div>
                <div>Trials</div>
                <div>Resolved</div>
                <div>Failed</div>
                <div>Pass rate</div>
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
                    <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{row.summaryPath ?? row.progressPath ?? row.root}</div>
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
            <div className="border-b border-border bg-muted/40 px-3 py-2 text-xs font-medium text-muted-foreground">Comparisons</div>
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

function SweBenchPlanPanel({ onCreated }: { onCreated(): void }): JSX.Element {
  const [open, setOpen] = useState(false)
  const [runId, setRunId] = useState('')
  const [dataset, setDataset] = useState('princeton-nlp/SWE-bench_Lite')
  const [split, setSplit] = useState('test')
  const [model, setModel] = useState('')
  const [instancesJsonl, setInstancesJsonl] = useState('')
  const [rootDir, setRootDir] = useState('')
  const [instanceIds, setInstanceIds] = useState('')
  const [limit, setLimit] = useState('')
  const [maxWorkers, setMaxWorkers] = useState('1')
  const [timeoutMs, setTimeoutMs] = useState('')
  const [repoCacheDir, setRepoCacheDir] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<SweBenchPlanResponse | null>(null)

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    setSubmitting(true)
    setError(null)
    setResult(null)
    const payload = compactFormPayload({
      runId,
      dataset,
      split,
      model,
      instancesJsonl,
      rootDir,
      instanceIds,
      limit,
      maxWorkers,
      timeoutMs,
      repoCacheDir,
    })
    try {
      const res = await fetch('/eval/swebench/plan', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const body = await res.json().catch(() => null) as (SweBenchPlanResponse & { error?: string }) | null
      if (!res.ok) throw new Error(body?.error ?? `SWE-bench plan failed: ${res.status}`)
      setResult(body ?? {})
      onCreated()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="rounded-md border border-border bg-background/70">
      <button type="button" className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-xs hover:bg-muted/30" onClick={() => setOpen((value) => !value)}>
        <span className="font-medium">Create SWE-bench Worker Plan</span>
        <span className="font-mono text-[11px] text-muted-foreground">{open ? 'hide' : 'show'}</span>
      </button>
      {open ? (
        <form onSubmit={(event) => void submit(event)} className="grid gap-3 border-t border-border p-3 text-xs">
          <div className="grid grid-cols-2 gap-2 max-lg:grid-cols-1">
            <LabeledInput label="Run ID" value={runId} onChange={setRunId} required placeholder="swebench-smoke" />
            <LabeledInput label="Model" value={model} onChange={setModel} required placeholder="gpt-5.5" />
            <LabeledInput label="Dataset" value={dataset} onChange={setDataset} required />
            <LabeledInput label="Split" value={split} onChange={setSplit} />
            <LabeledInput label="Instances JSONL" value={instancesJsonl} onChange={setInstancesJsonl} required placeholder="/path/to/instances.jsonl" />
            <LabeledInput label="Root Dir" value={rootDir} onChange={setRootDir} placeholder="uses artifact root when empty" />
            <LabeledInput label="Instance IDs" value={instanceIds} onChange={setInstanceIds} placeholder="comma separated" />
            <LabeledInput label="Repo Cache" value={repoCacheDir} onChange={setRepoCacheDir} placeholder="optional" />
            <LabeledInput label="Limit" value={limit} onChange={setLimit} inputMode="numeric" placeholder="optional" />
            <LabeledInput label="Max Workers" value={maxWorkers} onChange={setMaxWorkers} inputMode="numeric" />
            <LabeledInput label="Timeout ms" value={timeoutMs} onChange={setTimeoutMs} inputMode="numeric" placeholder="optional" />
          </div>
          {error ? <div className="rounded border border-rose-200 bg-rose-50 px-2 py-1 text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">{error}</div> : null}
          {result ? <div className="rounded border border-emerald-200 bg-emerald-50 px-2 py-1 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300">Created {result.planPath ?? result.runId} / {result.selectedCount ?? 0} instances / {result.shardCount ?? 0} shards</div> : null}
          <div className="flex justify-end">
            <Button type="submit" size="sm" disabled={submitting}>{submitting ? 'Creating...' : 'Create Plan'}</Button>
          </div>
        </form>
      ) : null}
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

function EnhancementActionPanel({ title, actions, onComplete }: { title: string; actions: readonly EnhancementActionConfig[]; onComplete(): void }): JSX.Element {
  const [open, setOpen] = useState(false)
  const [selectedAction, setSelectedAction] = useState(actions[0]?.action ?? '')
  const [values, setValues] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<EnhancementActionResponse | null>(null)
  const [rootDir, setRootDir] = useState('')
  const config = actions.find((action) => action.action === selectedAction) ?? actions[0]
  const configAction = config?.action

  useEffect(() => {
    if (!config) return
    const next: Record<string, string> = {}
    for (const field of config.fields) next[field.key] = field.defaultValue ?? ''
    setValues(next)
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
    if (rootDir.trim()) payload.rootDir = rootDir.trim()
    for (const field of activeConfig.fields) {
      const raw = values[field.key]?.trim() ?? ''
      if (!raw) continue
      if (field.boolean) payload[field.key] = raw === 'true'
      else if (field.numeric) payload[field.key] = Number(raw)
      else if (field.list) payload[field.key] = raw.split(',').map((item) => item.trim()).filter(Boolean)
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
    <div className="mb-3 rounded-md border border-border bg-background/70">
      <button type="button" className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-xs hover:bg-muted/30" onClick={() => setOpen((value) => !value)}>
        <span className="font-medium">{title}</span>
        <span className="font-mono text-[11px] text-muted-foreground">{open ? 'hide' : 'show'}</span>
      </button>
      {open ? (
        <form onSubmit={(event) => void submit(event)} className="grid gap-3 border-t border-border p-3 text-xs">
          <label className="grid gap-1">
            <span className="text-[11px] font-medium text-muted-foreground">Action</span>
            <select className="h-8 rounded border border-input bg-background px-2 text-sm" value={selectedAction} onChange={(event) => setSelectedAction(event.currentTarget.value)}>
              {actions.map((action) => <option key={action.action} value={action.action}>{action.label}</option>)}
            </select>
          </label>
          <LabeledInput label="Root Dir" value={rootDir} onChange={setRootDir} placeholder="uses artifact root when empty" />
          <div className="grid grid-cols-2 gap-2 max-lg:grid-cols-1">
            {config.fields.map((field) => (
              <LabeledInput
                key={`${config.action}:${field.key}`}
                label={field.label}
                value={values[field.key] ?? field.defaultValue ?? ''}
                onChange={(value) => setValues((current) => ({ ...current, [field.key]: value }))}
                required={field.required}
                placeholder={field.placeholder}
                inputMode={field.numeric ? 'numeric' : undefined}
              />
            ))}
          </div>
          {error ? <div className="rounded border border-rose-200 bg-rose-50 px-2 py-1 text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">{error}</div> : null}
          {result ? <div className="rounded border border-emerald-200 bg-emerald-50 px-2 py-1 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300">{typeof result.shellCommand === 'string' ? 'Generated' : 'Created'} {enhancementResultLabel(result)}</div> : null}
          <div className="flex justify-end">
            <Button type="submit" size="sm" disabled={submitting}>{submitting ? 'Running...' : 'Run Action'}</Button>
          </div>
        </form>
      ) : null}
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
  { key: 'sessionLogPath', label: 'Session Log Path', placeholder: 'optional fallback path' },
]

const evalActionConfigs: readonly EnhancementActionConfig[] = [
  { action: 'eval-score-session', label: 'Score session', fields: [...sessionFields, { key: 'instanceId', label: 'Instance ID' }, { key: 'patchPath', label: 'Patch Path' }, { key: 'requireDone', label: 'Require Done', placeholder: 'true or false', boolean: true }, { key: 'workspaceRoot', label: 'Workspace Root' }] },
  { action: 'eval-judge-score', label: 'Parse judge score', fields: [{ key: 'promptPath', label: 'Prompt Path', required: true }, { key: 'responsePath', label: 'Response Path', required: true }, { key: 'judgeModel', label: 'Judge Model', required: true }, { key: 'scorer', label: 'Scorer' }, { key: 'instanceId', label: 'Instance ID' }, { key: 'threshold', label: 'Threshold', numeric: true }, { key: 'inputRef', label: 'Input Ref' }, { key: 'workspaceRoot', label: 'Workspace Root' }] },
  { action: 'eval-compare-runs', label: 'Compare eval runs', fields: [{ key: 'baselineSummaryPath', label: 'Baseline Summary', required: true }, { key: 'candidateSummaryPath', label: 'Candidate Summary', required: true }] },
  { action: 'swebench-infer-patches', label: 'SWE-bench infer patches', fields: [{ key: 'runId', label: 'Run ID', required: true }, { key: 'dataset', label: 'Dataset', required: true, defaultValue: 'SWE-bench/SWE-bench_Verified' }, { key: 'split', label: 'Split' }, { key: 'model', label: 'Model', required: true }, { key: 'instancesJsonl', label: 'Instances JSONL', required: true }, { key: 'patchesDir', label: 'Patches Dir', required: true }, { key: 'instanceIds', label: 'Instance IDs', placeholder: 'comma separated', list: true }, { key: 'limit', label: 'Limit', numeric: true }, { key: 'workspaceRoot', label: 'Workspace Root' }] },
  { action: 'swebench-export-session', label: 'SWE-bench export session', fields: [...sessionFields, { key: 'runId', label: 'Run ID', required: true }, { key: 'dataset', label: 'Dataset', required: true, defaultValue: 'SWE-bench/SWE-bench_Verified' }, { key: 'split', label: 'Split' }, { key: 'model', label: 'Model', required: true }, { key: 'instanceId', label: 'Instance ID', required: true }, { key: 'modelPatchPath', label: 'Model Patch Path', required: true }, { key: 'workspaceRoot', label: 'Workspace Root' }] },
  { action: 'swebench-ingest-results', label: 'SWE-bench ingest results', fields: [{ key: 'runId', label: 'Run ID', required: true }, { key: 'resultsDir', label: 'Results Dir', required: true }] },
  { action: 'swebench-grade-command', label: 'SWE-bench grade command', fields: [{ key: 'runId', label: 'Run ID', required: true }, { key: 'dataset', label: 'Dataset', required: true, defaultValue: 'SWE-bench/SWE-bench_Verified' }, { key: 'predictionsPath', label: 'Predictions Path', required: true }, { key: 'maxWorkers', label: 'Max Workers', numeric: true }, { key: 'instanceIds', label: 'Instance IDs', placeholder: 'comma separated', list: true }, { key: 'modal', label: 'Modal', placeholder: 'true or false', boolean: true }] },
]

const profileActionConfigs: readonly EnhancementActionConfig[] = [
  { action: 'profile-session', label: 'Profile session', fields: [...sessionFields, { key: 'pricingPath', label: 'Pricing Path' }] },
]

const memoryActionConfigs: readonly EnhancementActionConfig[] = [
  { action: 'memory-index', label: 'Build memory index', fields: [{ key: 'workspaceRoot', label: 'Workspace Root' }, { key: 'includeGlobal', label: 'Include Global', placeholder: 'true or false', boolean: true }] },
]

const opsActionConfigs: readonly EnhancementActionConfig[] = [
  { action: 'reliability-audit-session', label: 'Audit session reliability', fields: sessionFields },
  { action: 'reliability-chaos-replay', label: 'Replay reliability chaos', fields: [{ key: 'sessionLogPaths', label: 'Session Log Paths', required: true, placeholder: 'comma separated paths', list: true }] },
  { action: 'trace-export-session', label: 'Export trace', fields: [...sessionFields, { key: 'runId', label: 'Run ID' }, { key: 'evalInstanceId', label: 'Eval Instance ID' }, { key: 'workspaceRoot', label: 'Workspace Root' }] },
  { action: 'rollout-export-segments', label: 'Export rollout segments', fields: [...sessionFields, { key: 'runId', label: 'Run ID' }, { key: 'evalInstanceId', label: 'Eval Instance ID' }, { key: 'workspaceRoot', label: 'Workspace Root' }] },
  { action: 'rollout-export-session', label: 'Export rollout sidecar', fields: [...sessionFields, { key: 'taskId', label: 'Task ID', required: true }, { key: 'frameworkTarget', label: 'Framework', required: true, placeholder: 'slime, verl, trl, openrlhf, unknown' }, { key: 'model', label: 'Model' }, { key: 'weightVersion', label: 'Weight Version' }, { key: 'rewardPath', label: 'Reward Path' }, { key: 'tokenSegmentsPath', label: 'Token Segments Path' }] },
  { action: 'rollout-export-adapter', label: 'Export rollout adapter', fields: [{ key: 'sidecarPath', label: 'Sidecar Path', required: true }, { key: 'frameworkTarget', label: 'Framework', placeholder: 'slime, verl, trl, openrlhf, unknown' }] },
  { action: 'subagents-graph', label: 'Export subagent graph', fields: [{ key: 'sessionsDir', label: 'Sessions Dir', placeholder: 'defaults to host sessions dir' }] },
]

function EvalWorkerPlansPanel({ plans, onOpenArtifact }: { plans: readonly EvalWorkerPlanRow[]; onOpenArtifact(request: ArtifactDetailRequest): void }): JSX.Element {
  return (
    <div className="min-h-0 rounded-md border border-border">
      <div className="border-b border-border bg-muted/40 px-3 py-2 text-xs font-medium text-muted-foreground">Worker Plans</div>
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
              <div className="font-mono text-[11px]">{row.plan.selectedCount ?? 0} instances</div>
              <div className="font-mono text-[11px]">{row.plan.maxWorkers ?? shards.length} workers / {shards.length} shards</div>
              <div className="min-w-0">
                <div className="truncate font-mono text-[11px]">{hints.workspaceIsolation ?? 'isolation unknown'} / max {hints.maxConcurrentWorkspaces ?? '-'}</div>
                <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{warnings.length > 0 ? warnings.join(', ') : hints.dockerRequired ? 'docker required' : row.path}</div>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function EvalScoresPanel({ scores, judges, onOpenArtifact }: { scores: readonly EvalScoreRow[]; judges: readonly EvalJudgeRow[]; onOpenArtifact(request: ArtifactDetailRequest): void }): JSX.Element {
  return (
    <div className="min-h-0 rounded-md border border-border">
      <div className="border-b border-border bg-muted/40 px-3 py-2 text-xs font-medium text-muted-foreground">Score Artifacts</div>
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
  const deltas = [
    { label: 'resolved', value: comparison.deltas?.resolved ?? 0, invert: false, percent: false },
    { label: 'failed', value: comparison.deltas?.failed ?? 0, invert: true, percent: false },
    { label: 'timeout', value: comparison.deltas?.timedOut ?? 0, invert: true, percent: false },
    { label: 'pass rate', value: comparison.deltas?.passRate ?? 0, invert: false, percent: true },
  ]
  const max = Math.max(0.01, ...deltas.map((delta) => Math.abs(delta.value)))
  return (
    <div className="grid grid-cols-4 gap-2 max-lg:grid-cols-2" aria-label="comparison delta chart">
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
      <Stat label="Runs" value={String(rows.length)} />
      <Stat label="Trials" value={formatInteger(totals.trials)} />
      <Stat label="Resolved" value={formatInteger(totals.resolved)} />
      <Stat label="Failed" value={formatInteger(totals.failed + totals.timedOut)} />
      <Stat label="Selected pass" value={formatPercent(selectedPassRate)} />
    </div>
  )
}

function FailureDeltaChips({ deltas }: { deltas: Record<string, number> | undefined }): JSX.Element {
  const entries = deltas
    ? Object.entries(deltas).filter(([, value]) => typeof value === 'number' && Number.isFinite(value) && value !== 0)
      .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]) || a[0].localeCompare(b[0]))
      .slice(0, 3)
    : []
  if (entries.length === 0) return <div className="truncate text-[11px] text-muted-foreground">no failure deltas</div>
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
            <div className="font-medium">Trial detail</div>
            <div className="truncate font-mono text-[11px] text-muted-foreground">{run.summaryPath ?? run.progressPath ?? run.root}</div>
          </div>
          {loading ? <div className="text-[11px] text-muted-foreground">Loading...</div> : null}
        </div>
        {error ? <div className="m-3 rounded-md border border-rose-200 bg-rose-50 p-2 text-xs text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">{error}</div> : null}
        {!loading && trials.length === 0 && !error ? <div className="p-3 text-xs text-muted-foreground">No trial artifacts found for this run.</div> : null}
        {trials.length > 0 ? (
          <ScrollArea className="h-full">
            <div className="min-w-[720px] divide-y divide-border text-xs">
              <div className="grid grid-cols-[1.2fr_110px_90px_120px_90px_80px] gap-3 bg-muted/20 px-3 py-2 font-medium text-muted-foreground">
                <div>Instance</div>
                <div>Status</div>
                <div>Result</div>
                <div>Failure</div>
                <div>Duration</div>
                <div>Patch</div>
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
              <div className="mb-1 text-[11px] font-medium uppercase text-muted-foreground">Selected instance</div>
              <div className="break-all font-mono text-[11px]">{trialInstanceId(selectedTrial)}</div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Stat label="Artifacts" value={String(selectedTrial.trial.artifacts?.length ?? 0)} />
              <Stat label="Session" value={selectedTrial.trial.sessionId ? 'linked' : 'none'} />
            </div>
            {selectedTrial.trial.sessionId ? (
              <button
                type="button"
                onClick={() => onOpenSession?.(selectedTrial.trial.sessionId!)}
                disabled={!onOpenSession}
                className="min-w-0 rounded-md border border-border bg-background px-2 py-1.5 text-left transition-colors hover:bg-muted/40 disabled:cursor-default disabled:opacity-60 disabled:hover:bg-background"
              >
                <div className="text-[11px] font-medium uppercase text-muted-foreground">Linked Session</div>
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
              <div className="border-b border-border px-2 py-1.5 text-[11px] font-medium uppercase text-muted-foreground">Artifacts</div>
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
                ) : <div className="text-[11px] text-muted-foreground">No artifact refs in trial.</div>}
              </div>
            </div>
          </div>
        ) : <div className="text-xs text-muted-foreground">Select a trial to inspect artifacts.</div>}
      </aside>
    </div>
  )
}

function EvalProgressStrip({ run }: { run: EvalRunRow }): JSX.Element | null {
  const progress = run.progress
  if (!progress) return null
  const total = progress.selectedCount ?? progress.instances?.length ?? 0
  return (
    <div className="rounded-md border border-border bg-muted/20 p-2 text-xs">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="font-medium">Progress</div>
          <div className="truncate font-mono text-[11px] text-muted-foreground">{run.progressPath ?? run.root}</div>
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
        <div className="font-medium">Failure Breakdown</div>
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

function ArtifactContentDialog({
  request,
  onOpenChange,
}: {
  request: ArtifactDetailRequest | null
  onOpenChange(open: boolean): void
}): JSX.Element {
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
          <DialogTitle>Artifact Detail</DialogTitle>
          <DialogDescription className="truncate font-mono text-xs">{request?.label ?? ''}</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 p-3">
          {loading ? <div className="text-xs text-muted-foreground">Loading artifact...</div> : null}
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
  const totals = rows.reduce((acc, row) => {
    acc.llmCalls += row.profile.llmCalls ?? 0
    acc.toolCalls += row.profile.toolCalls ?? 0
    acc.inputTokens += row.profile.totalInputTokens ?? 0
    acc.outputTokens += row.profile.totalOutputTokens ?? 0
    acc.knownCost += row.profile.costStatus === 'estimated' && typeof row.profile.estimatedCostUsd === 'number' ? row.profile.estimatedCostUsd : 0
    acc.unknownCost += row.profile.costStatus === 'unknown' ? 1 : 0
    acc.latencyCalls += row.profile.llmLatencyCalls ?? 0
    return acc
  }, { llmCalls: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, knownCost: 0, unknownCost: 0, latencyCalls: 0 })
  return (
    <div className="grid min-h-0 flex-1 grid-cols-[260px_minmax(0,1fr)] gap-0 max-md:grid-cols-1">
      <aside className="min-h-0 border-r border-border bg-muted/25 p-3 max-md:border-b max-md:border-r-0">
        <div className="grid gap-2 text-xs">
          <Stat label="Profiles" value={String(rows.length)} />
          <Stat label="LLM calls" value={String(totals.llmCalls)} />
          <Stat label="Tool calls" value={String(totals.toolCalls)} />
          <Stat label="Known cost" value={formatUsd(totals.knownCost)} />
          <Stat label="Unknown cost" value={String(totals.unknownCost)} />
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
        {loading && !manifest ? <div className="text-xs text-muted-foreground">Loading artifact manifest...</div> : null}
        <EnhancementActionPanel title="Profile Artifact Actions" actions={profileActionConfigs} onComplete={onArtifactActionComplete} />
        {manifest && rows.length === 0 && !error ? <div className="text-xs text-muted-foreground">No profile artifacts found.</div> : null}
        {rows.length > 0 ? (
          <ScrollArea className="h-full rounded-md border border-border">
            <div className="min-w-[1120px] divide-y divide-border text-xs">
              <div className="grid grid-cols-[1.25fr_70px_70px_95px_95px_85px_85px_85px_85px_1fr] gap-3 bg-muted/40 px-3 py-2 font-medium text-muted-foreground">
                <div>Profile</div>
                <div>LLM</div>
                <div>Tools</div>
                <div>Input</div>
                <div>Output</div>
                <div>Avg dur</div>
                <div>P95 dur</div>
                <div>Avg TTFT</div>
                <div>P95 TTFT</div>
                <div>Cost</div>
              </div>
              {rows.map((row) => (
                <div key={row.path} className="grid grid-cols-[1.25fr_70px_70px_95px_95px_85px_85px_85px_85px_1fr] gap-3 px-3 py-2">
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
                  <div className="font-mono text-[11px]">{row.profile.costStatus === 'estimated' ? formatUsd(row.profile.estimatedCostUsd) : row.profile.costStatus ?? 'unknown'}</div>
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
  const entries = rows.flatMap((row) => (row.index.entries ?? []).map((entry) => ({ row, entry })))
  const totals = entries.reduce((acc, item) => {
    if (item.entry.scope === 'global') acc.global += 1
    else acc.workspace += 1
    if (item.entry.status === 'tombstoned') acc.tombstoned += 1
    else acc.active += 1
    return acc
  }, { active: 0, tombstoned: 0, workspace: 0, global: 0 })
  const warningCount = rows.reduce((sum, row) => sum + (row.index.warnings?.length ?? 0), 0)
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
          <Stat label="Artifacts" value={String(manifest?.summary.entryCount ?? 0)} />
        </div>
      </aside>
      <div className="min-h-0 p-3">
        {error ? (
          <div className="mb-3 rounded-md border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
            {error}
          </div>
        ) : null}
        {loading && !manifest ? <div className="text-xs text-muted-foreground">Loading artifact manifest...</div> : null}
        <EnhancementActionPanel title="Memory Artifact Actions" actions={memoryActionConfigs} onComplete={onArtifactActionComplete} />
        {manifest && rows.length === 0 && !error ? <div className="text-xs text-muted-foreground">No memory index artifacts found.</div> : null}
        {entries.length > 0 ? (
          <ScrollArea className="h-full rounded-md border border-border">
            <div className="min-w-[980px] divide-y divide-border text-xs">
              <div className="grid grid-cols-[110px_110px_1fr_1.4fr_90px_130px_1fr] gap-3 bg-muted/40 px-3 py-2 font-medium text-muted-foreground">
                <div>Scope</div>
                <div>Status</div>
                <div>Key</div>
                <div>Description</div>
                <div>Confidence</div>
                <div>Session</div>
                <div>Provenance</div>
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
  if (status === 'tombstoned') return <div className="font-mono text-[11px] text-amber-700 dark:text-amber-300">tombstoned</div>
  if (status === 'active') return <div className="font-mono text-[11px] text-emerald-700 dark:text-emerald-300">active</div>
  return <div className="font-mono text-[11px] text-muted-foreground">unknown</div>
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
          <Stat label="Ops artifacts" value={String(rows.length)} />
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
        {loading && !manifest ? <div className="text-xs text-muted-foreground">Loading artifact manifest...</div> : null}
        <EnhancementActionPanel title="Ops Artifact Actions" actions={opsActionConfigs} onComplete={onArtifactActionComplete} />
        {manifest && rows.length === 0 && !error ? <div className="text-xs text-muted-foreground">No ops artifacts found.</div> : null}
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
  if (resolved === true) {
    return <div className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-300"><CheckCircle2 className="h-3 w-3" aria-hidden="true" />resolved</div>
  }
  if (resolved === false) {
    return <div className="inline-flex items-center gap-1 text-rose-600 dark:text-rose-300"><XCircle className="h-3 w-3" aria-hidden="true" />failed</div>
  }
  return <div className="text-muted-foreground">unknown</div>
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

function formatUsd(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? `$${value.toFixed(4)}` : 'unknown'
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
