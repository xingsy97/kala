import { useEffect, useMemo, useState } from 'react'
import { RefreshCw } from 'lucide-react'

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

type ViewMode = 'artifacts' | 'eval'

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

export function ArtifactExplorerDialog({ open, onOpenChange }: Props): JSX.Element {
  const [manifest, setManifest] = useState<ArtifactManifest | null>(null)
  const [mode, setMode] = useState<ViewMode>('artifacts')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reloadToken, setReloadToken] = useState(0)
  const [evalRows, setEvalRows] = useState<readonly EvalSummaryRow[]>([])
  const [evalError, setEvalError] = useState<string | null>(null)

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
    let cancelled = false
    setEvalError(null)
    setEvalRows([])
    void Promise.all(summaries.map(async (entry): Promise<EvalSummaryRow> => {
      const content = await fetchArtifactContent(entry.path)
      return { path: entry.path, summary: content.body as EvalRunSummary }
    }))
      .then((rows) => {
        if (!cancelled) setEvalRows(rows)
      })
      .catch((err: unknown) => {
        if (!cancelled) setEvalError(err instanceof Error ? err.message : String(err))
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
        {mode === 'artifacts' ? <ArtifactInventory manifest={manifest} kindRows={kindRows} error={error} loading={loading} /> : <EvalRunsView manifest={manifest} rows={evalRows} error={error ?? evalError} loading={loading} />}
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
  error,
  loading,
}: {
  manifest: ArtifactManifest | null
  rows: readonly EvalSummaryRow[]
  error: string | null
  loading: boolean
}): JSX.Element {
  const comparisonCount = manifest?.entries.filter((entry) => entry.kind === 'eval_comparison').length ?? 0
  return (
    <div className="grid min-h-0 flex-1 grid-cols-[260px_minmax(0,1fr)] gap-0 max-md:grid-cols-1">
      <aside className="min-h-0 border-r border-border bg-muted/25 p-3 max-md:border-b max-md:border-r-0">
        <div className="grid gap-2 text-xs">
          <Stat label="Eval runs" value={String(rows.length)} />
          <Stat label="Comparisons" value={String(comparisonCount)} />
          <Stat label="Artifacts" value={String(manifest?.summary.entryCount ?? 0)} />
        </div>
      </aside>
      <div className="min-h-0 p-3">
        {error ? (
          <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
            {error}
          </div>
        ) : null}
        {loading && !manifest ? <div className="text-xs text-muted-foreground">Loading artifact manifest...</div> : null}
        {manifest && rows.length === 0 && !error ? <div className="text-xs text-muted-foreground">No eval summaries found.</div> : null}
        {rows.length > 0 ? (
          <ScrollArea className="h-full rounded-md border border-border">
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
                <div key={row.path} className="grid grid-cols-[1.15fr_1fr_120px_90px_90px_90px_90px] gap-3 px-3 py-2">
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
                </div>
              ))}
            </div>
          </ScrollArea>
        ) : null}
      </div>
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

async function fetchArtifactContent(path: string): Promise<ArtifactContentResponse> {
  const res = await fetch(`/artifacts/content?path=${encodeURIComponent(path)}`, { cache: 'no-store' })
  if (res.ok) return (await res.json()) as ArtifactContentResponse
  const body = await res.json().catch(() => null) as { error?: string } | null
  throw new Error(body?.error ?? `artifact content request failed: ${res.status}`)
}
