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

type ViewMode = 'artifacts' | 'eval' | 'profiles'

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
  metrics?: Record<string, unknown>
}

type EvalSummaryRow = {
  path: string
  summary: EvalRunSummary
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
}

type ProfileRow = {
  path: string
  profile: SessionProfile
}

export function ArtifactExplorerDialog({ open, onOpenChange }: Props): JSX.Element {
  const [manifest, setManifest] = useState<ArtifactManifest | null>(null)
  const [mode, setMode] = useState<ViewMode>('artifacts')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reloadToken, setReloadToken] = useState(0)
  const [evalRows, setEvalRows] = useState<readonly EvalSummaryRow[]>([])
  const [evalComparisons, setEvalComparisons] = useState<readonly EvalComparisonRow[]>([])
  const [evalError, setEvalError] = useState<string | null>(null)
  const [selectedEvalRunPath, setSelectedEvalRunPath] = useState<string | null>(null)
  const [evalTrials, setEvalTrials] = useState<readonly EvalTrialRow[]>([])
  const [selectedTrialId, setSelectedTrialId] = useState<string | null>(null)
  const [evalTrialsLoading, setEvalTrialsLoading] = useState(false)
  const [evalTrialsError, setEvalTrialsError] = useState<string | null>(null)
  const [profileRows, setProfileRows] = useState<readonly ProfileRow[]>([])
  const [profileError, setProfileError] = useState<string | null>(null)

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
    const comparisons = manifest.entries.filter((entry) => entry.kind === 'eval_comparison' || entry.path.endsWith('/eval-comparison.json'))
    let cancelled = false
    setEvalError(null)
    setEvalRows([])
    setEvalComparisons([])
    void Promise.all([
      Promise.all(summaries.map(async (entry): Promise<EvalSummaryRow> => {
        const content = await fetchArtifactContent(entry.path)
        return { path: entry.path, summary: content.body as EvalRunSummary }
      })),
      Promise.all(comparisons.map(async (entry): Promise<EvalComparisonRow> => {
        const content = await fetchArtifactContent(entry.path)
        return { path: entry.path, comparison: content.body as EvalRunComparison }
      })),
    ])
      .then(([rows, comparisonRows]) => {
        if (!cancelled) setEvalRows(rows)
        if (!cancelled) setEvalComparisons(comparisonRows)
        if (!cancelled) setSelectedEvalRunPath((current) => current && rows.some((row) => row.path === current) ? current : rows[0]?.path ?? null)
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
    const root = evalRunRoot(selectedEvalRunPath)
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

  return (
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
                <button type="button" className={tabClass(mode === 'eval')} onClick={() => setMode('eval')}>Eval Runs</button>
                <button type="button" className={tabClass(mode === 'profiles')} onClick={() => setMode('profiles')}>Profiles</button>
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
          />
        ) : (
          <ProfilesView
            manifest={manifest}
            rows={profileRows}
            error={error ?? profileError}
            loading={loading}
          />
        )}
      </DialogContent>
    </Dialog>
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
}: {
  manifest: ArtifactManifest | null
  rows: readonly EvalSummaryRow[]
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
}): JSX.Element {
  const comparisonCount = comparisons.length
  const selectedRun = rows.find((row) => row.path === selectedRunPath)
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
      <div className="grid min-h-0 grid-rows-[minmax(170px,0.8fr)_minmax(220px,1.2fr)] gap-3 p-3 max-lg:grid-rows-none">
        {error ? (
          <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
            {error}
          </div>
        ) : null}
        {loading && !manifest ? <div className="text-xs text-muted-foreground">Loading artifact manifest...</div> : null}
        {manifest && rows.length === 0 && comparisons.length === 0 && !error ? <div className="text-xs text-muted-foreground">No eval summaries found.</div> : null}
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
                  key={row.path}
                  type="button"
                  className={cn(
                    'grid w-full grid-cols-[1.15fr_1fr_120px_90px_90px_90px_90px] gap-3 px-3 py-2 text-left transition-colors hover:bg-muted/30',
                    selectedRunPath === row.path && 'bg-primary/10 dark:bg-primary/10',
                  )}
                  onClick={() => onSelectRun(row.path)}
                >
                  <div className="min-w-0">
                    <div className="truncate font-mono text-[11px]">{row.summary.experimentId ?? row.path}</div>
                    <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{row.path}</div>
                  </div>
                  <div className="truncate">{row.summary.dataset ?? 'unknown'}</div>
                  <div className="truncate font-mono text-[11px] text-muted-foreground">{row.summary.model ?? 'unknown'}</div>
                  <div className="font-mono text-[11px]">{row.summary.trialCount ?? 0}</div>
                  <div className="font-mono text-[11px]">{row.summary.resolved ?? 0}</div>
                  <div className="font-mono text-[11px]">{row.summary.failed ?? 0}</div>
                  <div className="font-mono text-[11px]">{formatPercent(row.summary.metrics?.passRate)}</div>
                </button>
              ))}
            </div>
          </ScrollArea>
          ) : null}
        </div>
        {selectedRun ? (
          <EvalTrialDetail
            run={selectedRun}
            trials={trials}
            selectedTrial={selectedTrial}
            selectedTrialId={selectedTrialId}
            onSelectTrial={onSelectTrial}
            loading={trialsLoading}
            error={trialsError}
          />
        ) : null}
        {comparisons.length > 0 ? (
          <div className="rounded-md border border-border">
            <div className="border-b border-border bg-muted/40 px-3 py-2 text-xs font-medium text-muted-foreground">Comparisons</div>
            <div className="divide-y divide-border text-xs">
              {comparisons.map((row) => (
                <div key={row.path} className="grid grid-cols-[1fr_1fr_90px_90px_90px_90px] gap-3 px-3 py-2 max-lg:grid-cols-[1fr_1fr_80px_80px]">
                  <div className="min-w-0">
                    <div className="truncate font-mono text-[11px]">{row.comparison.baseline?.experimentId ?? 'baseline'}</div>
                    <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{row.path}</div>
                  </div>
                  <div className="truncate font-mono text-[11px]">{row.comparison.candidate?.experimentId ?? 'candidate'}</div>
                  <Delta label="resolved" value={row.comparison.deltas?.resolved} />
                  <Delta label="failed" value={row.comparison.deltas?.failed} invert />
                  <Delta label="timeout" value={row.comparison.deltas?.timedOut} invert />
                  <Delta label="pass" value={row.comparison.deltas?.passRate} percent />
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>
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
}: {
  run: EvalSummaryRow
  trials: readonly EvalTrialRow[]
  selectedTrial: EvalTrialRow | undefined
  selectedTrialId: string | null
  onSelectTrial(id: string): void
  loading: boolean
  error: string | null
}): JSX.Element {
  return (
    <div className="grid min-h-0 grid-cols-[minmax(0,1fr)_280px] overflow-hidden rounded-md border border-border max-xl:grid-cols-1">
      <div className="min-h-0 border-r border-border max-xl:border-b max-xl:border-r-0">
        <div className="flex items-center justify-between gap-2 border-b border-border bg-muted/40 px-3 py-2 text-xs">
          <div className="min-w-0">
            <div className="font-medium">Trial detail</div>
            <div className="truncate font-mono text-[11px] text-muted-foreground">{run.path}</div>
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
            <div className="rounded-md border border-border bg-background/70">
              <div className="border-b border-border px-2 py-1.5 text-[11px] font-medium uppercase text-muted-foreground">Artifacts</div>
              <div className="max-h-48 overflow-auto p-2">
                {(selectedTrial.trial.artifacts ?? []).length > 0 ? (
                  <div className="grid gap-1.5">
                    {(selectedTrial.trial.artifacts ?? []).map((artifact, index) => (
                      <div key={`${artifact.uri ?? 'artifact'}-${index}`} className="min-w-0 rounded border border-border bg-muted/20 px-2 py-1">
                        <div className="flex items-center gap-1.5">
                          <FileText className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
                          <span className="truncate font-mono text-[11px]" title={artifact.uri}>{artifact.uri ?? '(inline)'}</span>
                        </div>
                        <div className="mt-0.5 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                          <span>{artifact.kind ?? 'artifact'}</span>
                          <span>{typeof artifact.bytes === 'number' ? formatBytes(artifact.bytes) : ''}</span>
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
    return acc
  }, { llmCalls: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, knownCost: 0, unknownCost: 0 })
  return (
    <div className="grid min-h-0 flex-1 grid-cols-[260px_minmax(0,1fr)] gap-0 max-md:grid-cols-1">
      <aside className="min-h-0 border-r border-border bg-muted/25 p-3 max-md:border-b max-md:border-r-0">
        <div className="grid gap-2 text-xs">
          <Stat label="Profiles" value={String(rows.length)} />
          <Stat label="LLM calls" value={String(totals.llmCalls)} />
          <Stat label="Tool calls" value={String(totals.toolCalls)} />
          <Stat label="Known cost" value={formatUsd(totals.knownCost)} />
          <Stat label="Unknown cost" value={String(totals.unknownCost)} />
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
            <div className="min-w-[860px] divide-y divide-border text-xs">
              <div className="grid grid-cols-[1.25fr_95px_95px_110px_110px_105px_105px_1fr] gap-3 bg-muted/40 px-3 py-2 font-medium text-muted-foreground">
                <div>Profile</div>
                <div>LLM</div>
                <div>Tools</div>
                <div>Input tok</div>
                <div>Output tok</div>
                <div>Cost</div>
                <div>Missing</div>
                <div>Models</div>
              </div>
              {rows.map((row) => (
                <div key={row.path} className="grid grid-cols-[1.25fr_95px_95px_110px_110px_105px_105px_1fr] gap-3 px-3 py-2">
                  <div className="min-w-0">
                    <div className="truncate font-mono text-[11px]">{row.profile.sessionId ?? row.path}</div>
                    <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{row.path}</div>
                  </div>
                  <div className="font-mono text-[11px]">{row.profile.llmCalls ?? 0}</div>
                  <div className="font-mono text-[11px]">{row.profile.toolCalls ?? 0}</div>
                  <div className="font-mono text-[11px]">{formatInteger(row.profile.totalInputTokens)}</div>
                  <div className="font-mono text-[11px]">{formatInteger(row.profile.totalOutputTokens)}</div>
                  <div className="font-mono text-[11px]">{row.profile.costStatus === 'estimated' ? formatUsd(row.profile.estimatedCostUsd) : row.profile.costStatus ?? 'unknown'}</div>
                  <div className="font-mono text-[11px] text-muted-foreground">{row.profile.llmTraceMissingCalls ?? 0}</div>
                  <div className="truncate font-mono text-[11px] text-muted-foreground">{(row.profile.models ?? []).join(', ') || 'unknown'}</div>
                </div>
              ))}
            </div>
          </ScrollArea>
        ) : null}
      </div>
    </div>
  )
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
  return summaryPath.endsWith('/summary.json') ? summaryPath.slice(0, -'/summary.json'.length) : summaryPath.replace(/\/[^/]+$/, '')
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

async function fetchArtifactContent(path: string): Promise<ArtifactContentResponse> {
  const res = await fetch(`/artifacts/content?path=${encodeURIComponent(path)}`, { cache: 'no-store' })
  if (res.ok) return (await res.json()) as ArtifactContentResponse
  const body = await res.json().catch(() => null) as { error?: string } | null
  throw new Error(body?.error ?? `artifact content request failed: ${res.status}`)
}
