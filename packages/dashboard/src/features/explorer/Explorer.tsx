/**
 * Explorer — single left column that fuses the old Workspaces/Sessions
 * columns into a two-level tree: workspace parents with session children.
 *
 * "Workspace" here is the machine a session's tool calls run on
 * (see ADR 0013): a stable ULID that the executor announces on connect.
 * Sessions whose parent workspace has no attached executor are shown offline;
 * sessions without a workspaceId (older logs) group under "Unassigned".
 */

import { useMemo, useState } from 'react'
import useMeasure from 'react-use-measure'
import { NodeApi, Tree } from 'react-arborist'
import { ChevronDown, ChevronRight, Plus, X } from 'lucide-react'
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

const ROW_HEIGHT = 56

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
    <div className="flex flex-col h-full overflow-hidden bg-white dark:bg-slate-950">
      <Header onNewSession={onNewSession} />
      <div
        ref={ref}
        className="flex-1 min-h-0"
        data-testid="explorer-column"
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

function Header({ onNewSession }: { onNewSession: () => void }): JSX.Element {
  return (
    <div className="px-3 py-2 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between bg-white dark:bg-slate-950">
      <span className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
        Explorer
      </span>
      <Button
        variant="ghost"
        size="sm"
        onClick={onNewSession}
        data-testid="new-session-button"
        title="Start a new session"
        className="h-6 px-2 text-xs text-sky-600 hover:text-sky-800 dark:text-sky-400 dark:hover:text-sky-200"
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
      className="px-2 border-b border-slate-100 dark:border-slate-900 hover:bg-slate-100 dark:hover:bg-slate-900 cursor-pointer select-none"
    >
      <div className="flex items-center gap-1.5 h-7">
        {node.isOpen ? (
          <ChevronDown className="h-3.5 w-3.5 text-slate-500" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-slate-500" />
        )}
        <span className={`inline-block w-2 h-2 rounded-full ${dotCls}`} />
        <span className="text-sm text-slate-800 dark:text-slate-100 font-mono truncate">
          {w.name}
        </span>
      </div>
      <div className="pl-6 -mt-1 text-[11px] text-slate-500 dark:text-slate-500 font-mono truncate">
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
        'group relative border-b border-slate-100 dark:border-slate-900 hover:bg-slate-100 dark:hover:bg-slate-900 transition-colors',
        selected &&
          'bg-slate-200 dark:bg-slate-800 border-l-2 border-l-sky-500 dark:border-l-sky-400',
      )}
      onClick={() => node.activate()}
    >
      <div className="px-2 pl-6 py-1.5 pr-9 cursor-pointer">
        <div className="text-sm text-slate-800 dark:text-slate-100 truncate">
          {s.label}
        </div>
        <div className="mt-0.5 text-[11px] text-slate-600 dark:text-slate-400 font-mono flex gap-2 items-center">
          <StatusChip status={s.status} />
          <span className="text-slate-500 dark:text-slate-500 truncate">
            {s.eventCount} evt
          </span>
          <span className="text-slate-500 dark:text-slate-600 truncate ml-auto">
            {formatWhen(s.lastActivityIso)}
          </span>
        </div>
        {s.parentSessionId ? (
          <div className="mt-0.5 text-[10px] text-amber-600 dark:text-amber-400 font-mono truncate">
            ↳ fork of {s.parentSessionId.slice(0, 8)}…
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
        className="opacity-50 hover:opacity-100 absolute top-1.5 right-1.5 h-7 w-7 rounded-md text-slate-500 hover:text-white hover:bg-rose-500 dark:text-slate-400 dark:hover:text-white dark:hover:bg-rose-600 transition-colors"
      >
        <X className="h-4 w-4" strokeWidth={2.5} />
      </Button>
    </div>
  )
}

function StatusChip({
  status,
}: {
  status?: SessionSummary['status']
}): JSX.Element {
  if (!status) {
    return (
      <span className="px-1 text-slate-500 border border-slate-300 dark:border-slate-800 rounded">
        —
      </span>
    )
  }
  const cls =
    status === 'done'
      ? 'text-emerald-700 dark:text-emerald-300 border-emerald-300 dark:border-emerald-800/60 bg-emerald-50 dark:bg-emerald-950/30'
      : status === 'error'
        ? 'text-rose-700 dark:text-rose-300 border-rose-300 dark:border-rose-800/60 bg-rose-50 dark:bg-rose-950/30'
        : status === 'awaiting_approval'
          ? 'text-amber-700 dark:text-amber-300 border-amber-300 dark:border-amber-800/60 bg-amber-50 dark:bg-amber-950/30'
          : 'text-sky-700 dark:text-sky-300 border-sky-300 dark:border-sky-800/60 bg-sky-50 dark:bg-sky-950/30'
  return <span className={`px-1 border rounded ${cls}`}>{status}</span>
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
