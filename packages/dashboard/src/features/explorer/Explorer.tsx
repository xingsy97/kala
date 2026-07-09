/**
 * Explorer — single left column that fuses the old Workspaces/Sessions
 * columns into a two-level tree: workspace parents with session children.
 *
 * "Workspace" here is the machine a session's tool calls run on
 * (see ADR 0013): a stable ULID that the executor announces on connect.
 * Sessions whose parent workspace has no attached executor are shown offline;
 * sessions without a workspaceId (older logs) group under "Unassigned".
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement, type RefCallback } from 'react'
import useMeasure from 'react-use-measure'
import { NodeApi, Tree } from 'react-arborist'
import type { RowRendererProps } from 'react-arborist'
import { useTranslation } from 'react-i18next'
import {
  AlertCircle,
  Cable,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Circle,
  Clock3,
  Folder,
  GripVertical,
  GitFork,
  Info,
  LoaderCircle,
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
  TreeNode,
  WorkspaceChild,
  WorkspaceNode,
} from './tree-model.js'

type Props = {
  executors: readonly AttachedExecutor[]
  sessions: readonly SessionSummary[]
  loading?: boolean
  selectedSessionId: string | null
  sessionStatuses?: ReadonlyMap<string, SessionActivityStatus>
  onSelect(sessionId: string): void
  onNewSession(workspaceId?: string): void
  onConnectWorkspace(): void
  onDelete(sessionId: string): void
  onRename(sessionId: string, label: string): void
  onRenameWorkspace?(workspaceId: string, workspaceName: string): void
  onOpenSessionInfo?(sessionId: string): void
  onWorkspaceInfo?(workspaceId: string): void
  onCollapse?(): void
}

const SESSION_ROW_HEIGHT = 60
const WORKSPACE_ROW_HEIGHT = 48
const SESSION_ORDER_STORAGE_KEY = 'agent-kernel:explorer:session-order:v1'
const WORKSPACE_OPEN_STORAGE_KEY = 'agent-kernel:explorer:workspace-open:v1'
const SESSION_CHILDREN_OPEN_STORAGE_KEY = 'agent-kernel:explorer:session-children-open:v1'
const EXPLORER_ROW_GRID = 'grid grid-cols-[1rem_1rem_minmax(0,1fr)_auto] gap-x-2'
const EXPLORER_RAIL_CELL = 'flex h-5 w-4 flex-none items-center justify-center'

export type SessionActivityStatus = SessionSummary['status'] | 'loading'

export function Explorer({
  executors,
  sessions,
  loading = false,
  selectedSessionId,
  sessionStatuses,
  onSelect,
  onNewSession,
  onConnectWorkspace,
  onDelete,
  onRename,
  onRenameWorkspace,
  onOpenSessionInfo,
  onWorkspaceInfo,
  onCollapse,
}: Props): JSX.Element {
  const { t } = useTranslation()
  const [pendingDelete, setPendingDelete] = useState<SessionNode | null>(null)
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null)
  const [editingWorkspaceId, setEditingWorkspaceId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [workspaceOpenState, setWorkspaceOpenState] = useState<Record<string, boolean>>(() => readStoredWorkspaceOpenState())
  const [sessionChildrenOpenState, setSessionChildrenOpenState] = useState<Record<string, boolean>>(() => readStoredSessionChildrenOpenState())
  const [ref, bounds] = useMeasure({ debounce: 30 })

  const [manualSessionOrder, setManualSessionOrder] = useState<readonly string[]>(() =>
    syncSessionOrder(readStoredSessionOrder(), sessions),
  )
  useEffect(() => {
    setManualSessionOrder((prev) => syncSessionOrder(prev, sessions))
  }, [sessions])
  useEffect(() => {
    writeStoredSessionOrder(manualSessionOrder)
  }, [manualSessionOrder])
  const orderedSessions = useMemo(
    () => applyManualSessionOrder(sessions, manualSessionOrder),
    [sessions, manualSessionOrder],
  )
  const data = useMemo(
    () => buildTree(executors, orderedSessions),
    [executors, orderedSessions],
  )
  const visibleData = useMemo(() => filterTree(data, query), [data, query])
  const initialOpenState = useMemo(
    () => buildInitialOpenState(visibleData, workspaceOpenState, sessionChildrenOpenState),
    [visibleData, workspaceOpenState, sessionChildrenOpenState],
  )

  const empty = executors.length === 0 && sessions.length === 0
  const filteredEmpty = !empty && query.trim().length > 0 && visibleData.length === 0
  const selection = selectedSessionId ? `sess:${selectedSessionId}` : undefined

  const activate = (node: NodeApi<TreeNode>): void => {
    if (node.data.kind === 'session') onSelect(node.data.sessionId)
  }

  const handleMove = useCallback((args: {
    dragIds: string[]
    dragNodes: NodeApi<TreeNode>[]
    parentId: string | null
    parentNode: NodeApi<TreeNode> | null
    index: number
  }) => {
    const movedSessionIds = args.dragNodes
      .map((node) => node.data)
      .filter((node): node is SessionNode => node.kind === 'session')
      .map((node) => node.sessionId)
    if (movedSessionIds.length === 0) return
    const parent = args.parentNode?.data
    if (!parent || parent.kind !== 'workspace') return
    const targetWorkspaceId = parent.workspaceId ?? undefined
    const targetIds = parent.children
      .filter((node) => node.kind === 'session' && node.parentSessionId === undefined && node.workspaceId === targetWorkspaceId)
      .map((node) => node.sessionId)
    const movableIds = movedSessionIds.filter((id) => targetIds.includes(id))
    if (movableIds.length === 0) return
    setManualSessionOrder((prev) => reorderSessionIds(prev, targetIds, movableIds, args.index))
  }, [])

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden bg-muted/30">
      <Header query={query} onQueryChange={setQuery} onConnectWorkspace={onConnectWorkspace} onCollapse={onCollapse} />
      <div
        ref={ref}
        className="flex-1 min-h-0"
        data-testid="explorer-column"
        data-scroll-owner="react-arborist"
      >
        {loading ? (
          <ExplorerLoading />
        ) : empty ? (
          <div className="p-4 text-xs leading-relaxed text-muted-foreground">
            {t('explorer.noDaemons')}
          </div>
        ) : filteredEmpty ? (
          <div className="p-4 text-xs leading-relaxed text-muted-foreground" data-testid="explorer-filter-empty">
            {t('explorer.noMatches', { query: query.trim() })}
          </div>
        ) : bounds.height > 0 ? (
          <Tree<TreeNode>
            data={visibleData as unknown as TreeNode[]}
            childrenAccessor={(d) => {
              if (d.kind === 'workspace') return d.children
              return d.children.length > 0 ? d.children : null
            }}
            idAccessor="id"
            openByDefault
            initialOpenState={initialOpenState}
            onToggle={(id) => {
              if (id.startsWith('ws:')) {
                setWorkspaceOpenState((prev) => {
                  const next = { ...prev, [id]: !(prev[id] ?? true) }
                  writeStoredWorkspaceOpenState(next)
                  return next
                })
                return
              }
              if (id.startsWith('sess:')) {
                setSessionChildrenOpenState((prev) => {
                  const next = { ...prev, [id]: !(prev[id] ?? false) }
                  writeStoredSessionChildrenOpenState(next)
                  return next
                })
              }
            }}
            disableDrag={(d) => d.kind !== 'session'}
            disableDrop={({ parentNode, dragNodes }) => {
              if (parentNode.data.kind !== 'workspace') return true
              const targetWorkspaceId = parentNode.data.workspaceId ?? undefined
              return dragNodes.some((node) => {
                const data = node.data
                return data.kind !== 'session' || data.parentSessionId !== undefined || data.workspaceId !== targetWorkspaceId
              })
            }}
            disableEdit
            disableMultiSelection
            disableSelect={(d) => d.kind !== 'session'}
            selection={selection}
            onActivate={activate}
            onMove={handleMove}
            renderRow={TreeRow}
            rowHeight={rowHeightFor}
            indent={12}
            width={bounds.width}
            height={bounds.height}
          >
            {({ node, style, dragHandle }) => (
              <Row
                node={node}
                style={style}
                dragHandle={dragHandle}
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
                editingWorkspaceId={editingWorkspaceId}
                onStartWorkspaceEdit={(workspace) => setEditingWorkspaceId(workspace.workspaceId)}
                onCancelWorkspaceEdit={() => setEditingWorkspaceId(null)}
                onSubmitWorkspaceEdit={(workspace, next) => {
                  setEditingWorkspaceId(null)
                  if (workspace.workspaceId !== null && next.trim() !== workspace.name.trim()) {
                    onRenameWorkspace?.(workspace.workspaceId, next)
                  }
                }}
                onNewSession={onNewSession}
                query={query}
                sessionStatuses={sessionStatuses}
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
            <AlertDialogTitle>{t('explorer.deleteTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              <span className="font-mono text-foreground">
                {pendingDelete?.label ?? ''}
              </span>
              <br />
              {t('explorer.deleteDescription')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              data-testid="confirm-delete-button"
              onClick={() => {
                if (pendingDelete) onDelete(pendingDelete.sessionId)
                setPendingDelete(null)
              }}
            >
              {t('explorer.delete')}
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

function ExplorerLoading(): JSX.Element {
  return (
    <div className="space-y-3 p-3" data-testid="explorer-loading">
      <div className="flex items-center gap-2 rounded-lg bg-background/45 px-3 py-2 text-xs text-muted-foreground shadow-sm">
        <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden />
        <span>Loading workspaces and sessions</span>
      </div>
      {Array.from({ length: 5 }).map((_, i) => (
        <div
          key={i}
          className="ak-explorer-loading-row overflow-hidden rounded-lg bg-background/35 px-3 py-2"
          style={{ animationDelay: `${i * 70}ms` }}
        >
          <div className="flex items-center gap-2">
            <span className="h-7 w-7 rounded-md bg-muted/80" />
            <span className="h-2.5 w-24 rounded-full bg-muted/80" />
          </div>
          <div className="ml-9 mt-2 h-2 w-32 rounded-full bg-muted/50" />
        </div>
      ))}
    </div>
  )
}

function rowHeightFor(node: NodeApi<TreeNode>): number {
  if (node.data.kind === 'workspace') return WORKSPACE_ROW_HEIGHT
  return SESSION_ROW_HEIGHT
}

function Header({
  query,
  onQueryChange,
  onConnectWorkspace,
  onCollapse,
}: {
  query: string
  onQueryChange(query: string): void
  onConnectWorkspace: () => void
  onCollapse?: () => void
}): JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col gap-2 bg-sidebar-accent/60 px-3 py-2.5 backdrop-blur supports-[backdrop-filter]:bg-sidebar-accent/40">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {t('explorer.title')}
        </span>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={onConnectWorkspace}
            data-testid="new-session-button"
            title={t('explorer.connectWorkspace')}
            className="h-7 gap-1 rounded-full px-2.5 text-xs"
          >
            <Cable className="h-3 w-3" />
            {t('explorer.addWorkspace')}
          </Button>
          {onCollapse ? (
            <Button
              variant="ghost"
              size="icon"
              onClick={onCollapse}
              data-testid="explorer-collapse-button"
              title={t('explorer.collapsePanel')}
              aria-label={t('explorer.collapsePanel')}
              className="h-9 w-9 rounded-full text-muted-foreground hover:text-foreground sm:h-7 sm:w-7"
            >
              <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
            </Button>
          ) : null}
        </div>
      </div>
      <label className="flex h-7 min-w-0 items-center gap-1.5 rounded bg-background/70 px-2 text-xs ring-1 ring-border/50 focus-within:ring-primary/40">
        <Search className="h-3.5 w-3.5 flex-none text-muted-foreground" aria-hidden="true" />
        <input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder={t('explorer.searchPlaceholder')}
          className="min-w-0 flex-1 bg-transparent text-[12px] text-foreground outline-none placeholder:text-muted-foreground"
          data-testid="explorer-search"
          aria-label={t('explorer.searchLabel')}
        />
        {query ? (
          <button type="button" onClick={() => onQueryChange('')} className="rounded text-muted-foreground hover:text-foreground" aria-label={t('explorer.clearSearch')}>
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
  dragHandle,
  editingSessionId,
  onDeleteRequest,
  onStartEdit,
  onCancelEdit,
  onSubmitEdit,
  onOpenSessionInfo,
  onWorkspaceInfo,
  editingWorkspaceId,
  onStartWorkspaceEdit,
  onCancelWorkspaceEdit,
  onSubmitWorkspaceEdit,
  onNewSession,
  query,
  sessionStatuses,
}: {
  node: NodeApi<TreeNode>
  style: React.CSSProperties
  dragHandle?: (el: HTMLDivElement | null) => void
  editingSessionId: string | null
  onDeleteRequest(sess: SessionNode): void
  onStartEdit(sess: SessionNode): void
  onCancelEdit(): void
  onSubmitEdit(sess: SessionNode, label: string): void
  onOpenSessionInfo?(sessionId: string): void
  onWorkspaceInfo?(workspaceId: string): void
  editingWorkspaceId: string | null
  onStartWorkspaceEdit(workspace: WorkspaceNode): void
  onCancelWorkspaceEdit(): void
  onSubmitWorkspaceEdit(workspace: WorkspaceNode, label: string): void
  onNewSession(workspaceId?: string): void
  query: string
  sessionStatuses?: ReadonlyMap<string, SessionActivityStatus>
}): JSX.Element {
  if (node.data.kind === 'workspace') {
    return (
      <WorkspaceRow
        node={node as NodeApi<WorkspaceNode>}
        style={style}
        onWorkspaceInfo={onWorkspaceInfo}
        editing={node.data.workspaceId !== null && editingWorkspaceId === node.data.workspaceId}
        onStartEdit={onStartWorkspaceEdit}
        onCancelEdit={onCancelWorkspaceEdit}
        onSubmitEdit={onSubmitWorkspaceEdit}
        onNewSession={onNewSession}
        query={query}
      />
    )
  }
  return (
    <SessionRow
      node={node as NodeApi<SessionNode>}
      style={style}
      dragHandle={dragHandle}
      editing={editingSessionId === (node.data as SessionNode).sessionId}
      onDeleteRequest={onDeleteRequest}
      onStartEdit={onStartEdit}
      onCancelEdit={onCancelEdit}
      onSubmitEdit={onSubmitEdit}
      onOpenSessionInfo={onOpenSessionInfo}
      query={query}
      activeStatus={sessionStatuses?.get((node.data as SessionNode).sessionId)}
    />
  )
}

function WorkspaceRow({
  node,
  style,
  onWorkspaceInfo,
  editing,
  onStartEdit,
  onCancelEdit,
  onSubmitEdit,
  onNewSession,
  query,
}: {
  node: NodeApi<WorkspaceNode>
  style: React.CSSProperties
  onWorkspaceInfo?(workspaceId: string): void
  editing: boolean
  onStartEdit(workspace: WorkspaceNode): void
  onCancelEdit(): void
  onSubmitEdit(workspace: WorkspaceNode, label: string): void
  onNewSession(workspaceId?: string): void
  query: string
}): JSX.Element {
  const { t } = useTranslation()
  const w = node.data
  const dotCls = w.online
    ? 'bg-emerald-500 dark:bg-emerald-400'
    : 'bg-muted-foreground/40'
  const meta =
    w.workspaceId === null
      ? t('explorer.sessionsNoWorkspace')
      : [w.os, w.runtime, w.runtimeVersion, w.ip]
          .filter((s) => typeof s === 'string' && s.length > 0)
          .join(' · ') || t('explorer.offline')
  const canShowInfo = w.workspaceId !== null && onWorkspaceInfo
  const canCreateSession = w.workspaceId !== null
  const canRename = w.workspaceId !== null
  return (
    <div
      style={style}
      data-testid="workspace-row"
      data-workspace-id={w.workspaceId ?? 'unassigned'}
      data-online={w.online ? 'true' : 'false'}
      onClick={() => {
        if (!editing) node.toggle()
      }}
      className={cn(
        'group/ws min-w-0 cursor-pointer select-none px-3 py-1.5 hover:bg-accent/50',
        EXPLORER_ROW_GRID,
      )}
    >
      <div className={EXPLORER_RAIL_CELL}>
        {node.isOpen ? (
          <ChevronDown className="h-3.5 w-3.5 flex-none text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 flex-none text-muted-foreground" />
        )}
      </div>
      <div className={EXPLORER_RAIL_CELL}>
        <span className={cn('inline-block h-2 w-2 flex-none rounded-full', dotCls)} />
      </div>
      {editing ? (
        <RenameInput
          initial={w.name}
          onSubmit={(next) => onSubmitEdit(w, next)}
          onCancel={onCancelEdit}
          testId="workspace-rename-input"
          ariaLabel={t('explorer.renameWorkspace')}
        />
      ) : (
        <span
          className="min-w-0 truncate text-[13px] font-semibold leading-5 text-foreground"
          title={canRename ? t('explorer.doubleClickRename') : undefined}
          onDoubleClick={(e) => {
            if (!canRename) return
            e.preventDefault()
            e.stopPropagation()
            onStartEdit(w)
          }}
        >
          <HighlightText text={w.name} query={query} />
        </span>
      )}
      <div className="flex min-w-0 items-center justify-end gap-0.5 opacity-0 transition-opacity group-hover/ws:opacity-100">
        {canRename && !editing ? (
          <button
            type="button"
            data-testid={`workspace-rename-${w.workspaceId}`}
            title={t('explorer.renameWorkspace')}
            aria-label={t('explorer.renameWorkspaceAria', { workspaceId: w.workspaceId })}
            className="flex-none rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={(e) => {
              e.stopPropagation()
              onStartEdit(w)
            }}
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
        ) : null}
        {canCreateSession ? (
          <button
            type="button"
            data-testid={`workspace-new-session-${w.workspaceId}`}
            title={w.online ? t('explorer.newSessionInWorkspace') : t('explorer.workspaceOffline')}
            aria-label={t('explorer.newSessionInWorkspace')}
            disabled={!w.online}
            className="flex-none rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
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
            title={t('explorer.workspaceInfo')}
            aria-label={t('explorer.workspaceInfo')}
            className="flex-none rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={(e) => {
              e.stopPropagation()
              if (w.workspaceId !== null) onWorkspaceInfo?.(w.workspaceId)
            }}
          >
            <Info className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>
      <div className="col-start-3 min-w-0 truncate text-[11px] leading-4 text-muted-foreground">
        {meta}
      </div>
    </div>
  )
}

function SessionRow({
  node,
  style,
  dragHandle,
  editing,
  onDeleteRequest,
  onStartEdit,
  onCancelEdit,
  onSubmitEdit,
  onOpenSessionInfo,
  query,
  activeStatus,
}: {
  node: NodeApi<SessionNode>
  style: React.CSSProperties
  dragHandle?: (el: HTMLDivElement | null) => void
  editing: boolean
  onDeleteRequest(sess: SessionNode): void
  onStartEdit(sess: SessionNode): void
  onCancelEdit(): void
  onSubmitEdit(sess: SessionNode, label: string): void
  onOpenSessionInfo?(sessionId: string): void
  query: string
  activeStatus?: SessionActivityStatus
}): JSX.Element {
  const { t } = useTranslation()
  const s = node.data
  const selected = node.isSelected
  const status = activeStatus ?? s.status
  return (
    <div
      style={style}
      data-testid="session-row"
      data-session-id={s.sessionId}
      className={cn(
        'group relative min-w-0 cursor-pointer overflow-hidden px-3 py-2 transition-colors',
        'hover:bg-accent',
        selected && 'bg-accent',
        EXPLORER_ROW_GRID,
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
      {selected ? (
        <span
          className="absolute bottom-1.5 left-0 top-1.5 w-0.5 rounded-r-full bg-primary"
          data-testid="session-selected-marker"
          aria-hidden="true"
        />
      ) : null}
      <div className={EXPLORER_RAIL_CELL}>
        {s.children.length > 0 ? (
          <button
            type="button"
            className="flex h-5 w-4 flex-none items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
            title={node.isOpen ? t('explorer.collapseSubAgents') : t('explorer.expandSubAgents')}
            aria-label={node.isOpen ? t('explorer.collapseSubAgents') : t('explorer.expandSubAgents')}
            data-testid="session-children-toggle"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              node.toggle()
            }}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            {node.isOpen ? (
              <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
            )}
          </button>
        ) : !s.parentSessionId ? (
          <div
            ref={dragHandle}
            className="flex h-5 w-4 flex-none cursor-grab items-center justify-center text-muted-foreground/50 opacity-70 active:cursor-grabbing group-hover:text-muted-foreground"
            title={t('explorer.dragSession')}
            aria-label={t('explorer.dragSession')}
            data-testid="session-drag-handle"
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            <GripVertical className="h-3.5 w-3.5" aria-hidden="true" />
          </div>
        ) : (
          <GitFork
            className="h-3 w-3 flex-none text-amber-600 dark:text-amber-400"
            aria-label={t('explorer.forkedSession')}
          />
        )}
      </div>
      <div className={EXPLORER_RAIL_CELL}>
        <SessionStatusIndicator status={status} />
      </div>
      {editing ? (
        <RenameInput
          initial={s.label}
          onSubmit={(next) => onSubmitEdit(s, next)}
          onCancel={onCancelEdit}
        />
      ) : (
        <div
          className={cn(
            'min-w-0 truncate text-[13px] font-medium leading-5',
            selected ? 'text-foreground' : 'text-foreground/90',
          )}
          title={t('explorer.doubleClickRename')}
        >
          <HighlightText text={s.label} query={query} />
        </div>
      )}
      {editing ? null : (
        <div className="flex min-w-0 items-start justify-end gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          <Button
            variant="ghost"
            size="icon"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              onStartEdit(s)
            }}
            data-testid="session-rename-button"
            title={t('explorer.renameSession')}
            aria-label={t('explorer.renameSessionAria', { sessionId: s.sessionId })}
            className="h-9 w-9 rounded-md text-muted-foreground hover:bg-accent-foreground/10 hover:text-foreground sm:h-7 sm:w-7"
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
              title={t('explorer.sessionInfoTitle')}
              aria-label={t('explorer.sessionInfoAria', { sessionId: s.sessionId })}
              className="h-9 w-9 rounded-md text-muted-foreground hover:bg-accent-foreground/10 hover:text-foreground sm:h-7 sm:w-7"
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
            title={t('explorer.deleteSessionTitle')}
            aria-label={t('explorer.deleteSessionAria', { sessionId: s.sessionId })}
            className="h-9 w-9 rounded-md text-muted-foreground hover:bg-destructive hover:text-destructive-foreground sm:h-7 sm:w-7"
          >
            <Trash2 className="h-3.5 w-3.5" strokeWidth={2.2} />
          </Button>
        </div>
      )}
      <div className="col-start-2 flex h-4 w-4 items-center justify-center text-muted-foreground">
        {s.currentCwd ? <Folder className="h-3 w-3 opacity-70" aria-hidden="true" /> : null}
      </div>
      <div className="col-start-3 min-w-0 truncate font-mono text-[11px] leading-4 text-muted-foreground" title={s.currentCwd} data-testid="session-row-cwd">
        {s.currentCwd ? <HighlightText text={s.currentCwd} query={query} /> : null}
      </div>
      <div className="col-start-4 row-start-2 flex min-w-0 justify-end text-[11px] leading-4 text-muted-foreground">
        <span className="inline-flex flex-none items-center gap-1 tabular-nums opacity-70">
          <Clock3 className="h-3 w-3 opacity-70" aria-hidden="true" />
          {formatWhen(s.lastActivityIso, t)}
        </span>
      </div>
    </div>
  )
}

export function SessionStatusIndicator({
  status,
}: {
  status: SessionActivityStatus | undefined
  selected?: boolean
}): JSX.Element {
  const { t } = useTranslation()
  const label = statusIndicatorLabel(status, t)
  const base = 'inline-flex h-3.5 w-3.5 flex-none items-center justify-center'
  if (status === 'loading') {
    return (
      <span
        className={base}
        data-testid="session-status-indicator"
        data-status={status}
        aria-label={label}
        title={label}
      >
        <LoaderCircle
          className="h-3 w-3 animate-spin text-sky-500 dark:text-sky-400"
          strokeWidth={2.4}
        />
      </span>
    )
  }
  if (status === 'thinking') {
    return (
      <span
        className={base}
        data-testid="session-status-indicator"
        data-status={status}
        aria-label={label}
        title={label}
      >
        <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-sky-500 dark:bg-sky-400" />
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
          className="h-3 w-3 animate-[spin_2s_linear_infinite] text-violet-500 dark:text-violet-400"
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
          className="h-3 w-3 text-amber-500 dark:text-amber-400"
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
          className="h-3 w-3 text-rose-500 dark:text-rose-400"
          strokeWidth={2.4}
        />
      </span>
    )
  }
  if (status === 'done') {
    return (
      <span
        className={base}
        data-testid="session-status-indicator"
        data-status={status}
        aria-label={label}
        title={label}
      >
        <span className="h-2.5 w-2.5 rounded-full bg-emerald-500 dark:bg-emerald-400" />
      </span>
    )
  }
  if (status === 'idle') {
    return (
      <span
        className={base}
        data-testid="session-status-indicator"
        data-status={status}
        aria-label={label}
        title={label}
      >
        <Circle className="h-2.5 w-2.5 text-muted-foreground/80" strokeWidth={3} />
      </span>
    )
  }
  return (
    <span
      className={base}
      data-testid="session-status-indicator"
      data-status="unknown"
      aria-label={label}
      title={label}
    >
      <span className="h-2 w-2 rounded-full bg-muted-foreground/50" />
    </span>
  )
}

function statusIndicatorLabel(status: SessionActivityStatus | undefined, t: ReturnType<typeof useTranslation>['t']): string {
  switch (status) {
    case 'loading':
      return t('explorer.status.loading')
    case 'thinking':
      return t('explorer.status.thinking')
    case 'executing_tools':
      return t('explorer.status.executingTools')
    case 'awaiting_approval':
      return t('explorer.status.awaitingApproval')
    case 'error':
      return t('explorer.status.error')
    case 'done':
      return t('explorer.status.done')
    case 'idle':
      return t('explorer.status.idle')
    default:
      return t('explorer.status.unknown')
  }
}

function formatWhen(iso: string, t: ReturnType<typeof useTranslation>['t']): string {
  try {
    const d = new Date(iso)
    const delta = Date.now() - d.getTime()
    if (delta < 60_000) return t('explorer.time.justNow')
    if (delta < 3_600_000) return t('explorer.time.minutesAgo', { count: Math.floor(delta / 60_000) })
    if (delta < 86_400_000) return t('explorer.time.hoursAgo', { count: Math.floor(delta / 3_600_000) })
    return d.toISOString().slice(0, 10)
  } catch {
    return iso
  }
}

function RenameInput({
  initial,
  onSubmit,
  onCancel,
  testId = 'session-rename-input',
  ariaLabel,
}: {
  initial: string
  onSubmit(label: string): void
  onCancel(): void
  testId?: string
  ariaLabel?: string
}): JSX.Element {
  const { t } = useTranslation()
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
      data-testid={testId}
      aria-label={ariaLabel ?? t('explorer.renameSession')}
      spellCheck={false}
      className="min-w-0 flex-1 rounded-sm bg-background px-1.5 py-0.5 text-[13px] font-medium text-foreground shadow-inner outline-none ring-1 ring-primary/40 focus:ring-2"
    />
  )
}

function readStoredWorkspaceOpenState(): Record<string, boolean> {
  try {
    const raw = window.localStorage.getItem(WORKSPACE_OPEN_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, boolean> = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (key.startsWith('ws:') && typeof value === 'boolean') out[key] = value
    }
    return out
  } catch {
    return {}
  }
}

function writeStoredWorkspaceOpenState(state: Record<string, boolean>): void {
  try {
    window.localStorage.setItem(WORKSPACE_OPEN_STORAGE_KEY, JSON.stringify(state))
  } catch {
    // Storage can be unavailable in private mode or quota-exceeded states.
  }
}

function readStoredSessionChildrenOpenState(): Record<string, boolean> {
  try {
    const raw = window.localStorage.getItem(SESSION_CHILDREN_OPEN_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, boolean> = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (key.startsWith('sess:') && typeof value === 'boolean') out[key] = value
    }
    return out
  } catch {
    return {}
  }
}

function writeStoredSessionChildrenOpenState(state: Record<string, boolean>): void {
  try {
    window.localStorage.setItem(SESSION_CHILDREN_OPEN_STORAGE_KEY, JSON.stringify(state))
  } catch {
    // Storage can be unavailable in private mode or quota-exceeded states.
  }
}

function buildInitialOpenState(
  workspaces: readonly WorkspaceNode[],
  workspaceOpenState: Record<string, boolean>,
  sessionChildrenOpenState: Record<string, boolean>,
): Record<string, boolean> {
  const out: Record<string, boolean> = { ...workspaceOpenState }
  const visitSession = (session: SessionNode): void => {
    if (session.children.length > 0) {
      out[session.id] = sessionChildrenOpenState[session.id] ?? false
      session.children.forEach(visitSession)
    }
  }
  for (const workspace of workspaces) {
    out[workspace.id] = workspaceOpenState[workspace.id] ?? true
    workspace.children.forEach((child) => {
      if (child.kind === 'session') visitSession(child)
    })
  }
  return out
}

function readStoredSessionOrder(): readonly string[] {
  try {
    const raw = window.localStorage.getItem(SESSION_ORDER_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((value): value is string => typeof value === 'string' && value.length > 0)
  } catch {
    return []
  }
}

function writeStoredSessionOrder(order: readonly string[]): void {
  try {
    window.localStorage.setItem(SESSION_ORDER_STORAGE_KEY, JSON.stringify(order))
  } catch {
    // Storage can be unavailable in private mode or quota-exceeded states.
  }
}

function syncSessionOrder(
  prev: readonly string[],
  sessions: readonly SessionSummary[],
): readonly string[] {
  const ids = sessions.map((s) => s.sessionId)
  const live = new Set(ids)
  const next = prev.filter((id) => live.has(id))
  const seen = new Set(next)
  for (const id of ids) {
    if (!seen.has(id)) next.push(id)
  }
  return next
}

function applyManualSessionOrder(
  sessions: readonly SessionSummary[],
  order: readonly string[],
): readonly SessionSummary[] {
  const rank = new Map(order.map((id, index) => [id, index]))
  return [...sessions].sort((a, b) => {
    const ar = rank.get(a.sessionId) ?? Number.MAX_SAFE_INTEGER
    const br = rank.get(b.sessionId) ?? Number.MAX_SAFE_INTEGER
    return ar - br
  })
}

function reorderSessionIds(
  order: readonly string[],
  targetIds: readonly string[],
  movedIds: readonly string[],
  targetIndex: number,
): readonly string[] {
  const moved = new Set(movedIds)
  const target = new Set(targetIds)
  const targetWithoutMoved = targetIds.filter((id) => !moved.has(id))
  const insertIndex = Math.max(0, Math.min(targetIndex, targetWithoutMoved.length))
  const reorderedTarget = [
    ...targetWithoutMoved.slice(0, insertIndex),
    ...movedIds,
    ...targetWithoutMoved.slice(insertIndex),
  ]
  let cursor = 0
  return order.map((id) => {
    if (!target.has(id)) return id
    return reorderedTarget[cursor++] ?? id
  })
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
        const kept = filterSessionSubtree(child, needle, workspaceMatches)
        if (kept) children.push(kept)
      }
    }
    if (workspaceMatches || children.length > 0) filtered.push({ ...workspace, children })
  }
  return filtered
}

/**
 * Keeps a session if it or any descendant matches the query. When a parent
 * only exists to house a matching child, we still return the parent so the
 * user sees the fork relationship — otherwise the child would appear as
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
