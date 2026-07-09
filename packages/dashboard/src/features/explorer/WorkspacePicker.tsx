import { useEffect, useMemo, useState } from 'react'
import { ChevronRight, Folder, Loader2 } from 'lucide-react'
import type { AttachedExecutor, DirListResult } from '@agent-kernel/shared'

import { Button } from '../../components/ui/button.js'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog.js'
import { Input } from '../../components/ui/input.js'
import { ScrollArea } from '../../components/ui/scroll-area.js'
import { cn } from '../../lib/utils.js'
import type { DashboardSocket } from '../../session.js'

type Props = {
  open: boolean
  workspaces: readonly AttachedExecutor[]
  socket: DashboardSocket | null
  onCreate(input: {
    workspaceId: string
    workspaceName: string | undefined
    cwd: string
  }): void
  onCancel(): void
}

type DirColumn = {
  path: string
  entries: DirListResult['entries']
  error?: string
}

export function NewSessionDialog({
  open,
  workspaces,
  socket,
  onCreate,
  onCancel,
}: Props): JSX.Element {
  const [workspaceId, setWorkspaceId] = useState('')
  const [cwd, setCwd] = useState('')
  const [columns, setColumns] = useState<DirColumn[]>([])
  const [loadingPath, setLoadingPath] = useState<string | null>(null)
  const selectedWorkspace = useMemo(
    () => workspaces.find((w) => w.workspaceId === workspaceId),
    [workspaceId, workspaces],
  )

  useEffect(() => {
    if (!open) return
    const first = workspaces[0]
    setWorkspaceId(first?.workspaceId ?? '')
    const initialCwd = first ? initialPathFor(first) : ''
    setCwd(initialCwd)
    setColumns([])
  }, [open, workspaces])

  useEffect(() => {
    if (!open || !socket || !workspaceId) return
    const onDirList = (result: DirListResult): void => {
      if (result.workspaceId !== workspaceId) return
      setLoadingPath(null)
      setCwd(result.path)
      setColumns((prev) => {
        const existing = prev.findIndex((col) => col.path === result.path)
        const nextColumn: DirColumn = {
          path: result.path,
          entries: result.entries,
          ...(result.error ? { error: result.error } : {}),
        }
        if (existing >= 0) return [...prev.slice(0, existing), nextColumn]
        const parentIndex = prev.findIndex((col) =>
          col.entries.some((entry) => entry.path === result.path),
        )
        if (parentIndex >= 0) return [...prev.slice(0, parentIndex + 1), nextColumn]
        return [nextColumn]
      })
    }
    socket.on('server:dir_list', onDirList)
    const initial = selectedWorkspace ? initialPathFor(selectedWorkspace) : undefined
    requestDirs(socket, workspaceId, initial)
    setLoadingPath(initial ?? '')
    return () => {
      socket.off('server:dir_list', onDirList)
    }
  }, [open, socket, workspaceId, selectedWorkspace])

  const selectWorkspace = (id: string): void => {
    const workspace = workspaces.find((w) => w.workspaceId === id)
    setWorkspaceId(id)
    const nextCwd = workspace ? initialPathFor(workspace) : ''
    setCwd(nextCwd)
    setColumns([])
  }

  const openDir = (path: string): void => {
    if (!socket || !workspaceId) return
    setCwd(path)
    setLoadingPath(path)
    requestDirs(socket, workspaceId, path)
  }

  const create = (): void => {
    if (!selectedWorkspace || cwd.trim().length === 0) return
    onCreate({
      workspaceId: selectedWorkspace.workspaceId,
      workspaceName: selectedWorkspace.workspaceName,
      cwd: cwd.trim(),
    })
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onCancel() }}>
      <DialogContent className="max-w-4xl h-[78vh] overflow-hidden p-0 gap-0 grid-rows-[auto_minmax(0,1fr)_auto]" data-testid="new-session-dialog">
        <DialogHeader className="border-b border-slate-200 px-4 py-3 dark:border-slate-800">
          <DialogTitle>New session</DialogTitle>
          <DialogDescription>
            Choose the workspace and initial directory for tool calls.
          </DialogDescription>
        </DialogHeader>
        <div className="grid min-h-0 grid-cols-[220px_minmax(0,1fr)]">
          <aside className="min-h-0 border-r border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-950/70">
            <div className="px-3 py-2 text-xs font-medium text-slate-500">Workspaces</div>
            <ScrollArea className="h-[calc(78vh-9.5rem)]">
              <div className="space-y-1 px-2 pb-2">
                {workspaces.length === 0 ? (
                  <div className="rounded border border-dashed border-slate-200 px-3 py-3 text-xs text-slate-500 dark:border-slate-800">
                    No executor is online.
                  </div>
                ) : null}
                {workspaces.map((w) => (
                  <button
                    key={w.workspaceId}
                    type="button"
                    data-testid={`workspace-pick-${w.workspaceId}`}
                    onClick={() => selectWorkspace(w.workspaceId)}
                    className={cn(
                      'w-full rounded-md border px-2 py-2 text-left',
                      workspaceId === w.workspaceId
                        ? 'border-sky-400 bg-sky-50 dark:border-sky-500 dark:bg-sky-950/30'
                        : 'border-slate-200 bg-white hover:border-slate-300 dark:border-slate-800 dark:bg-slate-950 dark:hover:border-slate-700',
                    )}
                  >
                    <div className="truncate font-mono text-sm text-slate-900 dark:text-slate-100">
                      {w.workspaceName}
                    </div>
                    <div className="mt-0.5 truncate font-mono text-[11px] text-slate-500">
                      {workspaceMeta(w)}
                    </div>
                  </button>
                ))}
              </div>
            </ScrollArea>
          </aside>
          <main className="flex min-h-0 min-w-0 flex-col">
            <div className="border-b border-slate-200 p-3 dark:border-slate-800">
              <label className="mb-1 block text-xs font-medium text-slate-500" htmlFor="new-session-cwd">
                Initial directory
              </label>
              <Input
                id="new-session-cwd"
                value={cwd}
                onChange={(e) => setCwd(e.target.value)}
                placeholder="/tmp/project"
                data-testid="new-session-cwd-input"
                className="font-mono"
              />
            </div>
            <div className="min-h-0 flex-1 overflow-hidden">
              <ScrollArea className="h-full" data-testid="new-session-finder">
                <div className="flex min-h-full w-max min-w-full">
                  {columns.length === 0 ? (
                    <div className="flex h-48 w-full items-center justify-center text-sm text-slate-500">
                      {loadingPath !== null ? 'Loading directories...' : 'Select a workspace.'}
                    </div>
                  ) : null}
                  {columns.map((column) => (
                    <DirectoryColumn
                      key={column.path}
                      column={column}
                      cwd={cwd}
                      loadingPath={loadingPath}
                      onOpen={openDir}
                    />
                  ))}
                </div>
              </ScrollArea>
            </div>
          </main>
        </div>
        <DialogFooter className="border-t border-slate-200 px-4 py-3 dark:border-slate-800">
          <Button variant="outline" onClick={onCancel} data-testid="workspace-picker-cancel">
            Cancel
          </Button>
          <Button
            onClick={create}
            disabled={!selectedWorkspace || cwd.trim().length === 0}
            data-testid="new-session-create"
          >
            Create session
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export const WorkspacePicker = NewSessionDialog

function DirectoryColumn({
  column,
  cwd,
  loadingPath,
  onOpen,
}: {
  column: DirColumn
  cwd: string
  loadingPath: string | null
  onOpen(path: string): void
}): JSX.Element {
  return (
    <div className="w-64 shrink-0 border-r border-slate-200 dark:border-slate-800" data-testid="finder-column">
      <div className="truncate border-b border-slate-200 px-3 py-2 font-mono text-[11px] text-slate-500 dark:border-slate-800">
        {column.path}
      </div>
      {column.error ? (
        <div className="px-3 py-2 text-xs text-rose-600 dark:text-rose-300">{column.error}</div>
      ) : column.entries.length === 0 ? (
        <div className="px-3 py-2 text-xs text-slate-500">No subdirectories</div>
      ) : (
        <div className="py-1">
          {column.entries.map((entry) => (
            <button
              key={entry.path}
              type="button"
              onClick={() => onOpen(entry.path)}
              data-testid="finder-dir"
              className={cn(
                'flex h-8 w-full items-center gap-2 px-2 text-left text-sm hover:bg-slate-100 dark:hover:bg-slate-900',
                cwd === entry.path && 'bg-sky-50 text-sky-800 dark:bg-sky-950/30 dark:text-sky-200',
              )}
            >
              <Folder className="h-4 w-4 flex-none text-sky-600 dark:text-sky-300" />
              <span className="min-w-0 flex-1 truncate">{entry.name}</span>
              {loadingPath === entry.path ? (
                <Loader2 className="h-3.5 w-3.5 flex-none animate-spin text-slate-400" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5 flex-none text-slate-400" />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function requestDirs(socket: DashboardSocket, workspaceId: string, path: string | undefined): void {
  socket.emit('client:list_dirs', {
    requestId: crypto.randomUUID(),
    workspaceId,
    ...(path !== undefined && path.length > 0 ? { path } : {}),
  })
}

function initialPathFor(workspace: AttachedExecutor): string {
  return workspace.sandboxRoots?.[0] ?? workspace.workingDir ?? '/'
}

function workspaceMeta(workspace: AttachedExecutor): string {
  return [
    workspace.os,
    workspace.runtime,
    workspace.runtimeVersion,
    workspace.sandboxRoots?.[0] ?? workspace.workingDir,
  ]
    .filter((s) => typeof s === 'string' && s.length > 0)
    .join(' · ')
}
