import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { DiffEditor } from '@monaco-editor/react'
import { AlertCircle, Columns2, FileCode2, GitBranch, ListTree, Loader2, RefreshCw, Rows3 } from 'lucide-react'
import type { Socket } from 'socket.io-client'

import type {
  DashboardClientToServerEvents,
  DashboardServerToClientEvents,
  GitDiffResult,
  GitFileChange,
  GitStatusResult,
} from '@agent-kernel/shared'

import { Button } from '../../components/ui/button.js'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog.js'
import { cn } from '../../lib/utils.js'

type DashboardSocket = Socket<DashboardServerToClientEvents, DashboardClientToServerEvents>

type SourceControlPanelProps = {
  socket: DashboardSocket | null
  workspaceId?: string
  sessionId?: string | null
  cwd?: string
  fontSizePx?: number
}

type GitGroup = {
  id: string
  label: string
  files: GitFileChange[]
}

const GIT_STATUS_LABEL: Record<GitFileChange['status'], string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  untracked: '?',
  conflicted: 'U',
  typechanged: 'T',
}

function SourceControlPanelImpl({ socket, workspaceId, sessionId, cwd, fontSizePx = 12 }: SourceControlPanelProps): JSX.Element {
  const [status, setStatus] = useState<GitStatusResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<{ file: GitFileChange; staged: boolean } | null>(null)
  const [orderByPath, setOrderByPath] = useState(false)
  const online = Boolean(socket && workspaceId)

  const refresh = useCallback(async (): Promise<void> => {
    if (!socket || !workspaceId) return
    setLoading(true)
    const result = await requestGitStatus(socket, { workspaceId, sessionId: sessionId ?? undefined, cwd })
    setStatus(result)
    setLoading(false)
  }, [cwd, sessionId, socket, workspaceId])

  useEffect(() => {
    setStatus(null)
    setSelected(null)
    if (online) void refresh()
  }, [online, refresh])

  const groups = useMemo(() => groupGitFiles(status?.files ?? [], orderByPath), [orderByPath, status])
  const fileCount = status?.files.length ?? 0

  return (
    <div className="flex h-full min-h-0 flex-col bg-sidebar text-sidebar-foreground" data-testid="source-control-panel">
      <div className="flex h-8 flex-none items-center gap-1.5 border-b border-sidebar-border px-1.5">
        <GitBranch className="h-3.5 w-3.5 flex-none text-sidebar-foreground/70" />
        <div className="min-w-0 flex-1 truncate text-xs text-sidebar-foreground/75">
          {status?.repo?.branch ?? status?.repo?.head ?? 'Repository'}
        </div>
        {fileCount > 0 ? <span className="rounded bg-sidebar-accent px-1.5 py-0.5 text-[10px] leading-none text-sidebar-foreground/75">{fileCount}</span> : null}
        <Button
          variant="ghost"
          size="icon"
          className={cn('h-6 w-6 flex-none text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground', orderByPath ? 'bg-sidebar-accent text-sidebar-foreground' : '')}
          disabled={fileCount === 0}
          onClick={() => setOrderByPath((next) => !next)}
          title={orderByPath ? 'Use git status order' : 'Order by path'}
          aria-label={orderByPath ? 'Use git status order' : 'Order by path'}
          aria-pressed={orderByPath}
          data-testid="source-control-order-by-path"
        >
          <ListTree className="h-3.5 w-3.5" />
        </Button>
        <Button variant="ghost" size="icon" className="h-6 w-6 flex-none text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground" disabled={!online || loading} onClick={() => void refresh()} title="Refresh source control" aria-label="Refresh source control">
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-1" style={{ fontSize: fontSizePx }}>
        {!online ? (
          <EmptyState message="Workspace executor is offline." />
        ) : loading && !status ? (
          <div className="flex items-center gap-2 p-3 text-xs text-sidebar-foreground/60"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading changes</div>
        ) : status?.error ? (
          <ErrorState message={status.error.message} />
        ) : fileCount === 0 ? (
          <EmptyState message="No changes." />
        ) : (
          <div className="space-y-2">
            {status?.truncated ? <div className="rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-700 dark:text-amber-200">Showing first {status.truncated.limit} changed files.</div> : null}
            {groups.map((group) => (
              <div key={group.id}>
                <div className="px-1.5 py-1 text-[11px] font-medium uppercase tracking-normal text-sidebar-foreground/55">{group.label}</div>
                <div className="space-y-0.5">
                  {group.files.map((file) => (
                    <GitFileRow key={`${group.id}:${file.path}:${file.oldPath ?? ''}`} file={file} onOpen={() => setSelected({ file, staged: group.id === 'staged' })} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      <GitDiffDialog
        open={selected !== null}
        onOpenChange={(open) => { if (!open) setSelected(null) }}
        socket={socket}
        workspaceId={workspaceId}
        sessionId={sessionId ?? undefined}
        cwd={cwd}
        target={selected}
      />
    </div>
  )
}

export const SourceControlPanel = memo(SourceControlPanelImpl)

function GitFileRow({ file, onOpen }: { file: GitFileChange; onOpen: () => void }): JSX.Element {
  return (
    <button type="button" className="flex h-7 w-full min-w-0 items-center gap-1.5 rounded px-1.5 text-left hover:bg-sidebar-accent" onClick={onOpen} data-testid="source-control-file">
      <span className={cn('flex h-4 w-4 flex-none items-center justify-center rounded text-[10px] font-semibold', statusBadgeClass(file.status))}>{GIT_STATUS_LABEL[file.status]}</span>
      <FileCode2 className="h-3.5 w-3.5 flex-none text-sidebar-foreground/55" />
      <span className="min-w-0 flex-1 truncate font-mono text-[0.95em]">{file.path}</span>
    </button>
  )
}

function GitDiffDialog({ open, onOpenChange, socket, workspaceId, sessionId, cwd, target }: { open: boolean; onOpenChange: (open: boolean) => void; socket: DashboardSocket | null; workspaceId?: string; sessionId?: string; cwd?: string; target: { file: GitFileChange; staged: boolean } | null }): JSX.Element {
  const [diff, setDiff] = useState<GitDiffResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [renderSideBySide, setRenderSideBySide] = useState(true)
  const path = target?.file.path

  useEffect(() => {
    if (!open) return
    if (window.innerWidth < 640) setRenderSideBySide(false)
  }, [open])

  useEffect(() => {
    if (!open || !socket || !workspaceId || !target) return
    let cancelled = false
    setLoading(true)
    setDiff(null)
    requestGitDiff(socket, { workspaceId, sessionId, cwd, path: target.file.path, staged: target.staged }).then((result) => {
      if (cancelled) return
      setDiff(result)
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [open, socket, workspaceId, sessionId, cwd, target])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92dvh] w-[96vw] max-w-[min(1180px,96vw)] gap-0 overflow-hidden p-0" data-testid="source-control-diff-dialog">
        <DialogHeader className="border-b border-border px-3 py-2.5 pr-10 sm:px-4">
          <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start sm:gap-3">
            <div className="min-w-0 flex-1">
              <DialogTitle className="truncate font-mono text-sm font-medium">{path ?? 'Git diff'}</DialogTitle>
              <DialogDescription className="text-xs">Read-only source control diff.</DialogDescription>
            </div>
            <div className="grid w-fit flex-none grid-cols-2 rounded-md border border-border bg-muted/40 p-0.5" aria-label="Diff layout">
              <button
                type="button"
                className={cn('flex h-7 items-center justify-center gap-1.5 rounded px-2 text-xs font-medium', renderSideBySide ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:bg-muted hover:text-foreground')}
                onClick={() => setRenderSideBySide(true)}
                aria-pressed={renderSideBySide}
                data-testid="source-control-diff-side-by-side"
              >
                <Columns2 className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Side by side</span>
              </button>
              <button
                type="button"
                className={cn('flex h-7 items-center justify-center gap-1.5 rounded px-2 text-xs font-medium', !renderSideBySide ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:bg-muted hover:text-foreground')}
                onClick={() => setRenderSideBySide(false)}
                aria-pressed={!renderSideBySide}
                data-testid="source-control-diff-inline"
              >
                <Rows3 className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Inline</span>
              </button>
            </div>
          </div>
        </DialogHeader>
        <div className="h-[min(68dvh,760px)] min-h-0 sm:h-[min(74dvh,760px)]">
          {loading ? (
            <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading diff</div>
          ) : diff?.error ? (
            <DiffError message={diff.error.message} />
          ) : diff ? (
            <div className="flex h-full min-h-0 flex-col">
              {diff.truncated ? <div className="border-b border-amber-200 bg-amber-50 px-3 py-1 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">Large diff side was capped at {formatBytes(diff.truncated.maxBytes)}.</div> : null}
              <div className="min-h-0 flex-1">
                <DiffEditor
                  original={diff.oldText ?? ''}
                  modified={diff.newText ?? ''}
                  language={diff.language ?? 'plaintext'}
                  theme="vs-dark"
                  options={{ readOnly: true, renderSideBySide, minimap: { enabled: false }, scrollBeyondLastLine: false, automaticLayout: true }}
                />
              </div>
            </div>
          ) : (
            <div className="p-4 text-sm text-muted-foreground">Select a changed file.</div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function groupGitFiles(files: readonly GitFileChange[], orderByPath: boolean): GitGroup[] {
  const order = (items: GitFileChange[]): GitFileChange[] => orderByPath
    ? [...items].sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: 'base' }))
    : items
  const conflicts = order(files.filter((file) => file.status === 'conflicted'))
  const staged = order(files.filter((file) => file.staged && file.status !== 'conflicted'))
  const untracked = order(files.filter((file) => file.status === 'untracked'))
  const changes = order(files.filter((file) => file.unstaged && file.status !== 'untracked' && file.status !== 'conflicted'))
  return [
    { id: 'staged', label: 'Staged Changes', files: staged },
    { id: 'changes', label: 'Changes', files: changes },
    { id: 'untracked', label: 'Untracked', files: untracked },
    { id: 'conflicts', label: 'Conflicts', files: conflicts },
  ].filter((group) => group.files.length > 0)
}

function statusBadgeClass(status: GitFileChange['status']): string {
  if (status === 'added' || status === 'untracked') return 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-300'
  if (status === 'deleted') return 'bg-rose-500/15 text-rose-600 dark:text-rose-300'
  if (status === 'conflicted') return 'bg-amber-500/15 text-amber-700 dark:text-amber-200'
  return 'bg-sky-500/15 text-sky-600 dark:text-sky-300'
}

function EmptyState({ message }: { message: string }): JSX.Element {
  return <div className="p-3 text-xs text-sidebar-foreground/60">{message}</div>
}

function ErrorState({ message }: { message: string }): JSX.Element {
  return <div className="flex gap-2 p-3 text-xs text-sidebar-foreground/70"><AlertCircle className="mt-0.5 h-3.5 w-3.5 flex-none text-amber-500" /><span className="min-w-0 break-words">{message}</span></div>
}

function DiffError({ message }: { message: string }): JSX.Element {
  return <div className="flex gap-2 p-4 text-sm text-muted-foreground"><AlertCircle className="mt-0.5 h-4 w-4 flex-none text-amber-500" /><span className="min-w-0 break-words">{message}</span></div>
}

async function requestGitStatus(socket: DashboardSocket, payload: { workspaceId: string; sessionId?: string; cwd?: string }): Promise<GitStatusResult> {
  return await new Promise((resolve) => {
    const requestId = crypto.randomUUID()
    const timer = window.setTimeout(() => resolve({ requestId, workspaceId: payload.workspaceId, files: [], error: { code: 'timeout', message: 'timed out' } }), 8000)
    socket.emit('git:status', { requestId, ...payload }, (result) => {
      window.clearTimeout(timer)
      resolve(result)
    })
  })
}

async function requestGitDiff(socket: DashboardSocket, payload: { workspaceId: string; sessionId?: string; cwd?: string; path: string; staged: boolean }): Promise<GitDiffResult> {
  return await new Promise((resolve) => {
    const requestId = crypto.randomUUID()
    const timer = window.setTimeout(() => resolve({ requestId, workspaceId: payload.workspaceId, error: { code: 'timeout', message: 'timed out' } }), 10_000)
    socket.emit('git:diff', { requestId, ...payload }, (result) => {
      window.clearTimeout(timer)
      resolve(result)
    })
  })
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
