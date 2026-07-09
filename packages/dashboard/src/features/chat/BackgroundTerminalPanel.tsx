import { useEffect, useMemo, useRef, useState } from 'react'
import { useAutoAnimate } from '@formkit/auto-animate/react'
import { Copy, OctagonX, TerminalSquare } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import type { BackgroundTerminalTask } from '../../background-terminal.js'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog.js'
import { ScrollArea } from '../../components/ui/scroll-area.js'
import { cn } from '../../lib/utils.js'
import type { DashboardSocket } from '../../session.js'
import {
  useBackgroundTasks,
  type LiveBackgroundTask,
} from './useBackgroundTasks.js'

type Props = {
  /** Bound to the executor's registry. Empty when offline. */
  socket: DashboardSocket | null
  workspaceId: string | undefined
  sessionId: string | null
  /** Timeline-derived fallback used when there's no live executor. */
  fallbackTasks: readonly BackgroundTerminalTask[]
}

export function BackgroundShellsButton({
  socket,
  workspaceId,
  sessionId,
  fallbackTasks,
}: Props): JSX.Element | null {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const { tasks: liveTasks, error, killTask } = useBackgroundTasks({
    socket,
    workspaceId,
    sessionId,
    selectedTaskId: open ? selectedTaskId : null,
  })

  useEffect(() => {
    setOpen(false)
    setSelectedTaskId(null)
  }, [socket, workspaceId, sessionId])

  const liveById = useMemo(() => {
    const m = new Map<string, LiveBackgroundTask>()
    for (const t of liveTasks) m.set(t.taskId, t)
    return m
  }, [liveTasks])

  const rows: TerminalRow[] = useMemo(() => {
    if (liveTasks.length > 0) return liveTasks.map(rowFromLive)
    return fallbackTasks.map(rowFromFallback)
  }, [liveTasks, fallbackTasks])
  const hasWorkspaceRegistry = Boolean(socket && workspaceId)
  const visibleRows = useMemo(() => {
    if (hasWorkspaceRegistry) return rows.filter((row) => row.status === 'running')
    return rows
  }, [hasWorkspaceRegistry, rows])
  const scopeLabel = hasWorkspaceRegistry ? t('chat.backgroundShells.workspace') : t('chat.backgroundShells.sessionReplay')

  useEffect(() => {
    if (selectedTaskId && !rows.some((r) => r.taskId === selectedTaskId)) {
      setSelectedTaskId(null)
    }
    if (open && !selectedTaskId && rows.length > 0) {
      setSelectedTaskId(rows[0]!.taskId)
    }
  }, [rows, selectedTaskId, open])

  const showTrigger = hasWorkspaceRegistry || rows.length > 0
  if (!showTrigger && !open) return null

  const running = rows.filter((r) => r.status === 'running').length
  const selectedRow = selectedTaskId
    ? rows.find((r) => r.taskId === selectedTaskId) ?? null
    : null
  const selectedLive = selectedTaskId ? liveById.get(selectedTaskId) ?? null : null

  return (
    <>
      {showTrigger ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          data-testid="background-shells-trigger"
          aria-label={t('chat.backgroundShells.trigger', { count: visibleRows.length, scope: scopeLabel.toLowerCase() })}
          title={
            running > 0
              ? t('chat.backgroundShells.titleRunning', { scope: scopeLabel, running, total: rows.length })
              : t('chat.backgroundShells.titleTotal', { scope: scopeLabel, total: rows.length })
          }
          className={cn(
            'inline-flex h-9 flex-none items-center gap-1.5 rounded-md border-0 bg-transparent px-2 text-xs text-muted-foreground shadow-none transition-colors hover:bg-accent sm:h-7',
            running > 0 && 'text-sky-700 dark:text-sky-300',
          )}
        >
          <TerminalSquare className="h-3.5 w-3.5 flex-none" aria-hidden="true" />
          <span className="tabular-nums">
            {visibleRows.length} <span className="hidden sm:inline">{t('chat.backgroundShells.shell', { count: visibleRows.length }).replace(/^\d+\s*/, '')}</span>
          </span>
          {running > 0 ? (
            <span
              className="h-1.5 w-1.5 flex-none rounded-full bg-sky-500 shadow-[0_0_0_2px_hsl(var(--background))]"
              aria-hidden="true"
            />
          ) : null}
        </button>
      ) : null}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="grid max-w-[80rem] gap-0 p-0 sm:rounded-xl"
          data-testid="background-terminal-panel"
        >
          <DialogHeader className="border-b border-border/50 px-4 py-3">
            <DialogTitle className="flex items-center gap-2 text-sm">
              <TerminalSquare className="h-4 w-4" aria-hidden="true" />
              {t('chat.backgroundShells.dialogTitle', { scope: scopeLabel })}
              <span className="text-[11px] font-normal text-muted-foreground">
                {running > 0
                  ? t('chat.backgroundShells.summaryRunning', { running, total: rows.length })
                  : t('chat.backgroundShells.summaryTotal', { count: rows.length })}
              </span>
            </DialogTitle>
          </DialogHeader>
          <div className="grid gap-0 md:grid-cols-[minmax(0,260px)_minmax(0,1fr)]">
            <TaskList
              rows={rows}
              error={error}
              selectedTaskId={selectedTaskId}
              onSelect={setSelectedTaskId}
              onKill={hasWorkspaceRegistry ? killTask : null}
            />
            <OutputPane
              row={selectedRow}
              live={selectedLive}
              onKill={hasWorkspaceRegistry ? killTask : null}
            />
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

type TerminalRow = {
  taskId: string
  command: string
  status: 'running' | 'exited' | 'killed' | 'signaled' | 'done' | 'unknown'
  cwd?: string
  pid?: number
  startedAt?: string
  endedAt?: string
  exitCode?: number | null
  signal?: string | null
  output: string
  bytesTruncated: number
  killing: boolean
  origin: 'live' | 'fallback'
}

function rowFromLive(task: LiveBackgroundTask): TerminalRow {
  return {
    taskId: task.taskId,
    command: task.command,
    status: task.status,
    cwd: task.cwd,
    ...(typeof task.pid === 'number' ? { pid: task.pid } : {}),
    startedAt: task.startedAt,
    ...(task.endedAt ? { endedAt: task.endedAt } : {}),
    exitCode: task.exitCode,
    signal: task.signal,
    output: task.output,
    bytesTruncated: task.bytesTruncated,
    killing: task.killing,
    origin: 'live',
  }
}

function rowFromFallback(task: BackgroundTerminalTask): TerminalRow {
  return {
    taskId: task.taskId,
    command: task.command,
    status: task.status,
    ...(task.cwd ? { cwd: task.cwd } : {}),
    output: task.output,
    bytesTruncated: 0,
    killing: false,
    origin: 'fallback',
  }
}

function TaskList({
  rows,
  error,
  selectedTaskId,
  onSelect,
  onKill,
}: {
  rows: readonly TerminalRow[]
  error: string | null
  selectedTaskId: string | null
  onSelect: (id: string) => void
  onKill: ((taskId: string) => Promise<unknown>) | null
}): JSX.Element {
  const { t } = useTranslation()
  const [listRef] = useAutoAnimate<HTMLUListElement>()
  return (
    <ScrollArea className="h-[28rem] border-r border-border/50">
      {rows.length === 0 ? (
        <div className="space-y-2 px-3 py-6 text-xs text-muted-foreground" data-testid="bg-task-empty">
          {error ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-destructive">
              {error}
            </div>
          ) : null}
          <div>{t('chat.backgroundShells.empty')}</div>
        </div>
      ) : (
      <ul ref={listRef} className="divide-y divide-border/50">
        {error ? (
          <li className="px-3 py-2 text-xs text-destructive">
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1.5">
              {error}
            </div>
          </li>
        ) : null}
        {rows.map((row) => {
          const selected = row.taskId === selectedTaskId
          const parts = splitCommand(row.command, t('chat.backgroundShells.emptyCommand'))
          return (
            <li key={row.taskId}>
              <div
                className={cn(
                  'flex w-full items-start gap-2 px-3 py-2 text-left text-xs transition-colors',
                  selected ? 'bg-accent text-accent-foreground' : 'hover:bg-muted/70',
                )}
                data-testid={`bg-task-row-${row.taskId}`}
                data-selected={selected ? 'true' : 'false'}
                title={row.command}
              >
                <StatusPill status={row.status} />
                <button
                  type="button"
                  onClick={() => onSelect(row.taskId)}
                  className="min-w-0 flex-1 text-left"
                >
                  <span className="block truncate font-mono font-semibold text-foreground">
                    {parts.head}
                  </span>
                  {parts.tail ? (
                    <span className="block truncate font-mono text-[10px] text-muted-foreground">
                      {parts.tail}
                    </span>
                  ) : null}
                  <span className="mt-0.5 block truncate text-[10px] uppercase tracking-wide text-muted-foreground">
                    {row.origin === 'live' ? t('chat.backgroundShells.live') : t('chat.backgroundShells.replay')} · {row.taskId}
                  </span>
                </button>
                {onKill && row.status === 'running' ? (
                  <button
                    type="button"
                    className="mt-0.5 flex-none rounded border border-border/60 px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                    disabled={row.killing}
                    onClick={(e) => {
                      e.stopPropagation()
                      void onKill(row.taskId)
                    }}
                    data-testid={`bg-task-kill-${row.taskId}`}
                  >
                    {row.killing ? '...' : t('chat.backgroundShells.kill')}
                  </button>
                ) : (
                  <span className="mt-0.5 flex-none rounded bg-secondary px-1.5 py-0.5 text-[10px] capitalize text-muted-foreground">
                    {row.status}
                  </span>
                )}
              </div>
            </li>
          )
        })}
      </ul>
      )}
    </ScrollArea>
  )
}

function OutputPane({
  row,
  live,
  onKill,
}: {
  row: TerminalRow | null
  live: LiveBackgroundTask | null
  onKill: ((taskId: string) => Promise<unknown>) | null
}): JSX.Element {
  const { t } = useTranslation()
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const [autoScroll, setAutoScroll] = useState(true)
  const output = row?.output ?? ''

  useEffect(() => {
    if (!autoScroll || !viewportRef.current) return
    viewportRef.current.scrollTop = viewportRef.current.scrollHeight
  }, [output, autoScroll])

  if (!row) {
    return (
      <div className="flex items-center justify-center px-3 py-8 text-xs text-muted-foreground">
        {t('chat.backgroundShells.selectTask')}
      </div>
    )
  }

  const truncatedNote =
    row.bytesTruncated > 0
      ? t('chat.backgroundShells.truncated', { bytes: formatBytes(row.bytesTruncated) })
      : ''
  const canKill = Boolean(onKill && row.origin === 'live' && row.status === 'running')

  return (
    <div className="flex min-w-0 flex-col">
      <div className="flex min-w-0 flex-col gap-2 border-b border-border/50 bg-background/50 px-3 py-2 text-[11px] text-muted-foreground">
        <div className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate font-mono">task {row.taskId}</span>
          {row.pid !== undefined ? <span className="font-mono">pid {row.pid}</span> : null}
          {row.cwd ? <span className="min-w-0 truncate font-mono">cwd {row.cwd}</span> : null}
          {live ? (
            <span className="font-mono">
              {t('chat.backgroundShells.logged', { bytes: formatBytes(live.bytesLogged) })}
            </span>
          ) : null}
          <span className="ml-auto flex items-center gap-1">
            {canKill ? (
              <button
                type="button"
                className="flex items-center gap-1 rounded border border-destructive/40 px-1.5 py-0.5 uppercase text-destructive hover:bg-destructive/10 disabled:opacity-50"
                disabled={row.killing}
                onClick={() => {
                  void onKill?.(row.taskId)
                }}
                data-testid={`bg-task-kill-selected-${row.taskId}`}
                title={t('chat.backgroundShells.killSelected')}
              >
                <OctagonX className="h-3 w-3" />
                {row.killing ? t('chat.backgroundShells.killing') : t('chat.backgroundShells.kill')}
              </button>
            ) : null}
            <label className="flex cursor-pointer items-center gap-1">
              <input
                type="checkbox"
                className="h-3 w-3"
                checked={autoScroll}
                onChange={(e) => setAutoScroll(e.target.checked)}
              />
              {t('chat.backgroundShells.follow')}
            </label>
            <button
              type="button"
              className="flex items-center gap-1 rounded border border-border/60 px-1.5 py-0.5 uppercase text-muted-foreground hover:bg-muted"
              onClick={() => {
                void navigator.clipboard.writeText(output)
              }}
              title={t('chat.backgroundShells.copyOutput')}
            >
              <Copy className="h-3 w-3" />
              {t('chat.backgroundShells.copy')}
            </button>
          </span>
        </div>
        <div className="rounded-md border border-border/50 bg-muted/40 px-2 py-1.5">
          <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            {t('chat.backgroundShells.command')}
          </div>
          <pre
            className="max-h-24 whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-foreground [overflow-wrap:anywhere]"
            data-testid="bg-task-command"
          >
            {row.command}
          </pre>
        </div>
        <ProcessDetails row={row} />
      </div>
      <ScrollArea className="h-[26rem] bg-background" viewportRef={viewportRef} data-testid="bg-task-output">
        <pre className="min-w-max whitespace-pre-wrap p-3 font-mono text-[11px] leading-relaxed text-foreground">
          {truncatedNote}
          {output.length > 0
            ? output
            : row.status === 'running'
              ? t('chat.backgroundShells.noOutputRunning')
              : t('chat.backgroundShells.noOutputCaptured')}
        </pre>
      </ScrollArea>
    </div>
  )
}

function StatusPill({ status }: { status: TerminalRow['status'] }): JSX.Element {
  const { t } = useTranslation()
  return (
    <span
      className={cn(
        'mt-0.5 flex-none rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide',
        statusClass(status),
      )}
      title={statusHelp(status, t)}
    >
      {statusLabel(status)}
    </span>
  )
}

function ProcessDetails({ row }: { row: TerminalRow }): JSX.Element {
  const { t } = useTranslation()
  const fields: Array<[string, string]> = [
    [t('chat.backgroundShells.fields.status'), statusLabel(row.status)],
    ...(row.pid !== undefined ? [[t('chat.backgroundShells.fields.pid'), String(row.pid)] as [string, string]] : []),
    ...(row.exitCode !== undefined && row.exitCode !== null ? [[t('chat.backgroundShells.fields.exit'), String(row.exitCode)] as [string, string]] : []),
    ...(row.signal ? [[t('chat.backgroundShells.fields.signal'), row.signal] as [string, string]] : []),
    ...(row.startedAt ? [[t('chat.backgroundShells.fields.started'), formatTimestamp(row.startedAt)] as [string, string]] : []),
    ...(row.endedAt ? [[t('chat.backgroundShells.fields.ended'), formatTimestamp(row.endedAt)] as [string, string]] : []),
  ]
  return (
    <div className="grid grid-cols-2 gap-1 rounded-md border border-border/50 bg-muted/30 px-2 py-1.5 sm:grid-cols-3">
      {fields.map(([label, value]) => (
        <div key={label} className="min-w-0">
          <div className="text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
            {label}
          </div>
          <div className="truncate font-mono text-[11px] text-foreground" title={value}>
            {value}
          </div>
        </div>
      ))}
    </div>
  )
}

function statusClass(status: TerminalRow['status']): string {
  if (status === 'running') return 'bg-sky-50 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300'
  if (status === 'exited' || status === 'done') return 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
  if (status === 'killed') return 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300'
  if (status === 'signaled') return 'bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300'
  return 'bg-muted text-muted-foreground'
}

function statusLabel(status: TerminalRow['status']): string {
  if (status === 'exited') return 'exited'
  if (status === 'done') return 'done'
  if (status === 'killed') return 'killed'
  if (status === 'signaled') return 'signaled'
  if (status === 'running') return 'running'
  return 'unknown'
}

function statusHelp(status: TerminalRow['status'], t: ReturnType<typeof useTranslation>['t']): string {
  switch (status) {
    case 'running':
      return t('chat.backgroundShells.statusHelp.running')
    case 'killed':
      return t('chat.backgroundShells.statusHelp.killed')
    case 'signaled':
      return t('chat.backgroundShells.statusHelp.signaled')
    case 'exited':
    case 'done':
      return t('chat.backgroundShells.statusHelp.exited')
    default:
      return t('chat.backgroundShells.statusHelp.unknown')
  }
}

function formatTimestamp(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

/**
 * Split a shell command into a short "head" (binary + likely subcommand) and
 * a "tail" (everything else) so the sidebar can render them on two lines.
 *
 * Rules are intentionally shallow — we only care about the shape of the first
 * few tokens, not full parsing. We skip a leading env prefix (KEY=val) and
 * keep the next non-flag token as the subcommand hint (e.g. `pnpm exec`,
 * `git log`, `docker compose`). Falls back to just the binary basename.
 */
function splitCommand(command: string, emptyLabel: string): { head: string; tail: string } {
  const trimmed = command.trim()
  if (trimmed.length === 0) return { head: emptyLabel, tail: '' }
  const tokens = trimmed.split(/\s+/)
  let i = 0
  while (i < tokens.length && /^[A-Z_][A-Z0-9_]*=/.test(tokens[i] ?? '')) i += 1
  const binToken = tokens[i]
  if (!binToken) return { head: trimmed, tail: '' }
  const bin = binToken.includes('/') ? binToken.split('/').pop() ?? binToken : binToken
  const sub = tokens[i + 1]
  const headTokens = sub && !sub.startsWith('-') ? [bin, sub] : [bin]
  const head = headTokens.join(' ')
  const consumed = tokens.slice(0, i + headTokens.length).join(' ')
  const tail = trimmed.slice(consumed.length).trimStart()
  return { head, tail }
}
