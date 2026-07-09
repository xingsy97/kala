import { useEffect, useState } from 'react'
import { ChevronRight, Folder, Loader2 } from 'lucide-react'
import type { DirListResult } from '@agent-kernel/shared'

import { Input } from '../../components/ui/input.js'
import { ScrollArea } from '../../components/ui/scroll-area.js'
import { cn } from '../../lib/utils.js'
import type { DashboardSocket } from '../../session.js'

export type DirColumn = {
  path: string
  entries: DirListResult['entries']
  error?: string
}

type Props = {
  socket: DashboardSocket | null
  workspaceId: string
  initialPath: string | undefined
  value: string
  onChange(next: string): void
  inputId?: string
  inputTestId?: string
}

export function DirectoryPicker({
  socket,
  workspaceId,
  initialPath,
  value,
  onChange,
  inputId,
  inputTestId,
}: Props): JSX.Element {
  const [columns, setColumns] = useState<DirColumn[]>([])
  const [loadingPath, setLoadingPath] = useState<string | null>(null)

  useEffect(() => {
    setColumns([])
    if (!socket || !workspaceId) return
    const onDirList = (result: DirListResult): void => {
      if (result.workspaceId !== workspaceId) return
      setLoadingPath(null)
      onChange(result.path)
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
    requestDirs(socket, workspaceId, initialPath)
    setLoadingPath(initialPath ?? '')
    return () => {
      socket.off('server:dir_list', onDirList)
    }
    // onChange is a plain setter from the parent; excluded intentionally to
    // avoid re-subscribing on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket, workspaceId, initialPath])

  const openDir = (path: string): void => {
    if (!socket || !workspaceId) return
    onChange(path)
    setLoadingPath(path)
    requestDirs(socket, workspaceId, path)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-border/50 p-3">
        <Input
          id={inputId}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="/tmp/project"
          data-testid={inputTestId}
          className="font-mono"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <ScrollArea className="h-full" data-testid="directory-picker-finder">
          <div className="flex min-h-full w-max min-w-full">
            {columns.length === 0 ? (
              <div className="flex h-48 w-full items-center justify-center text-sm text-muted-foreground">
                {loadingPath !== null ? 'Loading directories...' : 'Select a workspace.'}
              </div>
            ) : null}
            {columns.map((column) => (
              <DirectoryColumn
                key={column.path}
                column={column}
                cwd={value}
                loadingPath={loadingPath}
                onOpen={openDir}
              />
            ))}
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}

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
    <div className="w-64 shrink-0 border-r border-border/50" data-testid="finder-column">
      <div className="truncate border-b border-border/50 px-3 py-2 font-mono text-[11px] text-muted-foreground">
        {column.path}
      </div>
      {column.error ? (
        <div className="px-3 py-2 text-xs text-rose-600 dark:text-rose-300">{column.error}</div>
      ) : column.entries.length === 0 ? (
        <div className="px-3 py-2 text-xs text-muted-foreground">No subdirectories</div>
      ) : (
        <div className="py-1">
          {column.entries.map((entry) => (
            <button
              key={entry.path}
              type="button"
              onClick={() => onOpen(entry.path)}
              data-testid="finder-dir"
              className={cn(
                'flex h-8 w-full items-center gap-2 px-2 text-left text-sm hover:bg-secondary transition-colors',
                cwd === entry.path && 'bg-primary/10 text-foreground',
              )}
            >
              <Folder className="h-4 w-4 flex-none text-sky-600 dark:text-sky-300" />
              <span className="min-w-0 flex-1 truncate">{entry.name}</span>
              {loadingPath === entry.path ? (
                <Loader2 className="h-3.5 w-3.5 flex-none animate-spin text-muted-foreground" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5 flex-none text-muted-foreground" />
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
