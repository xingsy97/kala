import { useEffect, useMemo, useState } from 'react'
import { CheckCircle2, FileText, RefreshCw, XCircle } from 'lucide-react'

import { Button } from '../../components/ui/button.js'
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
  onOpenChange(open: boolean): void
}

type ViewMode = 'artifacts' | 'eval' | 'profiles' | 'memory'

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

export function ArtifactExplorerDialog({ open, onOpenChange }: Props): JSX.Element {
  const [manifest, setManifest] = useState<ArtifactManifest | null>(null)
  const [mode, setMode] = useState<ViewMode>('artifacts')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reloadToken, setReloadToken] = useState(0)
  const [evalRows, setEvalRows] = useState<readonly EvalRunRow[]>([])
  const [evalComparisons, setEvalComparisons] = useState<readonly EvalComparisonRow[]>([])
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
  const [artifactDetail, setArtifactDetail] = useState<ArtifactDetailRequest | null>(null)

  useEffect(() => {
    if (!open) return
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
  }, [open, reloadToken])

  const kindRows = useMemo(() => {
    if (!manifest) return []
    return Object.entries(manifest.summary.kinds).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  }, [manifest])

  useEffect(() => {
    if (!open || mode !== 'eval' || !manifest) return
    const summaries = manifest.entries.filter((entry) => entry.kind === 'eval_summary' || entry.path.endsWith('/summary.json'))
    const progresses = manifest.entries.filter((entry) => entry.kind === 'eval_progress' || entry.path.endsWith('/progress.json'))
    const comparisons = manifest.entries.filter((entry) => entry.kind === 'eval_comparison' || entry.path.endsWith('/eval-comparison.json'))
    let cancelled = false
    setEvalError(null)
    setEvalRows([])
    setEvalComparisons([])
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
    ])
      .then(([summaryRows, comparisonRows, progressRows]) => {
        const rows = mergeEvalRuns(summaryRows, progressRows)
        if (!cancelled) setEvalRows(rows)
        if (!cancelled) setEvalComparisons(comparisonRows)
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

  return (
    <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(760px,86dvh)] w-[min(1040px,94vw)] max-w-none flex-col overflow-hidden p-0 gap-0">
        <DialogHeader className="border-b border-border px-4 py-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <DialogTitle>Artifacts</DialogTitle>
              <DialogDescription>Run output index from the host artifact store.</DialogDescription>
            </div>
            <div className="flex items-center gap-2">
              <div className="inline-flex rounded-md border border-border bg-muted/30 p-0.5 text-xs">
                <button type="button" className={tabClass(mode === 'artifacts')} onClick={() => setMode('artifacts')}>Artifacts</button>
                <button type="button" className={tabClass(mode === 'eval')} onClick={() => setMode('eval')}>Eval</button>
                <button type="button" className={tabClass(mode === 'profiles')} onClick={() => setMode('profiles')}>Profiles</button>
                <button type="button" className={tabClass(mode === 'memory')} onClick={() => setMode('memory')}>Memory</button>
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
          />
        ) : mode === 'profiles' ? (
          <ProfilesView
            manifest={manifest}
            rows={profileRows}
            error={error ?? profileError}
            loading={loading}
          />
        ) : (
          <MemoryView
            manifest={manifest}
            rows={memoryRows}
            error={error ?? memoryError}
            loading={loading}
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
}: {
  manifest: ArtifactManifest | null
  rows: readonly EvalRunRow[]
  comparisons: readonly EvalComparisonRow[]
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
          <Stat label="Artifacts" value={String(manifest?.summary.entryCount ?? 0)} />
        </div>
      </aside>
      <div className="grid min-h-0 grid-rows-[minmax(150px,0.55fr)_auto_auto_minmax(220px,1fr)_auto] gap-3 p-3 max-lg:grid-rows-none">
        {error ? (
          <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
            {error}
          </div>
        ) : null}
        {loading && !manifest ? <div className="text-xs text-muted-foreground">Loading artifact manifest...</div> : null}
        {manifest && rows.length === 0 && comparisons.length === 0 && !error ? <div className="text-xs text-muted-foreground">No eval summaries found.</div> : null}
        <EvalScorecard rows={rows} selectedRun={selectedRun} />
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
          />
          </div>
        ) : null}
        {comparisons.length > 0 ? (
          <div className="min-h-0 rounded-md border border-border">
            <div className="border-b border-border bg-muted/40 px-3 py-2 text-xs font-medium text-muted-foreground">Comparisons</div>
            <div className="max-h-48 divide-y divide-border overflow-auto text-xs">
              {comparisons.map((row) => (
                <div key={row.path} className="grid grid-cols-[1fr_1fr_90px_90px_90px_90px_minmax(150px,0.7fr)] gap-3 px-3 py-2 max-lg:grid-cols-[1fr_1fr_80px_80px]">
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
              ))}
            </div>
          </div>
        ) : null}
      </div>
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
}: {
  run: EvalRunRow
  trials: readonly EvalTrialRow[]
  selectedTrial: EvalTrialRow | undefined
  selectedTrialId: string | null
  onSelectTrial(id: string): void
  loading: boolean
  error: string | null
  onOpenArtifact(request: ArtifactDetailRequest): void
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
}: {
  manifest: ArtifactManifest | null
  rows: readonly ProfileRow[]
  error: string | null
  loading: boolean
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
                    <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{row.path}  -  {(row.profile.models ?? []).join(', ') || 'unknown'}  -  missing {row.profile.llmTraceMissingCalls ?? 0}</div>
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
}: {
  manifest: ArtifactManifest | null
  rows: readonly MemoryIndexRow[]
  error: string | null
  loading: boolean
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

function formatConfidence(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${Math.round(value * 100)}%` : 'n/a'
}

async function fetchArtifactContent(path: string): Promise<ArtifactContentResponse> {
  const res = await fetch(`/artifacts/content?path=${encodeURIComponent(path)}`, { cache: 'no-store' })
  if (res.ok) return (await res.json()) as ArtifactContentResponse
  const body = await res.json().catch(() => null) as { error?: string } | null
  throw new Error(body?.error ?? `artifact content request failed: ${res.status}`)
}
