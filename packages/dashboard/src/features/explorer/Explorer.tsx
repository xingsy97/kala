/**
 * Explorer  -  single left column that fuses the old Workspaces/Sessions
 * columns into a two-level tree: workspace parents with session children.
 *
 * "Workspace" here is the machine a session's tool calls run on
 * (see ADR 0013): a stable ULID that the executor announces on connect.
 * Sessions whose parent workspace has no attached executor are shown offline;
 * sessions without a workspaceId (older logs) group under "Unassigned".
 */

import { useEffect, useMemo, useRef, useState, type ReactElement, type RefCallback } from 'react'
import useMeasure from 'react-use-measure'
import { NodeApi, Tree } from 'react-arborist'
import type { RowRendererProps } from 'react-arborist'
import {
  AlertCircle,
  Cable,
  ChevronDown,
  ChevronRight,
  Clock3,
  Folder,
  GitFork,
  Info,
  Pencil,
  Plus,
  Search,
  TriangleAlert,
  Trash2,
  Wrench,
  X,
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
import type {
  SessionNode,
  TimeBucketNode,
  TreeNode,
  WorkspaceChild,
  WorkspaceNode,
} from './tree-model.js'

type Props = {
  executors: readonly AttachedExecutor[]
  sessions: readonly SessionSummary[]
  selectedSessionId: string | null
  onSelect(sessionId: string): void
  onNewSession(workspaceId?: string): void
  onConnectWorkspace(): void
  onDelete(sessionId: string): void
  onRename(sessionId: string, label: string): void
  onOpenSessionInfo?(sessionId: string): void
  onWorkspaceInfo?(workspaceId: string): void
}

const SESSION_ROW_HEIGHT = 60
const WORKSPACE_ROW_HEIGHT = 48
const BUCKET_ROW_HEIGHT = 28

export function Explorer({
  executors,
  sessions,
  selectedSessionId,
  onSelect,
  onNewSession,
  onConnectWorkspace,
  onDelete,
  onRename,
  onOpenSessionInfo,
  onWorkspaceInfo,
}: Props): JSX.Element {
  const [pendingDelete, setPendingDelete] = useState<SessionNode | null>(null)
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [ref, bounds] = useMeasure({ debounce: 30 })

  const data = useMemo(
    () => buildTree(executors, sessions),
    [executors, sessions],
  )
  const visibleData = useMemo(() => filterTree(data, query), [data, query])

  const empty = executors.length === 0 && sessions.length === 0
  const filteredEmpty = !empty && query.trim().length > 0 && visibleData.length === 0
  const selection = selectedSessionId ? `sess:${selectedSessionId}` : undefined

  const activate = (node: NodeApi<TreeNode>): void => {
    if (node.data.kind === 'session') onSelect(node.data.sessionId)
  }

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden bg-muted/30">
      <Header query={query} onQueryChange={setQuery} onConnectWorkspace={onConnectWorkspace} />
      <div
        ref={ref}
        className="flex-1 min-h-0"
        data-testid="explorer-column"
        data-scroll-owner="react-arborist"
      >
        {empty ? (
          <div className="p-4 text-xs leading-relaxed text-muted-foreground">
            No daemons attached. Start an executor with{' '}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-foreground">
              pnpm executor:dev
            </code>
            .
          </div>
        ) : filteredEmpty ? (
          <div className="p-4 text-xs leading-relaxed text-muted-foreground" data-testid="explorer-filter-empty">
            No sessions or workspaces match <span className="font-mono text-foreground">{query.trim()}</span>.
          </div>
        ) : bounds.height > 0 ? (
          <Tree<TreeNode>
            data={visibleData as unknown as TreeNode[]}
            childrenAccessor={(d) => {
              if (d.kind === 'workspace' || d.kind === 'bucket') return d.children
              return d.children.length > 0 ? d.children : null
            }}
            idAccessor="id"
            openByDefault
            disableDrag
            disableDrop
            disableEdit
            disableMultiSelection
            disableSelect={(d) => d.kind !== 'session'}
            selection={selection}
            onActivate={activate}
            renderRow={TreeRow}
            rowHeight={rowHeightFor}
            indent={12}
            width={bounds.width}
            height={bounds.height}
          >
            {({ node, style }) => (
              <Row
                node={node}
                style={style}
                editingSessionId={editingSessionId}
                onDeleteRequest={(sess) => setPendingDelete(sess)}
                onStartEdit={(sess) => setEditingSessionId(sess.sessionId)}
                onCancelEdit={() => setEditingSessionId(null)}
                onSubmitEdit={(sess, next) => {
                  setEditingSessionId(null)
                  if (next.trim() !== sess.label.trim()) {
                    onRename(sess.sessionId, next)
                  }
                }}
                onOpenSessionInfo={onOpenSessionInfo}
                onWorkspaceInfo={onWorkspaceInfo}
                onNewSession={onNewSession}
                query={query}
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
              <span className="font-mono text-foreground">
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

function rowHeightFor(node: NodeApi<TreeNode>): number {
  if (node.data.kind === 'workspace') return WORKSPACE_ROW_HEIGHT
  if (node.data.kind === 'bucket') return BUCKET_ROW_HEIGHT
  return SESSION_ROW_HEIGHT
}

function Header({
  query,
  onQueryChange,
  onConnectWorkspace,
}: {
  query: string
  onQueryChange(query: string): void
  onConnectWorkspace: () => void
}): JSX.Element {
  return (
    <div className="flex flex-col gap-2 bg-sidebar-accent/60 px-3 py-2.5 backdrop-blur supports-[backdrop-filter]:bg-sidebar-accent/40">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Explorer
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={onConnectWorkspace}
          data-testid="new-session-button"
          title="Connect a new workspace"
          className="h-7 gap-1 rounded-full px-2.5 text-xs"
        >
          <Cable className="h-3 w-3" />
          Workspace
        </Button>
      </div>
      <label className="flex h-7 min-w-0 items-center gap-1.5 rounded bg-background/70 px-2 text-xs ring-1 ring-border/50 focus-within:ring-primary/40">
        <Search className="h-3.5 w-3.5 flex-none text-muted-foreground" aria-hidden="true" />
        <input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="Search sessions"
          className="min-w-0 flex-1 bg-transparent text-[12px] text-foreground outline-none placeholder:text-muted-foreground"
          data-testid="explorer-search"
          aria-label="Search sessions and workspaces"
        />
        {query ? (
          <button type="button" onClick={() => onQueryChange('')} className="rounded text-muted-foreground hover:text-foreground" aria-label="Clear explorer search">
            <X className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </label>
    </div>
  )
}

function Row({
  node,
  style,
  editingSessionId,
  onDeleteRequest,
  onStartEdit,
  onCancelEdit,
  onSubmitEdit,
  onOpenSessionInfo,
  onWorkspaceInfo,
  onNewSession,
  query,
}: {
  node: NodeApi<TreeNode>
  style: React.CSSProperties
  editingSessionId: string | null
  onDeleteRequest(sess: SessionNode): void
  onStartEdit(sess: SessionNode): void
  onCancelEdit(): void
  onSubmitEdit(sess: SessionNode, label: string): void
  onOpenSessionInfo?(sessionId: string): void
  onWorkspaceInfo?(workspaceId: string): void
  onNewSession(workspaceId?: string): void
  query: string
}): JSX.Element {
  if (node.data.kind === 'workspace') {
    return (
      <WorkspaceRow
        node={node as NodeApi<WorkspaceNode>}
        style={style}
        onWorkspaceInfo={onWorkspaceInfo}
        onNewSession={onNewSession}
        query={query}
      />
    )
  }
  if (node.data.kind === 'bucket') {
    return <BucketRow node={node as NodeApi<TimeBucketNode>} style={style} query={query} />
  }
  return (
    <SessionRow
      node={node as NodeApi<SessionNode>}
      style={style}
      editing={editingSessionId === (node.data as SessionNode).sessionId}
      onDeleteRequest={onDeleteRequest}
      onStartEdit={onStartEdit}
      onCancelEdit={onCancelEdit}
      onSubmitEdit={onSubmitEdit}
      onOpenSessionInfo={onOpenSessionInfo}
      query={query}
    />
  )
}

function WorkspaceRow({
  node,
  style,
  onWorkspaceInfo,
  onNewSession,
  query,
}: {
  node: NodeApi<WorkspaceNode>
  style: React.CSSProperties
  onWorkspaceInfo?(workspaceId: string): void
  onNewSession(workspaceId?: string): void
  query: string
}): JSX.Element {
  const w = node.data
  const dotCls = w.online
    ? 'bg-emerald-500 dark:bg-emerald-400'
    : 'bg-muted-foreground/40'
  const meta =
    w.workspaceId === null
      ? 'sessions with no workspace'
      : [w.os, w.runtime, w.runtimeVersion, w.ip]
          .filter((s) => typeof s === 'string' && s.length > 0)
          .join('  -  ') || 'offline'
  const canShowInfo = w.workspaceId !== null && onWorkspaceInfo
  const canCreateSession = w.workspaceId !== null
  return (
    <div
      style={style}
      data-testid="workspace-row"
      data-workspace-id={w.workspaceId ?? 'unassigned'}
      data-online={w.online ? 'true' : 'false'}
      onClick={() => node.toggle()}
      className="group/ws flex min-w-0 cursor-pointer select-none flex-col justify-center px-3 hover:bg-accent/50"
    >
      <div className="flex items-center gap-1.5">
        {node.isOpen ? (
          <ChevronDown className="h-3.5 w-3.5 flex-none text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 flex-none text-muted-foreground" />
        )}
        <span className={cn('inline-block h-2 w-2 flex-none rounded-full', dotCls)} />
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-foreground">
          <HighlightText text={w.name} query={query} />
        </span>
        {canCreateSession ? (
          <button
            type="button"
            data-testid={`workspace-new-session-${w.workspaceId}`}
            title={w.online ? 'New session in this workspace' : 'Workspace offline'}
            aria-label="New session in this workspace"
            disabled={!w.online}
            className="flex-none rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-muted-foreground group-hover/ws:opacity-100"
            onClick={(e) => {
              e.stopPropagation()
              if (!w.online) return
              onNewSession(w.workspaceId ?? undefined)
            }}
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        ) : null}
        {canShowInfo ? (
          <button
            type="button"
            data-testid={`workspace-info-${w.workspaceId}`}
            title="Workspace info"
            aria-label="Workspace info"
            className="flex-none rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover/ws:opacity-100"
            onClick={(e) => {
              e.stopPropagation()
              if (w.workspaceId !== null) onWorkspaceInfo?.(w.workspaceId)
            }}
          >
            <Info className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>
      <div className="mt-0.5 truncate pl-6 text-[11px] text-muted-foreground">
        {meta}
      </div>
    </div>
  )
}

function BucketRow({
  node,
  style,
  query,
}: {
  node: NodeApi<TimeBucketNode>
  style: React.CSSProperties
  query: string
}): JSX.Element {
  const b = node.data
  return (
    <div
      style={style}
      data-testid="bucket-row"
      data-bucket={b.bucket}
      onClick={() => node.toggle()}
      className="flex min-w-0 cursor-pointer select-none items-center gap-1.5 px-3 pl-5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/80 hover:text-foreground"
    >
      {node.isOpen ? (
        <ChevronDown className="h-3 w-3 flex-none opacity-60" />
      ) : (
        <ChevronRight className="h-3 w-3 flex-none opacity-60" />
      )}
      <span className="truncate"><HighlightText text={b.label} query={query} /></span>
      <span className="ml-1 tabular-nums opacity-60">{b.children.length}</span>
    </div>
  )
}

function SessionRow({
  node,
  style,
  editing,
  onDeleteRequest,
  onStartEdit,
  onCancelEdit,
  onSubmitEdit,
  onOpenSessionInfo,
  query,
}: {
  node: NodeApi<SessionNode>
  style: React.CSSProperties
  editing: boolean
  onDeleteRequest(sess: SessionNode): void
  onStartEdit(sess: SessionNode): void
  onCancelEdit(): void
  onSubmitEdit(sess: SessionNode, label: string): void
  onOpenSessionInfo?(sessionId: string): void
  query: string
}): JSX.Element {
  const s = node.data
  const selected = node.isSelected
  return (
    <div
      style={style}
      data-testid="session-row"
      data-session-id={s.sessionId}
      className={cn(
        'group relative min-w-0 cursor-pointer overflow-hidden transition-colors',
        'hover:bg-accent',
        selected &&
          'bg-accent border-l-2 border-l-primary',
      )}
      onMouseDown={(e) => {
        // Suppress the second `click` in a native double-click sequence so it
        // doesn't reach the react-arborist row handler and re-activate the
        // session (which unmounts our rename input mid-edit).
        if (e.detail >= 2) e.preventDefault()
      }}
      onDoubleClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        onStartEdit(s)
      }}
    >
      <div className="min-w-0 cursor-pointer px-3 py-2 pl-6 pr-24">
        <div className="flex min-w-0 items-center gap-2">
          <SessionStatusIndicator status={s.status} selected={selected} />
          {s.parentSessionId ? (
            <GitFork
              className="h-3 w-3 flex-none text-amber-600 dark:text-amber-400"
              aria-label="forked session"
            />
          ) : null}
          {editing ? (
            <RenameInput
              initial={s.label}
              onSubmit={(next) => onSubmitEdit(s, next)}
              onCancel={onCancelEdit}
            />
          ) : (
            <div
              className={cn(
                'min-w-0 flex-1 truncate text-[13px] font-medium',
                selected ? 'text-foreground' : 'text-foreground/90',
              )}
              title="Double-click to rename"
            >
              <HighlightText text={s.label} query={query} />
            </div>
          )}
        </div>
        <div className="mt-1 flex min-w-0 items-center gap-2 pl-5 text-[11px] leading-4 text-muted-foreground">
          {s.currentCwd ? (
            <span
              className="flex min-w-0 items-center gap-1.5 truncate font-mono"
              title={s.currentCwd}
              data-testid="session-row-cwd"
            >
              <Folder className="h-3 w-3 flex-none opacity-70" />
              <span className="min-w-0 truncate"><HighlightText text={s.currentCwd} query={query} /></span>
            </span>
          ) : null}
          <span className="ml-auto flex-none tabular-nums opacity-70">
            <span className="inline-flex items-center gap-1">
              <Clock3 className="h-3 w-3 opacity-70" aria-hidden="true" />
              {formatWhen(s.lastActivityIso)}
            </span>
          </span>
        </div>
      </div>
      {editing ? null : (
        <div className="absolute right-1.5 top-1.5 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          <Button
            variant="ghost"
            size="icon"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              onStartEdit(s)
            }}
            data-testid="session-rename-button"
            title="Rename this session"
            aria-label={`rename session ${s.sessionId}`}
            className="h-7 w-7 rounded-md text-muted-foreground hover:bg-accent-foreground/10 hover:text-foreground"
          >
            <Pencil className="h-3.5 w-3.5" strokeWidth={2.2} />
          </Button>
          {onOpenSessionInfo ? (
            <Button
              variant="ghost"
              size="icon"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation()
                onOpenSessionInfo(s.sessionId)
              }}
              data-testid="session-info-button"
              title="Session info"
              aria-label={`session info ${s.sessionId}`}
              className="h-7 w-7 rounded-md text-muted-foreground hover:bg-accent-foreground/10 hover:text-foreground"
            >
              <Info className="h-3.5 w-3.5" strokeWidth={2.2} />
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="icon"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              onDeleteRequest(s)
            }}
            data-testid="session-delete-button"
            title="Delete this session (irreversible)"
            aria-label={`delete session ${s.sessionId}`}
            className="h-7 w-7 rounded-md text-muted-foreground hover:bg-destructive hover:text-destructive-foreground"
          >
            <Trash2 className="h-3.5 w-3.5" strokeWidth={2.2} />
          </Button>
        </div>
      )}
    </div>
  )
}

function SessionStatusIndicator({
  status,
  selected,
}: {
  status: SessionSummary['status'] | undefined
  selected: boolean
}): JSX.Element {
  const label = statusIndicatorLabel(status)
  const base = 'inline-flex h-3.5 w-3.5 flex-none items-center justify-center'
  if (status === 'thinking') {
    return (
      <span
        className={base}
        data-testid="session-status-indicator"
        data-status={status}
        aria-label={label}
        title={label}
      >
        <span
          className={cn(
            'h-2 w-2 rounded-full animate-pulse',
            selected ? 'bg-sky-500 dark:bg-sky-400' : 'bg-sky-500/80 dark:bg-sky-400/80',
          )}
        />
      </span>
    )
  }
  if (status === 'executing_tools') {
    return (
      <span
        className={base}
        data-testid="session-status-indicator"
        data-status={status}
        aria-label={label}
        title={label}
      >
        <Wrench
          className={cn(
            'h-3 w-3 animate-[spin_2s_linear_infinite]',
            selected ? 'text-violet-600 dark:text-violet-400' : 'text-violet-500 dark:text-violet-400/90',
          )}
          strokeWidth={2.4}
        />
      </span>
    )
  }
  if (status === 'awaiting_approval') {
    return (
      <span
        className={base}
        data-testid="session-status-indicator"
        data-status={status}
        aria-label={label}
        title={label}
      >
        <TriangleAlert
          className={cn(
            'h-3 w-3',
            selected ? 'text-amber-600 dark:text-amber-400' : 'text-amber-500 dark:text-amber-400/90',
          )}
          strokeWidth={2.4}
        />
      </span>
    )
  }
  if (status === 'error') {
    return (
      <span
        className={base}
        data-testid="session-status-indicator"
        data-status={status}
        aria-label={label}
        title={label}
      >
        <AlertCircle
          className={cn(
            'h-3 w-3',
            selected ? 'text-rose-600 dark:text-rose-400' : 'text-rose-500 dark:text-rose-400/90',
          )}
          strokeWidth={2.4}
        />
      </span>
    )
  }
  // idle | done | undefined  -  static gray dot; done gets a slightly stronger tone
  const dotTone =
    status === 'done'
      ? selected
        ? 'bg-emerald-500 dark:bg-emerald-400'
        : 'bg-emerald-500/70 dark:bg-emerald-400/70'
      : selected
        ? 'bg-muted-foreground'
        : 'bg-muted-foreground/60'
  return (
    <span
      className={base}
      data-testid="session-status-indicator"
      data-status={status ?? 'unknown'}
      aria-label={label}
      title={label}
    >
      <span className={cn('h-2 w-2 rounded-full', dotTone)} />
    </span>
  )
}

function statusIndicatorLabel(status: SessionSummary['status'] | undefined): string {
  switch (status) {
    case 'thinking':
      return 'Thinking'
    case 'executing_tools':
      return 'Running tools'
    case 'awaiting_approval':
      return 'Awaiting approval'
    case 'error':
      return 'Error'
    case 'done':
      return 'Done'
    case 'idle':
      return 'Ready'
    default:
      return 'Unknown'
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

function RenameInput({
  initial,
  onSubmit,
  onCancel,
}: {
  initial: string
  onSubmit(label: string): void
  onCancel(): void
}): JSX.Element {
  const [value, setValue] = useState(initial)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  return (
    <input
      ref={ref}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          onSubmit(value)
        } else if (e.key === 'Escape') {
          e.preventDefault()
          onCancel()
        }
      }}
      onBlur={() => onSubmit(value)}
      data-testid="session-rename-input"
      aria-label="Rename session"
      spellCheck={false}
      className="min-w-0 flex-1 rounded-sm bg-background px-1.5 py-0.5 text-[13px] font-medium text-foreground shadow-inner outline-none ring-1 ring-primary/40 focus:ring-2"
    />
  )
}

function filterTree(nodes: readonly WorkspaceNode[], query: string): WorkspaceNode[] {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return [...nodes]
  const filtered: WorkspaceNode[] = []
  for (const workspace of nodes) {
    const workspaceMatches = workspaceMatchesQuery(workspace, needle)
    const children: WorkspaceChild[] = []
    for (const child of workspace.children) {
      if (child.kind === 'session') {
        const kept = filterSessionSubtree(child, needle, workspaceMatches)
        if (kept) children.push(kept)
      } else {
        const sessions: SessionNode[] = []
        for (const session of child.children) {
          const kept = filterSessionSubtree(session, needle, workspaceMatches)
          if (kept) sessions.push(kept)
        }
        if (sessions.length > 0 || child.label.toLocaleLowerCase().includes(needle)) {
          children.push({ ...child, children: sessions })
        }
      }
    }
    if (workspaceMatches || children.length > 0) filtered.push({ ...workspace, children })
  }
  return filtered
}

/**
 * Keeps a session if it or any descendant matches the query. When a parent
 * only exists to house a matching child, we still return the parent so the
 * user sees the fork relationship  -  otherwise the child would appear as
 * an orphaned root and lose context.
 */
function filterSessionSubtree(
  session: SessionNode,
  needle: string,
  workspaceMatches: boolean,
): SessionNode | null {
  const keptChildren: SessionNode[] = []
  for (const child of session.children) {
    const kept = filterSessionSubtree(child, needle, workspaceMatches)
    if (kept) keptChildren.push(kept)
  }
  const selfMatches = workspaceMatches || sessionMatchesQuery(session, needle)
  if (!selfMatches && keptChildren.length === 0) return null
  return { ...session, children: keptChildren }
}

function workspaceMatchesQuery(workspace: WorkspaceNode, needle: string): boolean {
  return [workspace.name, workspace.workspaceId, workspace.os, workspace.runtime, workspace.runtimeVersion, workspace.ip, workspace.workingDir]
    .filter((value): value is string => typeof value === 'string')
    .some((value) => value.toLocaleLowerCase().includes(needle))
}

function sessionMatchesQuery(session: SessionNode, needle: string): boolean {
  return [session.label, session.sessionId, session.workspaceId, session.currentCwd, session.status, session.parentSessionId]
    .filter((value): value is string => typeof value === 'string')
    .some((value) => value.toLocaleLowerCase().includes(needle))
}

function HighlightText({ text, query }: { text: string; query: string }): JSX.Element {
  const needle = query.trim()
  if (!needle) return <>{text}</>
  const index = text.toLocaleLowerCase().indexOf(needle.toLocaleLowerCase())
  if (index === -1) return <>{text}</>
  const before = text.slice(0, index)
  const match = text.slice(index, index + needle.length)
  const after = text.slice(index + needle.length)
  return (
    <>
      {before}
      <mark className="rounded bg-amber-200/80 px-0.5 text-foreground dark:bg-amber-500/30" data-testid="explorer-search-highlight">
        {match}
      </mark>
      {after}
    </>
  )
}
