import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Archive, Boxes, ChevronDown, ChevronRight, ChevronUp, Clock3, Eraser, FolderOpen, GitBranch, Info, ListChecks, Loader2, Menu, Moon, PanelLeftClose, PanelRight, PanelRightClose, Plus, Settings, ShieldCheck, Sparkles, Square, SquareTerminal, Sun, Workflow, X } from 'lucide-react'
import { HelpHint } from './components/ui/help-hint.js'
import { useTranslation } from 'react-i18next'
import { Toaster } from 'sonner'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { shouldCompactContext } from '@agent-kernel/shared/context-policy'
import { notify } from './notify.js'

import type { Message, MessageContent, ReferencedFileContent } from '@agent-kernel/kernel'

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
  AttachedExecutor,
  ToolCardMode,
} from '@agent-kernel/shared'
import { isSessionResting } from '@agent-kernel/shared'

import { Button, buttonVariants } from './components/ui/button.js'
import { ProductState } from './components/ui/product-state.js'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './components/ui/alert-dialog.js'
import { cn } from './lib/utils.js'
import { randomId } from './lib/random-id.js'
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
import { deriveAgentProgress } from './features/chat/agent-progress.js'
import { ApprovalCard } from './features/chat/ApprovalCard.js'
import { AskUserChoiceCard } from './features/chat/AskUserChoiceCard.js'
import { BackgroundShellsButton } from './features/chat/BackgroundTerminalPanel.js'
import { ChatPanel, type WorkspaceFileTarget } from './features/chat/ChatPanel.js'
import { APPROVAL_MODES, Composer } from './features/chat/Composer.js'
import { SimpleChatDraft } from './features/chat/SimpleChatDraft.js'
import { ComposerFlipContainer } from './features/chat/ComposerFlipContainer.js'
import { ContextPressureBanner } from './features/chat/ContextPressureBanner.js'
import { BannerStack, BannerSlot } from './features/chat/BannerStack.js'
import { OfflineBanner, PwaLifecycleHost, PwaUpdateGlobalBanner } from './features/chat/PwaBanners.js'
import { isStandalone } from './lib/pwa.js'
import { loadDashboardExport } from './lib/dashboard-version-recovery.js'
import { CommandPalette, type CommandPaletteItem } from './features/command/CommandPalette.js'
import { SessionMetadataDialog } from './features/chat/SessionMetadataDialog.js'
import { ChangeCwdDialog } from './features/chat/ChangeCwdDialog.js'
import { ConnectWorkspaceDialog } from './features/explorer/ConnectWorkspaceDialog.js'
import { ExecutorPairingPrompt } from './features/explorer/ExecutorPairingPrompt.js'
import { WorkspaceMetadataDialog } from './features/explorer/WorkspaceMetadataDialog.js'
import { TasksButton } from './features/chat/TasksButton.js'
import { tasksFromMessages, tasksFromTimeline } from './features/chat/tasks-from-timeline.js'
import { taskGraphFromTimeline } from './features/chat/task-graph-from-timeline.js'
import { TaskGraphButton } from './features/chat/TaskGraphButton.js'
import { Explorer, NewChatButton, SessionStatusIndicator, type SessionActivityStatus } from './features/explorer/Explorer.js'
import { WorkspacePicker } from './features/explorer/WorkspacePicker.js'
import { SessionPreviewStore } from './features/explorer/session-preview-store.js'
import { InspectorPanel } from './features/inspector/InspectorPanel.js'
import { RightPanel, type RightPanelTab } from './features/right-panel/RightPanel.js'
import { SessionTabStrip } from './features/session-tabs/SessionTabStrip.js'
import { useSessionTabs } from './session-tabs.js'
import { AppShellGlobalActions, AppShellNav } from './app-shell/AppShellNav.js'
import { parseSessionDeepLink, useAppSection, useSessionDeepLink, type AppSection } from './app-shell/section.js'
import { useRuntimeDeployment } from './runtime-capabilities.js'
import { configureArtifactClient } from './features/artifacts/artifact-client.js'
import { useAuthSession } from './auth-session.js'
// Page-level lazy loading: the app boots into the "agent" section by default,
// so the five other top-level pages plus SettingsDialog are pulled in only
// when their tab (or the settings icon) is opened. Each import() becomes its
// own async chunk (see vite build output) and drops the initial JS payload
// substantially. Fallback is a bare blank div so we don't flash a skeleton
// while the chunk arrives on a fast connection.
const OperationsPage = lazy(() => loadDashboardExport(import('./features/operations/OperationsPage.js'), 'OperationsPage', 'OperationsPage'))
const ArtifactsPage = lazy(() => loadDashboardExport(import('./features/artifacts-browser/ArtifactsPage.js'), 'ArtifactsPage', 'ArtifactsPage'))
const DocsPage = lazy(() => loadDashboardExport(import('./features/docs/DocsPage.js'), 'DocsPage', 'DocsPage'))
const MemoPage = lazy(() => loadDashboardExport(import('./features/memo/MemoPage.js'), 'MemoPage', 'MemoPage'))
const PipelinePage = lazy(() => loadDashboardExport(import('./features/pipeline/PipelinePage.js'), 'PipelinePage', 'PipelinePage'))
const SettingsDialog = lazy(() => loadDashboardExport(import('./features/settings/SettingsDialog.js'), 'SettingsDialog', 'SettingsDialog'))
const SessionFilesPanel = lazy(() => loadDashboardExport(import('./features/session-files/SessionFilesPanel.js'), 'SessionFilesPanel', 'SessionFilesPanel'))
const SessionTerminalPanel = lazy(() => loadDashboardExport(import('./features/session-terminal/SessionTerminalPanel.js'), 'SessionTerminalPanel', 'SessionTerminalPanel'))
const WorkspaceFileViewDialog = lazy(() => loadDashboardExport(import('./features/session-files/SessionFilesPanel.js'), 'WorkspaceFileViewDialog', 'SessionFilesPanel'))
const SourceControlPanel = lazy(() => loadDashboardExport(import('./features/source-control/SourceControlPanel.js'), 'SourceControlPanel', 'SourceControlPanel'))
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
  respondAskUserChoice,
  setSessionApprovalMode,
  updateSessionPreferences,
  updateQueuedMessage,
  dashboardConnectionManager,
  useControlPlane,
  useDashboardControlSocket,
  useSession,
} from './session.js'
import { backgroundTerminalTasks } from './background-terminal.js'
import { resolveHostEndpoint, type ResolvedHostEndpoint } from './host-endpoint.js'
import { resolveWorkspaceExplorerBinding } from './workspace-explorer-binding.js'
import { workspaceReadBinary } from './lib/workspace-exec.js'
import { emitRpc } from './socket-rpc.js'
import { AdmissionDeliveryFailedError, AdmissionDeliveryPendingError, admitUserMessage, releaseMessageAttachments, uploadMessageAttachment } from './admission-client.js'
import { appendLiveTranscriptItems, appendTranscriptBaseItems, reconcilePendingUserMessages, transcriptBaseItems, transcriptTimelineForRuntime, type TranscriptItem } from './transcript.js'
import { compactFailureMessage, compactReasonMessage, hasCompactableContent, isCompactionSuccess, isCompactTerminalEvent, shouldShowQueuedAutoCompact } from './app-logic/compaction.js'
import { mergeOptimisticQueuedMessages, nextSessionSelection, queuedMessageKey, reconcileOptimisticQueuedMessages, removedSessionIds, sessionDisplayLabel, sessionExists, sessionIdsForCacheInvalidation } from './app-logic/session-selectors.js'
import { coarseStatusForIndicator, deriveSelectedSessionActivity, isRunningSessionActivity } from './app-logic/session-activity.js'
import { modelKey, resolveModelKey } from './app-logic/model-key.js'
import { useModels } from './app-logic/use-models.js'
import { useIsMobile, useMinWidth } from './app-logic/use-viewport.js'
import { useInterfaceScale } from './lib/interface-scale.js'
import { CHAT_FONT_SIZE_PX, SESSION_EXPLORER_FONT_SIZE_PX, FILE_EXPLORER_FONT_SIZE_PX } from './lib/display-sizes.js'
import { deleteSessionScrollState, useSessionPinnedState } from './features/chat/session-scroll-state.js'
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
  PREF_SESSION_EXPLORER_FONT_SIZE,
  PREF_TOPBAR_OPEN,
  PREF_KEEP_SCREEN_AWAKE,
  PREF_AGENT_RUNTIME,
  writeStringPref,
  useBooleanPref,
  useNumberPref,
} from './lib/prefs.js'
import {
  DEFAULT_SESSION_VIEW_CACHE_MAX_MB,
  PREF_SESSION_VIEW_CACHE_MAX_MB,
  sessionViewCacheMaxBytesFromMb,
} from './session-view-cache.js'
import { createDurableSessionViewCache, sessionCacheNamespace } from './durable-session-cache.js'
import { KERNEL_AGENT_RUNTIME_CAPABILITIES, PROTOCOL_VERSION } from '@agent-kernel/shared'
import { useInterventionDesktopNotifications } from './lib/desktop-notifications.js'
import { useNativeDesktop } from './lib/use-native-desktop.js'
import { isDesktopClient } from './lib/desktop.js'
import { AccountCenter } from './features/account/AccountCenter.js'
import { AdminCenter } from './features/admin/AdminCenter.js'
import { usePushActivityHeartbeat } from './lib/push-activity.js'
import { useRunningTitleIndicator } from './lib/running-title.js'
import { useTheme, type Theme } from './lib/theme.js'
import { useVisualViewportHeight } from './lib/useVisualViewportHeight.js'
import { useEdgeSwipe } from './lib/useEdgeSwipe.js'
import { clearAppNotificationIndicators, deriveAppBadgeCount, updateAppBadge } from './lib/app-badge.js'
import { useScreenWakeLock } from './lib/wake-lock.js'
import { useDeferredDispose } from './lib/use-deferred-dispose.js'
import {
  useBackgroundShellToasts,
  useInactiveSessionSummaryToasts,
  useSessionToasts,
} from './session-toasts.js'


// Stable empty-message reference so the memoized transcript base is not
// invalidated every render while a session's state is momentarily null.
const EMPTY_MESSAGES: readonly Message[] = []

type SlashDeleteState = {
  sessionId: string
}

const COMPACT_WATCHDOG_MS = 75_000

/**
 * Fetch the host's advertised models on mount. The host reads them from
 * `~/.claude/settings.json` and `~/.codex/config.toml`; hardcoding a list here
 * would drift away from what the host actually accepts.
 */





function PageLoadingFallback({ compact = false }: { compact?: boolean }): JSX.Element {
  const { t } = useTranslation()
  return (
    <div
      className={cn('flex items-center justify-center text-sm text-muted-foreground', compact ? 'fixed inset-0 z-40 bg-background/70' : 'h-full w-full')}
      role="status"
      aria-live="polite"
      data-testid="page-loading-fallback"
    >
      <span className="ak-loading-spinner mr-2 h-4 w-4" aria-hidden="true" />
      {t('common.loading')}
    </div>
  )
}

export function App(): JSX.Element {
  const { t } = useTranslation()
  const [config, setConfig] = useState(() => readInitialConfig())
  const [draftKey, setDraftKey] = useState(0)
  // Selection feedback is urgent and intentionally independent from the heavy
  // workspace/session hydration commit. Explorer can paint the marker first.
  const [optimisticSelectedSessionId, setOptimisticSelectedSessionId] = useState<string | null>(null)
  const [highlightIndex, setHighlightIndex] = useState<number | null>(null)
  const runtimeDeployment = useRuntimeDeployment()
  const runtimeCapabilities = runtimeDeployment.capabilities
  const privateCloudMode = runtimeDeployment.product === 'private-cloud'
  const authSession = useAuthSession(privateCloudMode)
  const productAccessReady = runtimeDeployment.loaded && !runtimeDeployment.error && (!privateCloudMode || authSession.session?.authenticated === true)
  const account = authSession.session?.authenticated ? authSession.session.profile : undefined
  useEffect(() => {
    if (!privateCloudMode || !authSession.checked || authSession.session?.authenticated !== false) return
    window.location.replace('/signed-out')
  }, [authSession.checked, authSession.session, privateCloudMode])
  const [explorerOpen, setExplorerOpen] = useBooleanPref(PREF_EXPLORER_OPEN, true)
  const [inspectorOpen, setInspectorOpen] = useBooleanPref(PREF_INSPECTOR_OPEN, true)
  const [topbarOpen, setTopbarOpen] = useBooleanPref(PREF_TOPBAR_OPEN, true)
  const [pendingWorkspacePick, setPendingWorkspacePick] = useState<
    { sessionId: string; workspaceId?: string } | null
  >(null)
  const [workspacePickError, setWorkspacePickError] = useState<string | null>(null)
  const [workspacePickSubmitting, setWorkspacePickSubmitting] = useState(false)
  const [connectWorkspaceOpen, setConnectWorkspaceOpen] = useState(false)
  const [explorerDrawerOpen, setExplorerDrawerOpen] = useState(false)
  const [inspectorDrawerOpen, setInspectorDrawerOpen] = useState(false)
  const [rightPanelTab, setRightPanelTab] = useState<RightPanelTab>('inspector')
  const [cwdDialogOpen, setCwdDialogOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [accountCenterOpen, setAccountCenterOpen] = useState(false)
  const [adminCenterOpen, setAdminCenterOpen] = useState(false)
  const [metadataOpen, setMetadataOpen] = useState(false)
  const [metadataSessionId, setMetadataSessionId] = useState<string | null>(null)
  const [slashDelete, setSlashDelete] = useState<SlashDeleteState | null>(null)
  const [slashDeletePhrase, setSlashDeletePhrase] = useState('')
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false)
  const [transcriptSearchOpen, setTranscriptSearchOpen] = useState(false)
  const [workspaceInfoId, setWorkspaceInfoId] = useState<string | null>(null)
  const [workspaceFileViewTarget, setWorkspaceFileViewTarget] = useState<WorkspaceFileTarget | null>(null)
  const [compactStatus, setCompactStatus] = useState<CompactStatus>({ kind: 'idle' })
  const [awaitingAck, setAwaitingAck] = useState(false)
  const [messageDeliveryError, setMessageDeliveryError] = useState<{ message: string; operationId?: string } | null>(null)
  // A cancel can arrive while the Host has accepted the socket request but has
  // not yet moved the durable session from idle to thinking. Keep that intent
  // until the authoritative state becomes active, then replay it exactly once.
  const [cancelPendingSessionId, setCancelPendingSessionId] = useState<string | null>(null)
  const [forkingFromSeq, setForkingFromSeq] = useState<number | null>(null)
  const [pendingUserMessages, setPendingUserMessages] = useState<readonly PendingUserTranscriptMessage[]>([])
  const [optimisticQueuedMessages, setOptimisticQueuedMessages] = useState<readonly QueuedMessagePreview[]>([])
  const compactResetTimer = useRef<number | null>(null)
  const compactStartSeq = useRef<number | null>(null)
  const inferredCompactSeq = useRef<number | null>(null)
  const suppressNextAutoSessionSelection = useRef(false)
  const pendingCreatedSessionId = useRef<string | null>(null)
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
  const interfaceScale = useInterfaceScale()
  const [chatFontSize] = useNumberPref(PREF_CHAT_FONT_SIZE, DEFAULT_CHAT_FONT_SIZE, { min: 0, max: CHAT_FONT_SIZE_PX.length - 1 })
  const [sessionExplorerFontSize] = useNumberPref(PREF_SESSION_EXPLORER_FONT_SIZE, DEFAULT_SESSION_EXPLORER_FONT_SIZE, { min: 0, max: SESSION_EXPLORER_FONT_SIZE_PX.length - 1 })
  const [fileExplorerFontSize] = useNumberPref(PREF_FILE_EXPLORER_FONT_SIZE, DEFAULT_FILE_EXPLORER_FONT_SIZE, { min: 0, max: FILE_EXPLORER_FONT_SIZE_PX.length - 1 })
  const [chatContentWidth] = useNumberPref(PREF_CHAT_CONTENT_WIDTH, DEFAULT_CHAT_CONTENT_WIDTH, { min: 0, max: 2 })
  const [chatSideSpace] = useNumberPref(PREF_CHAT_SIDE_SPACE, DEFAULT_CHAT_SIDE_SPACE, { min: 0, max: 2 })
  const [chatLineHeight] = useNumberPref(PREF_CHAT_LINE_HEIGHT, DEFAULT_CHAT_LINE_HEIGHT, { min: 0, max: 2 })
  const [chatMathScale] = useNumberPref(PREF_CHAT_MATH_SCALE, DEFAULT_CHAT_MATH_SCALE, { min: 0, max: 4 })
  // Stable display-prefs object shared by ChatPanel and Composer so streaming
  // re-renders don't hand them a fresh object identity every frame.
  const chatDisplayPrefs = useMemo(
    () => ({
      fontSize: chatFontSize,
      contentWidth: chatContentWidth,
      sideSpace: chatSideSpace,
      lineHeight: chatLineHeight,
      mathScale: chatMathScale,
    }),
    [chatFontSize, chatContentWidth, chatSideSpace, chatLineHeight, chatMathScale],
  )
  const [sessionViewCacheMaxMb] = useNumberPref(PREF_SESSION_VIEW_CACHE_MAX_MB, DEFAULT_SESSION_VIEW_CACHE_MAX_MB, { min: 0, max: 4096 })
  const [durableSessionCacheEnabled] = useBooleanPref(PREF_DURABLE_SESSION_CACHE_ENABLED, true)
  const [appBadgeEnabled] = useBooleanPref(PREF_APP_BADGE_ENABLED, true)
  const [keepScreenAwake] = useBooleanPref(PREF_KEEP_SCREEN_AWAKE, false)
  const sessionExplorerFontSizePx = (SESSION_EXPLORER_FONT_SIZE_PX[sessionExplorerFontSize] ?? 13) * interfaceScale
  const fileExplorerFontSizePx = (FILE_EXPLORER_FONT_SIZE_PX[fileExplorerFontSize] ?? 11) * interfaceScale
  const cachedSessionIdsRef = useRef<ReadonlySet<string>>(new Set())
  const [hostEndpoint, setHostEndpoint] = useState<ResolvedHostEndpoint>(() => resolveHostEndpoint())
  const identityCacheNamespace = privateCloudMode
    ? authSession.session?.authenticated ? authSession.session.cacheNamespace : 'signed-out'
    : 'local-operator'
  const cacheNamespace = `${sessionCacheNamespace(hostEndpoint.url, PROTOCOL_VERSION)}:${identityCacheNamespace}`
  const sessionViewCache = useMemo(() => createDurableSessionViewCache({
    namespace: cacheNamespace,
    maxBytes: sessionViewCacheMaxBytesFromMb(sessionViewCacheMaxMb),
    enabled: durableSessionCacheEnabled && (!privateCloudMode || authSession.session?.authenticated === true),
  }), [cacheNamespace])
  useEffect(() => {
    sessionViewCache.setMaxBytes(sessionViewCacheMaxBytesFromMb(sessionViewCacheMaxMb))
    sessionViewCache.setEnabled(durableSessionCacheEnabled && (!privateCloudMode || authSession.session?.authenticated === true))
  }, [authSession.session, durableSessionCacheEnabled, privateCloudMode, sessionViewCache, sessionViewCacheMaxMb])
  useDeferredDispose(sessionViewCache, (cache) => cache.close())
  const previewStore = useMemo(() => new SessionPreviewStore(), [cacheNamespace])
  const getCachedSessionView = useCallback((sessionId: string) => sessionViewCache.peek(sessionId), [sessionViewCache])
  const subscribeCachedSessionView = useCallback(
    (sessionId: string, listener: () => void) => sessionViewCache.subscribe(sessionId, listener),
    [sessionViewCache],
  )
  // iPad landscape/standalone still needs drawer semantics: four right-panel
  // tools do not fit safely beside the workbench at tablet widths.
  const wideLayout = useMinWidth(1180)
  const isMobile = useIsMobile()
  const { models, defaultModel, reload: reloadModels } = useModels(productAccessReady, {
    host: hostEndpoint.url,
    identity: identityCacheNamespace,
  })
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
      const command = event.metaKey || event.ctrlKey
      const key = event.key.toLocaleLowerCase()
      if (command && key === 'f' && config.sessionId !== null && !settingsOpen && !commandPaletteOpen) {
        const target = event.target as HTMLElement | null
        if (!target || !isEditable(target) || transcriptSearchOpen) {
          event.preventDefault()
          setTranscriptSearchOpen(true)
        }
        return
      }
      if (!command || key !== 'k') return
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
  }, [commandPaletteOpen, config.sessionId, settingsOpen, transcriptSearchOpen])

  useEffect(() => {
    if (!config.explicit) {
      if (window.location.search !== '') {
        window.history.replaceState(null, '', window.location.pathname + window.location.hash)
      }
      return
    }
    if (!config.sessionId) {
      if (window.location.search !== '') {
        window.history.replaceState(null, '', window.location.pathname + window.location.hash)
      }
      return
    }
    // Only sessionId belongs in the URL. The bootstrap token stays in
    // memory (see readInitialConfig) so it can't leak via history/referrer.
    const next = `?${new URLSearchParams({ sessionId: config.sessionId }).toString()}`
    if (window.location.search !== next) {
      window.history.replaceState(null, '', next + window.location.hash)
    }
  }, [config])

  useEffect(() => {
    configureArtifactClient({ host: hostEndpoint.url, ...(config.token ? { token: config.token } : {}) })
  }, [config.token, hostEndpoint.url])

  useEffect(() => {
    const refresh = () => setHostEndpoint(resolveHostEndpoint())
    window.addEventListener('agent-kernel:host-endpoint-changed', refresh)
    window.addEventListener('storage', refresh)
    return () => {
      window.removeEventListener('agent-kernel:host-endpoint-changed', refresh)
      window.removeEventListener('storage', refresh)
    }
  }, [])

  const controlSocket = useDashboardControlSocket(hostEndpoint.url, config.token, productAccessReady)
  const session = useSession({
    host: hostEndpoint.url,
    socket: controlSocket,
    sessionId: productAccessReady ? config.sessionId : null,
    cache: sessionViewCache,
    ...(config.token !== undefined ? { token: config.token } : {}),
    onForked: (p) => {
      setForkingFromSeq(null)
      setConfig((prev) => ({ ...prev, sessionId: p.sessionId, explicit: true }))
    },
  })
  useEffect(() => previewStore.connect(controlSocket, sessionViewCache), [controlSocket, previewStore, sessionViewCache])
  const control = useControlPlane(controlSocket)
  const controlSessionsRef = useRef<readonly SessionSummary[]>([])
  controlSessionsRef.current = control.sessions
  const currentSession = control.sessions.find(
    (s) => s.sessionId === config.sessionId,
  )
  const currentRuntimeDescriptor = control.agentRuntimes.find(
    (runtime) => runtime.id === (currentSession?.agentRuntime ?? 'kernel'),
  )
  const currentAgentRuntimeCapabilities = currentRuntimeDescriptor?.capabilities ?? KERNEL_AGENT_RUNTIME_CAPABILITIES
  const availableModels = currentRuntimeDescriptor?.models ?? models
  const selectedModelKey = resolveModelKey(availableModels, session.selectedModel) || session.selectedModel || ''
  const composerModel = selectedModelKey
    || (currentSession?.agentRuntime === 'copilot' ? '' : resolveModelKey(availableModels, defaultModel) || defaultModel)
    || modelKey(availableModels[0])
  useEffect(() => {
    if (!controlSocket || !currentSession?.workspaceId || !currentSession.sessionId) return
    const releaseWorkspace = dashboardConnectionManager(controlSocket).acquire(`workspace:${currentSession.workspaceId}`)
    return releaseWorkspace
  }, [controlSocket, currentSession?.sessionId, currentSession?.workspaceId])
  const activeSessionId = currentSession?.sessionId ?? null
  const explorerSelectedSessionId = optimisticSelectedSessionId ?? activeSessionId
  useEffect(() => {
    if (optimisticSelectedSessionId === null || activeSessionId !== optimisticSelectedSessionId) return
    setOptimisticSelectedSessionId(null)
  }, [activeSessionId, optimisticSelectedSessionId])
  usePushActivityHeartbeat(productAccessReady)
  // useSession updates its projection in an effect after selection changes.
  // During that render gap, the unified activity projection rejects all live
  // signals from the previous session and falls back to the selected summary.
  const selectedSessionActivity = deriveSelectedSessionActivity({
    selectedSessionId: activeSessionId,
    hydratedSessionId: session.hydratedSessionId,
    summaryStatus: currentSession?.status,
    liveStatus: session.state?.status,
    pendingCalls: session.state?.pendingCalls,
    streamingActive: session.streamingActive,
    awaitingAck,
    compactRunning: compactStatus.kind === 'running',
    lastError: session.lastError?.message,
  })
  const sessionHydrated = selectedSessionActivity.usesLiveProjection
  useScreenWakeLock(keepScreenAwake && selectedSessionActivity.derived.isRunning)

  useEffect(() => {
    // A visible app has no unread app-level notifications. Do not immediately
    // recreate a badge from persistent session status after entry cleared it.
    if (isDesktopClient()) return
    const count = document.visibilityState === 'visible' || !appBadgeEnabled ? 0 : deriveAppBadgeCount({
      sessions: control.sessions,
      activePendingApprovals: session.pendingApprovals.length,
      activeSessionHasError: Boolean(session.lastError),
      disconnected: activeSessionId !== null && (session.status === 'disconnected' || session.status === 'error'),
    })
    void updateAppBadge(count)
  }, [activeSessionId, appBadgeEnabled, control.sessions, session.lastError, session.pendingApprovals.length, session.status])
  useEffect(() => {
    if (isDesktopClient()) return
    const clearIndicators = (): void => {
      if (document.visibilityState !== 'visible') return
      void clearAppNotificationIndicators()
    }
    // Clear delivered push notifications and the Badging API count whenever
    // the installed app is entered, focused, or restored from the iOS bfcache.
    clearIndicators()
    document.addEventListener('visibilitychange', clearIndicators)
    window.addEventListener('focus', clearIndicators)
    window.addEventListener('pageshow', clearIndicators)
    return () => {
      document.removeEventListener('visibilitychange', clearIndicators)
      window.removeEventListener('focus', clearIndicators)
      window.removeEventListener('pageshow', clearIndicators)
    }
  }, [])

  useEffect(() => {
    const flushCache = (): void => { void sessionViewCache.flush() }
    window.addEventListener('pagehide', flushCache)
    return () => window.removeEventListener('pagehide', flushCache)
  }, [sessionViewCache])

  // Reliable queued-message delivery on close. A `queue` message is emitted
  // over the WebSocket, which can be lost if the browser/PWA is hard-killed
  // before the frame flushes — the user then sees the message "stuck" until
  // they reopen the app. On pagehide/hidden we re-send any queued messages the
  // host hasn't yet confirmed via navigator.sendBeacon, which the browser
  // delivers even during unload. The host enqueues + drains them with no live
  // socket required. Duplicate suppression is not needed: if the socket emit
  // already landed, this is a rare double at worst; queued follow-ups are
  // idempotent enough that reliability wins over that edge.
  const pendingBeaconRef = useRef<{ sessionId: string | null; texts: readonly string[]; url: string; token?: string }>({
    sessionId: null,
    texts: [],
    url: hostEndpoint.url,
  })
  useEffect(() => {
    pendingBeaconRef.current = {
      sessionId: activeSessionId,
      texts: optimisticQueuedMessages.map((m) => m.text).filter((t) => t.trim().length > 0),
      url: hostEndpoint.url,
      ...(config.token !== undefined ? { token: config.token } : {}),
    }
  }, [activeSessionId, optimisticQueuedMessages, hostEndpoint.url, config.token])
  useEffect(() => {
    const flush = (): void => {
      const { sessionId, texts, url, token } = pendingBeaconRef.current
      if (!sessionId || texts.length === 0 || typeof navigator.sendBeacon !== 'function') return
      const endpoint = `${url.replace(/\/$/, '')}/enhancement/action`
      for (const text of texts) {
        try {
          const payload = JSON.stringify({ action: 'enqueue-user-message', sessionId, text, ...(token ? { token } : {}) })
          navigator.sendBeacon(endpoint, new Blob([payload], { type: 'application/json' }))
        } catch {
          // Best-effort; nothing else we can do while the page is unloading.
        }
      }
    }
    const onHide = (): void => { if (document.visibilityState === 'hidden') flush() }
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', onHide)
    return () => {
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', onHide)
    }
  }, [])

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
    setCancelPendingSessionId(null)
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
    if ((status && status !== 'idle') || session.streamingActive) {
      setAwaitingAck(false)
    }
  }, [awaitingAck, session.state, session.streamingActive])

  useEffect(() => {
    if (cancelPendingSessionId === null || cancelPendingSessionId !== activeSessionId) return
    const status = session.state?.status
    if (status === 'done' || status === 'error') {
      setCancelPendingSessionId(null)
      return
    }
    if (status !== 'thinking' && status !== 'executing_tools' && status !== 'awaiting_approval') return
    if (session.socket) cancelSession(session.socket, cancelPendingSessionId)
    setCancelPendingSessionId(null)
  }, [activeSessionId, cancelPendingSessionId, session.socket, session.state?.status])

  useEffect(() => {
    setPendingUserMessages((prev) => reconcilePendingUserMessages(
      prev,
      session.timeline,
      session.queuedMessages,
      session.state?.status,
      session.streamingActive ? session.streamingText : '',
    ))
  }, [session.timeline, session.queuedMessages, session.state?.status, session.streamingText, session.streamingActive])

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
    if (shouldShowQueuedAutoCompact(session.agentRuntime, shouldQueueCompact, resting)) {
      if (compactStatus.kind === 'idle') setCompactStatus({ kind: 'queued' })
      return
    }
    if (compactStatus.kind === 'queued') setCompactStatus({ kind: 'idle' })
  }, [session.contextSnapshot, session.config?.hardThreshold, session.state?.status, compactStatus.kind])

  const onModelChange = (model: string): void => {
    if (!currentAgentRuntimeCapabilities.modelSelection) return
    if (!session.socket || config.sessionId === null) {
      notify.error('Unable to change model', { description: 'No active Session connection.' })
      return
    }
    const selected = availableModels.find((candidate) => candidate.ref === model)
    void updateSessionPreferences(session.socket, config.sessionId, { selectedModel: model }).then(() => {
      setStoredModel(model)
      try {
        localStorage.setItem(PREF_MODEL, model)
      } catch {}
      notify.success(`Model changed to ${selected?.label ?? model}`)
    }).catch((error) => {
      notify.error('Unable to change model', {
        description: error instanceof Error ? error.message : String(error),
      })
    })
  }

  const onApprovalModeChange = (mode: import('@agent-kernel/kernel').ApprovalMode): void => {
    if (!session.socket || activeSessionId === null) {
      notify.error('Unable to change approval mode', { description: 'No active Session connection.' })
      return
    }
    void setSessionApprovalMode(session.socket, activeSessionId, mode).then(() => {
      notify.success(`Approval mode changed to ${mode === 'allow_all' ? 'Allow all' : mode}`)
    }).catch((error) => {
      notify.error('Unable to change approval mode', {
        description: error instanceof Error ? error.message : String(error),
      })
    })
  }

  const runCompactNow = (): void => {
    if (!currentAgentRuntimeCapabilities.compact) return
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
      // Session state usage is lifetime/cumulative provider usage and can reach
      // billions of tokens in a long-lived Session. Compact operates on the
      // currently assembled context, so display the same bounded snapshot used
      // by the context indicator and Host compaction policy.
      tokensBefore: session.contextSnapshot?.usage.inputTokens ?? 0,
    })
    session.socket?.emit('client:compact', { sessionId: config.sessionId })
    if (!config.explicit) setConfig((prev) => ({ ...prev, explicit: true }))
  }

  const [consolidateBanner, setConsolidateBanner] = useState<
    { kind: 'success' | 'info' | 'error'; message: string } | null
  >(null)
  const consolidateBannerTimer = useRef<number | null>(null)
  const runConsolidateMemory = useCallback((): void => {
    if (!session.socket || config.sessionId === null || !currentAgentRuntimeCapabilities.memoryConsolidation) return
    const socket = session.socket
    const requestId = randomId()
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
  }, [session.socket, config.sessionId, currentAgentRuntimeCapabilities.memoryConsolidation])

  const selectSession = useCallback((sessionId: string): void => {
    setOptimisticSelectedSessionId(sessionId)
    pendingCreatedSessionId.current = null
    // Do NOT wrap this in withViewTransition: that forces a flushSync of the
    // entire App (2900-line tree + a fresh useSession socket connect + history
    // hydration) inside the browser's view-transition screenshot window, which
    // freezes the page for the whole synchronous commit — the visible "card
    // goes white, page hangs, then the chat suddenly swaps" jank. Instead we
    // let React render the sessionId change normally (non-blocking) and give
    // the chat pane its own lightweight per-session cross-fade (keyed on the
    // active session id) plus the existing loading skeleton for the hydration
    // gap. No frozen frame, and the right pane animates on every switch.
    setConfig((prev) => ({ ...prev, sessionId, explicit: true }))
  }, [])
  const selectCreatedSession = useCallback((sessionId: string): void => {
    // session:ready can arrive before the control-plane session list update.
    // Keep the intended id selected until that update makes it visible.
    pendingCreatedSessionId.current = sessionId
    setConfig((prev) => ({ ...prev, sessionId, explicit: true }))
  }, [])
  const clearSessionSelection = useCallback((): void => {
    pendingCreatedSessionId.current = null
    setOptimisticSelectedSessionId(null)
    setDraftKey((key) => key + 1)
    suppressNextAutoSessionSelection.current = true
    setMetadataOpen(false)
    setMetadataSessionId(null)
    setCwdDialogOpen(false)
    // Same rationale as selectSession: avoid a flushSync of the whole App. The
    // no-session placeholder already scale-fades in and the chat pane is keyed
    // on the active session id, so clearing gets a lightweight cross-fade too.
    setConfig((prev) => ({
      ...prev,
      sessionId: null,
      explicit: false,
    }))
  }, [])
  const newSession = useCallback((workspaceId?: string): void => {
    setWorkspacePickError(null)
    setWorkspacePickSubmitting(false)
    if (workspaceId === undefined) {
      setPendingWorkspacePick(null)
      clearSessionSelection()
      return
    }
    setPendingWorkspacePick({
      sessionId: randomId(),
      ...(workspaceId !== undefined ? { workspaceId } : {}),
    })
  }, [clearSessionSelection])
  const sessionTabs = useSessionTabs(control.sessions, config.sessionId, selectSession)
  useEffect(() => {
    if (!isStandalone()) return
    const handler = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null
      const editing = target?.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target?.tagName ?? '')
      const command = event.metaKey || event.ctrlKey
      if (command && !editing && /^[1-9]$/u.test(event.key)) { const id=sessionTabs.state.open[Number(event.key)-1]; if(id){event.preventDefault();selectSession(id)};return }
      if (command && !editing && event.key === 'Tab') { event.preventDefault();const list=sessionTabs.state.open;if(!list.length)return;const at=Math.max(0,list.indexOf(config.sessionId??''));selectSession(list[(at+(event.shiftKey?-1:1)+list.length)%list.length]!);return }
      if (command && !editing && event.key.toLowerCase()==='w' && config.sessionId) { event.preventDefault();sessionTabs.close(config.sessionId);return }
      if (command && event.shiftKey && !editing && event.key.toLowerCase()==='t') { event.preventDefault();sessionTabs.restore();return }
      if (command && !editing && event.key.toLowerCase()==='n') { event.preventDefault();newSession();return }
      if (event.altKey && !editing && event.key==='ArrowLeft'){event.preventDefault();sessionTabs.navigate(-1)}
      if (event.altKey && !editing && event.key==='ArrowRight'){event.preventDefault();sessionTabs.navigate(1)}
    }
    window.addEventListener('keydown',handler);return()=>window.removeEventListener('keydown',handler)
  },[config.sessionId,newSession,selectSession,sessionTabs])
  const clearCurrentSession = (): void => {
    if (!session.socket || config.sessionId === null || !currentAgentRuntimeCapabilities.clear) return
    sessionViewCache.delete(config.sessionId)
    clearSession(session.socket, config.sessionId)
  }
  const pickWorkspaceForNew = async (
    agentRuntime: import('@agent-kernel/shared').AgentRuntimeId,
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
        agentRuntime,
        workspaceId,
        ...(workspaceName !== undefined ? { workspaceName } : {}),
        cwd,
        ...(agentRuntime === 'kernel' ? { selectedModel: preferredModel } : {}),
      })
      selectCreatedSession(sessionId)
      setPendingWorkspacePick(null)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setWorkspacePickError(message === 'runtime_not_ready' ? t('dialogs.runtimeTemporarilyReadOnly') : message)
    } finally {
      setWorkspacePickSubmitting(false)
    }
  }
  const startSimpleChat = (agentRuntime: import('@agent-kernel/shared').AgentRuntimeId): void => {
    writeStringPref(PREF_AGENT_RUNTIME, agentRuntime)
    newSession()
  }
  const deleteSessionAt = useCallback((sessionId: string): void => {
    if (!controlSocket) {
      notify.error('Session could not be deleted', { description: 'Host is not connected.' })
      return
    }
    void deleteSession(controlSocket, sessionId).then(() => {
      for (const id of sessionIdsForCacheInvalidation(controlSessionsRef.current, sessionId)) {
        sessionViewCache.delete(id)
        deleteSessionScrollState(id)
      }
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
      notify.success('Session deleted')
    }).catch((error: unknown) => {
      notify.error('Session could not be deleted', { description: error instanceof Error ? error.message : String(error) })
    })
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
  const renameCurrentSessionFromSlash = useCallback((label: string | null): void => {
    if (activeSessionId === null) return
    if (label === null) {
      openSessionInfoDialog(activeSessionId)
      return
    }
    renameSessionAt(activeSessionId, label)
  }, [activeSessionId, openSessionInfoDialog, renameSessionAt])
  const requestSlashDeleteCurrentSession = useCallback((): void => {
    if (activeSessionId === null) return
    setSlashDelete({ sessionId: activeSessionId })
    setSlashDeletePhrase('')
  }, [activeSessionId])
  const resetSlashDelete = useCallback((): void => {
    setSlashDelete(null)
    setSlashDeletePhrase('')
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
  // Private Cloud Simple Chat has no workspace executor by design. Do not block the
  // empty-session entry point on an executor snapshot that is irrelevant there.
  // A Session directory is useful as soon as its own snapshot arrives. The
  // Executor snapshot enriches workspace presence independently and must not
  // prolong the directory's blocking state.
  const sessionListLoading = sessionDirectoryIsLoading(control.sessionsLoaded)
  const sessionDirectoryLoadingOwner = resolveSessionDirectoryLoadingOwner({
    loading: sessionListLoading && !hasSelectedSession,
    wideLayout,
    explorerOpen,
    explorerDrawerOpen,
  })
  const selectedHistorySessionLoading = Boolean(
    hasSelectedSession &&
      session.historyLoadedSessionId !== activeSessionId &&
      ((currentSession?.eventCount ?? 0) > 0 || Boolean(currentSession?.firstUserMessage)),
  )
  const currentWorkspaceExecutor = useMemo(() => {
    if (!currentSession?.workspaceId) return undefined
    return control.executors.find(
      (e) => e.workspaceId === currentSession.workspaceId,
    )
  }, [currentSession?.workspaceId, control.executors])
  // A workspace-free Chat must never silently borrow the only connected
  // Executor. File, Git, and Terminal stay unavailable until the user creates
  // or selects a workspace-bound Session.
  const fileExplorerWorkspaceId = currentSession?.workspaceId
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
    if (slashDelete === null) return
    if (control.sessions.some((s) => s.sessionId === slashDelete.sessionId)) return
    resetSlashDelete()
  }, [control.sessions, resetSlashDelete, slashDelete])

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
      pendingSessionId: pendingCreatedSessionId.current,
    })
    if (sessionExists(control.sessions, pendingCreatedSessionId.current)) {
      pendingCreatedSessionId.current = null
    }
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
  const sessionLabel = sessionDisplayLabel(currentSession, t('app.newSession'))
  const slashDeleteTarget = slashDelete
    ? control.sessions.find((s) => s.sessionId === slashDelete.sessionId)
    : undefined
  const slashDeleteDescendantCount = slashDelete
    ? Math.max(0, sessionIdsForCacheInvalidation(control.sessions, slashDelete.sessionId).length - 1)
    : 0
  const slashDeleteShortId = slashDelete?.sessionId.slice(0, 8) ?? ''
  const slashDeleteRequiredPhrase = slashDelete ? `DELETE ${slashDeleteShortId}` : ''
  const slashDeleteConfirmed = slashDeletePhrase.trim() === slashDeleteRequiredPhrase
  const visibleQueuedMessages = useMemo(
    () => mergeOptimisticQueuedMessages(session.queuedMessages, optimisticQueuedMessages),
    [session.queuedMessages, optimisticQueuedMessages],
  )
  // Split the transcript into a memoized, timeline-derived base (recomputed
  // only when the timeline / state messages actually change) and a cheap live
  // tail (streaming text + optimistic pending messages) appended on top. This
  // avoids iterating the entire timeline on every ~15fps streaming commit,
  // which was saturating the main thread on long sessions and dropping button
  // clicks / freezing the hover cursor while the agent ran.
  const stateMessages = session.state?.messages ?? EMPTY_MESSAGES
  const currentAgentRuntime = currentSession?.agentRuntime ?? session.agentRuntime
  const transcriptTimeline = transcriptTimelineForRuntime(
    currentAgentRuntime,
    session.timeline,
  )
  const includeStatePrefix = session.parentSessionId !== null
  const transcriptProjectionRef = useRef<{
    sessionId: string | null
    stateMessages: readonly Message[]
    includeStatePrefix: boolean
    timeline: readonly TimelineEntry[]
    items: readonly TranscriptItem[]
  } | null>(null)
  const transcriptBase = useMemo(() => {
    const previous = transcriptProjectionRef.current
    const incremental = previous
      && previous.sessionId === activeSessionId
      && previous.stateMessages === stateMessages
      && previous.includeStatePrefix === includeStatePrefix
      ? appendTranscriptBaseItems(previous.items, previous.timeline, transcriptTimeline)
      : null
    const items = incremental ?? transcriptBaseItems(stateMessages, transcriptTimeline, { includeStatePrefix })
    transcriptProjectionRef.current = { sessionId: activeSessionId, stateMessages, includeStatePrefix, timeline: transcriptTimeline, items }
    return items
  }, [activeSessionId, stateMessages, transcriptTimeline, includeStatePrefix])
  const visiblePendingUserMessages = useMemo(
    () => reconcilePendingUserMessages(
      pendingUserMessages,
      session.timeline,
      session.queuedMessages,
      session.state?.status,
      session.streamingActive ? session.streamingText : '',
      currentAgentRuntime === 'kernel' ? EMPTY_MESSAGES : stateMessages,
    ),
    [pendingUserMessages, session.timeline, session.queuedMessages, session.state?.status, session.streamingText, session.streamingActive, currentAgentRuntime, stateMessages],
  )
  const chatItems = useMemo(
    () =>
      appendLiveTranscriptItems(
        transcriptBase,
        stateMessages,
        transcriptTimeline,
        session.streamingText,
        visiblePendingUserMessages,
        visibleQueuedMessages,
        { streamingActive: session.streamingActive, streamingAnchor: session.streamingAnchor, retainedDrafts: session.retainedDrafts },
      ),
    [transcriptBase, stateMessages, transcriptTimeline, session.streamingText, session.streamingActive, session.streamingAnchor, session.retainedDrafts, visiblePendingUserMessages, visibleQueuedMessages],
  )
  // The header only needs the *count* of visible messages; derive it from the
  // already-built transcript instead of building a second full transcript.
  const chatMessagesCount = useMemo(
    () => chatItems.filter((item) => item.kind === 'message').length,
    [chatItems],
  )
  const backgroundTasks = useMemo(
    () => backgroundTerminalTasks(session.timeline),
    [session.timeline],
  )
  const taskItems = useMemo(
    () => tasksFromMessages(session.state?.messages ?? [], tasksFromTimeline(session.timeline)),
    [session.state?.messages, session.timeline],
  )
  const agentProgress = useMemo(() => deriveAgentProgress(session.state, session.timeline), [session.state, session.timeline])
  const taskGraph = useMemo(() => taskGraphFromTimeline(session.timeline), [session.timeline])
  useRunningTitleIndicator(selectedSessionActivity.derived.isRunning)
  // Coarse status for the indicators (sidebar + title): collapses the rapid
  // thinking↔executing_tools flips within a running turn so those indicators
  // (and the memoized Explorer) don't re-render on every tool step.
  const indicatorActiveSessionStatus = selectedSessionActivity.indicatorStatus
  const sidebarActiveSessionStatus = sessionHydrated ? indicatorActiveSessionStatus : undefined
  const sessionStatusesRef = useRef<{ signature: string; value: ReadonlyMap<string, SessionActivityStatus> }>({
    signature: '',
    value: new Map(),
  })
  const sessionStatuses = useMemo(() => {
    const entries: Array<[string, SessionActivityStatus]> = []
    for (const summary of control.sessions) {
      if (summary.status && isRunningSessionActivity(summary.status)) entries.push([summary.sessionId, coarseStatusForIndicator(summary.status) ?? 'loading'])
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
  const { pinned: chatPinnedToBottom, setPinned: setChatPinnedToBottom } = useSessionPinnedState(activeSessionId)
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
  const reconnectSession = useCallback(() => {
    session.socket?.disconnect()
    session.socket?.connect()
  }, [session.socket])
  const resyncSession = useCallback(() => {
    if (session.socket && activeSessionId) dashboardConnectionManager(session.socket).refresh(`session:${activeSessionId}`)
  }, [activeSessionId, session.socket])
  const sessionWorkspaceKnownOffline = Boolean(
    runtimeCapabilities.workspace &&
      hasSelectedSession &&
      session.status === 'ready' &&
      control.executorsLoaded &&
      !sessionWorkspaceOnline,
  )

  const waitingForUser = selectedSessionActivity.derived.canAcceptUserMessage
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
  useBackgroundShellToasts(backgroundTasks)

  const openCwdDialog = (): void => {
    setCwdDialogOpen(true)
  }

  const [section, setSection] = useAppSection()
  const nativeSessions = useMemo(() => control.sessions.map((summary): SessionSummary => {
    if (summary.sessionId !== activeSessionId || !sessionHydrated) return summary
    return {
      ...summary,
      status: selectedSessionActivity.derived.isRunning ? 'thinking'
        : pendingApprovalsCount > 0 && session.state?.approvalMode !== 'allow_all' ? 'awaiting_approval'
          : session.lastError ? 'error' : session.state?.status ?? summary.status,
      queuedCount: Math.max(summary.queuedCount ?? 0, session.queuedMessages.length),
    }
  }), [control.sessions, activeSessionId, sessionHydrated, selectedSessionActivity.derived.isRunning, pendingApprovalsCount, session.state?.approvalMode, session.state?.status, session.lastError, session.queuedMessages.length])
  useNativeDesktop({
    sessions: nativeSessions,
    activeSessionId,
    viewedSessionId: section === 'agent' && !accountCenterOpen && !adminCenterOpen && !settingsOpen ? activeSessionId : null,
    socket: controlSocket,
    ready: productAccessReady && control.sessionsLoaded,
    workspaceOnline: hasSelectedSession && control.executorsLoaded ? sessionWorkspaceOnline : null,
    onOpenSession: (sessionId) => {
      selectSession(sessionId)
      setAccountCenterOpen(false)
      setAdminCenterOpen(false)
      setSettingsOpen(false)
      setSection('agent')
    },
  })
  const sessionTabsNode = !explorerOpen ? <SessionTabStrip sessions={control.sessions} openIds={sessionTabs.state.open} pinned={sessionTabs.state.pinned} active={config.sessionId} onSelect={selectSession} onClose={sessionTabs.close} onPin={sessionTabs.pin} onReorder={sessionTabs.reorder} /> : undefined
  // Notification deep-links: `#/sessions/<id>` selects that session (works both
  // on cold-start openWindow and the focused-tab PUSH_NAVIGATE path).
  useSessionDeepLink(selectSession)
  // Mobile edge-swipe: a right-swipe from the left screen edge opens the
  // session explorer drawer; a left-swipe closes it. Only in the chat section
  // on narrow layouts (the drawer doesn't exist on wide/desktop, where the
  // explorer is a docked panel).
  useEdgeSwipe({
    enabled: !wideLayout && section === 'agent',
    onOpen: () => setExplorerDrawerOpen(true),
    ...(explorerDrawerOpen ? { onClose: () => setExplorerDrawerOpen(false) } : {}),
  })
  const handleSectionSelect = (next: AppSection): void => {
    setSection(next)
    // Operations, Artifacts, Pipeline, and Docs are real pages rendered inline below.
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
        disabled: !hasSelectedSession || sessionWorkspaceKnownOffline || !currentAgentRuntimeCapabilities.cwdMutation,
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
        disabled: !canRun || !currentAgentRuntimeCapabilities.compact || !hasCompactableContent(session.state),
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
        disabled: !canRun || !currentAgentRuntimeCapabilities.memoryConsolidation,
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
          if (!socket || activeSessionId === null) return
          setPendingUserMessages((items) => items.filter((item) => item.mode !== 'steer'))
          setOptimisticQueuedMessages([])
          cancelSession(socket, activeSessionId)
        },
      },
      {
        id: 'session.clear',
        group: t('commandPalette.groups.session'),
        label: t('commandPalette.commands.clearSession'),
        hint: t('commandPalette.commands.clearSessionHint'),
        icon: Eraser,
        keywords: ['reset'],
        disabled: !canRun || !currentAgentRuntimeCapabilities.clear,
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

    cmds.push({
      id: 'view.settings',
      group: t('commandPalette.groups.view'),
      label: t('commandPalette.commands.openSettings'),
      hint: t('commandPalette.commands.openSettingsHint'),
      icon: Settings,
      keywords: ['preferences', 'config'],
      run: () => setSettingsOpen(true),
    })
    cmds.push(
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

    for (const mode of currentAgentRuntimeCapabilities.approvalMode ? APPROVAL_MODES : []) {
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
          if (socket && activeSessionId !== null) void setSessionApprovalMode(socket, activeSessionId, mode.value).catch((error) => {
            notify.error('Unable to change approval mode', { description: error instanceof Error ? error.message : String(error) })
          })
        },
      })
    }

    for (const modelInfo of currentAgentRuntimeCapabilities.modelSelection ? models : []) {
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
    currentAgentRuntimeCapabilities,
    control.executors.length,
    hasSelectedSession,
    inspectorOpen,
    models,
    newSession,
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
        const requestId = randomId()
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
        const requestId = randomId()
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

  if (!runtimeDeployment.loaded || (privateCloudMode && authSession.loading && !authSession.checked)) {
    return <PageLoadingFallback compact />
  }
  if (runtimeDeployment.error || authSession.error || runtimeDeployment.unauthorized || (privateCloudMode && authSession.session?.authenticated !== true)) {
    const detail = runtimeDeployment.error ?? authSession.error ?? t('app.accessErrorDefault')
    return (
      <main className="fixed inset-0 grid place-items-center bg-background p-4 text-foreground" data-testid="product-access-error">
        <section className="w-full max-w-md rounded-2xl border bg-card p-6 shadow-xl" role="alert">
          <h1 className="text-xl font-semibold">{t('app.accessErrorTitle')}</h1>
          <p className="mt-2 text-sm text-muted-foreground">{detail}</p>
          <div className="mt-5 flex flex-wrap gap-2">
            <Button onClick={() => { window.location.href = '/auth/login?prompt=login' }}>{t('app.signInAgain')}</Button>
            <Button variant="outline" onClick={() => window.location.reload()}>{t('common.retry')}</Button>
          </div>
        </section>
      </main>
    )
  }

  const collapsedSessionTopbar = !topbarOpen && hasSelectedSession ? (
    <WorkbenchToolbar
      placement="topbar"
      brand={<TopbarBrand />}
      rightSlot={(
        <AppShellGlobalActions
          connectionStatus={<ConnectionStatus key={activeSessionId} socket={session.socket} status={session.status} transport={session.socket?.io.engine?.transport.name} cursor={session.state?.cursor ?? 0} workspaceId={currentSession?.workspaceId} executorConnected={sessionWorkspaceOnline} onResync={resyncSession} compact />}
          onOpenSettings={() => setSettingsOpen(true)}
          account={account}
          evaluationUrl={runtimeCapabilities.pipeline ? runtimeDeployment.evaluationUrl : undefined}
          accountLoading={privateCloudMode && authSession.loading}
          onOpenAccount={privateCloudMode ? () => setAccountCenterOpen(true) : undefined}
          onOpenAdmin={authSession.session?.authenticated && (authSession.session.organization?.role === 'owner' || authSession.session.organization?.role === 'admin') ? () => setAdminCenterOpen(true) : undefined}
          onSignOut={privateCloudMode ? () => {
            authSession.announceLogout()
            void sessionViewCache.clearDurable()
          } : undefined}
        />
      )}
      sessionLabel={sessionLabel}
      sessionActivityStatus={indicatorActiveSessionStatus}
      cwd={currentSession?.workspaceId ? currentCwd : ''}
      simpleChat={!currentSession?.workspaceId}
      onOpenTopbar={() => setTopbarOpen(true)}
      topbarAvailable
      onOpenExplorer={() => {
        if (wideLayout) setExplorerOpen(true)
        else setExplorerDrawerOpen(true)
      }}
      explorerAvailable={!wideLayout || !explorerOpen}
      onOpenSidebar={() => {
        if (wideLayout) setInspectorOpen(true)
        else setInspectorDrawerOpen(true)
      }}
      sidebarAvailable={!wideLayout || !inspectorOpen}
      onChangeCwd={runtimeCapabilities.workspace && currentAgentRuntimeCapabilities.cwdMutation && currentSession?.workspaceId ? openCwdDialog : undefined}
      sessionSelected
      sessionTabs={sessionTabsNode}
    />
  ) : undefined

  return (
    <PwaLifecycleHost>
    <div className="ak-app-shell ak-workspace-canvas flex flex-col text-foreground">
      {topbarOpen || !hasSelectedSession || collapsedSessionTopbar ? <AppShellNav
        section={section}
        onSelect={handleSectionSelect}
        onOpenSettings={() => setSettingsOpen(true)}
        connectionStatus={hasSelectedSession ? <ConnectionStatus key={activeSessionId} socket={session.socket} status={session.status} transport={session.socket?.io.engine?.transport.name} cursor={session.state?.cursor ?? 0} workspaceId={currentSession?.workspaceId} executorConnected={sessionWorkspaceOnline} onResync={resyncSession} /> : null}
        collapsed={!topbarOpen}
        collapsedContent={collapsedSessionTopbar}
        onCollapse={() => setTopbarOpen(false)}
        onExpand={() => setTopbarOpen(true)}
        account={account}
        evaluationUrl={runtimeCapabilities.pipeline ? runtimeDeployment.evaluationUrl : undefined}
        accountLoading={privateCloudMode && authSession.loading}
        onOpenAccount={privateCloudMode ? () => setAccountCenterOpen(true) : undefined}
        onOpenAdmin={authSession.session?.authenticated && (authSession.session.organization?.role === 'owner' || authSession.session.organization?.role === 'admin') ? () => setAdminCenterOpen(true) : undefined}
        onSignOut={privateCloudMode ? () => {
          authSession.announceLogout()
          void sessionViewCache.clearDurable()
          // Native form submission owns the authoritative POST + redirect. This
          // callback is progressive enhancement for cache and cross-tab cleanup.
        } : undefined}
      /> : null}
      {accountCenterOpen && account ? <AccountCenter profile={account} organization={authSession.session?.authenticated ? authSession.session.organization : undefined} onClose={() => setAccountCenterOpen(false)} /> : null}
      {adminCenterOpen ? <AdminCenter onClose={() => setAdminCenterOpen(false)} /> : null}
      <PwaUpdateGlobalBanner />
      <div className="min-h-0 min-w-0 max-w-full flex-1 overflow-hidden">
      <div className="hidden" data-testid="login-column-hidden" />
      {section === 'operations' ? (
        runtimeCapabilities.operations ? <Suspense fallback={<PageLoadingFallback />}>
          <OperationsPage
            deployment={runtimeDeployment}
            executors={control.executors}
            sessions={control.sessions}
            sessionStatuses={sessionStatuses}
            onOpenSession={(sessionId) => { selectSession(sessionId); setSection('agent') }}
          />
        </Suspense> : <CapabilityUnavailable title={t('app.operationsUnavailable')} />
      ) : section === 'artifacts' ? (
        runtimeCapabilities.artifacts ? <Suspense fallback={<PageLoadingFallback />}>
          <ArtifactsPage onOpenSession={(sessionId) => { selectSession(sessionId); setSection('agent') }} />
        </Suspense> : <CapabilityUnavailable title={t('app.artifactsUnavailable')} />
      ) : section === 'docs' ? (
        <Suspense fallback={<PageLoadingFallback />}>
          <DocsPage />
        </Suspense>
      ) : section === 'pipeline' ? (
        runtimeCapabilities.pipeline ? <Suspense fallback={<PageLoadingFallback />}>
          <PipelinePage />
        </Suspense> : <CapabilityUnavailable title={t('app.pipelineUnavailable')} />
      ) : section === 'memo' ? (
        <Suspense fallback={<PageLoadingFallback />}>
          <MemoPage />
        </Suspense>
      ) : (
      <ResizablePanelGroup direction="horizontal" dir="ltr" autoSaveId="ak-outer-cols-v6" className="min-w-0 max-w-full overflow-hidden">
        {wideLayout ? (
          <>
            {explorerOpen ? (
              <>
                <ResizablePanel
                  id="explorer"
                  order={1}
                  defaultSize={20}
                  minSize={12}
                  maxSize={45}
                  className="min-w-[220px] bg-transparent text-sidebar-foreground"
                  data-testid="explorer-panel"
                >
                  <div className="ak-motion-slide-left h-full min-h-0 p-3 pr-1">
                    <div className="ak-navigation-surface flex h-full min-h-0 flex-col overflow-hidden" data-testid="explorer-surface">
                      <div className="flex h-11 flex-none items-center border-b border-sidebar-border/40 bg-sidebar/65 px-2 backdrop-blur">
                        <NewChatButton onNewChat={() => newSession()} />
                        <span className="min-w-0 flex-1" />
                        <SidebarCollapseButton onCollapse={() => setExplorerOpen(false)} />
                      </div>
                      <div className="min-h-0 flex-1 overflow-hidden">
                        <Explorer executors={control.executors} sessions={control.sessions} loading={sessionDirectoryLoadingOwner === 'explorer'} selectedSessionId={explorerSelectedSessionId} sessionStatuses={sessionStatuses} onSelect={selectSession} onClearSelection={clearSessionSelection} onNewSession={newSession} onConnectWorkspace={runtimeCapabilities.workspace ? openConnectWorkspaceDialog : undefined} onDelete={deleteSessionAt} onRename={renameSessionAt} onRenameWorkspace={renameWorkspaceAt} embeddedHeader fontSizePx={sessionExplorerFontSizePx} previewStore={previewStore} onOpenSessionInfo={openSessionInfoDialog} onWorkspaceInfo={setWorkspaceInfoId} />
                      </div>
                    </div>
                  </div>
                </ResizablePanel>
                <ResizableHandle
                  id="explorer-resize-handle"
                  withHandle
                  aria-label={t('app.resizeExplorer')}
                  title={t('app.resizeExplorer')}
                  className="mx-0.5 w-2 bg-transparent after:w-3 hover:bg-sidebar-border/35 focus-visible:bg-sidebar-border/45"
                />
              </>
            ) : null}
          </>
        ) : null}
        <ResizablePanel
          id="workbench"
          order={2}
          defaultSize={wideLayout && explorerOpen ? 80 : 100}
          minSize={wideLayout && explorerOpen ? 55 : 100}
          className="min-w-0 bg-background"
          data-testid="workbench-panel"
        >
          <div className="h-full flex min-h-0 min-w-0 flex-col" data-testid="workbench">
            {topbarOpen ? <WorkbenchToolbar
              sessionLabel={sessionLabel}
              sessionActivityStatus={indicatorActiveSessionStatus}
              cwd={currentSession?.workspaceId ? currentCwd : ''}
              simpleChat={hasSelectedSession && !currentSession?.workspaceId}
              onOpenTopbar={() => setTopbarOpen(true)}
              topbarAvailable={!topbarOpen}
              onOpenExplorer={() => {
                if (wideLayout) setExplorerOpen(true)
                else setExplorerDrawerOpen(true)
              }}
              explorerAvailable={!wideLayout || !explorerOpen}
              onOpenSidebar={() => {
                if (wideLayout) setInspectorOpen(true)
                else setInspectorDrawerOpen(true)
              }}
              sidebarAvailable={hasSelectedSession && (!wideLayout || !inspectorOpen)}
              onChangeCwd={runtimeCapabilities.workspace && currentAgentRuntimeCapabilities.cwdMutation && currentSession?.workspaceId ? openCwdDialog : undefined}
              sessionSelected={hasSelectedSession}
              sessionDirectoryLoading={sessionListLoading && !hasSelectedSession}
              draft={config.sessionId === null}
              sessionTabs={sessionTabsNode}
            /> : null}
            {config.sessionId === null ? (
              <SimpleChatDraft
                key={`${cacheNamespace}:${draftKey}`}
                socket={controlSocket}
                host={hostEndpoint.url}
                token={config.token}
                agentRuntimes={control.agentRuntimes}
                models={models}
                preferredModel={preferredModel}
                displayPrefs={chatDisplayPrefs}
                onCreated={selectCreatedSession}
              />
            ) : sessionListLoading && !hasSelectedSession ? (
              <SessionDirectoryPendingArea active={sessionDirectoryLoadingOwner === 'workbench'} />
            ) : !hasSelectedSession ? (
              <NoSessionArea
                onNewSession={newSession}
                onConnectWorkspace={runtimeCapabilities.workspace ? openConnectWorkspaceDialog : undefined}
                onOpenSession={selectSession}
                onOpenWorkspace={setWorkspaceInfoId}
                sessions={control.sessions}
                executors={control.executors}
                sessionStatuses={sessionStatuses}
                hasSessions={control.sessions.length > 0}
                hasWorkspace={control.executors.length > 0}
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
                      key={activeSessionId ?? 'no-session'}
                      className="ak-motion-session-swap flex min-h-0 min-w-0 flex-col bg-background overflow-hidden"
                      data-testid="chat-panel"
                    >
                      <ChatPanel
                        sessionId={activeSessionId}
                        items={chatItems}
                        highlightIndex={highlightIndex}
                        pinnedToBottom={chatPinnedToBottom}
                        onPinnedChange={setChatPinnedToBottom}
                        scrollToBottomToken={chatScrollToBottomToken}
                        compactStatus={compactStatus}
                        liveToolActivityTailCount={liveToolActivityTailCount}
                        toolExecutionStartedAt={session.toolExecutionStartedAt}
                        toolCardMode={currentSession?.preferences?.toolCardMode ?? 'dots'}
                        displayPrefs={chatDisplayPrefs}
                        loading={selectedHistorySessionLoading}
                        onDismissCompactStatus={() => setCompactStatus({ kind: 'idle' })}
                        pendingApprovals={session.pendingApprovals}
                        activeToolCallIds={session.state?.pendingCalls.map((call) => call.callId) ?? []}
                        badgeIntentionCallId={agentProgress.intention ? agentProgress.callId : undefined}
                        onReadOverflow={readOverflow}
                        onOpenWorkspaceFile={setWorkspaceFileViewTarget}
                        searchOpen={transcriptSearchOpen}
                        onSearchOpenChange={setTranscriptSearchOpen}
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
                          if (activeSessionId === null || sessionWorkspaceKnownOffline) return
                          const pendingId = newPendingMessageId()
                          suppressNextWaitingNotification.current = true
                          setPendingUserMessages((prev) => [
                            ...prev,
                            {
                              id: pendingId,
                              text,
                              mode: 'steer',
                              createdAt: new Date().toISOString(),
                              afterSeq: session.timeline.at(-1)?.seq ?? 0,
                            },
                          ])
                          setAwaitingAck(true)
                          void admitUserMessage({
                            host: hostEndpoint.url,
                            ...(config.token ? { token: config.token } : {}),
                            sessionId: activeSessionId,
                            text,
                            mode: 'steer',
                          }).then(() => setAwaitingAck(false)).catch((error) => {
                            setPendingUserMessages((prev) => prev.filter((item) => item.id !== pendingId))
                            setAwaitingAck(false)
                            setMessageDeliveryError(error instanceof AdmissionDeliveryPendingError
                              ? { message: error.lastError ? t('composer.delivery.pendingDetail', { reason: error.lastError, attempts: error.attempts }) : t('composer.delivery.pending'), operationId: error.operationId }
                              : error instanceof AdmissionDeliveryFailedError
                                ? { message: error.lastError ?? t('composer.delivery.failed'), operationId: error.operationId }
                              : { message: error instanceof Error ? error.message : String(error) })
                            notify.error(error instanceof Error ? error.message : String(error))
                          })
                          if (!config.explicit) setConfig((prev) => ({ ...prev, explicit: true }))
                        }}
                        footerSlot={
                          selectedHistorySessionLoading ? null : <>
                            <InlineStatusRow
                              state={session.state}
                              fallbackStatus={currentSession?.status}
                              streamingActive={session.streamingActive}
                              toolExecutionStartedAt={session.toolExecutionStartedAt}
                              awaitingAck={awaitingAck}
                              progress={agentProgress}
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
                        {messageDeliveryError ? (
                          <BannerSlot>
                            <div className="flex items-start gap-3 border-t border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-200" data-testid="message-delivery-error">
                              <div className="min-w-0 flex-1">
                                <div className="font-medium">{t('composer.delivery.failedTitle')}</div>
                                <div className="mt-0.5 break-words">{messageDeliveryError.message}</div>
                                {messageDeliveryError.operationId ? <div className="mt-1 font-mono text-[0.625rem] opacity-75">{messageDeliveryError.operationId}</div> : null}
                              </div>
                              <Button type="button" size="sm" variant="outline" className="h-7 shrink-0" onClick={() => { setMessageDeliveryError(null); controlSocket?.connect() }}>
                                {t('composer.delivery.reconnect')}
                              </Button>
                            </div>
                          </BannerSlot>
                        ) : null}
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
                        {currentAgentRuntimeCapabilities.compact ? <ContextPressureBanner
                          state={session.state}
                          contextSnapshot={session.contextSnapshot}
                          compactRunning={compactStatus.kind === 'running'}
                          suppressed={awaitingAck || compactStatus.kind === 'running'}
                          onCompactNow={runCompactNow}
                        /> : null}
                        <OfflineBanner />
                      </BannerStack>
                      <ComposerFlipContainer
                        showApproval={session.pendingApprovals.length > 0 || session.pendingAskUserChoices.length > 0}
                        front={
                          <Composer
                          disabled={!controlSocket?.connected || sessionWorkspaceKnownOffline}
                          serviceUnavailable={!controlSocket?.connected}
                          workspaceUnavailable={sessionWorkspaceKnownOffline}
                          onReconnectService={() => controlSocket?.connect()}
                          model={composerModel}
                          models={availableModels}
                          onModelChange={onModelChange}
                          allowModelSelection={currentAgentRuntimeCapabilities.modelSelection}
                          approvalMode={session.state?.approvalMode ?? 'auto'}
                          onApprovalModeChange={onApprovalModeChange}
                          allowApprovalMode={currentAgentRuntimeCapabilities.approvalMode}
                          allowQueue={currentAgentRuntimeCapabilities.queue}
                          allowAttachments={currentAgentRuntimeCapabilities.attachments}
                          state={session.state}
                          config={session.config}
                          contextSnapshot={session.contextSnapshot}
                          humanAttention={session.humanAttention}
                          queuedMessages={visibleQueuedMessages}
                          timeline={session.timeline}
                          displayPrefs={chatDisplayPrefs}
                          onQueuedReorder={currentAgentRuntimeCapabilities.queue && session.status === 'ready' && sessionWorkspaceOnline && session.socket && activeSessionId !== null
                            ? (id, beforeId) => reorderQueuedMessage(session.socket!, activeSessionId, id, beforeId)
                            : undefined}
                          onQueuedUpdate={currentAgentRuntimeCapabilities.queue && session.status === 'ready' && sessionWorkspaceOnline && session.socket && activeSessionId !== null
                            ? (id, text, content) => updateQueuedMessage(session.socket!, activeSessionId, id, text, content)
                            : undefined}
                          onQueuedDelete={currentAgentRuntimeCapabilities.queue && session.status === 'ready' && sessionWorkspaceOnline && session.socket && activeSessionId !== null
                            ? (id) => deleteQueuedMessage(session.socket!, activeSessionId, id)
                            : undefined}
                          onCompact={currentAgentRuntimeCapabilities.compact ? runCompactNow : undefined}
                          onClearSession={currentAgentRuntimeCapabilities.clear ? clearCurrentSession : undefined}
                          onCancel={() => {
                            if (!session.socket || activeSessionId === null) return
                            if (cancelPendingSessionId === activeSessionId) return
                            if (awaitingAck) setCancelPendingSessionId(activeSessionId)
                            // Stop supersedes all not-yet-executed control work.
                            // The Host clears steer + follow-up queues atomically;
                            // mirror that immediately so no optimistic row remains
                            // stuck as "sending" or restarts the stopped Session.
                            setPendingUserMessages((items) => items.filter((item) => item.mode !== 'steer'))
                            setOptimisticQueuedMessages([])
                            cancelSession(session.socket, activeSessionId)
                          }}
                          onRenameSession={renameCurrentSessionFromSlash}
                          onDeleteSession={requestSlashDeleteCurrentSession}
                          onConsolidateMemory={currentAgentRuntimeCapabilities.memoryConsolidation ? runConsolidateMemory : undefined}
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
                              <TaskGraphButton graph={taskGraph} />
                              {!taskGraph ? <TasksButton todos={taskItems} /> : null}
                            </>
                          }
                          onUploadFiles={async (files) => {
                            if (activeSessionId === null) throw new Error('No active Session for attachment upload')
                            const uploaded: ReferencedFileContent[] = []
                            try {
                              for (const file of files) {
                                uploaded.push(await uploadMessageAttachment({
                                  host: hostEndpoint.url,
                                  ...(config.token ? { token: config.token } : {}),
                                  sessionId: activeSessionId,
                                  file,
                                }))
                              }
                              return uploaded
                            } catch (error) {
                              if (uploaded.length > 0) {
                                await releaseMessageAttachments({
                                  host: hostEndpoint.url,
                                  ...(config.token ? { token: config.token } : {}),
                                  sessionId: activeSessionId,
                                  files: uploaded,
                                }).catch((releaseError) => console.error('Unable to release partially uploaded attachments', releaseError))
                              }
                              throw error
                            }
                          }}
                          onReleaseFiles={async (files) => {
                            if (activeSessionId === null) return
                            await releaseMessageAttachments({
                              host: hostEndpoint.url,
                              ...(config.token ? { token: config.token } : {}),
                              sessionId: activeSessionId,
                              files,
                            })
                          }}
                          onSubmit={async (text, mode, images, extraBlocks) => {
                            if (activeSessionId === null) return
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
                                { id: `optimistic-${newPendingMessageId()}`, text, mode, createdAt, ...(content ? { content } : {}) },
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
                            setAwaitingAck(true)
                            setMessageDeliveryError(null)
                            try {
                              await admitUserMessage({
                                host: hostEndpoint.url,
                                ...(config.token ? { token: config.token } : {}),
                                sessionId: activeSessionId,
                                text,
                                mode,
                                ...(content ? { content } : {}),
                              })
                              if (effectiveOptimisticMode === 'steer') suppressNextWaitingNotification.current = true
                            } catch (error) {
                              setPendingUserMessages((prev) => prev.filter((item) => item.text !== text || item.createdAt !== createdAt))
                              setOptimisticQueuedMessages((prev) => prev.filter((item) => item.text !== text || item.createdAt !== createdAt))
                              if (error instanceof AdmissionDeliveryPendingError) {
                                setMessageDeliveryError({
                                  message: error.lastError
                                    ? t('composer.delivery.pendingDetail', { reason: error.lastError, attempts: error.attempts })
                                    : t('composer.delivery.pending'),
                                  operationId: error.operationId,
                                })
                              } else if (error instanceof AdmissionDeliveryFailedError) {
                                setMessageDeliveryError({
                                  message: error.lastError ?? t('composer.delivery.failed'),
                                  operationId: error.operationId,
                                })
                              } else {
                                setMessageDeliveryError({ message: error instanceof Error ? error.message : String(error) })
                              }
                              throw error
                            } finally {
                              setAwaitingAck(false)
                            }
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
                          session.pendingApprovals.length > 0 ? (
                            <ApprovalCard
                            approvals={session.pendingApprovals}
                            onDecision={(callId, decision) => {
                              if (!session.socket || activeSessionId === null) return
                              respondApproval(session.socket, activeSessionId, callId, decision)
                            }}
                            />
                          ) : (
                            <AskUserChoiceCard
                              requests={session.pendingAskUserChoices}
                              onChoose={(callId, value) => {
                                if (!session.socket || activeSessionId === null) return
                                void respondAskUserChoice(session.socket, activeSessionId, callId, value)
                              }}
                            />
                          )
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
                    <div className="ak-motion-slide-right h-full min-h-0 overflow-hidden" data-testid="inspector-drawer">
                      <RightPanel
                        activeTab={rightPanelTab}
                        onTabChange={setRightPanelTab}
                        onCollapse={() => setInspectorOpen(false)}
                        inspector={<InspectorPanel
                        state={session.state}
                        config={session.config}
                        contextSnapshot={session.contextSnapshot}
                        timeline={session.timeline}
                        visibleMessagesCount={chatMessagesCount}
                        socket={session.socket}
                        parentSessionId={session.parentSessionId}
                        parentCursor={session.parentCursor}
                        onFork={currentAgentRuntimeCapabilities.fork ? (cursor) => {
                          if (activeSessionId !== null) session.socket?.emit('client:fork', { sourceSessionId: activeSessionId, cursor })
                        } : undefined}
                        onJumpToMessage={(index) => {
                          setHighlightIndex(index)
                          const el = document.getElementById(`msg-${index}`)
                          if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
                          window.setTimeout(() => {
                            setHighlightIndex((cur) => (cur === index ? null : cur))
                          }, 1400)
                        }}
                      />}
                        files={<Suspense fallback={<PageLoadingFallback compact />}><SessionFilesPanel mode="sidebar" socket={workspaceExplorerBinding.socket} workspaceId={fileExplorerWorkspaceId} sessionId={workspaceExplorerBinding.sessionId} cwd={currentCwd} fontSizePx={fileExplorerFontSizePx} /></Suspense>}
                        git={<Suspense fallback={<PageLoadingFallback compact />}><SourceControlPanel socket={workspaceExplorerBinding.socket} workspaceId={fileExplorerWorkspaceId} sessionId={workspaceExplorerBinding.sessionId} cwd={currentCwd} /></Suspense>}
                        terminal={activeSessionId && currentSession?.workspaceId ? <Suspense fallback={<PageLoadingFallback compact />}><SessionTerminalPanel socket={session.socket} workspaceId={currentSession.workspaceId} sessionId={activeSessionId} cwd={currentCwd} online={sessionWorkspaceOnline} /></Suspense> : <div className="p-4 text-xs text-muted-foreground">{t('terminal.workspaceRequired')}</div>}
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
          className="ak-drawer-left left-0 top-0 h-[var(--ak-viewport-h,100dvh)] max-h-[var(--ak-viewport-h,100dvh)] w-screen max-w-none translate-x-0 translate-y-0 gap-0 overflow-hidden border-0 bg-sidebar p-0 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] shadow-2xl sm:w-96 sm:rounded-r-3xl"
          data-testid="explorer-drawer"
        >
          <DialogDescription className="sr-only">{t('common.contextualHelp')}</DialogDescription>
          <div className="flex h-full min-h-0 flex-col bg-sidebar pb-[env(safe-area-inset-bottom)] text-sidebar-foreground">
            <div className="flex h-11 flex-none items-center gap-2 border-b border-sidebar-border px-3">
              <DialogTitle className="flex items-center gap-1 text-sm">{t('common.explorer')}<HelpHint label={t('common.explorer')}>{t('app.explorerDescription')}</HelpHint></DialogTitle>
              <NewChatButton onNewChat={() => newSessionFromExplorerDrawer()} />
              <span className="min-w-0 flex-1" />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-8 w-8 flex-none text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground"
                title={t('app.closeExplorer')}
                aria-label={t('app.closeExplorer')}
                onClick={() => setExplorerDrawerOpen(false)}
              >
                <PanelLeftClose className="h-4 w-4" />
              </Button>
            </div>
            <div className="min-h-0 flex-1 overflow-hidden">
              <Explorer executors={control.executors} sessions={control.sessions} loading={sessionDirectoryLoadingOwner === 'explorer'} selectedSessionId={explorerSelectedSessionId} sessionStatuses={sessionStatuses} onSelect={selectSessionFromExplorerDrawer} onClearSelection={clearSessionSelectionFromExplorerDrawer} onNewSession={newSessionFromExplorerDrawer} onConnectWorkspace={runtimeCapabilities.workspace ? connectWorkspaceFromExplorerDrawer : undefined} onDelete={deleteSessionAt} onRename={renameSessionAt} onRenameWorkspace={renameWorkspaceAt} embeddedHeader fontSizePx={sessionExplorerFontSizePx} previewStore={previewStore} onOpenSessionInfo={openExplorerDrawerSessionInfo} onWorkspaceInfo={openExplorerDrawerWorkspaceInfo} />
            </div>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={inspectorDrawerOpen && !wideLayout && hasSelectedSession} onOpenChange={setInspectorDrawerOpen}>
        <DialogContent
          className="ak-drawer-right right-0 top-0 h-[var(--ak-viewport-h,100dvh)] max-h-[var(--ak-viewport-h,100dvh)] w-screen max-w-none !left-auto translate-x-0 translate-y-0 gap-0 overflow-hidden border-0 bg-card p-0 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] pr-[env(safe-area-inset-right)] shadow-2xl sm:w-[26rem] sm:rounded-l-3xl"
          data-testid="inspector-drawer-mobile"
        >
          <DialogHeader className="sr-only">
            <DialogTitle>{t('app.openInspector')}</DialogTitle>
            <DialogDescription className="sr-only">{t('common.contextualHelp')}</DialogDescription>
          </DialogHeader>
          <div className="h-full min-h-0 pb-[env(safe-area-inset-bottom)]">
            <RightPanel
              headerHelp={<HelpHint label={t('app.openInspector')}>{t('app.inspectorDescription')}</HelpHint>}
              activeTab={rightPanelTab}
              onTabChange={setRightPanelTab}
              onCollapse={() => setInspectorDrawerOpen(false)}
              inspector={<InspectorPanel
              state={session.state}
              config={session.config}
              contextSnapshot={session.contextSnapshot}
              timeline={session.timeline}
              visibleMessagesCount={chatMessagesCount}
              socket={session.socket}
              parentSessionId={session.parentSessionId}
              parentCursor={session.parentCursor}
              onFork={currentAgentRuntimeCapabilities.fork ? (cursor) => {
                if (activeSessionId !== null) session.socket?.emit('client:fork', { sourceSessionId: activeSessionId, cursor })
                setInspectorDrawerOpen(false)
              } : undefined}
              onJumpToMessage={(index) => {
                setHighlightIndex(index)
                const el = document.getElementById(`msg-${index}`)
                if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
                window.setTimeout(() => {
                  setHighlightIndex((cur) => (cur === index ? null : cur))
                }, 1400)
                setInspectorDrawerOpen(false)
              }}
            />}
              files={<Suspense fallback={<PageLoadingFallback compact />}><SessionFilesPanel mode="sidebar" socket={workspaceExplorerBinding.socket} workspaceId={fileExplorerWorkspaceId} sessionId={workspaceExplorerBinding.sessionId} cwd={currentCwd} fontSizePx={fileExplorerFontSizePx} /></Suspense>}
              git={<Suspense fallback={<PageLoadingFallback compact />}><SourceControlPanel socket={workspaceExplorerBinding.socket} workspaceId={fileExplorerWorkspaceId} sessionId={workspaceExplorerBinding.sessionId} cwd={currentCwd} /></Suspense>}
              terminal={activeSessionId && currentSession?.workspaceId ? <Suspense fallback={<PageLoadingFallback compact />}><SessionTerminalPanel socket={session.socket} workspaceId={currentSession.workspaceId} sessionId={activeSessionId} cwd={currentCwd} online={sessionWorkspaceOnline} /></Suspense> : <div className="p-4 text-xs text-muted-foreground">{t('terminal.workspaceRequired')}</div>}
            />
          </div>
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={slashDelete !== null}
        onOpenChange={(open) => {
          if (!open) resetSlashDelete()
        }}
      >
        <AlertDialogContent className="max-w-[min(92vw,34rem)]">
          <AlertDialogHeader>
            <AlertDialogTitle>{t('app.slashDelete.confirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                <p>{t('app.slashDelete.description')}</p>
                <div className="rounded-md border border-border/60 bg-muted/40 px-3 py-2 text-xs text-foreground">
                  <div className="text-[0.625rem] font-medium uppercase tracking-wide text-muted-foreground">{t('app.slashDelete.target')}</div>
                  <div className="mt-1 truncate font-medium" title={sessionDisplayLabel(slashDeleteTarget, slashDelete?.sessionId ?? '')}>{sessionDisplayLabel(slashDeleteTarget, slashDelete?.sessionId ?? '')}</div>
                  <div className="mt-1 break-all font-mono text-[0.6875rem] text-muted-foreground">{slashDelete?.sessionId}</div>
                </div>
                {slashDeleteDescendantCount > 0 ? <p className="text-amber-700 dark:text-amber-300">{t('app.slashDelete.children', { count: slashDeleteDescendantCount })}</p> : null}
                <p>{t('app.slashDelete.confirmDescription', { phrase: slashDeleteRequiredPhrase, label: sessionDisplayLabel(slashDeleteTarget, slashDelete?.sessionId ?? '') })}</p>
                <label className="block text-xs font-medium text-muted-foreground">
                  {t('app.slashDelete.phraseLabel')}
                  <input className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 font-mono text-sm text-foreground" value={slashDeletePhrase} onChange={(event) => setSlashDeletePhrase(event.target.value)} placeholder={slashDeleteRequiredPhrase} data-testid="slash-delete-confirm-input" />
                </label>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              disabled={!slashDeleteConfirmed}
              onClick={(event) => {
                if (!slashDelete || !slashDeleteConfirmed) { event.preventDefault(); return }
                deleteSessionAt(slashDelete.sessionId)
                resetSlashDelete()
              }}
              data-testid="slash-delete-confirm-button"
            >
              {t('app.slashDelete.confirmDelete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <ChangeCwdDialog
        open={cwdDialogOpen}
        socket={session.socket}
        workspace={currentWorkspaceExecutor}
        currentCwd={currentCwd}
        onSave={submitCwd}
        onOpenChange={setCwdDialogOpen}
      />
      {settingsOpen ? (
        <Suspense fallback={<PageLoadingFallback compact />}>
          <SettingsDialog
            open={settingsOpen}
            onOpenChange={setSettingsOpen}
            onModelsChanged={reloadModels}
            executors={control.executors}
            sessionCache={sessionViewCache}
            host={hostEndpoint.url}
            {...(config.token ? { token: config.token } : {})}
          />
        </Suspense>
      ) : null}
      <SessionMetadataDialog
        evaluationUrl={runtimeDeployment.evaluationUrl}
        open={metadataOpen}
        onOpenChange={(open) => {
          setMetadataOpen(open)
          if (!open) setMetadataSessionId(null)
        }}
        sessionId={metadataTargetSessionId ?? ''}
        summary={metadataSession}
        state={metadataIsCurrentSession ? session.state : null}
        contextSnapshot={metadataIsCurrentSession ? session.contextSnapshot : null}
        selectedModel={metadataIsCurrentSession ? session.selectedModel : metadataSession?.preferences?.selectedModel ?? null}
        canChangeCwd={metadataIsCurrentSession && currentAgentRuntimeCapabilities.cwdMutation}
        canChangeApprovalMode={metadataIsCurrentSession && currentAgentRuntimeCapabilities.approvalMode}
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
        agentRuntimes={control.agentRuntimes}
        initialWorkspaceId={pendingWorkspacePick?.workspaceId}
        socket={session.socket}
        error={workspacePickError}
        submitting={workspacePickSubmitting}
        onCreate={({ agentRuntime, workspaceId, workspaceName, cwd }) =>
          void pickWorkspaceForNew(agentRuntime, workspaceId, workspaceName, cwd)
        }
        onCreateSimpleChat={(agentRuntime) => void startSimpleChat(agentRuntime)}
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
      <ExecutorPairingPrompt />
      <WorkspaceMetadataDialog
        open={workspaceInfoId !== null}
        onOpenChange={(open) => {
          if (!open) setWorkspaceInfoId(null)
        }}
        workspaceId={workspaceInfoId ?? ''}
        executor={workspaceInfoExecutor}
        sessions={workspaceInfoSessions}
        onRename={(name) => renameWorkspaceAt(workspaceInfoId ?? '', name)}
        onOpenSession={(sessionId) => { selectSession(sessionId); setSection('agent') }}
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
              'group toast pointer-events-none border border-border/70 bg-popover text-popover-foreground shadow-md rounded-md text-xs pl-3 pr-3 py-2 border-l-2',
            title: 'text-xs font-medium',
            description: 'text-[0.6875rem] text-muted-foreground mt-0.5',
            actionButton: 'pointer-events-auto text-[0.6875rem] px-2 py-0.5 rounded bg-accent text-accent-foreground hover:bg-accent/80',
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

function isEditable(el: HTMLElement): boolean {
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return true
  if (el.isContentEditable) return true
  return false
}

function isResting(status: import('@agent-kernel/kernel').AgentState['status']): boolean {
  return isSessionResting({ status })
}



/**
 * Collapse every "running" activity (thinking / executing_tools / the
 * client-side `loading` bridge) into a single stable value for the status
 * indicators. The sidebar + title indicators render an identical spinner for
 * all of these, so distinguishing them only churns identity: during a
 * tool-heavy turn the kernel status flips thinking↔executing_tools many times a
 * second, and without this the sessionStatuses map signature changes on every
 * flip, re-rendering the whole Explorer and restarting the spinner animation
 * (the reported jank). Non-running statuses pass through unchanged.
 */










type Config = {
  sessionId: string | null
  explicit: boolean
  token?: string
}

function CapabilityUnavailable({ title }: { title: string }): JSX.Element {
  return <div className="grid h-full place-items-center p-6"><ProductState kind="degraded" title={title} description="The configured Host does not advertise this product capability." /></div>
}

function TopbarBrand(): JSX.Element {
  return (
    <span aria-label="Agent RunLab" className="group mr-2 hidden min-w-0 flex-none items-center gap-2 text-foreground sm:flex">
      <img
        src={isDesktopClient() ? '/icons/octopus-desktop.svg' : '/icons/octopus-web.svg'}
        alt=""
        className="h-5 w-5 text-foreground/90"
        aria-hidden
      />
      <span className="truncate text-[0.8125rem] font-semibold tracking-[-0.025em] text-foreground/90">Agent RunLab</span>
    </span>
  )
}

export function readInitialConfig(): Config {
  const url = new globalThis.URL(window.location.href)
  const fromUrl = url.searchParams.get('sessionId')
  const sessionId = fromUrl || parseSessionDeepLink(url.hash)
  const explicit = sessionId !== null
  const token = url.searchParams.get('token') ?? undefined
  if (token !== undefined) {
    // Strip the bootstrap token from the address bar so it doesn't leak
    // into browser history, referrer headers, screenshots, or bookmarks.
    url.searchParams.delete('token')
    window.history.replaceState(null, '', url.toString())
  }
  return { sessionId, explicit, ...(token !== undefined ? { token } : {}) }
}

export function sessionDirectoryIsLoading(sessionsLoaded: boolean): boolean {
  return !sessionsLoaded
}

export type SessionDirectoryLoadingOwner = 'explorer' | 'workbench' | null

/**
 * Gives the cold directory load one visible owner. The Explorer owns it while
 * it is visible; otherwise the workbench owns it. This keeps the mobile drawer
 * correct without allowing the title, list, and chat surface to announce the
 * same pending request independently.
 */
export function resolveSessionDirectoryLoadingOwner({
  loading,
  wideLayout,
  explorerOpen,
  explorerDrawerOpen,
}: {
  loading: boolean
  wideLayout: boolean
  explorerOpen: boolean
  explorerDrawerOpen: boolean
}): SessionDirectoryLoadingOwner {
  if (!loading) return null
  if ((wideLayout && explorerOpen) || (!wideLayout && explorerDrawerOpen)) return 'explorer'
  return 'workbench'
}

export function NoSessionArea({
  onNewSession,
  onConnectWorkspace,
  onOpenSession,
  onOpenWorkspace,
  sessions = [],
  executors = [],
  sessionStatuses,
  hasSessions,
  hasWorkspace = true,
}: {
  onNewSession(): void
  onConnectWorkspace?(): void
  onOpenSession?(sessionId: string): void
  onOpenWorkspace?(workspaceId: string): void
  sessions?: readonly SessionSummary[]
  executors?: readonly AttachedExecutor[]
  sessionStatuses?: ReadonlyMap<string, SessionActivityStatus>
  hasSessions: boolean
  hasWorkspace?: boolean
}): JSX.Element {
  const { t } = useTranslation()
  const recentSessions = [...sessions]
    .sort((a, b) => Date.parse(b.lastEventAt ?? b.createdAt) - Date.parse(a.lastEventAt ?? a.createdAt))
    .slice(0, 5)
  const waiting = sessions.filter((item) => (sessionStatuses?.get(item.sessionId) ?? item.status) === 'awaiting_approval').length
  const running = sessions.filter((item) => isRunningSessionActivity(sessionStatuses?.get(item.sessionId) ?? item.status)).length
  const queued = sessions.reduce((sum, item) => sum + (item.queuedCount ?? 0), 0)
  const onlineWorkspaceIds = new Set(executors.map((executor) => executor.workspaceId).filter(Boolean))
  const workspaceCount = new Set([
    ...executors.map((executor) => executor.workspaceId).filter(Boolean),
    ...sessions.map((session) => session.workspaceId).filter(Boolean),
  ]).size
  return (
    <div
      className="ak-workspace-canvas min-h-0 flex-1 overflow-auto bg-background"
      data-testid="no-session-placeholder"
    >
      <div className="ak-motion-scale-in mx-auto flex min-h-full w-full max-w-6xl flex-col justify-center gap-5 px-4 py-8 sm:px-6 lg:px-8">
        <section className="ak-hero-surface overflow-hidden rounded-3xl border border-border/35 bg-card/60 p-5 sm:p-7" data-testid="session-cockpit-hero">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div className="min-w-0">
              <div className="inline-flex items-center gap-2 rounded-full bg-primary/10 px-3 py-1 text-[0.6875rem] font-semibold uppercase tracking-[0.16em] text-primary">
                <Sparkles className="h-3.5 w-3.5" aria-hidden />
                {t('app.cockpit.eyebrow')}
              </div>
              <h1 className="mt-4 text-2xl font-semibold tracking-[-0.03em] text-foreground sm:text-3xl">
                {t('app.noSessionTitle')}
              </h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
                {hasSessions ? t('app.noSessionWithSessions') : t('app.noSessionEmpty')}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="button" onClick={() => onNewSession()} data-testid="no-session-new-button">
                {hasWorkspace ? t('app.newSessionButton') : t('dialogs.simpleChat')}
              </Button>
              {onConnectWorkspace ? (
                <Button type="button" variant="outline" onClick={onConnectWorkspace} data-testid="no-session-connect-workspace">
                  {hasWorkspace ? t('app.cockpit.connectWorkspace') : t('app.connectFirstWorkspace')}
                </Button>
              ) : null}
              <Button type="button" variant="outline" asChild>
                <a href="#/docs">{t('app.viewSetupGuide')}</a>
              </Button>
            </div>
          </div>
          <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <CockpitMetric icon={Workflow} label={t('app.cockpit.running')} value={String(running)} tone={running ? 'info' : 'neutral'} />
            <CockpitMetric icon={ShieldCheck} label={t('app.cockpit.waiting')} value={String(waiting)} tone={waiting ? 'warn' : 'neutral'} />
            <CockpitMetric icon={ListChecks} label={t('app.cockpit.queued')} value={String(queued)} tone={queued ? 'info' : 'neutral'} />
            <CockpitMetric icon={FolderOpen} label={t('app.cockpit.workspaces')} value={`${onlineWorkspaceIds.size}/${workspaceCount}`} tone={onlineWorkspaceIds.size ? 'good' : 'neutral'} />
          </div>
        </section>
        <div className="grid min-h-0 gap-5 lg:grid-cols-[minmax(0,1.35fr)_minmax(20rem,0.65fr)]">
          <section className="ak-workspace-surface overflow-hidden" data-testid="session-cockpit-recent">
            <div className="flex items-center justify-between gap-3 border-b border-border/25 px-4 py-3">
              <div>
                <h2 className="text-sm font-semibold">{t('app.cockpit.recentSessions')}</h2>
                <p className="text-xs text-muted-foreground">{t('app.cockpit.recentSessionsHint')}</p>
              </div>
              <Clock3 className="h-4 w-4 text-muted-foreground" aria-hidden />
            </div>
            <div className="divide-y divide-border/25">
              {recentSessions.length ? recentSessions.map((item) => {
                const status = sessionStatuses?.get(item.sessionId) ?? item.status
                return (
                  <button key={item.sessionId} type="button" onClick={() => onOpenSession?.(item.sessionId)} className="grid w-full min-w-0 gap-1 px-4 py-3 text-left transition-colors hover:bg-muted/35" data-testid="session-cockpit-session">
                    <div className="flex min-w-0 items-center gap-2">
                      <SessionStatusIndicator status={status} />
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">{sessionDisplayLabel(item, item.sessionId)}</span>
                      <span className="flex-none text-[0.6875rem] text-muted-foreground">{formatRelativeTime(item.lastEventAt ?? item.createdAt)}</span>
                    </div>
                    <div className="truncate pl-5 text-xs text-muted-foreground">{item.workspaceName ?? item.workspaceId ?? t('app.cockpit.simpleChat')} · {item.eventCount} events</div>
                  </button>
                )
              }) : (
                <div className="px-4 py-8 text-sm text-muted-foreground">{t('app.cockpit.noRecentSessions')}</div>
              )}
            </div>
          </section>
          <section className="ak-workspace-surface overflow-hidden" data-testid="session-cockpit-workspaces">
            <div className="flex items-center justify-between gap-3 border-b border-border/25 px-4 py-3">
              <div>
                <h2 className="text-sm font-semibold">{t('app.cockpit.workspaceHome')}</h2>
                <p className="text-xs text-muted-foreground">{t('app.cockpit.workspaceHomeHint')}</p>
              </div>
              <GitBranch className="h-4 w-4 text-muted-foreground" aria-hidden />
            </div>
            <div className="divide-y divide-border/25">
              {executors.length ? executors.slice(0, 5).map((executor) => (
                <button key={executor.executorId} type="button" onClick={() => executor.workspaceId && onOpenWorkspace?.(executor.workspaceId)} className="flex w-full min-w-0 items-center gap-3 px-4 py-3 text-left hover:bg-muted/35" data-testid="session-cockpit-workspace">
                  <span className="h-2.5 w-2.5 flex-none rounded-full bg-emerald-500 shadow-[0_0_0_3px_hsl(142_76%_36%/0.12)]" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{executor.workspaceName ?? executor.workspaceId}</span>
                    <span className="block truncate text-xs text-muted-foreground">{[executor.hostname, executor.os, executor.executorVersion].filter(Boolean).join(' · ')}</span>
                  </span>
                  <span className="text-[0.6875rem] text-muted-foreground">{sessions.filter((item) => item.workspaceId === executor.workspaceId).length}</span>
                </button>
              )) : (
                <div className="px-4 py-8 text-sm text-muted-foreground">{t('app.cockpit.noWorkspaces')}</div>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}

function CockpitMetric({ icon: Icon, label, value, tone }: { icon: typeof Workflow; label: string; value: string; tone: 'neutral' | 'good' | 'warn' | 'info' }): JSX.Element {
  return (
    <div className="rounded-2xl border border-border/45 bg-background/55 p-3 shadow-[inset_0_1px_0_hsl(0_0%_100%/0.06)]">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Icon className={cn('h-4 w-4', tone === 'good' && 'text-emerald-500', tone === 'warn' && 'text-amber-500', tone === 'info' && 'text-sky-500')} aria-hidden />
        {label}
      </div>
      <div className="mt-2 font-mono text-2xl font-semibold tracking-tight">{value}</div>
    </div>
  )
}

function formatRelativeTime(value: string): string {
  const ts = Date.parse(value)
  if (!Number.isFinite(ts)) return value
  const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (seconds < 60) return 'now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours}h`
  return new Date(ts).toLocaleDateString()
}


function SidebarCollapseButton({ onCollapse }: { onCollapse(): void }): JSX.Element {
  const { t } = useTranslation()
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="h-7 w-7 text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground"
      title={t('app.hideSidebar')}
      aria-label={t('app.hideSidebar')}
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
  const { t } = useTranslation()
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
          aria-label={t('app.dismissError')}
          title={t('app.dismiss')}
          data-testid="session-error-dismiss"
          className="flex-none rounded p-0.5 text-rose-600/80 transition-colors hover:bg-rose-100 hover:text-rose-800 dark:text-rose-300/80 dark:hover:bg-rose-900/60 dark:hover:text-rose-100"
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>
    </BannerSlot>
  )
}

function SessionDirectoryPendingArea({ active }: { active: boolean }): JSX.Element {
  const { t } = useTranslation()
  return (
    <div
      className="flex-1 min-h-0 flex items-center justify-center bg-background text-sm text-muted-foreground"
      data-testid="session-directory-pending"
      data-loading-owner={active ? 'true' : undefined}
      role={active ? 'status' : undefined}
      aria-live={active ? 'polite' : undefined}
      aria-hidden={active ? undefined : 'true'}
    >
      {active ? (
        <div className="inline-flex items-center gap-2">
          <span className="ak-loading-spinner h-4 w-4" aria-hidden="true" />
          <span>{t('app.loadingSessions')}</span>
        </div>
      ) : (
        <Sparkles className="h-6 w-6 text-muted-foreground/30" aria-hidden="true" />
      )}
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
  onOpenSidebar,
  sidebarAvailable,
  onChangeCwd,
  sessionSelected,
  sessionDirectoryLoading = false,
  simpleChat = false,
  draft = false,
  sessionTabs,
  placement = 'rail',
  brand,
  rightSlot,
}: {
  sessionLabel: string
  sessionActivityStatus?: SessionActivityStatus
  cwd: string
  onOpenTopbar(): void
  topbarAvailable: boolean
  onOpenExplorer(): void
  explorerAvailable: boolean
  onOpenSidebar(): void
  sidebarAvailable: boolean
  onChangeCwd?: () => void
  sessionSelected: boolean
  sessionDirectoryLoading?: boolean
  simpleChat?: boolean
  draft?: boolean
  sessionTabs?: React.ReactNode
  placement?: 'rail' | 'topbar'
  brand?: React.ReactNode
  rightSlot?: React.ReactNode
}): JSX.Element {
  const { t } = useTranslation()
  const displayLabel = sessionSelected
    ? sessionLabel
    : draft
      ? t('dialogs.simpleChat')
    : sessionDirectoryLoading
      ? t('app.sessionsTitle')
      : t('app.noSessionSelected')
  const topbarToggle = topbarAvailable ? (
    <Button
      variant="ghost"
      size="icon"
      onClick={onOpenTopbar}
      title={t('app.expandTopbar')}
      aria-label={t('app.expandTopbar')}
      data-testid="topbar-toggle"
      className="h-8 w-8 flex-none"
    >
      <ChevronDown className="h-4 w-4" />
    </Button>
  ) : null
  const isTopbarPlacement = placement === 'topbar'
  const content = (
    <>
      {!isTopbarPlacement ? topbarToggle : null}
      {explorerAvailable ? (
        <Button
          variant="ghost"
          size="icon"
          onClick={onOpenExplorer}
          title={t('app.openExplorer')}
          aria-label={t('app.openExplorer')}
          data-testid="explorer-toggle"
          className="h-8 w-8 flex-none"
        >
          <Menu className="h-4 w-4" />
        </Button>
      ) : null}
      <span
        className={cn(
          'inline-flex min-w-0 items-center gap-1.5',
          isTopbarPlacement ? 'max-w-[36vw] sm:max-w-[46vw] md:max-w-none' : 'max-w-[55vw] sm:max-w-none',
        )}
        title={displayLabel}
        data-testid="session-title"
      >
        {sessionSelected ? (
          <SessionStatusIndicator status={sessionActivityStatus} selected compact={isTopbarPlacement} />
        ) : null}
        <span className="min-w-0 truncate font-semibold tracking-[-0.01em] text-inherit" data-testid="session-label">
          {displayLabel}
        </span>
        {simpleChat ? <span className={cn('flex-none rounded-full bg-primary/10 px-2 py-0.5 text-[0.625rem] font-medium text-primary', isTopbarPlacement && 'hidden sm:inline-flex')} data-testid="simple-chat-badge">{t('explorer.chat')}</span> : null}
      </span>
      {sessionSelected && onChangeCwd ? (
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
      {sessionTabs ? <div className={cn('ml-2 min-w-0 flex-1 overflow-hidden', placement === 'topbar' && 'hidden md:block')}>{sessionTabs}</div> : <span className="min-w-0 flex-1" />}
      {sidebarAvailable ? (
        <Button
          variant="ghost"
          size="icon"
          onClick={onOpenSidebar}
          title={t('app.openSidebar')}
          aria-label={t('app.openSidebar')}
          data-testid="sidebar-toggle"
          className="h-8 w-8 flex-none"
        >
          <PanelRight className="h-4 w-4" />
        </Button>
      ) : null}
      {rightSlot}
      {isTopbarPlacement ? topbarToggle : null}
    </>
  )
  if (isTopbarPlacement) {
    return (
      <div className="flex h-full w-full min-w-0 flex-none items-center" data-testid="workbench-toolbar">
        <div className="ak-fused-topbar-capsule flex h-full w-full min-w-0 items-center gap-1.5 px-2 text-sm text-card-foreground backdrop-blur-xl sm:px-3">
          {brand}
          {content}
        </div>
      </div>
    )
  }
  return (
    <div
      className="flex-none p-1.5 sm:p-2 min-[1180px]:pl-0"
      data-testid="workbench-toolbar-rail"
    >
      <div
        className="ak-titlebar-surface flex min-h-9 items-center gap-1.5 px-2 py-0.5 text-sm text-card-foreground backdrop-blur sm:gap-2 sm:px-2.5"
        data-testid="workbench-toolbar"
      >
        {content}
      </div>
    </div>
  )
}

const CONNECTION_HEALTH_WINDOW_MS = 10 * 60 * 1000
const CONNECTION_HEALTH_FAILURES_BEFORE_ISSUE = 2

type ConnectionHealthSample = {
  at: number
  hostRttMs: number | null
  executorRttMs: number | null
  hostOk: boolean
  executorOk: boolean
  executorRequired: boolean
}

export const ConnectionStatus = memo(function ConnectionStatus({ socket, status, transport, cursor, workspaceId, executorConnected, onResync, compact = false }: { socket: DashboardSocket | null; status: string; transport?: string; cursor: number; workspaceId?: string; executorConnected: boolean; onResync(): void; compact?: boolean }): JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [hostRtt, setHostRtt] = useState<number | null>(null)
  const [executorRtt, setExecutorRtt] = useState<number | null>(null)
  const [hostError, setHostError] = useState<string | null>(null)
  const [executorError, setExecutorError] = useState<string | null>(null)
  const [history, setHistory] = useState<readonly ConnectionHealthSample[]>([])
  const [probeFailureStreak, setProbeFailureStreak] = useState(0)
  const [checking, setChecking] = useState(false)
  const [copied, setCopied] = useState(false)
  const executorRequired = Boolean(workspaceId)
  const probeGeneration = useRef(0)

  const appendSample = useCallback((sample: ConnectionHealthSample) => {
    setHistory((previous) => {
      const cutoff = sample.at - CONNECTION_HEALTH_WINDOW_MS
      return [...previous.filter((entry) => entry.at >= cutoff), sample]
    })
  }, [])

  const measure = useCallback(() => {
    const generation = ++probeGeneration.current
    if (!socket?.connected) {
      setHostRtt(null)
      setExecutorRtt(null)
      setHostError(t('common.disconnected'))
      setExecutorError(executorRequired ? t(executorConnected ? 'connectionHealth.unavailable' : 'connectionHealth.offline') : null)
      appendSample({ at: Date.now(), hostRttMs: null, executorRttMs: null, hostOk: false, executorOk: false, executorRequired })
      setChecking(false)
      return
    }
    setChecking(true)
    let pending = workspaceId && executorConnected ? 2 : 1
    const sample: ConnectionHealthSample = { at: Date.now(), hostRttMs: null, executorRttMs: null, hostOk: false, executorOk: false, executorRequired }
    const finish = (): void => {
      pending -= 1
      if (pending === 0) {
        appendSample(sample)
        setProbeFailureStreak((previous) => {
          const failed = !sample.hostOk || (sample.executorRequired && executorConnected && !sample.executorOk)
          return failed ? previous + 1 : 0
        })
        setChecking(false)
      }
    }
    const hostStart = performance.now()
    socket.timeout(3000).emit('client:connection_ping', Date.now(), (err: unknown) => {
      if (generation !== probeGeneration.current) return
      const nextHostRtt = err ? null : Math.round(performance.now() - hostStart)
      sample.hostRttMs = nextHostRtt
      sample.hostOk = !err
      setHostRtt(nextHostRtt)
      setHostError(err ? t('connectionHealth.timedOut') : null)
      finish()
    })
    if (workspaceId && executorConnected) {
      socket.timeout(3500).emit('client:executor_ping', workspaceId, (err: unknown, result?: { rttMs?: number; error?: string }) => {
        if (generation !== probeGeneration.current) return
        if (err || result?.error) {
          sample.executorRttMs = null
          sample.executorOk = false
          setExecutorRtt(null)
          setExecutorError(t(result?.error ? 'connectionHealth.unavailable' : 'connectionHealth.timedOut'))
        } else {
          sample.executorRttMs = result?.rttMs ?? null
          sample.executorOk = result?.rttMs !== undefined
          setExecutorRtt(sample.executorRttMs)
          setExecutorError(result?.rttMs === undefined ? t('connectionHealth.notMeasured') : null)
        }
        finish()
      })
    } else {
      sample.executorOk = false
      setExecutorRtt(null)
      setExecutorError(executorRequired ? t('connectionHealth.offline') : null)
    }
  }, [appendSample, executorConnected, executorRequired, socket, t, workspaceId])

  useEffect(() => {
    setHostRtt(null)
    setExecutorRtt(null)
    setHostError(null)
    setExecutorError(null)
    setHistory([])
    setProbeFailureStreak(0)
  }, [socket, workspaceId])

  useEffect(() => {
    measure()
    const onVisible = (): void => { if (!document.hidden) measure() }
    window.addEventListener('focus', measure)
    window.addEventListener('online', measure)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.removeEventListener('focus', measure)
      window.removeEventListener('online', measure)
      document.removeEventListener('visibilitychange', onVisible)
      probeGeneration.current += 1
    }
  }, [measure])

  const diagnostics = { status, transport: transport ?? 'unknown', hostRttMs: hostRtt, hostError, ...(executorRequired ? { executorRttMs: executorRtt, executorError, executorPresence: executorConnected ? 'online' : 'offline' } : {}), sessionCursor: cursor }
  const copy = (): void => { void navigator.clipboard.writeText(JSON.stringify(diagnostics, null, 2)).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) }).catch(() => setCopied(false)) }
  const transientProbeFailed = hostError !== null || executorRequired && executorConnected && executorError !== null
  const probeFailed = status === 'ready' && transientProbeFailed && probeFailureStreak >= CONNECTION_HEALTH_FAILURES_BEFORE_ISSUE
  const displayStatus = probeFailed ? 'error' : status
  const label = probeFailed ? t('connectionHealth.issue') : hostStatusLabel(status, t)
  const healthy = displayStatus === 'ready' && (!executorRequired || executorConnected)
  const failed = displayStatus === 'error' || displayStatus === 'disconnected'
  const hostTone = status === 'ready' && !hostError ? 'healthy' : hostError || status === 'disconnected' || status === 'error' ? 'failed' : 'pending'
  const executorTone = !executorConnected || executorError ? 'failed' : 'healthy'
  const headlineLatency = executorRequired && executorConnected
    ? hostRtt !== null && executorRtt !== null ? hostRtt + executorRtt : null
    : hostRtt
  const headlineText = headlineLatency !== null ? `${headlineLatency} ms` : checking ? t('connectionHealth.measuring') : '—'

  return (
    <div className="relative">
      <button type="button" onClick={() => setOpen((value) => !value)} className={cn('inline-flex h-9 items-center rounded-lg text-xs font-medium text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground sm:h-8', compact ? 'w-8 justify-center p-0' : 'gap-2 px-2')} data-testid="connection-status" data-status={displayStatus} data-compact={compact ? 'true' : undefined} aria-expanded={open} aria-label={compact ? `${label}${headlineText !== '—' ? ` · ${headlineText}` : ''}` : undefined} title={compact ? `${label}${headlineText !== '—' ? ` · ${headlineText}` : ''}` : undefined}>
        <span className={cn('h-2 w-2 rounded-full', statusDot(displayStatus))} />
        {compact ? null : <span className="hidden sm:inline">{label}</span>}
        {compact ? null : <span className="hidden font-mono text-[0.625rem] tabular-nums text-muted-foreground md:inline" data-testid="connection-headline-latency">{headlineText}</span>}
      </button>
      {open ? (
        <div className="fixed inset-x-2 top-14 z-50 mx-auto max-w-md rounded-2xl bg-popover p-4 text-xs shadow-2xl ring-1 ring-border/30 sm:absolute sm:inset-x-auto sm:right-0 sm:top-full sm:mt-2 sm:w-[28rem]" data-testid="connection-status-popover">
          <div className="flex items-start justify-between gap-3 pb-3">
            <div className="flex items-center gap-1.5">
              <h3 className="text-sm font-semibold">{t('connectionHealth.title')}</h3>
              <HelpHint label={t('connectionHealth.title')} testId="connection-health-help">{t('connectionHealth.subtitle')}</HelpHint>
            </div>
            <span className={cn('inline-flex items-center gap-1.5 text-[0.6875rem] font-medium', healthy ? 'text-emerald-600 dark:text-emerald-400' : failed ? 'text-rose-600 dark:text-rose-400' : 'text-amber-600 dark:text-amber-300')}><span className={cn('h-1.5 w-1.5 rounded-full', healthy ? 'bg-emerald-500' : failed ? 'bg-rose-500' : 'bg-amber-500')} />{t(healthy ? 'connectionHealth.healthy' : failed ? 'connectionHealth.issue' : 'connectionHealth.check')}</span>
          </div>
          <div className="divide-y divide-border/30 rounded-2xl bg-muted/20 px-3">
            <ConnectionPath
              deviceLabel={t('connectionHealth.device')}
              serviceLabel={t('connectionHealth.service')}
              executorLabel={t('connectionHealth.executor')}
              hostSegment={{ label: t('connectionHealth.deviceHost'), state: status === 'ready' ? hostError ?? t('common.connected') : label, tone: hostTone, latency: hostRtt, measuring: checking && hostRtt === null && !hostError }}
              executorSegment={executorRequired ? { label: t('connectionHealth.hostExecutor'), state: !executorConnected ? t('connectionHealth.offline') : executorError ?? t('common.connected'), tone: executorTone, latency: executorRtt, measuring: checking && executorConnected && executorRtt === null && !executorError } : undefined}
              measuringLabel={t('connectionHealth.measuring')}
            />
            <HealthRow label={t('connectionHealth.sessionSync')} state={displayStatus === 'ready' ? t('connectionHealth.synchronized') : label} tone={displayStatus === 'ready' ? 'healthy' : displayStatus === 'disconnected' || displayStatus === 'error' ? 'failed' : 'pending'} measuringLabel={t('connectionHealth.measuring')} />
          </div>
          <ConnectionHealthCurve key={workspaceId ?? 'chat'} samples={history} executorRequired={executorRequired} now={history[history.length - 1]?.at ?? Date.now()} t={t} />
          <div className="mt-3 flex items-center gap-2"><Button size="sm" variant="outline" className="h-8" disabled={checking || !socket?.connected} onClick={measure}>{t(checking ? 'connectionHealth.measuring' : 'connectionHealth.measureAgain')}</Button><Button size="sm" variant="ghost" className="h-8" onClick={onResync}>{t('connectionHealth.resync')}</Button></div>
          <div className="mt-2 flex min-w-0 items-center justify-between gap-3 text-[0.6875rem] text-muted-foreground" data-testid="connection-transport-row">
            <span className="min-w-0 truncate">{t('connectionHealth.transport')} · {transport ?? t('connectionHealth.unknown')}</span>
            <Button size="sm" variant="ghost" className="h-7 flex-none" onClick={copy} title={t('connectionHealth.diagnostics')}>{t(copied ? 'common.copied' : 'common.copy')}</Button>
          </div>
        </div>
      ) : null}
    </div>
  )
})

type HealthTone = 'healthy' | 'failed' | 'pending'
type ConnectionSegmentInfo = { label: string; state: string; tone: HealthTone; latency?: number | null; measuring?: boolean }

function ConnectionPath({ deviceLabel, serviceLabel, executorLabel, hostSegment, executorSegment, measuringLabel }: { deviceLabel: string; serviceLabel: string; executorLabel: string; hostSegment: ConnectionSegmentInfo; executorSegment?: ConnectionSegmentInfo; measuringLabel: string }): JSX.Element {
  return (
    <div className="py-2.5" data-testid="connection-path">
      <div className={cn('grid items-center gap-1.5', executorSegment ? 'grid-cols-[auto_minmax(0,1fr)_auto_minmax(0,1fr)_auto]' : 'grid-cols-[auto_minmax(0,1fr)_auto]')}>
        <ConnectionEndpoint label={deviceLabel} />
        <ConnectionSegment segment={hostSegment} measuringLabel={measuringLabel} testId="connection-segment-device-service" />
        <ConnectionEndpoint label={serviceLabel} />
        {executorSegment ? <><ConnectionSegment segment={executorSegment} measuringLabel={measuringLabel} testId="connection-segment-service-executor" /><ConnectionEndpoint label={executorLabel} /></> : null}
      </div>
    </div>
  )
}

function ConnectionEndpoint({ label }: { label: string }): JSX.Element {
  return <span className="rounded-full bg-background/80 px-2 py-1 text-[0.625rem] font-medium text-foreground ring-1 ring-border/40">{label}</span>
}

function ConnectionSegment({ segment, measuringLabel, testId }: { segment: ConnectionSegmentInfo; measuringLabel: string; testId: string }): JSX.Element {
  const state = segment.measuring ? measuringLabel : segment.state
  const label = segment.latency !== null && segment.latency !== undefined ? `${segment.latency} ms` : compactSegmentState(state)
  return (
    <div className="flex min-w-0 items-center gap-1" title={`${segment.label}: ${state}${segment.latency !== null && segment.latency !== undefined ? ` · ${segment.latency} ms` : ''}`} data-testid={testId}>
      <span className={cn('h-px min-w-2 flex-1', segment.tone === 'healthy' ? 'bg-emerald-500/60' : segment.tone === 'failed' ? 'bg-rose-500/60' : 'bg-amber-500/60')} />
      <span className={cn('whitespace-nowrap rounded-full px-1.5 py-0.5 font-mono text-[0.625rem] tabular-nums', segment.tone === 'healthy' ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : segment.tone === 'failed' ? 'bg-rose-500/10 text-rose-700 dark:text-rose-300' : 'bg-amber-500/10 text-amber-700 dark:text-amber-300')}>{label}</span>
      <span className={cn('h-px min-w-2 flex-1', segment.tone === 'healthy' ? 'bg-emerald-500/60' : segment.tone === 'failed' ? 'bg-rose-500/60' : 'bg-amber-500/60')} />
    </div>
  )
}

function compactSegmentState(state: string): string {
  return state.length > 8 ? '—' : state
}

function ConnectionHealthCurve({ samples, executorRequired, now, t }: { samples: readonly ConnectionHealthSample[]; executorRequired: boolean; now: number; t: ReturnType<typeof useTranslation>['t'] }): JSX.Element {
  const [hovered, setHovered] = useState<{ sample: ConnectionHealthSample; x: number } | null>(null)
  const width = 320
  const height = 72
  const windowStart = now - CONNECTION_HEALTH_WINDOW_MS
  const recent = samples.filter((sample) => sample.at >= windowStart)
  const domainStart = recent.length > 0 ? Math.max(windowStart, recent[0]!.at) : windowStart
  const domainMs = Math.max(1, now - domainStart)
  const hostMax = latencyMax(recent, (sample) => sample.hostRttMs)
  const executorMax = latencyMax(recent, (sample) => sample.executorRttMs)
  const hostPoints = sparklinePoints(recent, (sample) => sample.hostRttMs, domainStart, domainMs, hostMax, width, height)
  const executorPoints = sparklinePoints(recent, (sample) => sample.executorRttMs, domainStart, domainMs, executorMax, width, height)
  const failures = recent.filter((sample) => !sample.hostOk || sample.executorRequired && !sample.executorOk)

  return (
    <div className="relative mt-3 rounded-2xl border border-border/35 bg-muted/10 p-3" data-testid="connection-health-curve" data-sample-count={recent.length}>
      <div className="mb-2 flex items-center justify-between gap-3">
        <div>
          <p className="text-xs font-medium text-foreground">{t('connectionHealth.historyTitle')}</p>
        </div>
        <div className="flex flex-none items-center gap-2 text-[0.625rem] text-muted-foreground">
          <span className="inline-flex items-center gap-1"><span className="h-1.5 w-3 rounded-full bg-primary" />{t('connectionHealth.hostLegend')}</span>
          {executorRequired ? <span className="inline-flex items-center gap-1"><span className="h-1.5 w-3 rounded-full bg-sky-400" />{t('connectionHealth.executorLegend')}</span> : null}
        </div>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={t('connectionHealth.historyAria')} className="h-20 w-full overflow-visible">
        <line x1="0" y1={height - 8} x2={width} y2={height - 8} className="stroke-border" strokeWidth="1" />
        {hostPoints ? <polyline points={hostPoints} fill="none" className="stroke-primary" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" data-testid="connection-health-host-line" /> : null}
        {executorRequired && executorPoints ? <polyline points={executorPoints} fill="none" className="stroke-sky-400" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" data-testid="connection-health-executor-line" /> : null}
        {failures.map((sample, index) => (
          <circle key={`${sample.at}:${index}`} cx={scaleHealthX(sample.at, domainStart, domainMs, width)} cy={height - 8} r="3" className="fill-rose-500" />
        ))}
        {recent.map((sample, index) => {
          const x = scaleHealthX(sample.at, domainStart, domainMs, width)
          return (
            <rect
              key={`hit:${sample.at}:${index}`}
              x={Math.max(0, x - 6)}
              y="0"
              width="12"
              height={height}
              fill="transparent"
              tabIndex={0}
              aria-label={formatHealthSampleTitle(sample, t).replace(/\n/gu, ', ')}
              data-testid="connection-health-sample-hit"
              onFocus={() => setHovered({ sample, x })}
              onBlur={() => setHovered(null)}
              onMouseEnter={() => setHovered({ sample, x })}
              onMouseLeave={() => setHovered(null)}
            />
          )
        })}
      </svg>
      {hovered ? (
        <div className="pointer-events-none absolute top-12 z-10 min-w-32 -translate-x-1/2 rounded-lg bg-popover px-2.5 py-2 text-[0.6875rem] shadow-lg ring-1 ring-border/40" style={{ left: `calc(0.75rem + ${hovered.x / width * 100}%)` }} data-testid="connection-health-tooltip">
          {formatHealthSampleTitle(hovered.sample, t).split('\n').map((line) => <div key={line}>{line}</div>)}
        </div>
      ) : null}
    </div>
  )
}

function formatHealthSampleTitle(sample: ConnectionHealthSample, t: ReturnType<typeof useTranslation>['t']): string {
  const time = new Date(sample.at).toLocaleTimeString()
  return [
    time,
    `${t('connectionHealth.hostLegend')}: ${formatSampleLatency(sample.hostRttMs, sample.hostOk, t)}`,
    ...(sample.executorRequired ? [`${t('connectionHealth.executorLegend')}: ${formatSampleLatency(sample.executorRttMs, sample.executorOk, t)}`] : []),
  ].join('\n')
}

function formatSampleLatency(value: number | null, ok: boolean, t: ReturnType<typeof useTranslation>['t']): string {
  if (typeof value === 'number') return `${value} ms`
  return ok ? t('connectionHealth.notMeasured') : t('connectionHealth.timedOut')
}

function latencyMax(samples: readonly ConnectionHealthSample[], select: (sample: ConnectionHealthSample) => number | null): number {
  return Math.max(50, ...samples.map(select).filter((value): value is number => typeof value === 'number'))
}

function sparklinePoints(samples: readonly ConnectionHealthSample[], select: (sample: ConnectionHealthSample) => number | null, start: number, domainMs: number, max: number, width: number, height: number): string | null {
  const points = samples.flatMap((sample) => {
    const value = select(sample)
    if (value === null) return []
    const x = scaleHealthX(sample.at, start, domainMs, width)
    const y = height - 8 - value / max * (height - 16)
    return [`${x.toFixed(1)},${y.toFixed(1)}`]
  })
  if (points.length === 0) return null
  if (points.length === 1) return `${points[0]} ${points[0]}`
  return points.join(' ')
}

function scaleHealthX(at: number, start: number, domainMs: number, width: number): number {
  return Math.max(0, Math.min(width, (at - start) / domainMs * width))
}

function HealthRow({ label, state, tone, latency, measuring = false, measuringLabel }: { label: string; state: string; tone: 'healthy' | 'failed' | 'pending'; latency?: number | null; measuring?: boolean; measuringLabel: string }): JSX.Element {
  return (
    <div className="grid min-h-9 grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-2 py-1.5">
      <span className={cn('h-2 w-2 rounded-full', tone === 'healthy' ? 'bg-emerald-500' : tone === 'failed' ? 'bg-rose-500' : 'bg-amber-500')} />
      <span className="min-w-0 truncate font-medium text-foreground">{label}</span>
      <span className="min-w-0 truncate text-[0.6875rem] text-muted-foreground">{measuring ? measuringLabel : state}</span>
      {latency !== null && latency !== undefined ? <span className="font-mono text-xs tabular-nums text-foreground">{latency} ms</span> : null}
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
  return randomId()
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
