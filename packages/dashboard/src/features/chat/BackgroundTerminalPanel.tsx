import { useEffect, useMemo, useRef, useState } from 'react'
import { Copy, TerminalSquare } from 'lucide-react'

import type { BackgroundTerminalTask } from '../../background-terminal.js'
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
  /** Timeline-derived fallback used when there's no live executor. */
  fallbackTasks: readonly BackgroundTerminalTask[]
}

export function BackgroundTerminalPanel({
  socket,
  workspaceId,
  fallbackTasks,
}: Props): JSX.Element | null {
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)
  const { tasks: liveTasks, killTask } = useBackgroundTasks({
    socket,
    workspaceId,
    selectedTaskId,
  })

  const liveById = useMemo(() => {
    const m = new Map<string, LiveBackgroundTask>()
    for (const t of liveTasks) m.set(t.taskId, t)
    return m
  }, [liveTasks])

  const rows: TerminalRow[] = useMemo(() => {
    if (liveTasks.length > 0) {
      return liveTasks.map(rowFromLive)
    }
    return fallbackTasks.map(rowFromFallback)
  }, [liveTasks, fallbackTasks])

  useEffect(() => {
    // Keep the selection valid if the selected task disappears (evicted or
    // fallback - live swap). Selecting the first row on expand is what most
    // operators want and matches Claude Code's default.
    if (selectedTaskId && !rows.some((r) => r.taskId === selectedTaskId)) {
      setSelectedTaskId(null)
    }
    if (expanded && !selectedTaskId && rows.length > 0) {
      setSelectedTaskId(rows[0]!.taskId)
    }
  }, [rows, selectedTaskId, expanded])

  if (rows.length === 0) return null

  const running = rows.filter((r) => r.status === 'running').length
  const selectedRow = selectedTaskId
    ? rows.find((r) => r.taskId === selectedTaskId) ?? null
    : null
  const selectedLive = selectedTaskId ? liveById.get(selectedTaskId) ?? null : null

  return (
    <div
      className="bg-muted"
      data-testid="background-terminal-panel"
      data-expanded={expanded ? 'true' : 'false'}
    >
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-xs text-muted-foreground transition-colors hover:bg-muted/70"
        onClick={() => setExpanded((v) => !v)}
      >
        <TerminalSquare className="h-4 w-4" />
        <span className="font-medium">Background terminal</span>
        <span className="text-[11px] text-muted-foreground">
          {running > 0
            ? `${running} running  -  ${rows.length} total`
            : `${rows.length} task${rows.length === 1 ? '' : 's'}`}
        </span>
        {rows.length > 0 && rows[0] ? (
          <span className="ml-2 min-w-0 flex-1 truncate text-left font-mono text-[11px] text-muted-foreground">
            {rows[0].command}
          </span>
        ) : null}
        <span className="ml-auto text-[11px] text-muted-foreground">
          {expanded ? 'hide' : 'show'}
        </span>
      </button>
      {expanded ? (
        <div className="grid gap-0 border-t border-border/50 md:grid-cols-[minmax(0,240px)_minmax(0,1fr)]">
          <TaskList
            rows={rows}
            selectedTaskId={selectedTaskId}
            onSelect={setSelectedTaskId}
            onKill={liveTasks.length > 0 ? killTask : null}
          />
          <OutputPane row={selectedRow} live={selectedLive} />
        </div>
      ) : null}
    </div>
  )
}

type TerminalRow = {
  taskId: string
  command: string
  status: 'running' | 'exited' | 'killed' | 'signaled' | 'done' | 'unknown'
  cwd?: string
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
  selectedTaskId,
  onSelect,
  onKill,
}: {
  rows: readonly TerminalRow[]
  selectedTaskId: string | null
  onSelect: (id: string) => void
  onKill: ((taskId: string) => Promise<unknown>) | null
}): JSX.Element {
  return (
    <ScrollArea className="max-h-64 border-r border-border/50">
      <ul className="divide-y divide-border/50">
        {rows.map((row) => {
          const selected = row.taskId === selectedTaskId
          return (
            <li key={row.taskId}>
              <button
                type="button"
                onClick={() => onSelect(row.taskId)}
                className={cn(
                  'flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors',
                  selected ? 'bg-accent text-accent-foreground' : 'hover:bg-muted/70',
                )}
                data-testid={`bg-task-row-${row.taskId}`}
                data-selected={selected ? 'true' : 'false'}
              >
                <span className={cn('h-2 w-2 flex-none rounded-full', statusDot(row.status))} />
                <span className="min-w-0 flex-1 truncate font-mono text-foreground">
                  {row.command}
                </span>
                {onKill && row.status === 'running' ? (
                  <button
                    type="button"
                    className="flex-none rounded border border-border/60 px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                    disabled={row.killing}
                    onClick={(e) => {
                      e.stopPropagation()
                      void onKill(row.taskId)
                    }}
                    data-testid={`bg-task-kill-${row.taskId}`}
                  >
                    {row.killing ? ' - ' : 'kill'}
                  </button>
                ) : (
                  <span className="flex-none rounded bg-secondary px-1.5 py-0.5 text-[10px] capitalize text-muted-foreground">
                    {row.status}
                  </span>
                )}
              </button>
            </li>
          )
        })}
      </ul>
    </ScrollArea>
  )
}

function OutputPane({
  row,
  live,
}: {
  row: TerminalRow | null
  live: LiveBackgroundTask | null
}): JSX.Element {
  const preRef = useRef<HTMLPreElement | null>(null)
  const [autoScroll, setAutoScroll] = useState(true)
  const output = row?.output ?? ''

  useEffect(() => {
    if (!autoScroll || !preRef.current) return
    preRef.current.scrollTop = preRef.current.scrollHeight
  }, [output, autoScroll])

  if (!row) {
    return (
      <div className="flex items-center justify-center px-3 py-8 text-xs text-muted-foreground">
        Select a task to view its output.
      </div>
    )
  }

  const truncatedNote =
    row.bytesTruncated > 0
      ? `[ -  ${formatBytes(row.bytesTruncated)} truncated  -  buffer wrapped] `
      : ''

  return (
    <div className="flex min-w-0 flex-col">
      <div className="flex items-center gap-2 border-b border-border/50 bg-background/50 px-3 py-1.5 text-[11px] text-muted-foreground">
        <span className="min-w-0 truncate font-mono">task {row.taskId}</span>
        {row.cwd ? <span className="min-w-0 truncate font-mono">cwd {row.cwd}</span> : null}
        {live ? (
          <span className="font-mono">
            {formatBytes(live.bytesLogged)} logged
          </span>
        ) : null}
        <span className="ml-auto flex items-center gap-1">
          <label className="flex cursor-pointer items-center gap-1">
            <input
              type="checkbox"
              className="h-3 w-3"
              checked={autoScroll}
              onChange={(e) => setAutoScroll(e.target.checked)}
            />
            follow
          </label>
          <button
            type="button"
            className="flex items-center gap-1 rounded border border-border/60 px-1.5 py-0.5 uppercase text-muted-foreground hover:bg-muted"
            onClick={() => {
              void navigator.clipboard.writeText(output)
            }}
            title="Copy output"
          >
            <Copy className="h-3 w-3" />
            copy
          </button>
        </span>
      </div>
      <pre
        ref={preRef}
        className="max-h-80 min-w-max overflow-auto whitespace-pre-wrap bg-background p-3 font-mono text-[11px] leading-relaxed text-foreground"
        data-testid="bg-task-output"
      >
        {truncatedNote}
        {output.length > 0
          ? output
          : row.status === 'running'
            ? 'No output yet. Streaming - '
            : 'No output captured.'}
      </pre>
    </div>
  )
}

function statusDot(status: TerminalRow['status']): string {
  if (status === 'running') return 'bg-sky-500'
  if (status === 'exited' || status === 'done') return 'bg-emerald-500'
  if (status === 'killed') return 'bg-amber-500'
  if (status === 'signaled') return 'bg-red-500'
  return 'bg-muted'
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}
