/**
 * Explorer — single left column that fuses the old Workspaces/Sessions
 * columns into a two-level tree: workspace parents with session children.
 *
 * "Workspace" here is the machine a session's tool calls run on
 * (see ADR 0013): a stable ULID that the executor announces on connect.
 * Sessions whose parent workspace has no attached executor are shown offline;
 * sessions without a workspaceId are ordinary chats and group under "Chats".
 */

import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type ReactElement, type RefCallback } from 'react'
import { createPortal } from 'react-dom'
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
  EyeOff,
  GripVertical,
  GitFork,
  Info,
  LoaderCircle,
  MoreHorizontal,
  Pencil,
  Plus,
  RotateCcw,
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
import {
  PREF_SESSION_CHILDREN_OPEN,
  PREF_SESSION_ORDER,
  PREF_WORKSPACE_OPEN,
  PREF_WORKSPACE_ORDER,
} from '../../lib/prefs.js'
import { cn } from '../../lib/utils.js'
import { useMinuteClock } from '../../lib/minute-clock.js'
import {
  applyManualSessionOrder,
  applyManualWorkspaceOrder,
  buildInitialOpenState,
  buildTree,
  countSessionDescendants,
  filterTree,
  isRootDropParent,
  reorderSessionIds,
  reorderWorkspaceIds,
  sessionStructureKeyFor,
  syncSessionOrder,
  syncWorkspaceOrder,
  toStructuralSessionSummary,
} from './tree-model.js'
import { useHiddenWorkspaces } from './useHiddenWorkspaces.js'
import { useHiddenSessions } from './useHiddenSessions.js'
import { SessionHoverPreview, type SessionPreviewAnchor } from './SessionHoverPreview.js'
import type { SessionPreviewStore } from './session-preview-store.js'
import type { CachedSessionView } from '../../session-view-cache.js'
import type {
  SessionNode,
  TreeNode,
  WorkspaceNode,
} from './tree-model.js'
import { readStoredSessionChildrenOpenState, readStoredSessionOrder, readStoredWorkspaceOpenState, readStoredWorkspaceOrder, writeStoredSessionChildrenOpenState, writeStoredSessionOrder, writeStoredWorkspaceOpenState, writeStoredWorkspaceOrder } from './persistence.js'
import { coarseSummaryStatus, isSessionWorkspaceOnline, sameExecutorListForExplorer, sameSessionListForExplorer, sameSessionStatusMap } from './comparators.js'
import { SessionRuntimeStore, useSessionRuntime } from './session-runtime-store.js'

type Props = {
  executors: readonly AttachedExecutor[]
  sessions: readonly SessionSummary[]
  loading?: boolean
  selectedSessionId: string | null
  sessionStatuses?: ReadonlyMap<string, SessionActivityStatus>
  onSelect(sessionId: string): void
  onClearSelection?(): void
  onNewSession(workspaceId?: string): void
  onConnectWorkspace(): void
  onDelete(sessionId: string, options?: { cascade?: boolean }): void
  onRename(sessionId: string, label: string): void
  onRenameWorkspace?(workspaceId: string, workspaceName: string): void
  onOpenSessionInfo?(sessionId: string): void
  onWorkspaceInfo?(workspaceId: string): void
  onCollapse?(): void
  embeddedHeader?: boolean
  fontSizePx?: number
  previewStore?: SessionPreviewStore
  getCachedSessionView?: (sessionId: string) => CachedSessionView | null
  subscribeCachedSessionView?: (sessionId: string, listener: () => void) => () => void
}

const SESSION_ROW_HEIGHT = 44
const WORKSPACE_ROW_HEIGHT = 34
const EXPLORER_ROW_GRID = 'grid grid-cols-[1rem_1rem_minmax(0,1fr)_auto] gap-x-2'
const WORKSPACE_ROW_GRID = 'grid grid-cols-[1rem_minmax(0,1fr)_auto] gap-x-2'
const EXPLORER_RAIL_CELL = 'flex h-5 w-4 flex-none items-center justify-center'

export type SessionActivityStatus = SessionSummary['status'] | 'loading'

function ExplorerImpl({
  executors,
  sessions,
  loading = false,
  selectedSessionId,
  sessionStatuses,
  onSelect,
  onClearSelection,
  onNewSession,
  onConnectWorkspace,
  onDelete,
  onRename,
  onRenameWorkspace,
  onOpenSessionInfo,
  onWorkspaceInfo,
  onCollapse,
  embeddedHeader = false,
  fontSizePx = 13,
  previewStore,
  getCachedSessionView,
  subscribeCachedSessionView,
}: Props): JSX.Element {
  const { t } = useTranslation()
  const [pendingDelete, setPendingDelete] = useState<SessionNode | null>(null)
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null)
  const [editingWorkspaceId, setEditingWorkspaceId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [workspaceOpenState, setWorkspaceOpenState] = useState<Record<string, boolean>>(() => readStoredWorkspaceOpenState())
  const [sessionChildrenOpenState, setSessionChildrenOpenState] = useState<Record<string, boolean>>(() => readStoredSessionChildrenOpenState())
  const [manualWorkspaceOrder, setManualWorkspaceOrder] = useState<readonly string[]>(() => readStoredWorkspaceOrder())
  const [previewAnchor, setPreviewAnchor] = useState<SessionPreviewAnchor | null>(null)
  const previewHoveringRef = useRef(false)
  const pointerActivatedSessionRef = useRef<string | null>(null)
  const hiddenWorkspaces = useHiddenWorkspaces()
  const [ref, bounds] = useMeasure({ debounce: 30 })

  const [manualSessionOrder, setManualSessionOrder] = useState<readonly string[]>(() =>
    syncSessionOrder(readStoredSessionOrder(), sessions),
  )
  const sessionStructureKey = useMemo(() => sessions.map(sessionStructureKeyFor).join('\u001f'), [sessions])
  const structuralSessions = useMemo(
    () => sessions.map(toStructuralSessionSummary),
    [sessionStructureKey],
  )
  const sessionRuntimeStoreRef = useRef<SessionRuntimeStore | null>(null)
  if (sessionRuntimeStoreRef.current === null) sessionRuntimeStoreRef.current = new SessionRuntimeStore()
  const sessionRuntimeStore = sessionRuntimeStoreRef.current
  // Sync before rows render so useSyncExternalStore snapshots always match this
  // render. Only listeners for session IDs whose volatile snapshot changed fire.
  sessionRuntimeStore.sync(sessions, sessionStatuses)
  useEffect(() => {
    setManualSessionOrder((prev) => syncSessionOrder(prev, structuralSessions))
  }, [structuralSessions])
  useEffect(() => {
    writeStoredSessionOrder(manualSessionOrder)
  }, [manualSessionOrder])
  const orderedSessions = useMemo(
    () => applyManualSessionOrder(structuralSessions, manualSessionOrder),
    [structuralSessions, manualSessionOrder],
  )
  const hiddenSessions = useHiddenSessions()
  // Hidden sessions are filtered out of the tree entirely (a local UI filter,
  // like hidden workspaces). Forked children of a hidden session re-parent to
  // the workspace root via buildTree's missing-parent handling.
  const visibleOrderedSessions = useMemo(
    () => orderedSessions.filter((s) => !hiddenSessions.isHidden(s.sessionId)),
    [orderedSessions, hiddenSessions],
  )
  // Hidden session id → display label, for the "hidden sessions" unhide bar.
  const hiddenSessionEntries = useMemo(
    () =>
      sessions
        .filter((s) => hiddenSessions.isHidden(s.sessionId))
        .map((s) => ({
          sessionId: s.sessionId,
          label: (s.label?.trim() || s.firstUserMessage?.trim() || s.sessionId),
        })),
    [sessions, hiddenSessions],
  )
  const treeData = useMemo(
    () => buildTree(executors, visibleOrderedSessions),
    [executors, visibleOrderedSessions],
  )
  useEffect(() => {
    setManualWorkspaceOrder((prev) => syncWorkspaceOrder(prev, treeData))
  }, [treeData])
  useEffect(() => {
    writeStoredWorkspaceOrder(manualWorkspaceOrder)
  }, [manualWorkspaceOrder])
  const data = useMemo(
    () => applyManualWorkspaceOrder(treeData, manualWorkspaceOrder),
    [treeData, manualWorkspaceOrder],
  )
  const onlineWorkspaceIds = useMemo(
    () => new Set(executors.map((executor) => executor.workspaceId).filter((id): id is string => typeof id === 'string' && id.length > 0)),
    [executors],
  )
  const hiddenWorkspaceRows = useMemo(
    () => data.filter((workspace) => workspace.workspaceId !== null && hiddenWorkspaces.isHidden(workspace.workspaceId)),
    [data, hiddenWorkspaces],
  )
  const visibleWorkspaceData = useMemo(
    () => data.filter((workspace) => workspace.workspaceId === null || !hiddenWorkspaces.isHidden(workspace.workspaceId)),
    [data, hiddenWorkspaces],
  )
  const deferredQuery = useDeferredValue(query)
  const visibleData = useMemo(() => filterTree(visibleWorkspaceData, deferredQuery), [visibleWorkspaceData, deferredQuery])
  const initialOpenState = useMemo(
    () => buildInitialOpenState(visibleData, workspaceOpenState, sessionChildrenOpenState),
    [visibleData, workspaceOpenState, sessionChildrenOpenState],
  )
  const pendingDeleteDescendantCount = pendingDelete ? countSessionDescendants(pendingDelete) : 0

  const empty = executors.length === 0 && sessions.length === 0
  const filteredEmpty = !empty && query.trim().length > 0 && visibleData.length === 0
  const hiddenEmpty = !empty && query.trim().length === 0 && visibleData.length === 0 && hiddenWorkspaces.count > 0
  const selection = selectedSessionId ? `sess:${selectedSessionId}` : undefined
  const clearPreviewSoon = useCallback((sessionId?: string) => {
    window.setTimeout(() => {
      setPreviewAnchor((current) => {
        if (previewHoveringRef.current) return current
        if (sessionId !== undefined && current?.sessionId !== sessionId) return current
        return null
      })
    }, 80)
  }, [])

  // Tear the hover preview down once a session actually becomes selected. Doing
  // this here (reacting to the committed selection) rather than in the row's
  // mousedown handler is important: mutating this state during mousedown
  // re-renders the react-arborist tree mid-click and swallows the activation,
  // which made previously-opened (preview-eligible) sessions require two
  // clicks to load. This keeps the click path untouched while still ensuring
  // the heavy full-ChatPanel preview never lingers over the switching pane.
  useEffect(() => {
    if (selectedSessionId === null) return
    previewHoveringRef.current = false
    setPreviewAnchor((current) => (current === null ? current : null))
  }, [selectedSessionId])

  const activate = (node: NodeApi<TreeNode>): void => {
    if (node.data.kind !== 'session') return
    if (pointerActivatedSessionRef.current === node.data.sessionId) {
      pointerActivatedSessionRef.current = null
      return
    }
    onSelect(node.data.sessionId)
  }
  const activateSessionOnPointerDown = useCallback((sessionId: string): void => {
    // A running Session can commit between pointerdown and click. If that
    // commit replaces a virtualized row, the browser drops the click that
    // react-arborist normally turns into onActivate. Honor the discrete
    // pointerdown immediately and suppress the matching normal activation.
    pointerActivatedSessionRef.current = sessionId
    onSelect(sessionId)
  }, [onSelect])

  const handleMove = useCallback((args: {
    dragIds: string[]
    dragNodes: NodeApi<TreeNode>[]
    parentId: string | null
    parentNode: NodeApi<TreeNode> | null
    index: number
  }) => {
    const movedWorkspaces = args.dragNodes
      .map((node) => node.data)
      .filter((node): node is WorkspaceNode => node.kind === 'workspace' && node.workspaceId !== null)
    if (movedWorkspaces.length > 0) {
      if (movedWorkspaces.length !== args.dragNodes.length || !isRootDropParent(args.parentNode)) return
      const targetIds = data
        .filter((node) => node.workspaceId !== null)
        .map((node) => node.workspaceId as string)
      setManualWorkspaceOrder((prev) => reorderWorkspaceIds(prev, targetIds, movedWorkspaces.map((node) => node.workspaceId as string), args.index))
      return
    }
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
  }, [data])

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden bg-muted/30">
      <Header query={query} onQueryChange={setQuery} onConnectWorkspace={onConnectWorkspace} onCollapse={onCollapse} embedded={embeddedHeader} />
      <div
        ref={ref}
        className="flex-1 min-h-0"
        data-testid="explorer-column"
        data-scroll-owner="react-arborist"
        onClick={(event) => {
          if (event.target !== event.currentTarget) return
          onClearSelection?.()
        }}
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
        ) : hiddenEmpty ? (
          <div className="p-4 text-xs leading-relaxed text-muted-foreground" data-testid="explorer-hidden-empty">
            {t('explorer.allWorkspacesHidden')}
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
            disableDrag={(d) => d.kind === 'workspace' ? d.workspaceId === null : d.parentSessionId !== undefined}
            disableDrop={({ parentNode, dragNodes }) => {
              const allWorkspaces = dragNodes.every((node) => node.data.kind === 'workspace')
              if (allWorkspaces) return !isRootDropParent(parentNode) || dragNodes.some((node) => node.data.kind === 'workspace' && node.data.workspaceId === null)
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
                onStartEdit={(sess) => {
                  if (!isSessionWorkspaceOnline(sess, onlineWorkspaceIds)) return
                  setEditingSessionId(sess.sessionId)
                }}
                onCancelEdit={() => setEditingSessionId(null)}
                onSubmitEdit={(sess, next) => {
                  setEditingSessionId(null)
                  if (next.trim() !== sess.label.trim()) {
                    onRename(sess.sessionId, next)
                  }
                }}
                onOpenSessionInfo={onOpenSessionInfo}
                onHideSession={hiddenSessions.hide}
                onWorkspaceInfo={onWorkspaceInfo}
                onHideWorkspace={hiddenWorkspaces.hide}
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
                sessionRuntimeStore={sessionRuntimeStore}
                onlineWorkspaceIds={onlineWorkspaceIds}
                fontSizePx={fontSizePx}
                onPreviewAnchorChange={setPreviewAnchor}
                onPreviewLeave={clearPreviewSoon}
                onPointerActivateSession={activateSessionOnPointerDown}
              />
            )}
          </Tree>
        ) : null}
        <SessionHoverPreview
          anchor={previewAnchor}
          previewStore={previewStore}
          getCachedSessionView={getCachedSessionView}
          subscribeCachedSessionView={subscribeCachedSessionView}
          onHoverChange={(hovering) => {
            previewHoveringRef.current = hovering
            if (!hovering) clearPreviewSoon()
          }}
        />
      </div>
      {hiddenWorkspaces.count > 0 ? (
        <HiddenWorkspacesBar
          workspaces={hiddenWorkspaceRows}
          hiddenIds={hiddenWorkspaces.hiddenIds}
          onUnhide={hiddenWorkspaces.unhide}
        />
      ) : null}
      {hiddenSessions.count > 0 ? (
        <HiddenSessionsBar
          entries={hiddenSessionEntries}
          onUnhide={hiddenSessions.unhide}
        />
      ) : null}

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
              {pendingDeleteDescendantCount > 0 ? (
                <>
                  <br />
                  <span className="mt-2 block text-amber-700 dark:text-amber-300">
                    {t('explorer.deleteChildrenDescription', { count: pendingDeleteDescendantCount })}
                  </span>
                </>
              ) : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            {pendingDeleteDescendantCount > 0 ? (
              <AlertDialogAction
                data-testid="confirm-delete-cascade-button"
                onClick={() => {
                  if (pendingDelete) onDelete(pendingDelete.sessionId, { cascade: true })
                  setPendingDelete(null)
                }}
              >
                {t('explorer.deleteWithChildren', { count: pendingDeleteDescendantCount })}
              </AlertDialogAction>
            ) : null}
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

export const Explorer = memo(ExplorerImpl, areExplorerPropsEqual)

/**
 * Returns true when the event originated inside an interactive control (button,
 * link, form field) or an element explicitly opted out of row activation via
 * `data-row-action`. Such clicks must run their own handler only and never
 * trigger react-arborist row selection/activation (which would switch session).
 */
function isRowActionTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  return Boolean(
    target.closest(
      'button, a, input, textarea, select, [role="button"], [data-row-action]',
    ),
  )
}

function TreeRow({ node, attrs, innerRef, children }: RowRendererProps<TreeNode>): ReactElement {
  return (
    <div
      {...attrs}
      ref={innerRef as RefCallback<HTMLDivElement>}
      onFocus={(e) => e.stopPropagation()}
      onClick={(e) => {
        // Guard: clicks on row action controls (rename/info/hide/delete, etc.)
        // must not activate the row and switch the selected session.
        if (isRowActionTarget(e.target)) return
        node.handleClick(e)
      }}
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

function HiddenWorkspacesBar({
  workspaces,
  hiddenIds,
  onUnhide,
}: {
  workspaces: readonly WorkspaceNode[]
  hiddenIds: ReadonlySet<string>
  onUnhide(workspaceId: string): void
}): JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const restoredIds = new Set(workspaces.map((workspace) => workspace.workspaceId).filter((id): id is string => typeof id === 'string' && id.length > 0))
  const missingIds = Array.from(hiddenIds).filter((id) => !restoredIds.has(id))
  const hiddenCount = workspaces.length + missingIds.length
  return (
    <div className="flex-none border-t border-sidebar-border bg-sidebar px-1.5 py-1" data-testid="hidden-workspaces-bar">
      <button
        type="button"
        className="flex h-6 w-full min-w-0 items-center gap-1 rounded px-1 text-left text-[11px] text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-foreground"
        onClick={() => setOpen((value) => !value)}
        data-testid="hidden-workspaces-toggle"
        aria-expanded={open}
      >
        {open ? <ChevronDown className="h-3 w-3 flex-none" aria-hidden="true" /> : <ChevronRight className="h-3 w-3 flex-none" aria-hidden="true" />}
        <EyeOff className="h-3 w-3 flex-none" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">
          {t('explorer.hiddenWorkspaces', { count: hiddenCount })}
        </span>
      </button>
      {open ? (
        <div className="mt-0.5 space-y-px" data-testid="hidden-workspaces-list">
          {workspaces.map((workspace) => workspace.workspaceId === null ? null : (
            <HiddenWorkspaceItem
              key={workspace.workspaceId}
              workspaceId={workspace.workspaceId}
              label={workspace.name}
              onUnhide={onUnhide}
            />
          ))}
          {missingIds.map((workspaceId) => (
            <HiddenWorkspaceItem
              key={workspaceId}
              workspaceId={workspaceId}
              label={workspaceId}
              onUnhide={onUnhide}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}

function HiddenWorkspaceItem({
  workspaceId,
  label,
  onUnhide,
}: {
  workspaceId: string
  label: string
  onUnhide(workspaceId: string): void
}): JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="flex min-w-0 items-center gap-1 rounded px-1 py-0.5 text-[11px] text-sidebar-foreground/60 hover:bg-sidebar-accent/70 hover:text-sidebar-foreground" data-testid="hidden-workspace-item">
      <span className="min-w-0 flex-1 truncate" title={label}>{label}</span>
      <button
        type="button"
        className="flex-none rounded p-0.5 text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-foreground"
        onClick={() => onUnhide(workspaceId)}
        data-testid={`workspace-unhide-${workspaceId}`}
        title={t('explorer.unhideWorkspace')}
        aria-label={t('explorer.unhideWorkspaceAria', { workspaceId })}
      >
        <RotateCcw className="h-3 w-3" aria-hidden="true" />
      </button>
    </div>
  )
}

function HiddenSessionsBar({
  entries,
  onUnhide,
}: {
  entries: readonly { sessionId: string; label: string }[]
  onUnhide(sessionId: string): void
}): JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  return (
    <div className="flex-none border-t border-sidebar-border bg-sidebar px-1.5 py-1" data-testid="hidden-sessions-bar">
      <button
        type="button"
        className="flex h-6 w-full min-w-0 items-center gap-1 rounded px-1 text-left text-[11px] text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-foreground"
        onClick={() => setOpen((value) => !value)}
        data-testid="hidden-sessions-toggle"
        aria-expanded={open}
      >
        {open ? <ChevronDown className="h-3 w-3 flex-none" aria-hidden="true" /> : <ChevronRight className="h-3 w-3 flex-none" aria-hidden="true" />}
        <EyeOff className="h-3 w-3 flex-none" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">
          {t('explorer.hiddenSessions', { count: entries.length })}
        </span>
      </button>
      {open ? (
        <div className="mt-0.5 space-y-px" data-testid="hidden-sessions-list">
          {entries.map((entry) => (
            <HiddenSessionItem
              key={entry.sessionId}
              sessionId={entry.sessionId}
              label={entry.label}
              onUnhide={onUnhide}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}

function HiddenSessionItem({
  sessionId,
  label,
  onUnhide,
}: {
  sessionId: string
  label: string
  onUnhide(sessionId: string): void
}): JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="flex min-w-0 items-center gap-1 rounded px-1 py-0.5 text-[11px] text-sidebar-foreground/60 hover:bg-sidebar-accent/70 hover:text-sidebar-foreground" data-testid="hidden-session-item">
      <span className="min-w-0 flex-1 truncate" title={label}>{label}</span>
      <button
        type="button"
        className="flex-none rounded p-0.5 text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-foreground"
        onClick={() => onUnhide(sessionId)}
        data-testid={`session-unhide-${sessionId}`}
        title={t('explorer.unhideSession')}
        aria-label={t('explorer.unhideSessionAria', { sessionId })}
      >
        <RotateCcw className="h-3 w-3" aria-hidden="true" />
      </button>
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
  embedded,
}: {
  query: string
  onQueryChange(query: string): void
  onConnectWorkspace: () => void
  onCollapse?: () => void
  embedded: boolean
}): JSX.Element {
  const { t } = useTranslation()
  if (embedded) {
    return (
      <div className="flex h-9 flex-none items-center gap-1.5 border-b border-sidebar-border bg-sidebar px-2">
        <label className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded bg-background/70 px-2 text-xs ring-1 ring-border/50 focus-within:ring-primary/40">
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
        <Button
          variant="ghost"
          size="icon"
          onClick={onConnectWorkspace}
          data-testid="connect-workspace-button"
          title={t('explorer.connectWorkspace')}
          aria-label={t('explorer.connectWorkspace')}
          className="h-7 w-7 flex-none"
        >
          <Cable className="h-3.5 w-3.5" />
        </Button>
        {onCollapse ? (
          <Button
            variant="ghost"
            size="icon"
            onClick={onCollapse}
            data-testid="explorer-collapse-button"
            title={t('explorer.collapsePanel')}
            aria-label={t('explorer.collapsePanel')}
            className="h-7 w-7 flex-none text-muted-foreground hover:text-foreground"
          >
            <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
        ) : null}
      </div>
    )
  }
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
            data-testid="connect-workspace-button"
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
  onHideWorkspace,
  onHideSession,
  editingWorkspaceId,
  onStartWorkspaceEdit,
  onCancelWorkspaceEdit,
  onSubmitWorkspaceEdit,
  onNewSession,
  query,
  sessionRuntimeStore,
  onlineWorkspaceIds,
  fontSizePx,
  onPreviewAnchorChange,
  onPreviewLeave,
  onPointerActivateSession,
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
  onHideWorkspace(workspaceId: string): void
  onHideSession(sessionId: string): void
  editingWorkspaceId: string | null
  onStartWorkspaceEdit(workspace: WorkspaceNode): void
  onCancelWorkspaceEdit(): void
  onSubmitWorkspaceEdit(workspace: WorkspaceNode, label: string): void
  onNewSession(workspaceId?: string): void
  query: string
  sessionRuntimeStore: SessionRuntimeStore
  onlineWorkspaceIds: ReadonlySet<string>
  fontSizePx: number
  onPreviewAnchorChange(anchor: SessionPreviewAnchor | null): void
  onPreviewLeave(sessionId: string): void
  onPointerActivateSession(sessionId: string): void
}): JSX.Element {
  if (node.data.kind === 'workspace') {
    return (
        <WorkspaceRow
          node={node as NodeApi<WorkspaceNode>}
          style={style}
          dragHandle={dragHandle}
          onWorkspaceInfo={onWorkspaceInfo}
          onHideWorkspace={onHideWorkspace}
        editing={node.data.workspaceId !== null && editingWorkspaceId === node.data.workspaceId}
        onStartEdit={onStartWorkspaceEdit}
        onCancelEdit={onCancelWorkspaceEdit}
        onSubmitEdit={onSubmitWorkspaceEdit}
        onNewSession={onNewSession}
        query={query}
        fontSizePx={fontSizePx}
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
      onHideSession={onHideSession}
      query={query}
      runtimeStore={sessionRuntimeStore}
      renameDisabled={!isSessionWorkspaceOnline(node.data as SessionNode, onlineWorkspaceIds)}
      fontSizePx={fontSizePx}
      onPreviewAnchorChange={onPreviewAnchorChange}
      onPreviewLeave={onPreviewLeave}
      onPointerActivateSession={onPointerActivateSession}
    />
  )
}


function WorkspaceRow({
  node,
  style,
  dragHandle,
  onWorkspaceInfo,
  onHideWorkspace,
  editing,
  onStartEdit,
  onCancelEdit,
  onSubmitEdit,
  onNewSession,
  query,
  fontSizePx,
}: {
  node: NodeApi<WorkspaceNode>
  style: React.CSSProperties
  dragHandle?: (el: HTMLDivElement | null) => void
  onWorkspaceInfo?(workspaceId: string): void
  onHideWorkspace(workspaceId: string): void
  editing: boolean
  onStartEdit(workspace: WorkspaceNode): void
  onCancelEdit(): void
  onSubmitEdit(workspace: WorkspaceNode, label: string): void
  onNewSession(workspaceId?: string): void
  query: string
  fontSizePx: number
}): JSX.Element {
  const { t } = useTranslation()
  const w = node.data
  const workspaceLabel = w.workspaceId === null ? t('explorer.chats') : w.name
  const meta =
    w.workspaceId === null
      ? t('explorer.sessionsNoWorkspace')
      : w.online ? t('explorer.online') : t('explorer.offline')
  const metaBadgeCls = w.workspaceId === null
    ? 'bg-muted-foreground/45'
    : w.online
      ? 'bg-emerald-500'
      : 'bg-muted-foreground/45'
  const canShowInfo = w.workspaceId !== null && onWorkspaceInfo
  const canCreateSession = w.workspaceId !== null
  const canRename = w.workspaceId !== null
  const canReorder = w.workspaceId !== null
  const canHide = w.workspaceId !== null
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
        'group/ws relative min-w-0 cursor-pointer select-none rounded-lg px-3 py-2 transition-colors hover:bg-accent/40',
        WORKSPACE_ROW_GRID,
      )}
    >
      {canReorder ? (
        <div
          ref={dragHandle}
          className="group/drag absolute bottom-1 left-0 top-1 z-10 flex w-1.5 cursor-grab items-center justify-start active:cursor-grabbing"
          title={t('explorer.dragWorkspace')}
          aria-label={t('explorer.dragWorkspace')}
          data-testid="workspace-drag-handle"
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <GripVertical className="h-2.5 w-2.5 text-muted-foreground/70 opacity-0 transition-opacity group-hover/drag:opacity-100 group-active/drag:opacity-100" aria-hidden="true" />
        </div>
      ) : null}
      <div className={EXPLORER_RAIL_CELL}>
        {node.isOpen ? (
          <ChevronDown className="h-3.5 w-3.5 flex-none text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 flex-none text-muted-foreground" />
        )}
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
        <div className="flex min-w-0 items-center gap-2">
          <span className={cn('h-2 w-2 flex-none rounded-full', metaBadgeCls)} data-testid="workspace-status-badge" title={meta} aria-label={meta}><span className="sr-only">{meta}</span></span>
          <span
            className="min-w-0 truncate font-semibold leading-5 text-foreground"
            style={{ fontSize: fontSizePx }}
            title={canRename ? t('explorer.doubleClickRename') : undefined}
            onDoubleClick={(e) => {
              if (!canRename) return
              e.preventDefault()
              e.stopPropagation()
              onStartEdit(w)
            }}
          >
            <HighlightText text={workspaceLabel} query={query} />
          </span>
        </div>
      )}
      <div data-row-action className="ak-touch-reveal pointer-events-none flex min-w-0 items-center justify-end gap-0.5 opacity-0 transition-opacity group-hover/ws:pointer-events-auto group-hover/ws:opacity-100">
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
        {canHide ? (
          <button
            type="button"
            data-testid={`workspace-hide-${w.workspaceId}`}
            title={t('explorer.hideWorkspace')}
            aria-label={t('explorer.hideWorkspaceAria', { workspaceId: w.workspaceId })}
            className="flex-none rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={(e) => {
              e.stopPropagation()
              if (w.workspaceId !== null) onHideWorkspace(w.workspaceId)
            }}
          >
            <EyeOff className="h-3.5 w-3.5" />
          </button>
        ) : null}
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
  onHideSession,
  query,
  runtimeStore,
  renameDisabled,
  fontSizePx,
  onPreviewAnchorChange,
  onPreviewLeave,
  onPointerActivateSession,
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
  onHideSession(sessionId: string): void
  query: string
  runtimeStore: SessionRuntimeStore
  renameDisabled?: boolean
  fontSizePx: number
  onPreviewAnchorChange(anchor: SessionPreviewAnchor | null): void
  onPreviewLeave(sessionId: string): void
  onPointerActivateSession(sessionId: string): void
}): JSX.Element {
  const { t } = useTranslation()
  const s = node.data
  const selected = node.isSelected
  const runtime = useSessionRuntime(runtimeStore, s.sessionId)
  const status = runtime?.status ?? s.status
  const currentCwd = runtime?.currentCwd ?? s.currentCwd
  const lastActivityIso = runtime?.lastActivityIso ?? s.lastActivityIso
  const minuteNow = useMinuteClock()
  const [touchMenuPosition, setTouchMenuPosition] = useState<{ right: number; top: number } | null>(null)
  useEffect(() => {
    if (!touchMenuPosition) return
    const close = (): void => setTouchMenuPosition(null)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [touchMenuPosition])
  return (
    <div
      style={style}
      data-testid="session-row"
      data-session-id={s.sessionId}
      className={cn(
        'group relative min-w-0 cursor-pointer overflow-hidden rounded-xl px-3 py-1.5 transition-colors',
        'hover:bg-accent/50',
        selected && 'bg-accent shadow-[inset_0_0_0_1px_hsl(var(--border)/0.35)]',
        EXPLORER_ROW_GRID,
      )}
      onClick={() => {
        // Keep a click fallback in addition to the eager pointerdown path. The
        // virtualized Tree may commit a controlled selection update between
        // pointerdown and its own onActivate callback; a row-local click keeps
        // the user action authoritative without depending on Tree internals.
        if (!editing) onPointerActivateSession(s.sessionId)
      }}
      onMouseDown={(e) => {
        // Suppress the second `click` in a native double-click sequence so it
        // doesn't reach the react-arborist row handler and re-activate the
        // session (which unmounts our rename input mid-edit).
        //
        // NOTE: do NOT tear the hover preview down here. Mutating Explorer
        // state during mousedown re-renders the react-arborist tree between
        // mousedown and click and swallows the activation, so the session only
        // loads on the *second* click. Preview teardown is handled by an effect
        // that watches the selected session id instead (see ExplorerImpl).
        if (e.detail >= 2) e.preventDefault()
      }}
      onPointerDown={(e) => {
        if (e.button > 0 || editing) return
        onPointerActivateSession(s.sessionId)
      }}
      onDoubleClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        if (renameDisabled) return
        onStartEdit(s)
      }}
      onPointerEnter={(e) => {
        if (selected || editing || e.pointerType === 'touch' || !canUseHoverPreview()) return
        onPreviewAnchorChange({
          sessionId: s.sessionId,
          label: s.label,
          rect: e.currentTarget.getBoundingClientRect(),
        })
      }}
      onPointerLeave={() => {
        onPreviewLeave(s.sessionId)
      }}
    >
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
            className="flex h-4 w-3.5 flex-none cursor-grab items-center justify-center text-muted-foreground/45 opacity-70 active:cursor-grabbing group-hover:text-muted-foreground/80"
            title={t('explorer.dragSession')}
            aria-label={t('explorer.dragSession')}
            data-testid="session-drag-handle"
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            <GripVertical className="h-3 w-3" aria-hidden="true" />
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
            'min-w-0 truncate font-medium leading-5',
            selected ? 'text-foreground' : 'text-foreground/90',
          )}
          style={{ fontSize: fontSizePx }}
          title={currentCwd || t('explorer.doubleClickRename')}
        >
          <HighlightText text={s.label} query={query} />
        </div>
      )}
      {editing ? null : (
        <div data-row-action className="ak-session-row-actions ak-touch-reveal pointer-events-none col-start-4 row-start-1 flex min-w-0 items-center justify-end gap-0.5 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100">
          <Button
            variant="ghost"
            size="icon"
            data-testid="session-more-button"
            title={t('common.more')}
            aria-label={t('common.more')}
            aria-expanded={touchMenuPosition !== null}
            className="ak-session-more-button hidden h-9 w-9 rounded-md text-muted-foreground hover:bg-accent-foreground/10 hover:text-foreground"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              const rect = e.currentTarget.getBoundingClientRect()
              setTouchMenuPosition((current) => current ? null : {
                right: Math.max(8, window.innerWidth - rect.right),
                top: Math.min(window.innerHeight - 192, rect.bottom + 4),
              })
            }}
          >
            <MoreHorizontal className="h-4 w-4" />
          </Button>
          {touchMenuPosition && typeof document !== 'undefined' ? createPortal(
            <>
              <button type="button" className="fixed inset-0 z-40 cursor-default" aria-label={t('common.close')} onClick={(e) => { e.stopPropagation(); setTouchMenuPosition(null) }} />
              <div
                className="fixed z-50 min-w-40 overflow-hidden rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-xl"
                style={{ right: touchMenuPosition.right, top: touchMenuPosition.top }}
                data-testid="session-action-menu"
                onClick={(e) => e.stopPropagation()}
              >
                <button type="button" className="flex min-h-10 w-full items-center gap-2 rounded px-3 text-left text-sm hover:bg-accent" onClick={() => { setTouchMenuPosition(null); if (!renameDisabled) onStartEdit(s) }}><Pencil className="h-4 w-4" />{t('explorer.renameSession')}</button>
                {onOpenSessionInfo ? <button type="button" className="flex min-h-10 w-full items-center gap-2 rounded px-3 text-left text-sm hover:bg-accent" onClick={() => { setTouchMenuPosition(null); onOpenSessionInfo(s.sessionId) }}><Info className="h-4 w-4" />{t('explorer.sessionInfoTitle')}</button> : null}
                <button type="button" className="flex min-h-10 w-full items-center gap-2 rounded px-3 text-left text-sm hover:bg-accent" onClick={() => { setTouchMenuPosition(null); onHideSession(s.sessionId) }}><EyeOff className="h-4 w-4" />{t('explorer.hideSession')}</button>
                <button type="button" className="flex min-h-10 w-full items-center gap-2 rounded px-3 text-left text-sm text-destructive hover:bg-destructive/10" onClick={() => { setTouchMenuPosition(null); onDeleteRequest(s) }}><Trash2 className="h-4 w-4" />{t('explorer.deleteSessionTitle')}</button>
              </div>
            </>,
            document.body,
          ) : null}
          <Button
            variant="ghost"
            size="icon"
            onPointerDown={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              if (renameDisabled) return
              onStartEdit(s)
            }}
            onDoubleClick={(e) => e.stopPropagation()}
            data-testid="session-rename-button"
            title={t('explorer.renameSession')}
            aria-label={t('explorer.renameSessionAria', { sessionId: s.sessionId })}
            disabled={renameDisabled}
            className="h-9 w-9 rounded-md text-muted-foreground hover:bg-accent-foreground/10 hover:text-foreground sm:h-7 sm:w-7"
          >
            <Pencil className="h-3.5 w-3.5" strokeWidth={2.2} />
          </Button>
          {onOpenSessionInfo ? (
            <Button
              variant="ghost"
              size="icon"
              onPointerDown={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation()
                onOpenSessionInfo(s.sessionId)
              }}
              onDoubleClick={(e) => e.stopPropagation()}
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
            onPointerDown={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              onHideSession(s.sessionId)
            }}
            onDoubleClick={(e) => e.stopPropagation()}
            data-testid="session-hide-button"
            title={t('explorer.hideSession')}
            aria-label={t('explorer.hideSessionAria', { sessionId: s.sessionId })}
            className="h-9 w-9 rounded-md text-muted-foreground hover:bg-accent-foreground/10 hover:text-foreground sm:h-7 sm:w-7"
          >
            <EyeOff className="h-3.5 w-3.5" strokeWidth={2.2} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onPointerDown={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              onDeleteRequest(s)
            }}
            onDoubleClick={(e) => e.stopPropagation()}
            data-testid="session-delete-button"
            title={t('explorer.deleteSessionTitle')}
            aria-label={t('explorer.deleteSessionAria', { sessionId: s.sessionId })}
            className="h-9 w-9 rounded-md text-muted-foreground hover:bg-destructive hover:text-destructive-foreground sm:h-7 sm:w-7"
          >
            <Trash2 className="h-3.5 w-3.5" strokeWidth={2.2} />
          </Button>
        </div>
      )}
      <div className="ak-touch-hide pointer-events-none col-start-4 row-start-1 flex flex-none items-center justify-end whitespace-nowrap text-[11px] leading-4 text-muted-foreground group-hover:opacity-0">
        <span className="inline-flex flex-none items-center gap-1 whitespace-nowrap tabular-nums opacity-70">
          <Clock3 className="h-3 w-3 opacity-70" aria-hidden="true" />
          {formatWhen(lastActivityIso, t, minuteNow * 60_000)}
        </span>
      </div>
    </div>
  )
}

export const SessionStatusIndicator = memo(function SessionStatusIndicator({
  status,
  selected = false,
}: {
  status: SessionActivityStatus | undefined
  selected?: boolean
}): JSX.Element {
  const { t } = useTranslation()
  const label = statusIndicatorLabel(status, t)
  if (selected) return <ToolbarSessionStatus status={status} label={label} />
  const base = 'inline-flex h-3.5 w-3.5 flex-none items-center justify-center'
  if (status === 'loading' || status === 'thinking' || status === 'executing_tools') {
    return (
      <span
        className={base}
        data-testid="session-status-indicator"
        data-status={status}
        aria-label={label}
        title={label}
      >
        <span className="ak-session-status-spinner" data-testid="session-status-spinner" aria-hidden="true">
          <LoaderCircle
            className="h-3 w-3 text-sky-500 dark:text-sky-400"
            strokeWidth={2.4}
          />
        </span>
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
})

function ToolbarSessionStatus({ status, label }: { status: SessionActivityStatus | undefined; label: string }): JSX.Element {
  const running = status === 'thinking' || status === 'executing_tools' || status === 'loading'
  const tone = status === 'error'
    ? 'border-rose-500/25 bg-rose-500/10 text-rose-700 dark:text-rose-300'
    : status === 'awaiting_approval'
      ? 'border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300'
      : status === 'executing_tools'
        ? 'border-violet-500/25 bg-violet-500/10 text-violet-700 dark:text-violet-300'
        : running
          ? 'border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-300'
          : status === 'done'
            ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
            : 'border-border/70 bg-muted/45 text-muted-foreground'
  const Icon = status === 'executing_tools'
    ? Wrench
    : status === 'awaiting_approval'
      ? TriangleAlert
      : status === 'error'
        ? AlertCircle
        : running
          ? LoaderCircle
          : Circle
  return (
    <span className={cn('inline-flex h-6 flex-none items-center gap-1.5 rounded-md border px-2 text-[10px] font-medium', tone)} data-testid="session-status-indicator" data-status={status ?? 'unknown'} aria-label={label}>
      <span className={cn('inline-flex', running && 'ak-session-status-spinner')} data-testid={running ? 'session-status-spinner' : undefined} aria-hidden="true">
        <Icon className="h-3 w-3" strokeWidth={2.3} />
      </span>
      <span>{label}</span>
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

function formatWhen(iso: string, t: ReturnType<typeof useTranslation>['t'], now = Date.now()): string {
  try {
    const d = new Date(iso)
    const delta = now - d.getTime()
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
  const submitted = useRef(false)
  const submit = (): void => {
    if (submitted.current) return
    submitted.current = true
    onSubmit(value)
  }
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
          submit()
        } else if (e.key === 'Escape') {
          e.preventDefault()
          submitted.current = true
          onCancel()
        }
      }}
      onBlur={submit}
      data-testid={testId}
      aria-label={ariaLabel ?? t('explorer.renameSession')}
      spellCheck={false}
      className="min-w-0 flex-1 rounded-sm bg-background px-1.5 py-0.5 text-[13px] font-medium text-foreground shadow-inner outline-none ring-1 ring-primary/40 focus:ring-2"
    />
  )
}









function areExplorerPropsEqual(prev: Props, next: Props): boolean {
  return prev.loading === next.loading &&
    prev.selectedSessionId === next.selectedSessionId &&
    prev.embeddedHeader === next.embeddedHeader &&
    prev.fontSizePx === next.fontSizePx &&
    prev.onSelect === next.onSelect &&
    prev.onClearSelection === next.onClearSelection &&
    prev.onNewSession === next.onNewSession &&
    prev.onConnectWorkspace === next.onConnectWorkspace &&
    prev.onDelete === next.onDelete &&
    prev.onRename === next.onRename &&
    prev.onRenameWorkspace === next.onRenameWorkspace &&
    prev.onOpenSessionInfo === next.onOpenSessionInfo &&
    prev.onWorkspaceInfo === next.onWorkspaceInfo &&
    prev.onCollapse === next.onCollapse &&
    prev.previewStore === next.previewStore &&
    prev.getCachedSessionView === next.getCachedSessionView &&
    prev.subscribeCachedSessionView === next.subscribeCachedSessionView &&
    sameExecutorListForExplorer(prev.executors, next.executors) &&
    sameSessionListForExplorer(prev.sessions, next.sessions) &&
    sameSessionStatusMap(prev.sessionStatuses, next.sessionStatuses)
}



/** Collapse running session-summary statuses so tool-step flips don't churn. */


function canUseHoverPreview(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(hover: hover) and (pointer: fine)').matches
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
