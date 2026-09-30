import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import type { Socket } from 'socket.io-client'
import type {
  DashboardClientToServerEvents,
  DashboardServerToClientEvents,
  GlobalStorageSnapshot,
} from '@agent-kernel/shared'

import { Button } from '../../../components/ui/button.js'
import { ProductState } from '../../../components/ui/product-state.js'
import { SectionHeader } from '../controls.js'

type DashboardSocket = Socket<DashboardServerToClientEvents, DashboardClientToServerEvents>

export function StorageSection({ socket }: { socket?: DashboardSocket }): JSX.Element {
  const [snapshot, setSnapshot] = useState<GlobalStorageSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = (refresh: boolean): void => {
    if (!socket) return
    setLoading(true)
    setError(null)
    socket.emit('client:get_global_storage', refresh ? { refresh: true } : {}, (result) => {
      setLoading(false)
      if (result.ok) setSnapshot(result.value)
      else setError(result.error)
    })
  }

  useEffect(() => {
    load(false)
  }, [socket])

  return (
    <div data-testid="settings-storage">
      <SectionHeader
        title="Storage"
        subtitle="Cached disk usage for sessions and diagnostic artifacts. Scans are explicit and metadata-only."
      />
      {!socket ? (
        <ProductState kind="empty" title="Storage inventory unavailable" description="Connect to a Host session to inspect storage." />
      ) : error ? (
        <ProductState kind="error" title="Could not load storage" description={error} primary={{ label: 'Retry', onClick: () => load(false) }} />
      ) : snapshot ? (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border/50 bg-muted/15 p-4">
            <div>
              <div className="text-xs text-muted-foreground">Kala session storage</div>
              <div className="text-2xl font-semibold">{formatBytes(snapshot.totalBytes)}</div>
              <div className="text-caption text-muted-foreground">{snapshot.totalFiles.toLocaleString()} files</div>
            </div>
            <Button type="button" variant="outline" size="sm" disabled={loading} onClick={() => load(true)}>
              <RefreshCw className={`mr-1.5 h-4 w-4 ${loading ? 'animate-spin' : ''}`} aria-hidden />
              Refresh inventory
            </Button>
          </div>

          <section>
            <h3 className="mb-2 text-sm font-medium">Categories</h3>
            <div className="grid gap-2 sm:grid-cols-2">
              {Object.entries(snapshot.categories)
                .filter(([, value]) => value.bytes > 0 || value.files > 0)
                .sort((left, right) => right[1].bytes - left[1].bytes)
                .map(([category, value]) => (
                  <div key={category} className="flex items-center justify-between gap-3 rounded-md border border-border/40 px-3 py-2 text-sm">
                    <span>{category}</span>
                    <span className="text-right text-xs text-muted-foreground">{formatBytes(value.bytes)} · {value.files} files</span>
                  </div>
                ))}
            </div>
          </section>

          <section>
            <h3 className="mb-2 text-sm font-medium">Largest session trees</h3>
            <div className="divide-y divide-border/40 rounded-md border border-border/50">
              {snapshot.largestSessionTrees.map((entry) => (
                <div key={entry.sessionId} className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 px-3 py-2 text-sm">
                  <div className="min-w-0">
                    <div className="truncate font-mono text-xs" title={entry.sessionId}>{entry.sessionId}</div>
                    <div className="text-caption text-muted-foreground">{entry.descendantCount} descendants</div>
                  </div>
                  <span>{formatBytes(entry.treeBytes)}</span>
                </div>
              ))}
            </div>
          </section>

          {snapshot.orphanCandidates.length > 0 ? (
            <section>
              <h3 className="mb-2 text-sm font-medium">Cleanup candidates</h3>
              <p className="mb-2 text-xs text-muted-foreground">
                These entries are candidates only. Nothing is deleted without an exact, revalidated cleanup plan.
              </p>
              <div className="divide-y divide-border/40 rounded-md border border-border/50">
                {snapshot.orphanCandidates.slice(0, 50).map((candidate) => (
                  <div key={`${candidate.category}:${candidate.id}`} className="flex items-center justify-between gap-3 px-3 py-2 text-xs">
                    <span className="min-w-0 truncate font-mono" title={candidate.id}>{candidate.id}</span>
                    <span className="shrink-0 text-muted-foreground">{candidate.category} · {formatBytes(candidate.bytes)}</span>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          <p className="text-caption text-muted-foreground">
            Last measured: {snapshot.state.measuredAt ?? 'not yet'}. Inventory refreshes are lazy and do not read complete session logs.
          </p>
        </div>
      ) : (
        <ProductState kind="loading" title="Loading storage inventory" description="Reading cached measurements without scanning disk." />
      )}
    </div>
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KiB', 'MiB', 'GiB', 'TiB']
  let value = bytes / 1024
  let unit = units[0]!
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024
    unit = units[index]!
  }
  return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${unit}`
}
