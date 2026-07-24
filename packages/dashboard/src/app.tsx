import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Archive, BarChart3, Boxes, ChevronDown, ChevronRight, Eraser, Files, FolderGit2, FolderOpen, Info, ListChecks, Loader2, Menu, Moon, PanelLeftClose, PanelRight, PanelRightClose, Plus, Settings, ShieldCheck, Sparkles, Square, Sun, Workflow, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Toaster } from 'sonner'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { shouldCompactContext } from '@agent-kernel/shared/context-policy'

import type { MessageContent } from '@agent-kernel/kernel'

import type {
  ConsolidateMemoryResult,
  EventAppendedEvent,
  FileContentsResult,
  FileListEntry,
  FileListResult,
  ModelInfo,
  OverflowContentsResult,
  QueuedMessagePreview,
  ServerModelsPayload,
  SessionErrorEvent,
  SessionSummary,
  ToolCardMode,
} from '@agent-kernel/shared'
import { deriveSessionState, isSessionResting, isSessionRunning } from '@agent-kernel/shared'

import { Button } from './components/ui/button.js'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from './components/ui/dialog.js'
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from './components/ui/resizable.js'
import { InlineStatusRow, CompactFeedbackRow, type CompactStatus } from './features/chat/InlineStatusRow.js'
import { ApprovalCard } from './features/chat/ApprovalCard.js'
import { BackgroundShellsButton } from './features/chat/BackgroundTerminalPanel.js'
import { ChatPanel, type WorkspaceFileTarget } from './features/chat/ChatPanel.js'
import { APPROVAL_MODES, Composer } from './features/chat/Composer.js'
import { ComposerFlipContainer } from './features/chat/ComposerFlipContainer.js'
import { ContextPressureBanner } from './features/chat/ContextPressureBanner.js'
import { BannerStack, BannerSlot } from './features/chat/BannerStack.js'
import { OfflineBanner, PwaLifecycleHost, PwaUpdateGlobalBanner } from './features/chat/PwaBanners.js'
import { CommandPalette, type CommandPaletteItem } from './features/command/CommandPalette.js'
import { SessionMetadataDialog } from './features/chat/SessionMetadataDialog.js'
import { ChangeCwdDialog } from './features/chat/ChangeCwdDialog.js'
import { ConnectWorkspaceDialog } from './features/explorer/ConnectWorkspaceDialog.js'
import { WorkspaceMetadataDialog } from './features/explorer/WorkspaceMetadataDialog.js'
import { TasksButton } from './features/chat/TasksButton.js'
import { tasksFromTimeline } from './features/chat/tasks-from-timeline.js'
import { Explorer, SessionStatusIndicator, type SessionActivityStatus } from './features/explorer/Explorer.js'
import { WorkspacePicker } from './features/explorer/WorkspacePicker.js'
import { InspectorPanel } from './features/inspector/InspectorPanel.js'
import { AppShellNav } from './app-shell/AppShellNav.js'
import { useAppSection, type AppSection } from './app-shell/section.js'
// Page-level lazy loading: the app boots into the "agent" section by default,
// so the five other top-level pages plus SettingsDialog are pulled in only
// when their tab (or the settings icon) is opened. Each import() becomes its
// own async chunk (see vite build output) and drops the initial JS payload
// substantially. Fallback is a bare blank div so we don't flash a skeleton
// while the chunk arrives on a fast connection.
const BenchmarksPage = lazy(() => import('./features/benchmarks/BenchmarksPage.js').then((m) => ({ default: m.BenchmarksPage })))
const OperationsPage = lazy(() => import('./features/operations/OperationsPage.js').then((m) => ({ default: m.OperationsPage })))
const ArtifactsPage = lazy(() => import('./features/artifacts-browser/ArtifactsPage.js').then((m) => ({ default: m.ArtifactsPage })))
const DocsPage = lazy(() => import('./features/docs/DocsPage.js').then((m) => ({ default: m.DocsPage })))
const PipelinePage = lazy(() => import('./features/pipeline/PipelinePage.js').then((m) => ({ default: m.PipelinePage })))
const SettingsDialog = lazy(() => import('./features/settings/SettingsDialog.js').then((m) => ({ default: m.SettingsDialog })))
const SessionFilesPanel = lazy(() => import('./features/session-files/SessionFilesPanel.js').then((m) => ({ default: m.SessionFilesPanel })))
const WorkspaceFileViewDialog = lazy(() => import('./features/session-files/SessionFilesPanel.js').then((m) => ({ default: m.WorkspaceFileViewDialog })))
const SourceControlPanel = lazy(() => import('./features/source-control/SourceControlPanel.js').then((m) => ({ default: m.SourceControlPanel })))
import {
  cancelSession,
  clearSession,
  createSessionWithAck,
  deleteQueuedMessage,
  deleteSession,
  reorderQueuedMessage,
  renameSession,
  renameWorkspace,
  respondApproval,
  setSessionApprovalMode,
  updateSessionPreferences,
  updateQueuedMessage,
  useControlPlane,
  useDashboardControlSocket,
  useSession,
} from './session.js'
import { backgroundTerminalTasks } from './background-terminal.js'
import { resolveHostEndpoint, type ResolvedHostEndpoint } from './host-endpoint.js'
import { resolveWorkspaceExplorerBinding } from './workspace-explorer-binding.js'
import { cn } from './lib/utils.js'
import { withViewTransition } from './lib/viewTransition.js'
import { workspaceReadBinary } from './lib/workspace-exec.js'
import { reconcilePendingUserMessages, visibleMessages, visibleTranscript } from './transcript.js'
import type { PendingUserTranscriptMessage } from './transcript.js'
import type { DashboardSocket, TimelineEntry } from './session.js'
import {
  DEFAULT_LIVE_TOOL_ACTIVITY_TAIL_COUNT,
  DEFAULT_CHAT_CONTENT_WIDTH,
  DEFAULT_CHAT_FONT_SIZE,
  DEFAULT_CHAT_LINE_HEIGHT,
  DEFAULT_CHAT_MATH_SCALE,
  DEFAULT_CHAT_SIDE_SPACE,
  DEFAULT_FILE_EXPLORER_FONT_SIZE,
  DEFAULT_SESSION_EXPLORER_FONT_SIZE,
  PREF_CHAT_CONTENT_WIDTH,
  PREF_CHAT_FONT_SIZE,
  PREF_CHAT_LINE_HEIGHT,
  PREF_CHAT_MATH_SCALE,
  PREF_CHAT_SIDE_SPACE,
  PREF_APP_BADGE_ENABLED,
  PREF_DURABLE_SESSION_CACHE_ENABLED,
  PREF_EXPLORER_OPEN,
  PREF_FILE_EXPLORER_FONT_SIZE,
  PREF_INSPECTOR_OPEN,
  PREF_LIVE_TOOL_ACTIVITY_TAIL_COUNT,
  PREF_MODEL,
  PREF_SESSION_EXPLORER_SECTION_OPEN,
  PREF_SESSION_EXPLORER_FONT_SIZE,
  PREF_TOPBAR_OPEN,
  PREF_KEEP_SCREEN_AWAKE,
  useBooleanPref,
  useNumberPref,
} from './lib/prefs.js'
import {
  DEFAULT_SESSION_VIEW_CACHE_MAX_MB,
  PREF_SESSION_VIEW_CACHE_MAX_MB,
  sessionViewCacheMaxBytesFromMb,
} from './session-view-cache.js'
import { createDurableSessionViewCache, sessionCacheNamespace } from './durable-session-cache.js'
import { PROTOCOL_VERSION } from '@agent-kernel/shared'
import { useInterventionDesktopNotifications } from './lib/desktop-notifications.js'
import { useRunningTitleIndicator } from './lib/running-title.js'
import { useTheme, type Theme } from './lib/theme.js'
import { useVisualViewportHeight } from './lib/useVisualViewportHeight.js'
import { deriveAppBadgeCount, updateAppBadge } from './lib/app-badge.js'
import { useScreenWakeLock } from './lib/wake-lock.js'
import { useDeferredDispose } from './lib/use-deferred-dispose.js'
import {
  useBackgroundShellToasts,
  useInactiveSessionSummaryToasts,
  useSessionToasts,
  useSubAgentToasts,
} from './session-toasts.js'

type LowerExplorerTab = 'files' | 'git'
type MobileExplorerTab = 'sessions' | 'files' | 'git'

const SESSION_EXPLORER_FONT_SIZE_PX = [11, 12, 13, 14, 15] as const
const FILE_EXPLORER_FONT_SIZE_PX = [10, 11, 12, 13, 14] as const
const COMPACT_WATCHDOG_MS = 75_000
const SIMPLE_CHAT_TOOLS: readonly string[] = ['todowrite', 'agent', 'websearch', 'memory']

/**
 * Fetch the host's advertised models on mount. The host reads them from
 * `~/.claude/settings.json` and `~/.codex/config.toml`; hardcoding a list here
 * would drift away from what the host actually accepts.
 */
function useModels(): { models: readonly ModelInfo[]; defaultModel: string; reload(): void } {
  const client = useQueryClient()
  const query = useQuery({
    queryKey: ['models'],
    queryFn: async (): Promise<ServerModelsPayload | null> => {
      const r = await fetch('/models', { cache: 'no-store' })
      if (!r.ok) return null
      return (await r.json()) as ServerModelsPayload
    },
    staleTime: 60_000,
  })
  return {
    models: query.data?.models ?? [],
    defaultModel: query.data?.defaultModel ?? '',
    reload: () => {
      void client.invalidateQueries({ queryKey: ['models'] })
    },
  }
}

function modelKey(model: ModelInfo | null | undefined): string {
  return model?.ref ?? model?.id ?? ''
}

function resolveModelKey(models: readonly ModelInfo[], value: string | null | undefined): string {
  if (!value) return ''
  const exact = models.find((model) => modelKey(model) === value)
  if (exact) return modelKey(exact)
  const byId = models.filter((model) => model.id === value)
  return byId.length === 1 ? modelKey(byId[0]) : ''
}

function useMinWidth(px: number): boolean {
  const query = `(min-width: ${px}px)`
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const media = window.matchMedia(query)
    const onChange = (): void => setMatches(media.matches)
    onChange()
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [query])
  return matches
}

function useIsMobile(): boolean {
  return !useMinWidth(640)
}

export function App(): JSX.Element {
  const { t } = useTranslation()
  const [config, setConfig] = useState(() => readInitialConfig())
  const [highlightIndex, setHighlightIndex] = useState<number | null>(null)
  const [explorerOpen, setExplorerOpen] = useBooleanPref(PREF_EXPLORER_OPEN, true)
  const [sessionExplorerSectionOpen, setSessionExplorerSectionOpen] = useBooleanPref(PREF_SESSION_EXPLORER_SECTION_OPEN, true)
  const [lowerExplorerCollapsed, setLowerExplorerCollapsed] = useState(false)
  const [inspectorOpen, setInspectorOpen] = useBooleanPref(PREF_INSPECTOR_OPEN, true)
  const [topbarOpen, setTopbarOpen] = useBooleanPref(PREF_TOPBAR_OPEN, true)
  const [pendingWorkspacePick, setPendingWorkspacePick] = useState<
    { sessionId: string; workspaceId?: string } | null
  >(null)
  const [workspacePickError, setWorkspacePickError] = useState<string | null>(null)
  const [workspacePickSubmitting, setWorkspacePickSubmitting] = useState(false)
  const [connectWorkspaceOpen, setConnectWorkspaceOpen] = useState(false)
  const [explorerDrawerOpen, setExplorerDrawerOpen] = useState(false)
  const [lowerExplorerTab, setLowerExplorerTab] = useState<LowerExplorerTab>('files')
  const [mobileExplorerTab, setMobileExplorerTab] = useState<MobileExplorerTab>('sessions')
  const [inspectorDrawerOpen, setInspectorDrawerOpen] = useState(false)
  const [cwdDialogOpen, setCwdDialogOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [metadataOpen, setMetadataOpen] = useState(false)
  const [metadataSessionId, setMetadataSessionId] = useState<string | null>(null)
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false)
  const [workspaceInfoId, setWorkspaceInfoId] = useState<string | null>(null)
  const [workspaceFileViewTarget, setWorkspaceFileViewTarget] = useState<WorkspaceFileTarget | null>(null)
  const [compactStatus, setCompactStatus] = useState<CompactStatus>({ kind: 'idle' })
  const [awaitingAck, setAwaitingAck] = useState(false)
  const [forkingFromSeq, setForkingFromSeq] = useState<number | null>(null)
  const [pendingUserMessages, setPendingUserMessages] = useState<readonly PendingUserTranscriptMessage[]>([])
  const [optimisticQueuedMessages, setOptimisticQueuedMessages] = useState<readonly QueuedMessagePreview[]>([])
  const compactResetTimer = useRef<number | null>(null)
  const compactStartSeq = useRef<number | null>(null)
  const inferredCompactSeq = useRef<number | null>(null)
  const suppressNextAutoSessionSelection = useRef(false)
  const suppressNextWaitingNotification = useRef(false)
  const [themePreference, toggleTheme, , effectiveTheme] = useTheme()
  // Drives the app shell, drawers, and dialogs from one visible-viewport
  // height source instead of mixing 100dvh with ad hoc safe-area fixes.
  useVisualViewportHeight()
  const [liveToolActivityTailCount] = useNumberPref(
    PREF_LIVE_TOOL_ACTIVITY_TAIL_COUNT,
    DEFAULT_LIVE_TOOL_ACTIVITY_TAIL_COUNT,
    { min: 0, max: 10 },
  )
  const [chatFontSize] = useNumberPref(PREF_CHAT_FONT_SIZE, DEFAULT_CHAT_FONT_SIZE, { min: 0, max: 6 })
  const [sessionExplorerFontSize] = useNumberPref(PREF_SESSION_EXPLORER_FONT_SIZE, DEFAULT_SESSION_EXPLORER_FONT_SIZE, { min: 0, max: SESSION_EXPLORER_FONT_SIZE_PX.length - 1 })
  const [fileExplorerFontSize] = useNumberPref(PREF_FILE_EXPLORER_FONT_SIZE, DEFAULT_FILE_EXPLORER_FONT_SIZE, { min: 0, max: FILE_EXPLORER_FONT_SIZE_PX.length - 1 })
  const [chatContentWidth] = useNumberPref(PREF_CHAT_CONTENT_WIDTH, DEFAULT_CHAT_CONTENT_WIDTH, { min: 0, max: 2 })
  const [chatSideSpace] = useNumberPref(PREF_CHAT_SIDE_SPACE, DEFAULT_CHAT_SIDE_SPACE, { min: 0, max: 2 })
  const [chatLineHeight] = useNumberPref(PREF_CHAT_LINE_HEIGHT, DEFAULT_CHAT_LINE_HEIGHT, { min: 0, max: 2 })
  const [chatMathScale] = useNumberPref(PREF_CHAT_MATH_SCALE, DEFAULT_CHAT_MATH_SCALE, { min: 0, max: 4 })
  const [sessionViewCacheMaxMb] = useNumberPref(PREF_SESSION_VIEW_CACHE_MAX_MB, DEFAULT_SESSION_VIEW_CACHE_MAX_MB, { min: 0, max: 4096 })
  const [durableSessionCacheEnabled] = useBooleanPref(PREF_DURABLE_SESSION_CACHE_ENABLED, true)
  const [appBadgeEnabled] = useBooleanPref(PREF_APP_BADGE_ENABLED, true)
  const [keepScreenAwake] = useBooleanPref(PREF_KEEP_SCREEN_AWAKE, false)
  const sessionExplorerFontSizePx = SESSION_EXPLORER_FONT_SIZE_PX[sessionExplorerFontSize] ?? SESSION_EXPLORER_FONT_SIZE_PX[DEFAULT_SESSION_EXPLORER_FONT_SIZE]
  const fileExplorerFontSizePx = FILE_EXPLORER_FONT_SIZE_PX[fileExplorerFontSize] ?? FILE_EXPLORER_FONT_SIZE_PX[DEFAULT_FILE_EXPLORER_FONT_SIZE]
  const cachedSessionIdsRef = useRef<ReadonlySet<string>>(new Set())
  const [hostEndpoint, setHostEndpoint] = useState<ResolvedHostEndpoint>(() => resolveHostEndpoint())
  const cacheNamespace = sessionCacheNamespace(hostEndpoint.url, PROTOCOL_VERSION)
  const sessionViewCache = useMemo(() => createDurableSessionViewCache({
    namespace: cacheNamespace,
    maxBytes: sessionViewCacheMaxBytesFromMb(sessionViewCacheMaxMb),
    enabled: durableSessionCacheEnabled,
  }), [cacheNamespace])
  useEffect(() => {
    sessionViewCache.setMaxBytes(sessionViewCacheMaxBytesFromMb(sessionViewCacheMaxMb))
    sessionViewCache.setEnabled(durableSessionCacheEnabled)
  }, [durableSessionCacheEnabled, sessionViewCache, sessionViewCacheMaxMb])
  useDeferredDispose(sessionViewCache, (cache) => cache.close())
  const getCachedSessionView = useCallback(
    (sessionId: string) => sessionViewCache.get(sessionId),
    [sessionViewCache],
  )
  const wideLayout = useMinWidth(1024)
  const isMobile = useIsMobile()
  const { models, defaultModel, reload: reloadModels } = useModels()
  const [storedModel, setStoredModel] = useState<string | null>(() => {
    try {
      return localStorage.getItem(PREF_MODEL)
    } catch {
      return null
    }
  })
  // Prefer the user's last choice, but only if it's still a valid option
  // (host's `/models` is authoritative). Otherwise fall back to host default,
  // or first advertised model.
  const preferredModel = useMemo<string>(() => {
    const stored = resolveModelKey(models, storedModel)
    if (stored) return stored
    const defaultKey = resolveModelKey(models, defaultModel)
    if (defaultKey) return defaultKey
    return modelKey(models[0])
  }, [storedModel, models, defaultModel])
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLocaleLowerCase() !== 'k') return
      // Skip when the user is typing in an editable element. Cmd+K is a
      // browser-provided shortcut in some contexts (search bar) and we don't
      // want to hijack it when the composer already owns focus.
      const target = event.target as HTMLElement | null
      if (target && isEditable(target) && !commandPaletteOpen) return
      event.preventDefault()
      setCommandPaletteOpen((open) => !open)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [commandPaletteOpen])

  useEffect(() => {
    if (!config.explicit) {
      if (window.location.search !== '') {
        window.history.replaceState(null, '', window.location.pathname)
      }
      return
    }
    if (!config.sessionId) {
      if (window.location.search !== '') {
        window.history.replaceState(null, '', window.location.pathname)
      }
      return
    }
    // Only sessionId belongs in the URL. The bootstrap token stays in
    // memory (see readInitialConfig) so it can't leak via history/referrer.
    const next = `?${new URLSearchParams({ sessionId: config.sessionId }).toString()}`
    if (window.location.search !== next) {
      window.history.replaceState(null, '', next)
    }
  }, [config])

  useEffect(() => {
    const refresh = () => setHostEndpoint(resolveHostEndpoint())
    window.addEventListener('agent-kernel:host-endpoint-changed', refresh)
    window.addEventListener('storage', refresh)
    return () => {
      window.removeEventListener('agent-kernel:host-endpoint-changed', refresh)
      window.removeEventListener('storage', refresh)
    }
  }, [])

  const session = useSession({
    host: hostEndpoint.url,
    sessionId: config.sessionId,
    cache: sessionViewCache,
    ...(config.token !== undefined ? { token: config.token } : {}),
    onForked: (p) => {
      setForkingFromSeq(null)
      setConfig((prev) => ({ ...prev, sessionId: p.sessionId, explicit: true }))
    },
  })
  const controlSocket = useDashboardControlSocket(hostEndpoint.url, config.token)
  const selectedModelKey = useMemo(
    () => resolveModelKey(models, session.selectedModel) || session.selectedModel || '',
    [models, session.selectedModel],
  )
  const composerModel = selectedModelKey || resolveModelKey(models, defaultModel) || defaultModel || modelKey(models[0])
  const control = useControlPlane(controlSocket)
  const controlSessionsRef = useRef<readonly SessionSummary[]>([])
  controlSessionsRef.current = control.sessions
  const currentSession = control.sessions.find(
    (s) => s.sessionId === config.sessionId,
  )
  const activeSessionId = currentSession?.sessionId ?? null
  const activeSessionRunning = isSessionRunning({
    status: session.state?.status ?? currentSession?.status,
    pendingCalls: session.state?.pendingCalls,
    streamingActive: session.streamingText.length > 0,
    awaitingAck,
    compactRunning: compactStatus.kind === 'running',
  })
  useScreenWakeLock(keepScreenAwake && activeSessionRunning)

  useEffect(() => {
    const count = appBadgeEnabled ? deriveAppBadgeCount({
      sessions: control.sessions,
      activePendingApprovals: session.pendingApprovals.length,
      activeSessionHasError: Boolean(session.lastError),
      disconnected: activeSessionId !== null && (session.status === 'disconnected' || session.status === 'error'),
    }) : 0
    void updateAppBadge(count)
  }, [activeSessionId, appBadgeEnabled, control.sessions, session.lastError, session.pendingApprovals.length, session.status])
  useEffect(() => {
    const clearBadge = (): void => { void updateAppBadge(0) }
    window.addEventListener('pagehide', clearBadge)
    return () => {
      window.removeEventListener('pagehide', clearBadge)
      clearBadge()
    }
  }, [])

  useEffect(() => {
    const flushCache = (): void => { void sessionViewCache.flush() }
    window.addEventListener('pagehide', flushCache)
    return () => window.removeEventListener('pagehide', flushCache)
  }, [sessionViewCache])

  useEffect(() => {
    if (!control.sessionsLoaded) return
    const nextIds = new Set(control.sessions.map((s) => s.sessionId))
    for (const removedId of removedSessionIds(cachedSessionIdsRef.current, nextIds)) sessionViewCache.delete(removedId)
    cachedSessionIdsRef.current = nextIds
  }, [control.sessions, control.sessionsLoaded, sessionViewCache])

  useEffect(() => {
    const socket = session.socket
    if (!socket) return
    const onEventAppended = (payload: EventAppendedEvent): void => {
      if (payload.event.kind === 'clear') sessionViewCache.delete(payload.sessionId)
    }
    socket.on('event:appended', onEventAppended)
    return () => {
      socket.off('event:appended', onEventAppended)
    }
  }, [session.socket, sessionViewCache])

  useEffect(() => {
    setCompactStatus({ kind: 'idle' })
    compactStartSeq.current = null
    inferredCompactSeq.current = null
    setAwaitingAck(false)
    setPendingUserMessages([])
    setOptimisticQueuedMessages([])
    setForkingFromSeq(null)
    suppressNextWaitingNotification.current = false
  }, [config.sessionId])

  useEffect(() => {
    if (forkingFromSeq === null) return
    const t = window.setTimeout(() => setForkingFromSeq(null), 8000)
    return () => window.clearTimeout(t)
  }, [forkingFromSeq])

  useEffect(() => {
    if (!awaitingAck) return
    const status = session.state?.status
    if ((status && status !== 'idle') || session.streamingText.length > 0) {
      setAwaitingAck(false)
    }
  }, [awaitingAck, session.state, session.streamingText])

  useEffect(() => {
    setPendingUserMessages((prev) => reconcilePendingUserMessages(
      prev,
      session.timeline,
      session.queuedMessages,
      session.state?.status,
      session.streamingText,
    ))
  }, [session.timeline, session.queuedMessages, session.state?.status, session.streamingText])

  useEffect(() => {
    setOptimisticQueuedMessages((prev) => reconcileOptimisticQueuedMessages(prev, session.queuedMessages, session.timeline))
  }, [session.queuedMessages, session.timeline])

  const scheduleCompactIdle = (ms: number): void => {
    if (compactResetTimer.current !== null) {
      window.clearTimeout(compactResetTimer.current)
    }
    compactResetTimer.current = window.setTimeout(() => {
      setCompactStatus({ kind: 'idle' })
      compactResetTimer.current = null
    }, ms)
  }

  useEffect(() => {
    if (compactStartSeq.current === null) return
    const last = session.timeline[session.timeline.length - 1]
    if (!last || !isCompactTerminalEvent(last.event.kind)) return
    if (last.seq <= compactStartSeq.current) return
    compactStartSeq.current = null
    inferredCompactSeq.current = null
    setCompactStatus(isCompactionSuccess(last.event) ? { kind: 'done' } : { kind: 'error', message: compactFailureMessage(last.event) })
    scheduleCompactIdle(2500)
  }, [compactStatus, session.timeline])

  useEffect(() => {
    if (compactStatus.kind !== 'running') return
    const startSeq = inferredCompactSeq.current
    if (startSeq === null) return
    const terminal = session.timeline.find((entry) => entry.seq > startSeq && isCompactTerminalEvent(entry.event.kind))
    if (terminal) {
      compactStartSeq.current = null
      inferredCompactSeq.current = null
      setCompactStatus(isCompactionSuccess(terminal.event) ? { kind: 'done' } : { kind: 'error', message: compactFailureMessage(terminal.event) })
      scheduleCompactIdle(2500)
      return
    }
    const llmResponse = session.timeline.some((entry) => entry.seq > startSeq && (entry.event.kind === 'llm_response' || entry.event.kind === 'llm_error'))
    if (!llmResponse) return
    compactStartSeq.current = null
    inferredCompactSeq.current = null
    setCompactStatus({ kind: 'idle' })
  }, [compactStatus, session.timeline])

  // Mirror remote compaction lifecycle broadcasts (server:compact_status)
  // into local state so every attached dashboard renders the same
  // "Compacting…" row — not just the tab that clicked /compact.
  const remoteCompact = session.compactStatus
  useEffect(() => {
    if (!remoteCompact) return
    if (remoteCompact.kind === 'running') {
      setCompactStatus({
        kind: 'running',
        startedAt: Date.parse(remoteCompact.startedAt) || Date.now(),
        tokensBefore: remoteCompact.tokensBefore,
      })
      return
    }
    if (remoteCompact.kind === 'done') {
      setCompactStatus({ kind: 'done' })
      scheduleCompactIdle(2500)
      return
    }
    if (remoteCompact.kind === 'skipped') {
      setCompactStatus({ kind: 'error', message: remoteCompact.message ?? compactReasonMessage(remoteCompact.reason) })
      scheduleCompactIdle(6000)
      return
    }
    if (remoteCompact.kind === 'error') {
      setCompactStatus({ kind: 'error', message: remoteCompact.message })
      scheduleCompactIdle(6000)
    }
    // Intentionally not listing scheduleCompactIdle in deps: it's a stable
    // ref-based helper defined in the same component (see below).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remoteCompact])

  useEffect(() => {
    if (compactStatus.kind !== 'running') return
    if (!session.lastError) return
    compactStartSeq.current = null
    setCompactStatus({ kind: 'error', message: session.lastError.message })
    scheduleCompactIdle(6000)
  }, [compactStatus, session.lastError])

  useEffect(() => {
    if (compactStatus.kind !== 'running') return
    const timer = window.setTimeout(() => {
      setCompactStatus({
        kind: 'error',
        message: t('app.compactTimeout'),
      })
    }, COMPACT_WATCHDOG_MS)
    return () => window.clearTimeout(timer)
  }, [compactStatus])

  // Hard-tier context pressure means the host will auto-compact before the
  // next user turn runs. Surface that as a transcript row (queued state) so
  // the UI shows *something is about to happen* rather than a static banner.
  // Live transitions: hard + resting → queued; hard clears / turn starts /
  // compact runs → back to idle (or whatever the running-observer set).
  useEffect(() => {
    const shouldQueueCompact = shouldCompactContext(session.contextSnapshot, {}, { triggerRatio: session.config?.hardThreshold ?? 0.92 }).shouldCompact
    const status = session.state?.status
    const resting = status === 'idle' || status === 'done' || status === 'error'
    if (shouldQueueCompact && resting) {
      if (compactStatus.kind === 'idle') setCompactStatus({ kind: 'queued' })
      return
    }
    if (compactStatus.kind === 'queued') setCompactStatus({ kind: 'idle' })
  }, [session.contextSnapshot, session.config?.hardThreshold, session.state?.status, compactStatus.kind])

  const onModelChange = (model: string): void => {
    setStoredModel(model)
    try {
      localStorage.setItem(PREF_MODEL, model)
    } catch {}
    if (session.socket && config.sessionId !== null) {
      updateSessionPreferences(session.socket, config.sessionId, { selectedModel: model })
    }
  }

  const onApprovalModeChange = (mode: import('@agent-kernel/kernel').ApprovalMode): void => {
    if (!session.socket || config.sessionId === null) return
    setSessionApprovalMode(session.socket, config.sessionId, mode)
  }

  const runCompactNow = (): void => {
    if (config.sessionId === null) return
    if (!hasCompactableContent(session.state)) {
      setCompactStatus({ kind: 'empty', message: t('app.compactEmpty') })
      scheduleCompactIdle(6000)
      return
    }
    if (session.state && !isResting(session.state.status)) {
      setCompactStatus({ kind: 'error', message: t('app.compactBusy') })
      scheduleCompactIdle(6000)
      return
    }
    if (compactResetTimer.current !== null) {
      window.clearTimeout(compactResetTimer.current)
      compactResetTimer.current = null
    }
    compactStartSeq.current = session.timeline.at(-1)?.seq ?? 0
    setCompactStatus({
      kind: 'running',
      startedAt: Date.now(),
      tokensBefore: session.state?.usage.inputTokens ?? 0,
    })
    session.socket?.emit('client:compact', { sessionId: config.sessionId })
    if (!config.explicit) setConfig((prev) => ({ ...prev, explicit: true }))
  }

  const [consolidateBanner, setConsolidateBanner] = useState<
    { kind: 'success' | 'info' | 'error'; message: string } | null
  >(null)
  const consolidateBannerTimer = useRef<number | null>(null)
  const runConsolidateMemory = useCallback((): void => {
    if (!session.socket || config.sessionId === null) return
    const socket = session.socket
    const requestId = crypto.randomUUID()
    const handler = (result: ConsolidateMemoryResult): void => {
      if (result.requestId !== requestId) return
      socket.off('server:memory_consolidated', handler)
      if (consolidateBannerTimer.current !== null) {
        window.clearTimeout(consolidateBannerTimer.current)
      }
      if (result.error) {
        setConsolidateBanner({ kind: 'error', message: t('app.consolidateFailed', { error: result.error }) })
      } else if (result.saved.length > 0) {
        setConsolidateBanner({
          kind: 'success',
          message: t('app.savedMemories', {
            count: result.saved.length,
            label: t(result.saved.length === 1 ? 'app.memory_one' : 'app.memory_other'),
            items: result.saved.join(', '),
          }),
        })
      } else {
        setConsolidateBanner({
          kind: 'info',
          message: result.reason ?? t('app.nothingWorthSaving'),
        })
      }
      consolidateBannerTimer.current = window.setTimeout(() => {
        setConsolidateBanner(null)
        consolidateBannerTimer.current = null
      }, 6000)
    }
    socket.on('server:memory_consolidated', handler)
    socket.emit('client:consolidate_memory', { requestId, sessionId: config.sessionId })
  }, [session.socket, config.sessionId])

  const selectSession = useCallback((sessionId: string): void => {
    withViewTransition(() => setConfig((prev) => ({ ...prev, sessionId, explicit: true })))
  }, [])
  const clearSessionSelection = useCallback((): void => {
    suppressNextAutoSessionSelection.current = true
    setMetadataOpen(false)
    setMetadataSessionId(null)
    setCwdDialogOpen(false)
    withViewTransition(() => setConfig((prev) => ({
      ...prev,
      sessionId: null,
      explicit: false,
    })))
  }, [])
  const newSession = useCallback((workspaceId?: string): void => {
    setWorkspacePickError(null)
    setWorkspacePickSubmitting(false)
    setPendingWorkspacePick({
      sessionId: crypto.randomUUID(),
      ...(workspaceId !== undefined ? { workspaceId } : {}),
    })
  }, [])
  const clearCurrentSession = (): void => {
    if (!session.socket || config.sessionId === null) return
    sessionViewCache.delete(config.sessionId)
    clearSession(session.socket, config.sessionId)
  }
  const pickWorkspaceForNew = async (
    workspaceId: string,
    workspaceName: string | undefined,
    cwd: string,
  ): Promise<void> => {
    if (!pendingWorkspacePick) return
    const { sessionId } = pendingWorkspacePick
    if (!controlSocket) {
      setWorkspacePickError(t('app.socketNotConnected'))
      return
    }
    setWorkspacePickSubmitting(true)
    setWorkspacePickError(null)
    try {
      await createSessionWithAck(controlSocket, {
        sessionId,
        workspaceId,
        ...(workspaceName !== undefined ? { workspaceName } : {}),
        cwd,
        selectedModel: preferredModel,
      })
      selectSession(sessionId)
      setPendingWorkspacePick(null)
    } catch (err) {
      setWorkspacePickError(err instanceof Error ? err.message : String(err))
    } finally {
      setWorkspacePickSubmitting(false)
    }
  }
  const startSimpleChat = async (): Promise<void> => {
    if (!pendingWorkspacePick) return
    const { sessionId } = pendingWorkspacePick
    if (!controlSocket) {
      setWorkspacePickError(t('app.socketNotConnected'))
      return
    }
    setWorkspacePickSubmitting(true)
    setWorkspacePickError(null)
    try {
      const cwd = `/tmp/agent-kernel-chat-${crypto.randomUUID()}`
      await createSessionWithAck(controlSocket, {
        sessionId,
        cwd,
        tools: SIMPLE_CHAT_TOOLS,
        selectedModel: preferredModel,
      })
      selectSession(sessionId)
      setPendingWorkspacePick(null)
    } catch (err) {
      setWorkspacePickError(err instanceof Error ? err.message : String(err))
    } finally {
      setWorkspacePickSubmitting(false)
    }
  }
  const deleteSessionAt = useCallback((sessionId: string, options: { cascade?: boolean } = {}): void => {
    if (!controlSocket) return
    for (const id of sessionIdsForCacheInvalidation(controlSessionsRef.current, sessionId, Boolean(options.cascade))) {
      sessionViewCache.delete(id)
    }
    deleteSession(controlSocket, sessionId, options)
    if (sessionId === config.sessionId) {
      suppressNextAutoSessionSelection.current = true
      setMetadataOpen(false)
      setCwdDialogOpen(false)
      setConfig((prev) => ({
        ...prev,
        sessionId: null,
        explicit: false,
      }))
    }
  }, [config.sessionId, controlSocket, sessionViewCache])
  const renameSessionAt = useCallback((sessionId: string, label: string): void => {
    if (!controlSocket) return
    renameSession(controlSocket, sessionId, label)
  }, [controlSocket])
  const renameWorkspaceAt = useCallback((workspaceId: string, workspaceName: string): void => {
    if (!controlSocket || workspaceId.length === 0) return
    renameWorkspace(controlSocket, workspaceId, workspaceName)
  }, [controlSocket])
  const openConnectWorkspaceDialog = useCallback((): void => {
    setConnectWorkspaceOpen(true)
  }, [])
  const openSessionInfoDialog = useCallback((sessionId: string): void => {
    setMetadataSessionId(sessionId)
    setMetadataOpen(true)
  }, [])
  const openExplorerDrawerSessionInfo = useCallback((sessionId: string): void => {
    setExplorerDrawerOpen(false)
    setMetadataSessionId(sessionId)
    setMetadataOpen(true)
  }, [])
  const openExplorerDrawerWorkspaceInfo = useCallback((workspaceId: string): void => {
    setExplorerDrawerOpen(false)
    setWorkspaceInfoId(workspaceId)
  }, [])
  const selectSessionFromExplorerDrawer = useCallback((sessionId: string): void => {
    selectSession(sessionId)
    setExplorerDrawerOpen(false)
  }, [selectSession])
  const clearSessionSelectionFromExplorerDrawer = useCallback((): void => {
    clearSessionSelection()
    setExplorerDrawerOpen(false)
  }, [clearSessionSelection])
  const newSessionFromExplorerDrawer = useCallback((workspaceId?: string): void => {
    newSession(workspaceId)
    setExplorerDrawerOpen(false)
  }, [newSession])
  const connectWorkspaceFromExplorerDrawer = useCallback((): void => {
    setExplorerDrawerOpen(false)
    setConnectWorkspaceOpen(true)
  }, [])

  const metadataTargetSessionId = metadataSessionId ?? activeSessionId
  const metadataSession = control.sessions.find(
    (s) => s.sessionId === metadataTargetSessionId,
  )
  const metadataIsCurrentSession = metadataTargetSessionId !== null && metadataTargetSessionId === activeSessionId
  const hasSelectedSession = currentSession !== undefined
  const sessionListLoading = !control.executorsLoaded || !control.sessionsLoaded
  const sessionHydrated = activeSessionId !== null && session.hydratedSessionId === activeSessionId
  const selectedHistorySessionLoading = Boolean(
    hasSelectedSession &&
      !sessionHydrated &&
      ((currentSession?.eventCount ?? 0) > 0 || Boolean(currentSession?.firstUserMessage)),
  )
  const currentWorkspaceExecutor = useMemo(() => {
    if (!currentSession?.workspaceId) return undefined
    return control.executors.find(
      (e) => e.workspaceId === currentSession.workspaceId,
    )
  }, [currentSession?.workspaceId, control.executors])
  const fileExplorerWorkspaceId = useMemo(() => {
    if (currentSession?.workspaceId) return currentSession.workspaceId
    return control.executors.length === 1 ? control.executors[0]?.workspaceId : undefined
  }, [currentSession?.workspaceId, control.executors])
  const workspaceExplorerBinding = resolveWorkspaceExplorerBinding({
    activeSessionId,
    sessionSocket: session.socket,
    controlSocket,
  })

  const workspaceInfoExecutor = useMemo(
    () => control.executors.find((e) => e.workspaceId === workspaceInfoId),
    [control.executors, workspaceInfoId],
  )
  const workspaceInfoSessions = useMemo(
    () => control.sessions.filter((s) => s.workspaceId === workspaceInfoId),
    [control.sessions, workspaceInfoId],
  )
  const workspaceInfoExists = Boolean(
    workspaceInfoId && (workspaceInfoExecutor || workspaceInfoSessions.length > 0),
  )

  useEffect(() => {
    if (hasSelectedSession) return
    setMetadataOpen(false)
    setMetadataSessionId(null)
    setCwdDialogOpen(false)
  }, [hasSelectedSession])

  useEffect(() => {
    if (metadataSessionId === null) return
    if (control.sessions.some((s) => s.sessionId === metadataSessionId)) return
    setMetadataOpen(false)
    setMetadataSessionId(null)
  }, [control.sessions, metadataSessionId])

  useEffect(() => {
    if (workspaceInfoId === null || workspaceInfoExists) return
    setWorkspaceInfoId(null)
  }, [workspaceInfoExists, workspaceInfoId])

  useEffect(() => {
    if (config.sessionId === null) return
    if (suppressNextAutoSessionSelection.current) {
      suppressNextAutoSessionSelection.current = false
      return
    }
    const next = nextSessionSelection({
      sessions: control.sessions,
      currentSessionId: config.sessionId,
      explicit: config.explicit,
    })
    if (!next) return
    setConfig((prev) => ({
      ...prev,
      sessionId: next.sessionId,
      explicit: true,
    }))
  }, [config.explicit, config.sessionId, control.sessions])

  const currentCwd = sessionHydrated
    ? session.state?.cwd ?? currentSession?.currentCwd ?? ''
    : currentSession?.currentCwd ?? ''
  const overrideLabel = currentSession?.label?.trim()
  const firstMsg = currentSession?.firstUserMessage
  const sessionLabel =
    overrideLabel && overrideLabel.length > 0
      ? overrideLabel.length > 40
        ? `${overrideLabel.slice(0, 40)}…`
        : overrideLabel
      : firstMsg
        ? firstMsg.length > 40
          ? `${firstMsg.slice(0, 40)}…`
          : firstMsg
        : t('app.newSession')
  const chatMessages = visibleMessages(
    session.state?.messages ?? [],
    session.timeline,
    session.streamingText,
    { includeStatePrefix: session.parentSessionId !== null },
  )
  const visibleQueuedMessages = useMemo(
    () => mergeOptimisticQueuedMessages(session.queuedMessages, optimisticQueuedMessages),
    [session.queuedMessages, optimisticQueuedMessages],
  )
  const chatItems = visibleTranscript(
    session.state?.messages ?? [],
    session.timeline,
    session.streamingText,
    pendingUserMessages,
    visibleQueuedMessages,
    { includeStatePrefix: session.parentSessionId !== null },
  )
  const backgroundTasks = backgroundTerminalTasks(session.timeline)
  const taskItems = useMemo(() => tasksFromTimeline(session.timeline), [session.timeline])
  const activeSessionStatus = sessionActivityStatus({
    status: session.state?.status ?? currentSession?.status,
    streamingActive: session.streamingText.length > 0,
    awaitingAck,
    compactRunning: compactStatus.kind === 'running',
  })
  useRunningTitleIndicator(isRunningSessionActivity(activeSessionStatus))
  const sidebarActiveSessionStatus = sessionHydrated ? activeSessionStatus : undefined
  const sessionStatusesRef = useRef<{ signature: string; value: ReadonlyMap<string, SessionActivityStatus> }>({
    signature: '',
    value: new Map(),
  })
  const sessionStatuses = useMemo(() => {
    const entries: Array<[string, SessionActivityStatus]> = []
    for (const summary of control.sessions) {
      if (summary.status && isRunningSessionActivity(summary.status)) entries.push([summary.sessionId, summary.status])
    }
    if (activeSessionId !== null && sidebarActiveSessionStatus) {
      const existing = entries.findIndex(([sessionId]) => sessionId === activeSessionId)
      if (existing >= 0) entries[existing] = [activeSessionId, sidebarActiveSessionStatus]
      else entries.push([activeSessionId, sidebarActiveSessionStatus])
    }
    const signature = entries.map(([sessionId, status]) => `${sessionId}:${status}`).join('|')
    if (sessionStatusesRef.current.signature === signature) return sessionStatusesRef.current.value
    const value = new Map(entries)
    sessionStatusesRef.current = { signature, value }
    return value
  }, [control.sessions, activeSessionId, sidebarActiveSessionStatus])

  const pendingApprovalsCount = session.pendingApprovals.length
  // Pinned-to-bottom is owned by ChatPanel/VirtualTranscript now; we mirror
  // it up here only so a session switch or a first-load reset can force a
  // jump-to-bottom (see scrollToBottomToken below). Virtuoso reports
  // `atBottom` back to us via `onChatPinnedChange` — we forward that but
  // do NOT drive scrollTop manually anymore.
  const [chatPinnedToBottom, setChatPinnedToBottom] = useState(true)
  useEffect(() => {
    setChatPinnedToBottom(true)
  }, [config.sessionId])
  // Bumping this forces VirtualTranscript to jump-to-bottom. Keep it for
  // explicit jumps such as session switches and sends; ordinary appends are
  // handled by Virtuoso's pinned `followOutput` path so the scroll container
  // is not rebuilt or imperatively repositioned during streaming.
  const [chatScrollToBottomToken, setChatScrollToBottomToken] = useState(0)
  useEffect(() => {
    setChatScrollToBottomToken((t) => t + 1)
  }, [config.sessionId])

  // A bound session (`workspaceId` set) is only useful while its executor is
  // attached. Legacy sessions without workspaceId keep working through the
  // host's sticky-map fallback, so treat them as online.
  const sessionWorkspaceOnline = useMemo(() => {
    if (!currentSession?.workspaceId) return true
    return control.executors.some(
      (e) => e.workspaceId === currentSession.workspaceId,
    )
  }, [currentSession?.workspaceId, control.executors])
  const sessionWorkspaceKnownOffline = Boolean(
    hasSelectedSession &&
      session.status === 'ready' &&
      control.executorsLoaded &&
      !sessionWorkspaceOnline,
  )

  const waitingForUser = isWaitingForUserInput({
    status: session.state?.status,
    streamingActive: session.streamingText.length > 0,
    awaitingAck,
    pendingApprovalsCount,
  })
  const suppressWaitingForUser = suppressNextWaitingNotification.current && waitingForUser

  useInterventionDesktopNotifications({
    sessionId: activeSessionId,
    sessionLabel,
    pendingApprovalsCount,
    pendingApprovalSummary: session.pendingApprovals[0],
    waitingForUser,
    lastError: session.lastError,
    connectionStatus: session.status,
    workspaceOnline: hasSelectedSession && control.executorsLoaded ? sessionWorkspaceOnline : null,
    workspaceLabel: currentSession?.workspaceName ?? currentSession?.workspaceId,
    suppressWaitingForUser,
    approvalMode: session.state?.approvalMode,
    ready: sessionHydrated,
  })

  useEffect(() => {
    if (suppressWaitingForUser) suppressNextWaitingNotification.current = false
  }, [suppressWaitingForUser])

  useSessionToasts({
    sessionId: activeSessionId,
    sessionLabel,
    connectionStatus: session.status,
    pendingApprovals: session.pendingApprovals,
    lastError: session.lastError,
    approvalMode: session.state?.approvalMode,
  })
  useInactiveSessionSummaryToasts({
    sessions: control.sessions,
    activeSessionId,
  })
  useSubAgentToasts(session.socket)
  useBackgroundShellToasts(backgroundTasks)

  const openCwdDialog = (): void => {
    setCwdDialogOpen(true)
  }

  const [section, setSection] = useAppSection()
  const handleSectionSelect = (next: AppSection): void => {
    setSection(next)
    // Benchmarks, Operations, Artifacts, Pipeline & Docs are all real pages — rendered inline below.
  }

  const commandPaletteCommands = useMemo<readonly CommandPaletteItem[]>(() => {
    const cmds: CommandPaletteItem[] = []
    const socket = session.socket
    const canRun = hasSelectedSession && socket !== null

    cmds.push(
      {
        id: 'session.new',
        group: t('commandPalette.groups.session'),
        label: t('commandPalette.commands.newSession'),
        hint: t('commandPalette.commands.newSessionHint'),
        icon: Plus,
        keywords: ['create', 'start'],
        disabled: control.executors.length === 0,
        disabledReason: t('commandPalette.disabled.noWorkspaceOnline'),
        run: () => newSession(),
      },
      {
        id: 'session.info',
        group: t('commandPalette.groups.session'),
        label: t('commandPalette.commands.sessionInfo'),
        hint: t('commandPalette.commands.sessionInfoHint'),
        icon: Info,
        keywords: ['metadata', 'details'],
        disabled: !hasSelectedSession,
        disabledReason: t('commandPalette.disabled.noSessionSelected'),
        run: () => {
          if (activeSessionId === null) return
          setMetadataSessionId(activeSessionId)
          setMetadataOpen(true)
        },
      },
      {
        id: 'session.change-cwd',
        group: t('commandPalette.groups.session'),
        label: t('commandPalette.commands.changeCwd'),
        hint: t('commandPalette.commands.changeCwdHint'),
        icon: FolderOpen,
        keywords: ['directory', 'folder'],
        disabled: !hasSelectedSession || sessionWorkspaceKnownOffline,
        disabledReason: !hasSelectedSession ? t('commandPalette.disabled.noSessionSelected') : t('commandPalette.disabled.workspaceOffline'),
        run: openCwdDialog,
      },
      {
        id: 'session.compact',
        group: t('commandPalette.groups.session'),
        label: t('commandPalette.commands.compactContext'),
        hint: t('commandPalette.commands.compactContextHint'),
        icon: Archive,
        keywords: ['summarize', 'shrink'],
        disabled: !canRun || !hasCompactableContent(session.state),
        disabledReason: !canRun ? t('commandPalette.disabled.noActiveSession') : t('commandPalette.disabled.nothingToCompact'),
        run: runCompactNow,
      },
      {
        id: 'session.consolidate-memory',
        group: t('commandPalette.groups.session'),
        label: t('commandPalette.commands.consolidateMemory'),
        hint: t('commandPalette.commands.consolidateMemoryHint'),
        icon: ListChecks,
        keywords: ['memory'],
        disabled: !canRun,
        disabledReason: t('commandPalette.disabled.noActiveSession'),
        run: () => runConsolidateMemory(),
      },
      {
        id: 'session.cancel',
        group: t('commandPalette.groups.session'),
        label: t('commandPalette.commands.stopCurrentTurn'),
        hint: t('commandPalette.commands.stopCurrentTurnHint'),
        icon: Square,
        keywords: ['stop', 'abort'],
        disabled: !canRun,
        disabledReason: t('commandPalette.disabled.noActiveSession'),
        run: () => {
          if (socket && activeSessionId !== null) cancelSession(socket, activeSessionId)
        },
      },
      {
        id: 'session.clear',
        group: t('commandPalette.groups.session'),
        label: t('commandPalette.commands.clearSession'),
        hint: t('commandPalette.commands.clearSessionHint'),
        icon: Eraser,
        keywords: ['reset'],
        disabled: !canRun,
        disabledReason: t('commandPalette.disabled.noActiveSession'),
        run: () => {
          if (socket && activeSessionId !== null) clearSession(socket, activeSessionId)
        },
      },
    )

    cmds.push({
      id: 'workspace.connect',
      group: t('commandPalette.groups.workspace'),
      label: t('commandPalette.commands.connectWorkspace'),
      hint: t('commandPalette.commands.connectWorkspaceHint'),
      icon: FolderOpen,
      keywords: ['attach', 'executor'],
      run: () => setConnectWorkspaceOpen(true),
    })

    cmds.push(
      {
        id: 'view.settings',
        group: t('commandPalette.groups.view'),
        label: t('commandPalette.commands.openSettings'),
        hint: t('commandPalette.commands.openSettingsHint'),
        icon: Settings,
        keywords: ['preferences', 'config'],
        run: () => setSettingsOpen(true),
      },
      {
        id: 'view.eval',
        group: t('commandPalette.groups.view'),
        label: t('commandPalette.commands.openEval'),
        hint: t('commandPalette.commands.openEvalHint'),
        icon: BarChart3,
        keywords: ['swebench', 'benchmark', 'comparison', 'score'],
        run: () => {
          setSection('benchmarks')
          if (typeof window !== 'undefined') window.location.hash = '#/benchmarks'
        },
      },
      {
        id: 'view.artifacts',
        group: t('commandPalette.groups.view'),
        label: t('commandPalette.commands.openArtifacts'),
        hint: t('commandPalette.commands.openArtifactsHint'),
        icon: Boxes,
        keywords: ['manifest', 'trace', 'eval', 'memory'],
        run: () => {
          setSection('artifacts')
          if (typeof window !== 'undefined') window.location.hash = '#/artifacts'
        },
      },
      {
        id: 'view.ops-artifacts',
        group: t('commandPalette.groups.view'),
        label: t('commandPalette.commands.openOps'),
        hint: t('commandPalette.commands.openOpsHint'),
        icon: Workflow,
        keywords: ['reliability', 'rollout', 'trace', 'router', 'subagent'],
        run: () => {
          setSection('operations')
          if (typeof window !== 'undefined') window.location.hash = '#/operations'
        },
      },
      {
        id: 'view.toggle-theme',
        group: t('commandPalette.groups.view'),
        label: effectiveTheme === 'dark' ? t('commandPalette.commands.switchLight') : t('commandPalette.commands.switchDark'),
        hint: t('commandPalette.commands.toggleThemeHint'),
        icon: effectiveTheme === 'dark' ? Sun : Moon,
        keywords: ['dark', 'light', 'appearance'],
        run: () => toggleTheme(),
      },
      {
        id: 'view.toggle-inspector',
        group: t('commandPalette.groups.view'),
        label: inspectorOpen ? t('commandPalette.commands.hideInspector') : t('commandPalette.commands.showInspector'),
        hint: t('commandPalette.commands.toggleInspectorHint'),
        icon: inspectorOpen ? PanelRightClose : PanelRight,
        keywords: ['debug', 'panel'],
        disabled: !wideLayout || !hasSelectedSession,
        disabledReason: !wideLayout ? t('commandPalette.disabled.inspectorWideOnly') : t('commandPalette.disabled.noSessionSelected'),
        run: () => setInspectorOpen(!inspectorOpen),
      },
      {
        id: 'view.open-explorer',
        group: t('commandPalette.groups.view'),
        label: t('commandPalette.commands.openExplorer'),
        hint: wideLayout ? t('commandPalette.commands.showExplorerHint') : t('commandPalette.commands.openExplorerHint'),
        icon: Menu,
        keywords: ['sidebar', 'drawer'],
        run: () => {
          if (wideLayout) setExplorerOpen(true)
          else setExplorerDrawerOpen(true)
        },
      },
    )

    for (const mode of APPROVAL_MODES) {
      cmds.push({
        id: `runtime.approval-${mode.value}`,
        group: t('commandPalette.groups.runtime'),
        label: t('commandPalette.commands.approval', { label: mode.label }),
        hint: mode.hint,
        icon: ShieldCheck,
        keywords: ['approval', 'safety', mode.value],
        disabled: !canRun,
        disabledReason: t('commandPalette.disabled.noActiveSession'),
        run: () => {
          if (socket && activeSessionId !== null) setSessionApprovalMode(socket, activeSessionId, mode.value)
        },
      })
    }

    for (const modelInfo of models) {
      const key = modelKey(modelInfo)
      cmds.push({
        id: `runtime.model-${key}`,
        group: t('commandPalette.groups.runtime'),
        label: t('commandPalette.commands.model', { label: modelInfo.label ?? modelInfo.id }),
        hint: t('commandPalette.commands.modelHint', { model: key }),
        icon: Sparkles,
        keywords: ['model', 'switch', modelInfo.id, key],
        disabled: !canRun,
        disabledReason: t('commandPalette.disabled.noActiveSession'),
        run: () => onModelChange(key),
      })
    }

    return cmds
  }, [
    activeSessionId,
    control.executors.length,
    hasSelectedSession,
    inspectorOpen,
    models,
    onModelChange,
    runCompactNow,
    runConsolidateMemory,
    session.socket,
    session.state,
    sessionWorkspaceKnownOffline,
    t,
    effectiveTheme,
    themePreference,
    toggleTheme,
    wideLayout,
  ])

  const submitCwd = (cwd: string): void => {
    if (!cwd || !session.socket || activeSessionId === null) return
    session.socket.emit('client:set_cwd', {
      sessionId: activeSessionId,
      cwd,
    })
    if (!config.explicit) {
      setConfig((prev) => ({ ...prev, explicit: true }))
    }
  }

  const executorHost = useMemo(() => {
    if (!currentSession?.workspaceId) return undefined
    const ex = control.executors.find(
      (e) => e.workspaceId === currentSession.workspaceId,
    )
    if (!ex) return undefined
    return ex.hostname ?? ex.ipAddresses?.[0]
  }, [currentSession?.workspaceId, control.executors])

  const listWorkspaceFiles = useCallback(
    async (query: string): Promise<readonly FileListEntry[]> => {
      const socket = session.socket
      const workspaceId = currentSession?.workspaceId
      if (!socket || !workspaceId) return []
      return await new Promise((resolve) => {
        const requestId = crypto.randomUUID()
        const timer = setTimeout(() => {
          socket.off('server:file_list', handler)
          resolve([])
        }, 3000)
        const handler = (result: FileListResult): void => {
          if (result.requestId !== requestId) return
          clearTimeout(timer)
          socket.off('server:file_list', handler)
          resolve(result.error ? [] : result.files)
        }
        socket.on('server:file_list', handler)
        socket.emit('client:list_files', {
          requestId,
          workspaceId,
          ...(query ? { query } : {}),
          limit: 40,
        })
      })
    },
    [session.socket, currentSession?.workspaceId],
  )

  const readWorkspaceFile = useCallback(
    async (path: string): Promise<{ content?: string; error?: string }> => {
      const socket = session.socket
      const workspaceId = currentSession?.workspaceId
      if (!socket || !workspaceId) return { error: 'no active workspace' }
      // Uses the generic workspace:read_binary channel; decode the base64 as
      // UTF-8 for the caller (Composer @-mention preview / etc.).
      const res = await workspaceReadBinary(socket, workspaceId, path, { cwd: currentCwd, ackTimeoutMs: 5000 })
      if (res.error) return { error: res.error.message }
      try {
        const binary = atob(res.base64)
        const bytes = new Uint8Array(binary.length)
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
        return { content: new TextDecoder('utf-8', { fatal: false }).decode(bytes) }
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) }
      }
    },
    [session.socket, currentSession?.workspaceId, currentCwd],
  )

  const readOverflow = useCallback(
    async (callId: string): Promise<{ content?: string; error?: string }> => {
      const socket = session.socket
      if (!socket || activeSessionId === null) return { error: 'not connected' }
      return await new Promise((resolve) => {
        const requestId = crypto.randomUUID()
        const timer = setTimeout(() => {
          socket.off('server:overflow_contents', handler)
          resolve({ error: 'timed out' })
        }, 5000)
        const handler = (result: OverflowContentsResult): void => {
          if (result.requestId !== requestId) return
          clearTimeout(timer)
          socket.off('server:overflow_contents', handler)
          if (result.error) resolve({ error: result.error })
          else resolve({ content: result.content ?? '' })
        }
        socket.on('server:overflow_contents', handler)
        socket.emit('client:read_overflow', {
          requestId,
          sessionId: activeSessionId,
          callId,
        })
      })
    },
    [session.socket, activeSessionId],
  )

  return (
    <PwaLifecycleHost>
    <div className="ak-app-shell flex flex-col bg-background text-foreground">
      <AppShellNav
        section={section}
        onSelect={handleSectionSelect}
        onOpenSettings={() => setSettingsOpen(true)}
        connectionStatus={hasSelectedSession ? <ConnectionStatus status={session.status} /> : null}
        collapsed={!topbarOpen}
        onCollapse={() => setTopbarOpen(false)}
        onExpand={() => setTopbarOpen(true)}
      />
      <PwaUpdateGlobalBanner />
      {!topbarOpen ? (
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setTopbarOpen(true)}
          title={t('app.expandTopbar')}
          aria-label={t('app.expandTopbar')}
          data-testid="topbar-floating-toggle"
          className="fixed right-2 top-[calc(env(safe-area-inset-top)+0.5rem)] z-40 h-8 w-8 border border-border/60 bg-background/70 text-muted-foreground opacity-55 shadow-sm backdrop-blur transition hover:bg-background/95 hover:text-foreground hover:opacity-100 focus-visible:opacity-100 sm:h-7 sm:w-7"
        >
          <ChevronDown className="h-4 w-4" />
        </Button>
      ) : null}
      <div className="min-h-0 min-w-0 max-w-full flex-1 overflow-hidden">
      <div className="hidden" data-testid="login-column-hidden" />
      {section === 'benchmarks' ? (
        <Suspense fallback={<div className="h-full w-full" />}>
          <BenchmarksPage onOpenSession={(sessionId) => selectSession(sessionId)} />
        </Suspense>
      ) : section === 'operations' ? (
        <Suspense fallback={<div className="h-full w-full" />}>
          <OperationsPage onOpenSession={(sessionId) => selectSession(sessionId)} />
        </Suspense>
      ) : section === 'artifacts' ? (
        <Suspense fallback={<div className="h-full w-full" />}>
          <ArtifactsPage onOpenSession={(sessionId) => selectSession(sessionId)} />
        </Suspense>
      ) : section === 'docs' ? (
        <Suspense fallback={<div className="h-full w-full" />}>
          <DocsPage />
        </Suspense>
      ) : section === 'pipeline' ? (
        <Suspense fallback={<div className="h-full w-full" />}>
          <PipelinePage />
        </Suspense>
      ) : (
      <ResizablePanelGroup direction="horizontal" autoSaveId="ak-outer-cols-v5" className="min-w-0 max-w-full overflow-hidden">
        {wideLayout ? (
          <>
            {explorerOpen ? (
              <>
                <ResizablePanel
                  defaultSize={20}
                  minSize={17}
                  maxSize={22}
                  className="min-w-[240px] bg-sidebar text-sidebar-foreground"
                  data-testid="explorer-panel"
                >
                  <div className="flex h-full min-h-0 flex-col">
                    <div className="flex h-10 flex-none items-center border-b border-sidebar-border px-1.5">
                      <button
                        type="button"
                        className="flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded px-1.5 text-left text-xs font-medium text-sidebar-foreground hover:bg-sidebar-accent"
                        aria-expanded={sessionExplorerSectionOpen}
                        data-testid="session-explorer-sidebar-toggle"
                        onClick={() => setSessionExplorerSectionOpen(!sessionExplorerSectionOpen)}
                      >
                        {sessionExplorerSectionOpen ? <ChevronDown className="h-3.5 w-3.5 flex-none" /> : <ChevronRight className="h-3.5 w-3.5 flex-none" />}
                        <Menu className="h-3.5 w-3.5 flex-none" />
                        <span className="min-w-0 truncate">Session</span>
                      </button>
                      <SidebarCollapseButton onCollapse={() => setExplorerOpen(false)} />
                    </div>
                    {sessionExplorerSectionOpen ? (
                      <ResizablePanelGroup direction="vertical" autoSaveId="ak-left-sidebar-session-file-git-v2" className="min-h-0 flex-1">
                        <ResizablePanel id="session-explorer" order={1} defaultSize={58} minSize={28} className="min-h-0 overflow-hidden">
                          <Explorer
                            executors={control.executors}
                            sessions={control.sessions}
                            loading={!control.executorsLoaded || !control.sessionsLoaded}
                            selectedSessionId={activeSessionId}
                            sessionStatuses={sessionStatuses}
                            onSelect={selectSession}
                            onClearSelection={clearSessionSelection}
                            onNewSession={newSession}
                            onConnectWorkspace={openConnectWorkspaceDialog}
                            onDelete={deleteSessionAt}
                            onRename={renameSessionAt}
                            onRenameWorkspace={renameWorkspaceAt}
                            embeddedHeader
                            fontSizePx={sessionExplorerFontSizePx}
                            getCachedSessionView={getCachedSessionView}
                            onOpenSessionInfo={openSessionInfoDialog}
                            onWorkspaceInfo={setWorkspaceInfoId}
                          />
                        </ResizablePanel>
                        <ResizableHandle
                          withHandle
                          aria-label={
                            lowerExplorerCollapsed
                              ? 'Drag up to show files and source control'
                              : 'Resize files and source control; drag down to hide'
                          }
                          className={lowerExplorerCollapsed ? 'h-1.5 data-[panel-group-direction=vertical]:h-1.5' : undefined}
                        />
                        <ResizablePanel
                          id="file-git-explorer"
                          order={2}
                          defaultSize={42}
                          minSize={18}
                          collapsible
                          collapsedSize={0}
                          onCollapse={() => setLowerExplorerCollapsed(true)}
                          onExpand={() => setLowerExplorerCollapsed(false)}
                          className="flex min-h-0 flex-col"
                          data-testid="file-git-explorer-panel"
                          data-collapsed={lowerExplorerCollapsed ? 'true' : 'false'}
                        >
                          {lowerExplorerCollapsed ? null : (
                            <LowerExplorerArea
                              active={lowerExplorerTab}
                              onSelect={setLowerExplorerTab}
                              socket={workspaceExplorerBinding.socket}
                              workspaceId={fileExplorerWorkspaceId}
                              sessionId={workspaceExplorerBinding.sessionId}
                              cwd={currentCwd}
                              fontSizePx={fileExplorerFontSizePx}
                            />
                          )}
                        </ResizablePanel>
                      </ResizablePanelGroup>
                    ) : (
                      <div className="flex min-h-0 flex-1 flex-col">
                        <LowerExplorerArea
                          active={lowerExplorerTab}
                          onSelect={setLowerExplorerTab}
                          socket={workspaceExplorerBinding.socket}
                          workspaceId={fileExplorerWorkspaceId}
                          sessionId={workspaceExplorerBinding.sessionId}
                          cwd={currentCwd}
                          fontSizePx={fileExplorerFontSizePx}
                        />
                      </div>
                    )}
                  </div>
                </ResizablePanel>
                <ResizableHandle withHandle />
              </>
            ) : null}
          </>
        ) : null}
        <ResizablePanel
          defaultSize={wideLayout && explorerOpen ? 80 : 100}
          minSize={wideLayout && explorerOpen ? 78 : 100}
          className="min-w-0 bg-background"
          data-testid="workbench-panel"
        >
          <div className="h-full flex min-h-0 min-w-0 flex-col" data-testid="workbench">
            <WorkbenchToolbar
              sessionLabel={sessionLabel}
              sessionActivityStatus={activeSessionStatus}
              cwd={currentCwd}
              onOpenTopbar={() => setTopbarOpen(true)}
              topbarAvailable={!topbarOpen}
              onOpenExplorer={() => {
                if (wideLayout) setExplorerOpen(true)
                else setExplorerDrawerOpen(true)
              }}
              explorerAvailable={!wideLayout || !explorerOpen}
              onOpenInspector={() => {
                if (wideLayout) setInspectorOpen(true)
                else setInspectorDrawerOpen(true)
              }}
              inspectorAvailable={hasSelectedSession && (!wideLayout || !inspectorOpen)}
              onChangeCwd={openCwdDialog}
              sessionSelected={hasSelectedSession}
              sessionLoading={sessionListLoading && !hasSelectedSession}
            />
            {sessionListLoading && !hasSelectedSession ? (
              <SessionLoadingArea />
            ) : !hasSelectedSession ? (
              <NoSessionArea
                onNewSession={newSession}
                hasSessions={control.sessions.length > 0}
                data-testid="no-session-placeholder"
              />
            ) : activeSessionId !== null ? (
            <ResizablePanelGroup direction="horizontal" autoSaveId="ak-workbench-cols-v1" className="min-h-0 min-w-0 max-w-full flex-1 overflow-hidden">
              <ResizablePanel
                defaultSize={wideLayout ? (inspectorOpen ? 74 : 100) : 100}
                minSize={wideLayout ? 70 : 100}
                className="min-w-0"
                data-testid="main-panel"
              >
                <div className="h-full flex flex-col min-w-0 min-h-0">
                  {session.parentSessionId ? (
                    <LineageBar
                      parentSessionId={session.parentSessionId}
                      parentCursor={session.parentCursor}
                      parentAvailable={sessionExists(control.sessions, session.parentSessionId)}
                      onGoParent={() => {
                        const parentId = session.parentSessionId
                        if (!parentId) return
                        if (!sessionExists(control.sessions, parentId)) return
                        selectSession(parentId)
                      }}
                    />
                  ) : null}
                  <div className="relative grid flex-1 min-h-0 min-w-0 grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)_auto] overflow-hidden">
                    <div
                      className="flex min-h-0 min-w-0 flex-col bg-background overflow-hidden"
                      data-testid="chat-panel"
                    >
                      <ChatPanel
                        items={chatItems}
                        highlightIndex={highlightIndex}
                        pinnedToBottom={chatPinnedToBottom}
                        onPinnedChange={setChatPinnedToBottom}
                        scrollToBottomToken={chatScrollToBottomToken}
                        compactStatus={compactStatus}
                        liveToolActivityTailCount={liveToolActivityTailCount}
                        toolCardMode={currentSession?.preferences?.toolCardMode ?? 'dots'}
                        displayPrefs={{
                          fontSize: chatFontSize,
                          contentWidth: chatContentWidth,
                          sideSpace: chatSideSpace,
                          lineHeight: chatLineHeight,
                          mathScale: chatMathScale,
                        }}
                        loading={selectedHistorySessionLoading}
                        onDismissCompactStatus={() => setCompactStatus({ kind: 'idle' })}
                        pendingApprovals={session.pendingApprovals}
                        onReadOverflow={readOverflow}
                        onOpenWorkspaceFile={setWorkspaceFileViewTarget}
                        parentSessionId={activeSessionId ?? undefined}
                        socket={session.socket}
                        onApprovalDecision={(callId, decision) => {
                          if (!session.socket || activeSessionId === null) return
                          respondApproval(session.socket, activeSessionId, callId, decision)
                        }}
                        onEditAndRerun={(seq, text) => {
                          if (!session.socket || activeSessionId === null) return
                          setForkingFromSeq(seq)
                          session.socket.emit('client:fork', {
                            sourceSessionId: activeSessionId,
                            cursor: seq - 1,
                            seedMessage: text,
                          })
                        }}
                        onSuggest={(text) => {
                          if (!session.socket || activeSessionId === null || session.status !== 'ready' || sessionWorkspaceKnownOffline) return
                          suppressNextWaitingNotification.current = true
                          setPendingUserMessages((prev) => [
                            ...prev,
                            {
                              id: newPendingMessageId(),
                              text,
                              mode: 'steer',
                              createdAt: new Date().toISOString(),
                              afterSeq: session.timeline.at(-1)?.seq ?? 0,
                            },
                          ])
                          setAwaitingAck(true)
                          session.socket.emit('client:user_message', {
                            sessionId: activeSessionId,
                            text,
                            mode: 'steer',
                          })
                          if (!config.explicit) setConfig((prev) => ({ ...prev, explicit: true }))
                        }}
                        footerSlot={
                          <>
                            <InlineStatusRow
                              state={session.state}
                              fallbackStatus={currentSession?.status}
                              streamingActive={session.streamingText.length > 0}
                              toolExecutionStartedAt={session.toolExecutionStartedAt}
                              awaitingAck={awaitingAck}
                            />
                            {forkingFromSeq !== null ? (
                              <div
                                className="flex items-center gap-2 rounded-md bg-muted/60 px-3 py-1.5 text-xs text-muted-foreground"
                                data-testid="rerun-pending"
                              >
                                <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                                <span>{t('chat.transcript.rerunPending', { seq: forkingFromSeq })}</span>
                              </div>
                            ) : null}
                          </>
                        }
                      />
                    </div>
                    <div className="min-h-0">
                      <BannerStack>
                        <SessionErrorBanner error={session.lastError} />
                        {sessionWorkspaceKnownOffline ? (
                          <BannerSlot>
                            <div
                              className="px-3 py-2 text-xs text-amber-800 dark:text-amber-200 bg-amber-50 dark:bg-amber-950/40 border-t border-amber-200 dark:border-amber-900"
                              data-testid="workspace-offline-banner"
                            >
                              workspace <span className="font-mono">{currentSession?.workspaceName ?? currentSession?.workspaceId}</span> is offline — start its executor to send messages.
                            </div>
                          </BannerSlot>
                        ) : null}
                        {consolidateBanner ? (
                          <BannerSlot>
                            <div
                              className={cn(
                                'px-3 py-2 text-xs border-t',
                                consolidateBanner.kind === 'success' &&
                                  'text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-900',
                                consolidateBanner.kind === 'error' &&
                                  'text-rose-700 dark:text-rose-300 bg-rose-50 dark:bg-rose-950/40 border-rose-200 dark:border-rose-900',
                                consolidateBanner.kind === 'info' &&
                                  'text-sky-700 dark:text-sky-300 bg-sky-50 dark:bg-sky-950/40 border-sky-200 dark:border-sky-900',
                              )}
                              data-testid="consolidate-banner"
                            >
                              {consolidateBanner.message}
                            </div>
                          </BannerSlot>
                        ) : null}
                        <ContextPressureBanner
                          state={session.state}
                          contextSnapshot={session.contextSnapshot}
                          compactRunning={compactStatus.kind === 'running'}
                          suppressed={awaitingAck || compactStatus.kind === 'running'}
                          onCompactNow={runCompactNow}
                        />
                        <OfflineBanner />
                      </BannerStack>
                      <ComposerFlipContainer
                        showApproval={session.pendingApprovals.length > 0}
                        front={
                          <Composer
                          disabled={session.status !== 'ready' || sessionWorkspaceKnownOffline}
                          model={composerModel}
                          models={models}
                          onModelChange={onModelChange}
                          approvalMode={session.state?.approvalMode ?? 'auto'}
                          onApprovalModeChange={onApprovalModeChange}
                          state={session.state}
                          config={session.config}
                          contextSnapshot={session.contextSnapshot}
                          humanAttention={session.humanAttention}
                          queuedMessages={visibleQueuedMessages}
                          timeline={session.timeline}
                          displayPrefs={{
                            fontSize: chatFontSize,
                            contentWidth: chatContentWidth,
                            sideSpace: chatSideSpace,
                            lineHeight: chatLineHeight,
                            mathScale: chatMathScale,
                          }}
                          onQueuedReorder={(id, beforeId) => {
                            if (session.socket && activeSessionId !== null) reorderQueuedMessage(session.socket, activeSessionId, id, beforeId)
                          }}
                          onQueuedUpdate={(id, text) => {
                            if (session.socket && activeSessionId !== null) updateQueuedMessage(session.socket, activeSessionId, id, text)
                          }}
                          onQueuedDelete={(id) => {
                            if (session.socket && activeSessionId !== null) deleteQueuedMessage(session.socket, activeSessionId, id)
                          }}
                          onCompact={runCompactNow}
                          onClearSession={clearCurrentSession}
                          onCancel={() => {
                            if (!session.socket || activeSessionId === null) return
                            cancelSession(session.socket, activeSessionId)
                          }}
                          onConsolidateMemory={runConsolidateMemory}
                          workspaceOnline={sessionWorkspaceOnline}
                          onListFiles={listWorkspaceFiles}
                          onReadFile={readWorkspaceFile}
                          awaitingAck={awaitingAck}
                          footerExtras={
                            <>
                              <BackgroundShellsButton
                                socket={session.socket}
                                workspaceId={currentSession?.workspaceId}
                                sessionId={activeSessionId}
                                fallbackTasks={backgroundTasks}
                              />
                              <TasksButton todos={taskItems} />
                            </>
                          }
                          onSubmit={(text, mode, images, extraBlocks) => {
                            if (!session.socket || activeSessionId === null) return
                            const imageBlocks = images ?? []
                            const extras = extraBlocks ?? []
                            const hasStructured = imageBlocks.length > 0 || extras.length > 0
                            const content = hasStructured
                              ? [
                                  ...(text.length > 0
                                    ? [{ type: 'text' as const, text }]
                                    : []),
                                  ...extras,
                                  ...imageBlocks,
                                ] satisfies readonly MessageContent[]
                              : undefined
                            const createdAt = new Date().toISOString()
                            // When the operator picked "queue" but the agent
                            // is currently idle, the server will drain the
                            // queue immediately — routing the message through
                            // the queued-messages dock would just animate it
                            // in and back out within a round-trip. Treat it
                            // as a normal pending message in that case; the
                            // wire `mode` stays `queue` because the server
                            // path is equivalent.
                            const agentStatus = session.state?.status
                            const agentBusy =
                              agentStatus === 'thinking' ||
                              agentStatus === 'executing_tools' ||
                              agentStatus === 'awaiting_approval'
                            const effectiveOptimisticMode: typeof mode = mode === 'queue' && !agentBusy ? 'steer' : mode
                            if (effectiveOptimisticMode === 'queue') {
                              setOptimisticQueuedMessages((prev) => [
                                ...prev,
                                { id: `optimistic-${newPendingMessageId()}`, text, mode, createdAt },
                              ])
                            } else {
                              setPendingUserMessages((prev) => [
                                ...prev,
                                {
                                  id: newPendingMessageId(),
                                  text,
                                  mode: effectiveOptimisticMode,
                                  ...(content ? { content } : {}),
                                  createdAt,
                                  afterSeq: session.timeline.at(-1)?.seq ?? 0,
                                },
                              ])
                            }
                            session.socket.emit('client:user_message', {
                              sessionId: activeSessionId,
                              text,
                              mode,
                              ...(content ? { content } : {}),
                            })
                            if (effectiveOptimisticMode === 'steer') suppressNextWaitingNotification.current = true
                            setAwaitingAck(true)
                            // Sending is an explicit "I'm at the end" signal:
                            // re-pin and force a jump even if the user had
                            // scrolled up (or was never pinned because the
                            // composer took most of the viewport on load).
                            setChatPinnedToBottom(true)
                            setChatScrollToBottomToken((t) => t + 1)
                            if (!config.explicit) setConfig((prev) => ({ ...prev, explicit: true }))
                          }}
                          />
                        }
                        back={
                          <ApprovalCard
                          approvals={session.pendingApprovals}
                          onDecision={(callId, decision) => {
                            if (!session.socket || activeSessionId === null) return
                            respondApproval(session.socket, activeSessionId, callId, decision)
                          }}
                          />
                        }
                      />
                    </div>
                  </div>
                </div>
              </ResizablePanel>
              {wideLayout && inspectorOpen ? (
                <>
                  <ResizableHandle withHandle />
                  <ResizablePanel defaultSize={26} minSize={22} maxSize={36} className="bg-card text-card-foreground" data-testid="inspector-panel">
                    <div className="h-full min-h-0 overflow-hidden" data-testid="inspector-drawer">
                      <InspectorPanel
                        state={session.state}
                        config={session.config}
                        contextSnapshot={session.contextSnapshot}
                        timeline={session.timeline}
                        visibleMessagesCount={chatMessages.length}
                        socket={session.socket}
                        parentSessionId={session.parentSessionId}
                        parentCursor={session.parentCursor}
                        onFork={(cursor) => {
                          if (activeSessionId !== null) session.socket?.emit('client:fork', { sourceSessionId: activeSessionId, cursor })
                        }}
                        onJumpToMessage={(index) => {
                          setHighlightIndex(index)
                          const el = document.getElementById(`msg-${index}`)
                          if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
                          window.setTimeout(() => {
                            setHighlightIndex((cur) => (cur === index ? null : cur))
                          }, 1400)
                        }}
                        onCollapse={() => setInspectorOpen(false)}
                      />
                    </div>
                  </ResizablePanel>
                </>
              ) : null}
            </ResizablePanelGroup>
            ) : null}
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
      )}
      <Dialog open={explorerDrawerOpen} onOpenChange={setExplorerDrawerOpen}>
        <DialogContent
          className="left-0 top-0 h-[var(--ak-viewport-h,100dvh)] max-h-[var(--ak-viewport-h,100dvh)] w-screen max-w-none !translate-x-0 !translate-y-0 overflow-hidden p-0 gap-0 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] sm:w-96 sm:rounded-none"
          data-testid="explorer-drawer"
        >
          <DialogHeader className="sr-only">
            <DialogTitle>{t('common.explorer')}</DialogTitle>
            <DialogDescription>{t('app.explorerDescription')}</DialogDescription>
          </DialogHeader>
          <div className="flex h-full min-h-0 flex-col bg-sidebar pb-[env(safe-area-inset-bottom)] text-sidebar-foreground">
            <div className="flex h-11 flex-none items-center gap-2 border-b border-sidebar-border px-2">
              <MobileExplorerTabBar active={mobileExplorerTab} onSelect={setMobileExplorerTab} />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-8 w-8 flex-none text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground"
                title="Close explorer"
                aria-label="Close explorer"
                onClick={() => setExplorerDrawerOpen(false)}
              >
                <PanelLeftClose className="h-4 w-4" />
              </Button>
            </div>
            <div className="min-h-0 flex-1 overflow-hidden">
              {mobileExplorerTab === 'sessions' ? (
                <Explorer
                  executors={control.executors}
                  sessions={control.sessions}
                  selectedSessionId={activeSessionId}
                  sessionStatuses={sessionStatuses}
                  onSelect={selectSessionFromExplorerDrawer}
                  onClearSelection={clearSessionSelectionFromExplorerDrawer}
                  onNewSession={newSessionFromExplorerDrawer}
                  onConnectWorkspace={connectWorkspaceFromExplorerDrawer}
                  onDelete={deleteSessionAt}
                  onRename={renameSessionAt}
                  onRenameWorkspace={renameWorkspaceAt}
                  embeddedHeader
                  fontSizePx={sessionExplorerFontSizePx}
                  getCachedSessionView={getCachedSessionView}
                  onOpenSessionInfo={openExplorerDrawerSessionInfo}
                  onWorkspaceInfo={openExplorerDrawerWorkspaceInfo}
                />
              ) : mobileExplorerTab === 'files' ? (
                <Suspense fallback={<div className="p-3 text-xs text-sidebar-foreground/60">Loading files...</div>}>
                  <SessionFilesPanel
                    mode="sidebar"
                    socket={workspaceExplorerBinding.socket}
                    workspaceId={fileExplorerWorkspaceId}
                    sessionId={workspaceExplorerBinding.sessionId}
                    cwd={currentCwd}
                    fontSizePx={fileExplorerFontSizePx}
                  />
                </Suspense>
              ) : (
                <Suspense fallback={<div className="p-3 text-xs text-sidebar-foreground/60">Loading source control...</div>}>
                  <SourceControlPanel
                    socket={workspaceExplorerBinding.socket}
                    workspaceId={fileExplorerWorkspaceId}
                    sessionId={workspaceExplorerBinding.sessionId}
                    cwd={currentCwd}
                    fontSizePx={fileExplorerFontSizePx}
                  />
                </Suspense>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={inspectorDrawerOpen && !wideLayout && hasSelectedSession} onOpenChange={setInspectorDrawerOpen}>
        <DialogContent
          className="right-0 top-0 h-[var(--ak-viewport-h,100dvh)] max-h-[var(--ak-viewport-h,100dvh)] w-screen max-w-none !left-auto !translate-x-0 !translate-y-0 overflow-hidden p-0 gap-0 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] pr-[env(safe-area-inset-right)] sm:w-[26rem] sm:rounded-none"
          data-testid="inspector-drawer-mobile"
        >
          <DialogHeader className="sr-only">
            <DialogTitle>{t('app.openInspector')}</DialogTitle>
            <DialogDescription>{t('app.inspectorDescription')}</DialogDescription>
          </DialogHeader>
          <div className="h-full min-h-0 pb-[env(safe-area-inset-bottom)]">
            <InspectorPanel
              state={session.state}
              config={session.config}
              contextSnapshot={session.contextSnapshot}
              timeline={session.timeline}
              visibleMessagesCount={chatMessages.length}
              socket={session.socket}
              parentSessionId={session.parentSessionId}
              parentCursor={session.parentCursor}
              onFork={(cursor) => {
                if (activeSessionId !== null) session.socket?.emit('client:fork', { sourceSessionId: activeSessionId, cursor })
                setInspectorDrawerOpen(false)
              }}
              onJumpToMessage={(index) => {
                setHighlightIndex(index)
                const el = document.getElementById(`msg-${index}`)
                if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
                window.setTimeout(() => {
                  setHighlightIndex((cur) => (cur === index ? null : cur))
                }, 1400)
                setInspectorDrawerOpen(false)
              }}
              onCollapse={() => setInspectorDrawerOpen(false)}
            />
          </div>
        </DialogContent>
      </Dialog>
      <ChangeCwdDialog
        open={cwdDialogOpen}
        socket={session.socket}
        workspace={currentWorkspaceExecutor}
        currentCwd={currentCwd}
        onSave={submitCwd}
        onOpenChange={setCwdDialogOpen}
      />
      {settingsOpen ? (
        <Suspense fallback={null}>
          <SettingsDialog
            open={settingsOpen}
            onOpenChange={setSettingsOpen}
            onModelsChanged={reloadModels}
            executors={control.executors}
            sessionCache={sessionViewCache}
          />
        </Suspense>
      ) : null}
      <SessionMetadataDialog
        open={metadataOpen}
        onOpenChange={(open) => {
          setMetadataOpen(open)
          if (!open) setMetadataSessionId(null)
        }}
        sessionId={metadataTargetSessionId ?? ''}
        summary={metadataSession}
        state={metadataIsCurrentSession ? session.state : null}
        selectedModel={metadataIsCurrentSession ? session.selectedModel : metadataSession?.preferences?.selectedModel ?? null}
        {...(metadataIsCurrentSession && executorHost !== undefined ? { executorHost } : {})}
        onRename={(label) => {
          if (metadataTargetSessionId !== null) renameSessionAt(metadataTargetSessionId, label)
        }}
        onOpenChangeCwdDialog={() => {
          if (metadataIsCurrentSession) openCwdDialog()
        }}
        onChangeApprovalMode={(mode) => {
          if (metadataIsCurrentSession) onApprovalModeChange(mode)
        }}
        onChangeToolCardMode={(mode: ToolCardMode) => {
          if (controlSocket && metadataTargetSessionId !== null) {
            updateSessionPreferences(controlSocket, metadataTargetSessionId, { toolCardMode: mode })
          }
        }}
      />
      <WorkspacePicker
        open={pendingWorkspacePick !== null}
        workspaces={control.executors}
        initialWorkspaceId={pendingWorkspacePick?.workspaceId}
        socket={session.socket}
        error={workspacePickError}
        submitting={workspacePickSubmitting}
        onCreate={({ workspaceId, workspaceName, cwd }) =>
          void pickWorkspaceForNew(workspaceId, workspaceName, cwd)
        }
        onCreateSimpleChat={() => void startSimpleChat()}
        onCancel={() => {
          setPendingWorkspacePick(null)
          setWorkspacePickError(null)
          setWorkspacePickSubmitting(false)
        }}
      />
      <ConnectWorkspaceDialog
        open={connectWorkspaceOpen}
        onOpenChange={setConnectWorkspaceOpen}
      />
      <WorkspaceMetadataDialog
        open={workspaceInfoId !== null}
        onOpenChange={(open) => {
          if (!open) setWorkspaceInfoId(null)
        }}
        workspaceId={workspaceInfoId ?? ''}
        executor={workspaceInfoExecutor}
        sessions={workspaceInfoSessions}
        onRename={(name) => renameWorkspaceAt(workspaceInfoId ?? '', name)}
      />
      <Suspense fallback={null}>
        <WorkspaceFileViewDialog
          open={workspaceFileViewTarget !== null}
          onOpenChange={(open) => {
            if (!open) setWorkspaceFileViewTarget(null)
          }}
          socket={session.socket}
          workspaceId={fileExplorerWorkspaceId}
          sessionId={hasSelectedSession ? activeSessionId ?? undefined : undefined}
          cwd={currentCwd}
          target={workspaceFileViewTarget}
        />
      </Suspense>
      <CommandPalette
        open={commandPaletteOpen}
        onOpenChange={setCommandPaletteOpen}
        commands={commandPaletteCommands}
      />
      <Toaster
        position="bottom-right"
        theme={effectiveTheme}
        duration={4000}
        gap={8}
        offset={16}
        toastOptions={{
          // Match the app's flat, muted style instead of sonner's default
          // shouty `richColors` variants. A subtle left border carries the
          // severity, everything else stays bg-popover/text-foreground.
          unstyled: false,
          classNames: {
            toast:
              'group toast border border-border/70 bg-popover text-popover-foreground shadow-md rounded-md text-xs pl-3 pr-3 py-2 border-l-2',
            title: 'text-xs font-medium',
            description: 'text-[11px] text-muted-foreground mt-0.5',
            actionButton: 'text-[11px] px-2 py-0.5 rounded bg-accent text-accent-foreground hover:bg-accent/80',
            success: 'border-l-emerald-500/70',
            info: 'border-l-sky-500/70',
            warning: 'border-l-amber-500/70',
            error: 'border-l-rose-500/70',
          },
        }}
      />
      </div>
    </div>
    </PwaLifecycleHost>
  )
}

function hasCompactableContent(state: import('@agent-kernel/kernel').AgentState | null): boolean {
  return state?.messages.some((m, index) => !(index === 0 && m.role === 'system')) ?? false
}

function isEditable(el: HTMLElement): boolean {
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return true
  if (el.isContentEditable) return true
  return false
}

function isResting(status: import('@agent-kernel/kernel').AgentState['status']): boolean {
  return isSessionResting({ status })
}

function isCompactTerminalEvent(kind: string): boolean {
  return kind === 'messages_replaced'
}

function isCompactionSuccess(event: { kind: string; reason?: string }): boolean {
  return event.kind === 'messages_replaced' && event.reason === 'compaction'
}

function compactFailureMessage(event: { kind: string; reason?: string }): string {
  if (event.reason) return compactReasonMessage(event.reason)
  return 'Compaction failed.'
}

function compactReasonMessage(reason: string): string {
  switch (reason) {
    case 'summary_schema_invalid':
      return 'Compaction summary was missing required sections.'
    case 'summary_too_short':
      return 'Compaction summary was too short to be useful.'
    case 'summary_conversational':
      return 'Compaction summary looked conversational instead of structured.'
    case 'post_compaction_still_over_budget':
      return 'Compaction did not reduce context enough.'
    case 'circuit_breaker_open':
      return 'Auto compaction is paused after repeated failures.'
    case 'session_busy':
      return 'Compaction skipped while the session is busy.'
    case 'empty':
      return 'Nothing to compact yet.'
    default:
      return reason.replace(/_/g, ' ')
  }
}

function sessionActivityStatus({
  status,
  streamingActive,
  awaitingAck,
  compactRunning,
}: {
  status: import('@agent-kernel/kernel').AgentState['status'] | undefined
  streamingActive: boolean
  awaitingAck: boolean
  compactRunning: boolean
}): SessionActivityStatus | undefined {
  if (awaitingAck || streamingActive || compactRunning) return 'loading'
  if (!status) return undefined
  return status
}

function isRunningSessionActivity(status: SessionActivityStatus | undefined): boolean {
  return isSessionRunning({ status })
}

function isWaitingForUserInput({
  status,
  streamingActive,
  awaitingAck,
  pendingApprovalsCount,
}: {
  status: import('@agent-kernel/kernel').AgentState['status'] | undefined
  streamingActive: boolean
  awaitingAck: boolean
  pendingApprovalsCount: number
}): boolean {
  if (awaitingAck || streamingActive || pendingApprovalsCount > 0) return false
  return deriveSessionState({ status }).canAcceptUserMessage
}

function mergeOptimisticQueuedMessages(
  serverMessages: readonly QueuedMessagePreview[],
  optimisticMessages: readonly QueuedMessagePreview[],
): readonly QueuedMessagePreview[] {
  if (optimisticMessages.length === 0) return serverMessages
  const serverKeys = new Set(serverMessages.map((item) => queuedMessageKey(item)))
  return [
    ...serverMessages,
    ...optimisticMessages.filter((item) => !serverKeys.has(queuedMessageKey(item))),
  ]
}

export function reconcileOptimisticQueuedMessages(
  optimisticMessages: readonly QueuedMessagePreview[],
  serverMessages: readonly QueuedMessagePreview[],
  timeline: readonly TimelineEntry[] = [],
): readonly QueuedMessagePreview[] {
  if (optimisticMessages.length === 0) return optimisticMessages
  const serverKeys = new Set(serverMessages.map((item) => queuedMessageKey(item)))
  const ackedUserTexts = new Map<string, number[]>()
  for (const entry of timeline) {
    if (entry.event.kind !== 'user_message') continue
    const text = entry.event.text ?? entry.event.content?.map((part) => part.type === 'text' ? part.text : '').join('') ?? ''
    const ts = Date.parse(entry.ts)
    const bucket = ackedUserTexts.get(text) ?? []
    bucket.push(Number.isFinite(ts) ? ts : Number.POSITIVE_INFINITY)
    ackedUserTexts.set(text, bucket)
  }
  const next = optimisticMessages.filter((item) => {
    if (serverKeys.has(queuedMessageKey(item))) return false
    const bucket = ackedUserTexts.get(item.text)
    if (!bucket || bucket.length === 0) return true
    const createdAt = Date.parse(item.createdAt)
    const minTs = Number.isFinite(createdAt) ? createdAt : Number.NEGATIVE_INFINITY
    const index = bucket.findIndex((ts) => ts >= minTs)
    if (index === -1) return true
    bucket.splice(index, 1)
    return false
  })
  return next.length === optimisticMessages.length ? optimisticMessages : next
}

function queuedMessageKey(item: QueuedMessagePreview): string {
  return `${item.mode}\u0000${item.text}`
}

export function sessionExists(
  sessions: readonly SessionSummary[],
  sessionId: string | null | undefined,
): boolean {
  return Boolean(sessionId && sessions.some((s) => s.sessionId === sessionId))
}

export function sessionIdsForCacheInvalidation(
  sessions: readonly SessionSummary[],
  rootSessionId: string,
  cascade: boolean,
): readonly string[] {
  if (!cascade) return [rootSessionId]
  const childrenByParent = new Map<string, string[]>()
  for (const session of sessions) {
    if (!session.parentSessionId) continue
    const children = childrenByParent.get(session.parentSessionId) ?? []
    children.push(session.sessionId)
    childrenByParent.set(session.parentSessionId, children)
  }
  const out: string[] = []
  const seen = new Set<string>()
  const queue = [rootSessionId]
  while (queue.length > 0) {
    const id = queue.shift()!
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id)
    queue.push(...(childrenByParent.get(id) ?? []))
  }
  return out
}

export function removedSessionIds(
  previousIds: ReadonlySet<string>,
  nextIds: ReadonlySet<string>,
): readonly string[] {
  const removed: string[] = []
  for (const id of previousIds) {
    if (!nextIds.has(id)) removed.push(id)
  }
  return removed
}

export function nextSessionSelection({
  sessions,
  currentSessionId,
  explicit,
}: {
  sessions: readonly SessionSummary[]
  currentSessionId: string | null
  explicit: boolean
}): SessionSummary | null {
  if (sessions.length === 0) return null
  if (currentSessionId === null) return null
  const currentExists = sessionExists(sessions, currentSessionId)
  if (explicit && currentExists) return null
  const candidates = currentExists ? sessions : sessions.filter((s) => s.sessionId !== currentSessionId)
  return candidates.find((s) => s.eventCount > 0) ?? candidates[0] ?? null
}

type Config = {
  sessionId: string | null
  explicit: boolean
  token?: string
}

function readInitialConfig(): Config {
  const url = new URL(window.location.href)
  const fromUrl = url.searchParams.get('sessionId')
  const sessionId = fromUrl ?? crypto.randomUUID()
  const explicit = fromUrl !== null
  const token = url.searchParams.get('token') ?? undefined
  if (token !== undefined) {
    // Strip the bootstrap token from the address bar so it doesn't leak
    // into browser history, referrer headers, screenshots, or bookmarks.
    url.searchParams.delete('token')
    window.history.replaceState(null, '', url.toString())
  }
  return { sessionId, explicit, ...(token !== undefined ? { token } : {}) }
}

export function NoSessionArea({
  onNewSession,
  hasSessions,
}: {
  onNewSession(): void
  hasSessions: boolean
}): JSX.Element {
  const { t } = useTranslation()
  return (
    <div
      className="flex-1 min-h-0 flex items-center justify-center bg-background"
      data-testid="no-session-placeholder"
    >
      <div className="flex max-w-md flex-col items-center gap-4 px-6 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-muted/60">
          <Sparkles className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
        </div>
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          {t('app.noSessionTitle')}
        </h1>
        <p className="text-sm text-muted-foreground">
          {hasSessions
            ? t('app.noSessionWithSessions')
            : t('app.noSessionEmpty')}
        </p>
        <Button type="button" onClick={() => onNewSession()} data-testid="no-session-new-button">
          {t('app.newSessionButton')}
        </Button>
      </div>
    </div>
  )
}

const LOWER_EXPLORER_TABS: ReadonlyArray<{ id: LowerExplorerTab; label: string; icon: ReactNode }> = [
  { id: 'files', label: 'File', icon: <Files className="h-3.5 w-3.5" /> },
  { id: 'git', label: 'Git', icon: <FolderGit2 className="h-3.5 w-3.5" /> },
]

const MOBILE_EXPLORER_TABS: ReadonlyArray<{ id: MobileExplorerTab; label: string; icon: ReactNode }> = [
  { id: 'sessions', label: 'Session', icon: <Menu className="h-3.5 w-3.5" /> },
  ...LOWER_EXPLORER_TABS,
]

function LowerExplorerTabBar({ active, onSelect }: { active: LowerExplorerTab; onSelect(tab: LowerExplorerTab): void }): JSX.Element {
  return (
    <div className="flex h-8 flex-none items-center border-b border-sidebar-border px-1.5">
      <ExplorerSegmentedTabs tabs={LOWER_EXPLORER_TABS} active={active} onSelect={onSelect} columns="grid-cols-2" compact />
    </div>
  )
}

function MobileExplorerTabBar({ active, onSelect }: { active: MobileExplorerTab; onSelect(tab: MobileExplorerTab): void }): JSX.Element {
  return <ExplorerSegmentedTabs tabs={MOBILE_EXPLORER_TABS} active={active} onSelect={onSelect} columns="grid-cols-3" showIcons />
}

function LowerExplorerArea({ active, onSelect, socket, workspaceId, sessionId, cwd, fontSizePx }: {
  active: LowerExplorerTab
  onSelect(tab: LowerExplorerTab): void
  socket: DashboardSocket | null
  workspaceId?: string
  sessionId?: string | null
  cwd: string
  fontSizePx: number
}): JSX.Element {
  return (
    <>
      <LowerExplorerTabBar active={active} onSelect={onSelect} />
      <div className="min-h-0 flex-1 overflow-hidden">
        {active === 'files' ? (
          <div className="h-full min-h-0" data-testid="session-files-sidebar">
            <Suspense fallback={<div className="p-3 text-xs text-sidebar-foreground/60">Loading files...</div>}>
              <SessionFilesPanel
                mode="sidebar"
                socket={socket}
                workspaceId={workspaceId}
                sessionId={sessionId ?? null}
                cwd={cwd}
                fontSizePx={fontSizePx}
              />
            </Suspense>
          </div>
        ) : (
          <Suspense fallback={<div className="p-3 text-xs text-sidebar-foreground/60">Loading source control...</div>}>
            <SourceControlPanel
              socket={socket}
              workspaceId={workspaceId}
              sessionId={sessionId}
              cwd={cwd}
              fontSizePx={fontSizePx}
            />
          </Suspense>
        )}
      </div>
    </>
  )
}

function ExplorerSegmentedTabs<T extends string>({ tabs, active, onSelect, columns, compact = false, showIcons = false }: { tabs: ReadonlyArray<{ id: T; label: string; icon: ReactNode }>; active: T; onSelect(tab: T): void; columns: string; compact?: boolean; showIcons?: boolean }): JSX.Element {
  return (
    <div className={cn('grid min-w-0 flex-1 rounded-md border border-sidebar-border bg-sidebar-accent/40 p-0.5', columns)}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          className={cn(
            'flex min-w-0 items-center justify-center rounded font-medium transition-colors',
            compact ? 'h-6 gap-1 px-1.5 text-[11px]' : showIcons ? 'h-8 gap-1 px-1.5 text-xs' : 'h-8 gap-1.5 px-2 text-xs',
            active === tab.id ? 'bg-background text-foreground shadow-sm' : 'text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground',
          )}
          onClick={() => onSelect(tab.id)}
          aria-pressed={active === tab.id}
          data-testid={`explorer-tab-${tab.id}`}
        >
          <span className={cn('flex-none', showIcons ? 'inline-flex' : 'hidden sm:inline-flex')}>{tab.icon}</span>
          <span className="min-w-0 truncate">{tab.label}</span>
        </button>
      ))}
    </div>
  )
}

function SidebarCollapseButton({ onCollapse }: { onCollapse(): void }): JSX.Element {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="h-7 w-7 text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground"
      title="Hide sidebar"
      aria-label="Hide sidebar"
      data-testid="sidebar-collapse-button"
      onClick={(event) => {
        event.stopPropagation()
        onCollapse()
      }}
    >
      <PanelLeftClose className="h-3.5 w-3.5" aria-hidden="true" />
    </Button>
  )
}

function SessionErrorBanner({ error }: { error: SessionErrorEvent | null }): JSX.Element | null {
  const shouldShow = Boolean(error)
  // Signature identifies a distinct error occurrence, so a fresh error after a
  // dismissed one still surfaces.
  const signature = useMemo(() => {
    if (!error) return ''
    return `${error.scope}\u0000${error.message}`
  }, [error])
  const [dismissedSignature, setDismissedSignature] = useState<string | null>(null)
  useEffect(() => {
    if (!shouldShow) setDismissedSignature(null)
  }, [shouldShow])
  if (!shouldShow || !error) return null
  if (dismissedSignature === signature) return null
  return (
    <BannerSlot>
      <div
        className="flex items-start gap-2 border-t border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300"
        data-testid="session-error"
        role="status"
      >
        <span className="min-w-0 flex-1">
          [{error.scope}] {error.message}
        </span>
        <button
          type="button"
          onClick={() => setDismissedSignature(signature)}
          aria-label="Dismiss error"
          title="Dismiss"
          data-testid="session-error-dismiss"
          className="flex-none rounded p-0.5 text-rose-600/80 transition-colors hover:bg-rose-100 hover:text-rose-800 dark:text-rose-300/80 dark:hover:bg-rose-900/60 dark:hover:text-rose-100"
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>
    </BannerSlot>
  )
}

function SessionLoadingArea(): JSX.Element {
  const { t } = useTranslation()
  return (
    <div
      className="flex-1 min-h-0 flex items-center justify-center bg-background text-sm text-muted-foreground"
      data-testid="session-loading-placeholder"
    >
      <div className="inline-flex items-center gap-2">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        <span>{t('common.loading')}</span>
      </div>
    </div>
  )
}

export function WorkbenchToolbar({
  sessionLabel,
  sessionActivityStatus,
  cwd,
  onOpenTopbar,
  topbarAvailable,
  onOpenExplorer,
  explorerAvailable,
  onOpenInspector,
  inspectorAvailable,
  onChangeCwd,
  sessionSelected,
  sessionLoading = false,
}: {
  sessionLabel: string
  sessionActivityStatus?: SessionActivityStatus
  cwd: string
  onOpenTopbar(): void
  topbarAvailable: boolean
  onOpenExplorer(): void
  explorerAvailable: boolean
  onOpenInspector(): void
  inspectorAvailable: boolean
  onChangeCwd(): void
  sessionSelected: boolean
  sessionLoading?: boolean
}): JSX.Element {
  const { t } = useTranslation()
  const displayLabel = sessionSelected ? sessionLabel : sessionLoading ? t('common.loading') : t('app.noSessionSelected')
  return (
    <div
      className="flex min-h-9 flex-none items-center gap-1.5 bg-card px-2 py-1 text-sm text-card-foreground backdrop-blur-md sm:gap-2 sm:px-3"
      data-testid="workbench-toolbar"
    >
      {topbarAvailable ? (
        <Button
          variant="ghost"
          size="icon"
          onClick={onOpenTopbar}
          title={t('app.expandTopbar')}
          aria-label={t('app.expandTopbar')}
          data-testid="topbar-toggle"
          className="h-9 w-9 flex-none sm:h-8 sm:w-8"
        >
          <ChevronDown className="h-4 w-4" />
        </Button>
      ) : null}
      {explorerAvailable ? (
        <Button
          variant="ghost"
          size="icon"
          onClick={onOpenExplorer}
          title={t('app.openExplorer')}
          aria-label={t('app.openExplorer')}
          data-testid="explorer-toggle"
          className="h-9 w-9 flex-none sm:h-8 sm:w-8"
        >
          <Menu className="h-4 w-4" />
        </Button>
      ) : null}
      <span
        className="inline-flex min-w-0 max-w-[55vw] items-center gap-1.5 sm:max-w-none"
        title={displayLabel}
        data-testid="session-title"
        data-loading={sessionLoading ? 'true' : undefined}
      >
        {sessionSelected ? (
          <SessionStatusIndicator status={sessionActivityStatus} selected />
        ) : sessionLoading ? (
          <Loader2 className="h-3.5 w-3.5 flex-none animate-spin text-muted-foreground" aria-hidden="true" />
        ) : null}
        <span className="min-w-0 truncate font-medium" data-testid="session-label">
          {displayLabel}
        </span>
      </span>
      {sessionSelected ? (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={onChangeCwd}
        title={cwd ? t('app.changeSessionCwd', { cwd }) : t('app.setSessionCwd')}
        data-testid="cwd-button"
        className="hidden h-8 min-w-0 max-w-[34vw] justify-start gap-1.5 px-2 text-xs text-muted-foreground dark:text-muted-foreground sm:inline-flex lg:max-w-[45%]"
      >
        <FolderOpen className="h-3.5 w-3.5 flex-none" />
        <span className="min-w-0 truncate font-mono" data-testid="cwd-label">
          {cwd || t('app.cwdUnset')}
        </span>
      </Button>
      ) : null}
      <span className="min-w-0 flex-1" />
      {inspectorAvailable ? (
        <Button
          variant="ghost"
          size="icon"
          onClick={onOpenInspector}
          title={t('app.openInspector')}
          aria-label={t('app.openInspector')}
          data-testid="inspector-toggle"
          className="h-9 w-9 flex-none sm:h-8 sm:w-8"
        >
          <PanelRight className="h-4 w-4" />
        </Button>
      ) : null}
    </div>
  )
}

function ConnectionStatus({ status }: { status: string }): JSX.Element {
  const { t } = useTranslation()
  const label = hostStatusLabel(status, t)
  return (
    <div
      className="inline-flex h-8 w-8 flex-none items-center justify-center rounded-md px-0 text-xs text-muted-foreground transition-[background-color,color,transform] duration-150 hover:bg-accent/60 hover:text-foreground hover:scale-[1.02] motion-reduce:transition-none motion-reduce:hover:scale-100 sm:w-auto sm:gap-1.5 sm:px-2"
      data-testid="connection-status"
      data-status={status}
      title={label}
      aria-label={label}
    >
      <span className={cn('h-2 w-2 flex-none rounded-full transition-colors duration-300', statusDot(status))} />
      <span className="hidden sm:inline">{label}</span>
    </div>
  )
}

function hostStatusLabel(status: string, t: ReturnType<typeof useTranslation>['t']): string {
  if (status === 'ready') return t('common.connected')
  if (status === 'connecting') return t('common.connecting')
  if (status === 'disconnected') return t('common.disconnected')
  if (status === 'error') return t('common.connectionError')
  return status
}

function statusDot(status: string): string {
  if (status === 'ready') return 'bg-emerald-500'
  if (status === 'error' || status === 'disconnected') return 'bg-rose-500'
  if (status === 'connecting') return 'bg-amber-500 ak-status-pulse'
  return 'bg-muted'
}

function newPendingMessageId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function LineageBar({
  parentSessionId,
  parentCursor,
  parentAvailable,
  onGoParent,
}: {
  parentSessionId: string
  parentCursor: number | null
  parentAvailable: boolean
  onGoParent(): void
}): JSX.Element {
  return (
    <div className="px-3 py-2 border-b border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/30 text-xs text-amber-800 dark:text-amber-200 flex items-center gap-2">
      <span>
        forked from{' '}
        <span className="font-mono">
          {parentSessionId}
          {parentCursor !== null ? `@${parentCursor}` : ''}
        </span>
      </span>
      <Button
        variant={parentAvailable ? 'link' : 'ghost'}
        size="sm"
        onClick={onGoParent}
        disabled={!parentAvailable}
        data-testid="go-parent-session"
        title={parentAvailable ? 'Open parent session' : 'Parent session is no longer available'}
        className={cn(
          'ml-auto h-auto p-0 text-amber-700 dark:text-amber-300',
          !parentAvailable && 'cursor-not-allowed text-amber-700/60 hover:bg-transparent hover:text-amber-700/60 dark:text-amber-300/60 dark:hover:text-amber-300/60',
        )}
      >
        {parentAvailable ? 'go to parent' : 'parent deleted'}
      </Button>
    </div>
  )
}
