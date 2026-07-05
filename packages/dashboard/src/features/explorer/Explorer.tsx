/**
 * Explorer — single left column that fuses the old Workspaces/Sessions
 * columns into a two-level tree: workspace parents with session children.
 *
 * "Workspace" here is the machine a session's tool calls run on
 * (see ADR 0013): a stable ULID that the executor announces on connect.
 * Sessions whose parent workspace has no attached executor are shown offline;
 * sessions without a workspaceId (older logs) group under "Unassigned".
 */

import { useMemo, useState, type ReactElement, type RefCallback } from 'react'
import useMeasure from 'react-use-measure'
import { NodeApi, Tree } from 'react-arborist'
import type { RowRendererProps } from 'react-arborist'
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock3,
  Folder,
  GitFork,
  Loader2,
  MessageSquare,
  Plus,
  Trash2,
} from 'lucide-react'
import type { AttachedExecutor, SessionSummary } from '@agent-kernel/shared'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../../components/ui/alert-dialog.js'
import { Button } from '../../components/ui/button.js'
import { cn } from '../../lib/utils.js'
import { buildTree } from './tree-model.js'
import type { SessionNode, TreeNode, WorkspaceNode } from './tree-model.js'

type Props = {
  executors: readonly AttachedExecutor[]
  sessions: readonly SessionSummary[]
  selectedSessionId: string | null
  onSelect(sessionId: string): void
  onNewSession(): void
  onDelete(sessionId: string): void
}

const ROW_HEIGHT = 86

export function Explorer({
  executors,
  sessions,
  selectedSessionId,
  onSelect,
  onNewSession,
  onDelete,
}: Props): JSX.Element {
  const [pendingDelete, setPendingDelete] = useState<SessionNode | null>(null)
  const [ref, bounds] = useMeasure({ debounce: 30 })

  const data = useMemo(
    () => buildTree(executors, sessions),
    [executors, sessions],
  )

  const empty = executors.length === 0 && sessions.length === 0
  const selection = selectedSessionId ? `sess:${selectedSessionId}` : undefined

  const activate = (node: NodeApi<TreeNode>): void => {
    if (node.data.kind === 'session') onSelect(node.data.sessionId)
  }

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <Header onNewSession={onNewSession} />
      <div
        ref={ref}
        className="flex-1 min-h-0"
        data-testid="explorer-column"
        data-scroll-owner="react-arborist"
      >
        {empty ? (
          <div className="p-3 text-xs text-slate-500 leading-relaxed">
            No daemons attached. Start an executor with{' '}
            <code className="text-slate-700 dark:text-slate-200">
              pnpm executor:dev
            </code>
            .
          </div>
        ) : bounds.height > 0 ? (
          <Tree<TreeNode>
            data={data as unknown as TreeNode[]}
            childrenAccessor={(d) =>
              d.kind === 'workspace' ? d.children : null
            }
            idAccessor="id"
            openByDefault
            disableDrag
            disableDrop
            disableEdit
            disableMultiSelection
            disableSelect={(d) => d.kind === 'workspace'}
            selection={selection}
            onActivate={activate}
            renderRow={TreeRow}
            rowHeight={ROW_HEIGHT}
            indent={16}
            width={bounds.width}
            height={bounds.height}
          >
            {({ node, style }) => (
              <Row
                node={node}
                style={style}
                onDeleteRequest={(sess) => setPendingDelete(sess)}
              />
            )}
          </Tree>
        ) : null}
      </div>

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete session?</AlertDialogTitle>
            <AlertDialogDescription>
              <span className="font-mono text-slate-700 dark:text-slate-200">
                {pendingDelete?.label ?? ''}
              </span>
              <br />
              The JSONL log will be removed from disk. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              data-testid="confirm-delete-button"
              onClick={() => {
                if (pendingDelete) onDelete(pendingDelete.sessionId)
                setPendingDelete(null)
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function TreeRow({ node, attrs, innerRef, children }: RowRendererProps<TreeNode>): ReactElement {
  return (
    <div
      {...attrs}
      ref={innerRef as RefCallback<HTMLDivElement>}
      onFocus={(e) => e.stopPropagation()}
      onClick={node.handleClick}
      className={cn(attrs.className, 'min-w-0 max-w-full overflow-hidden')}
      style={{ ...attrs.style, minWidth: 0, width: '100%' }}
    >
      {children}
    </div>
  )
}

function Header({ onNewSession }: { onNewSession: () => void }): JSX.Element {
  return (
    <div className="px-3 py-2 border-b border-slate-200 bg-white/90 dark:border-slate-800 dark:bg-slate-950 flex items-center justify-between">
      <span className="text-xs font-medium text-slate-600 dark:text-slate-300">
        Explorer
      </span>
      <Button
        variant="ghost"
        size="sm"
        onClick={onNewSession}
        data-testid="new-session-button"
        title="Start a new session"
        className="h-6 px-2 text-xs text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-900 dark:hover:text-slate-50"
      >
        <Plus className="mr-1 h-3 w-3" /> new
      </Button>
    </div>
  )
}

function Row({
  node,
  style,
  onDeleteRequest,
}: {
  node: NodeApi<TreeNode>
  style: React.CSSProperties
  onDeleteRequest(sess: SessionNode): void
}): JSX.Element {
  if (node.data.kind === 'workspace') {
    return (
      <WorkspaceRow node={node as NodeApi<WorkspaceNode>} style={style} />
    )
  }
  return (
    <SessionRow
      node={node as NodeApi<SessionNode>}
      style={style}
      onDeleteRequest={onDeleteRequest}
    />
  )
}

function WorkspaceRow({
  node,
  style,
}: {
  node: NodeApi<WorkspaceNode>
  style: React.CSSProperties
}): JSX.Element {
  const w = node.data
  const dotCls = w.online
    ? 'bg-emerald-500 dark:bg-emerald-400'
    : 'bg-slate-400 dark:bg-slate-600'
  const meta =
    w.workspaceId === null
      ? 'sessions with no workspace'
      : [w.os, w.runtime, w.runtimeVersion, w.ip]
          .filter((s) => typeof s === 'string' && s.length > 0)
          .join(' · ') || 'offline'
  return (
    <div
      style={style}
      data-testid="workspace-row"
      data-workspace-id={w.workspaceId ?? 'unassigned'}
      data-online={w.online ? 'true' : 'false'}
      onClick={() => node.toggle()}
      className="min-w-0 px-2 border-b border-slate-200/70 dark:border-slate-900 hover:bg-slate-100 dark:hover:bg-slate-900 cursor-pointer select-none"
    >
      <div className="flex items-center gap-1.5 h-7">
        {node.isOpen ? (
          <ChevronDown className="h-3.5 w-3.5 text-slate-500" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-slate-500" />
        )}
        <span className={`inline-block w-2 h-2 rounded-full ${dotCls}`} />
        <span className="text-sm text-slate-800 dark:text-slate-100 truncate">
          {w.name}
        </span>
      </div>
      <div className="pl-6 -mt-1 text-[11px] text-slate-500 dark:text-slate-500 truncate">
        {meta}
      </div>
    </div>
  )
}

function SessionRow({
  node,
  style,
  onDeleteRequest,
}: {
  node: NodeApi<SessionNode>
  style: React.CSSProperties
  onDeleteRequest(sess: SessionNode): void
}): JSX.Element {
  const s = node.data
  const selected = node.isSelected
  return (
    <div
      style={style}
      data-testid="session-row"
      data-session-id={s.sessionId}
      className={cn(
        'group relative min-w-0 overflow-hidden border-b border-slate-200/70 dark:border-slate-900 hover:bg-white dark:hover:bg-slate-900/80 transition-colors',
        selected &&
          'bg-sky-50/70 dark:bg-slate-900/80 border-l-2 border-l-sky-500 dark:border-l-sky-400 shadow-[inset_0_1px_0_rgba(56,189,248,0.18)]',
      )}
      onClick={() => node.activate()}
    >
      <div className="min-w-0 px-2 pl-6 py-2.5 pr-9 cursor-pointer">
        <div className="flex min-w-0 items-center gap-2">
          <MessageSquare className="h-3.5 w-3.5 flex-none text-slate-400 dark:text-slate-500" />
          <div className="min-w-0 flex-1 truncate text-sm font-medium text-slate-800 dark:text-slate-100">
            {s.label}
          </div>
        </div>
        <div className="mt-1 flex min-w-0 items-center gap-2 pl-5 text-[11px] text-slate-500 dark:text-slate-400">
          <StatusChip status={s.status} />
          <span className="truncate tabular-nums text-slate-500 dark:text-slate-500">
            {s.eventCount} evt
          </span>
          <span className="ml-auto truncate tabular-nums text-slate-400 dark:text-slate-600">
            {formatWhen(s.lastActivityIso)}
          </span>
        </div>
        {s.currentCwd ? (
          <div
            className="mt-1 flex min-w-0 items-center gap-1.5 pl-5 text-[11px] leading-4 text-slate-500 dark:text-slate-500"
            title={s.currentCwd}
            data-testid="session-row-cwd"
          >
            <Folder className="h-3 w-3 flex-none text-slate-400 dark:text-slate-600" />
            <span className="min-w-0 truncate font-mono">cwd {s.currentCwd}</span>
          </div>
        ) : null}
        {s.parentSessionId ? (
          <div className="mt-1 flex min-w-0 items-center gap-1.5 pl-5 text-[11px] text-amber-600 dark:text-amber-400">
            <GitFork className="h-3 w-3 flex-none" />
            <span className="min-w-0 truncate font-mono">fork of {s.parentSessionId.slice(0, 8)}...</span>
          </div>
        ) : null}
      </div>
      <Button
        variant="ghost"
        size="icon"
        onClick={(e) => {
          e.stopPropagation()
          onDeleteRequest(s)
        }}
        data-testid="session-delete-button"
        title="Delete this session (irreversible)"
        aria-label={`delete session ${s.sessionId}`}
        className="absolute right-1.5 top-1.5 h-7 w-7 rounded-md text-slate-400 opacity-0 transition-colors hover:bg-rose-500 hover:text-white group-hover:opacity-100 dark:text-slate-500 dark:hover:bg-rose-600 dark:hover:text-white"
      >
        <Trash2 className="h-3.5 w-3.5" strokeWidth={2.2} />
      </Button>
    </div>
  )
}

function StatusChip({
  status,
}: {
  status?: SessionSummary['status']
}): JSX.Element {
  const meta = statusMeta(status)
  const Icon = meta.icon
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1 truncate', meta.className)}>
      <Icon className={cn('h-3 w-3 flex-none', meta.spin ? 'animate-spin' : '')} />
      <span className="truncate">{meta.label}</span>
    </span>
  )
}

function statusMeta(status: SessionSummary['status'] | undefined): {
  label: string
  icon: typeof CheckCircle2
  spin?: boolean
  className: string
} {
  if (!status) {
    return {
      label: 'unknown',
      icon: Clock3,
      className: 'text-slate-500 dark:text-slate-500',
    }
  }
  if (status === 'done' || status === 'idle') {
    return {
      label: status === 'done' ? 'done' : 'ready',
      icon: CheckCircle2,
      className: 'text-emerald-600 dark:text-emerald-400',
    }
  }
  if (status === 'error') {
    return {
      label: 'error',
      icon: AlertCircle,
      className: 'text-rose-600 dark:text-rose-400',
    }
  }
  if (status === 'awaiting_approval') {
    return {
      label: 'approval',
      icon: Clock3,
      className: 'text-amber-600 dark:text-amber-400',
    }
  }
  return {
    label: status === 'executing_tools' ? 'tools' : 'thinking',
    icon: Loader2,
    spin: status === 'thinking',
    className: 'text-sky-600 dark:text-sky-400',
  }
}

function formatWhen(iso: string): string {
  try {
    const d = new Date(iso)
    const delta = Date.now() - d.getTime()
    if (delta < 60_000) return 'just now'
    if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`
    if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`
    return d.toISOString().slice(0, 10)
  } catch {
    return iso
  }
}
