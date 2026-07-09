import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowUp, ChevronRight, Folder, Home, Loader2, RefreshCw, Slash } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { DirListResult } from '@agent-kernel/shared'

import { Button } from '../../components/ui/button.js'
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

const MANUAL_LOAD_DEBOUNCE_MS = 400

export function DirectoryPicker({
  socket,
  workspaceId,
  initialPath,
  value,
  onChange,
  inputId,
  inputTestId,
}: Props): JSX.Element {
  const { t } = useTranslation()
  const [columns, setColumns] = useState<DirColumn[]>([])
  const [loadingPath, setLoadingPath] = useState<string | null>(null)
  const [rootPath, setRootPath] = useState<string | null>(null)
  const activeRequestIdRef = useRef<string | null>(null)
  const manualTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const finderScrollRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    setColumns([])
    setRootPath(null)
    activeRequestIdRef.current = null
    if (!socket || !workspaceId) return
    const onDirList = (result: DirListResult): void => {
      if (result.workspaceId !== workspaceId) return
      if (result.requestId !== activeRequestIdRef.current) return
      setLoadingPath(null)
      onChange(result.path)
      if (result.roots.length > 0) setRootPath(result.roots[0]!)
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
    activeRequestIdRef.current = requestDirs(socket, workspaceId, initialPath)
    setLoadingPath(initialPath ?? '')
    return () => {
      socket.off('server:dir_list', onDirList)
      if (manualTimerRef.current) clearTimeout(manualTimerRef.current)
    }
    // onChange is a plain setter from the parent; excluded intentionally to
    // avoid re-subscribing on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket, workspaceId, initialPath])

  // Auto-scroll the finder to the right so freshly-pushed columns are visible
  // instead of hiding behind the scroller. Runs when the column count grows.
  useLayoutEffect(() => {
    const el = finderScrollRef.current
    if (!el) return
    el.scrollLeft = el.scrollWidth
  }, [columns.length])

  const loadPath = (path: string): void => {
    if (!socket || !workspaceId) return
    onChange(path)
    setLoadingPath(path)
    activeRequestIdRef.current = requestDirs(socket, workspaceId, path)
  }

  const scheduleManualLoad = (path: string): void => {
    if (manualTimerRef.current) clearTimeout(manualTimerRef.current)
    if (!socket || !workspaceId) return
    if (!path.startsWith('/')) return
    manualTimerRef.current = setTimeout(() => {
      manualTimerRef.current = null
      setLoadingPath(path)
      activeRequestIdRef.current = requestDirs(socket, workspaceId, path)
    }, MANUAL_LOAD_DEBOUNCE_MS)
  }

  const openDir = (path: string): void => {
    if (manualTimerRef.current) {
      clearTimeout(manualTimerRef.current)
      manualTimerRef.current = null
    }
    loadPath(path)
  }

  const updateManualPath = (next: string): void => {
    // Invalidate any in-flight request so a late response can't stomp the
    // user's edit. The debounced load below will register a fresh request id
    // once the user stops typing.
    activeRequestIdRef.current = null
    setLoadingPath(null)
    onChange(next)
    scheduleManualLoad(next.trim())
  }

  const commitManualPath = (): void => {
    if (manualTimerRef.current) {
      clearTimeout(manualTimerRef.current)
      manualTimerRef.current = null
    }
    const trimmed = value.trim()
    if (trimmed.length === 0 || !trimmed.startsWith('/')) return
    loadPath(trimmed)
  }

  const goUp = (): void => {
    const parent = parentPath(value.trim())
    if (parent === null) return
    if (rootPath && !isWithinRoot(parent, rootPath)) return
    openDir(parent)
  }

  const goRoot = (): void => {
    if (!rootPath) return
    openDir(rootPath)
  }

  const refresh = (): void => {
    const target = value.trim()
    if (target.length === 0) return
    openDir(target)
  }

  const atRoot =
    rootPath !== null && (value.trim() === rootPath || !isWithinRoot(value.trim(), rootPath))
  const canGoUp = parentPath(value.trim()) !== null && !atRoot
  const crumbs = buildBreadcrumbs(value.trim(), rootPath)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-col gap-2 border-b border-border/50 p-3">
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 px-2"
            onClick={goUp}
            disabled={!canGoUp}
            title={t('directory.goUp')}
            data-testid="dir-picker-up"
          >
            <ArrowUp className="h-3.5 w-3.5" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 px-2"
            onClick={goRoot}
            disabled={!rootPath}
            title={rootPath ? t('directory.jumpRoot', { root: rootPath }) : t('directory.rootUnknown')}
            data-testid="dir-picker-root"
          >
            <Home className="h-3.5 w-3.5" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 px-2"
            onClick={refresh}
            disabled={value.trim().length === 0}
            title={t('directory.refresh')}
            data-testid="dir-picker-refresh"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
          <Input
            id={inputId}
            value={value}
            onChange={(e) => updateManualPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                commitManualPath()
              }
            }}
            onBlur={commitManualPath}
            placeholder={t('directory.placeholder')}
            data-testid={inputTestId}
            title={value}
            className="min-w-0 flex-1 truncate font-mono"
          />
        </div>
        {crumbs.length > 0 ? (
          <div
            className="flex min-w-0 items-center gap-0.5 overflow-x-auto"
            data-testid="dir-picker-breadcrumbs"
          >
            {crumbs.map((crumb, i) => (
              <div key={`${crumb.path}-${i}`} className="flex flex-none items-center gap-0.5">
                {i > 0 ? (
                  <Slash className="h-3 w-3 flex-none text-muted-foreground" aria-hidden="true" />
                ) : null}
                <button
                  type="button"
                  onClick={() => openDir(crumb.path)}
                  disabled={crumb.path === value.trim()}
                  title={crumb.path}
                  data-testid={`dir-picker-breadcrumb-${i}`}
                  className={cn(
                    'max-w-[14rem] truncate rounded px-1.5 py-0.5 font-mono text-[11px] transition-colors',
                    crumb.path === value.trim()
                      ? 'text-foreground'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                  )}
                >
                  {crumb.label}
                </button>
              </div>
            ))}
          </div>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <ScrollArea
          className="h-full"
          data-testid="directory-picker-finder"
          viewportRef={finderScrollRef}
        >
          <div className="flex min-h-full w-max min-w-full">
            {columns.length === 0 ? (
              <div className="flex h-48 w-full items-center justify-center text-sm text-muted-foreground">
                {loadingPath !== null ? t('directory.loading') : t('directory.selectWorkspace')}
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
  const { t } = useTranslation()
  return (
    <div className="w-64 shrink-0 border-r border-border/50" data-testid="finder-column">
      <div
        className="truncate border-b border-border/50 px-3 py-2 font-mono text-[11px] text-muted-foreground"
        title={column.path}
      >
        {column.path}
      </div>
      {column.error ? (
        <div className="px-3 py-2 text-xs text-rose-600 dark:text-rose-300">{column.error}</div>
      ) : column.entries.length === 0 ? (
        <div className="px-3 py-2 text-xs text-muted-foreground">{t('directory.noSubdirectories')}</div>
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

function requestDirs(socket: DashboardSocket, workspaceId: string, path: string | undefined): string {
  const requestId = crypto.randomUUID()
  socket.emit('client:list_dirs', {
    requestId,
    workspaceId,
    ...(path !== undefined && path.length > 0 ? { path } : {}),
  })
  return requestId
}

function parentPath(path: string): string | null {
  if (!path.startsWith('/')) return null
  if (path === '/') return null
  const segments = path.split('/').filter((s) => s.length > 0)
  if (segments.length <= 1) return '/'
  segments.pop()
  return `/${segments.join('/')}`
}

function isWithinRoot(path: string, root: string): boolean {
  if (path === root) return true
  const normRoot = root.endsWith('/') ? root : `${root}/`
  return path.startsWith(normRoot)
}

type Breadcrumb = { label: string; path: string }

function buildBreadcrumbs(path: string, root: string | null): Breadcrumb[] {
  if (!path.startsWith('/')) return []
  const segments = path.split('/').filter((s) => s.length > 0)
  const crumbs: Breadcrumb[] = []
  if (root && isWithinRoot(path, root)) {
    // Collapse ancestors above the workspace root into a single "root" chip so
    // deep paths inside /very/long/parents/workspace-root/... stay readable.
    const rootSegments = root.split('/').filter((s) => s.length > 0)
    const rootLabel = rootSegments.at(-1) ?? '/'
    crumbs.push({ label: rootLabel || '/', path: root })
    for (let i = rootSegments.length; i < segments.length; i += 1) {
      const p = `/${segments.slice(0, i + 1).join('/')}`
      crumbs.push({ label: segments[i]!, path: p })
    }
  } else {
    crumbs.push({ label: '/', path: '/' })
    for (let i = 0; i < segments.length; i += 1) {
      const p = `/${segments.slice(0, i + 1).join('/')}`
      crumbs.push({ label: segments[i]!, path: p })
    }
  }
  return crumbs
}
