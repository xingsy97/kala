import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { Archive, BarChart3, Boxes, ChevronDown, ChevronUp, Eraser, Files, FolderOpen, Info, ListChecks, Loader2, Menu, Moon, PanelLeftClose, PanelRight, PanelRightClose, Plus, Settings, ShieldCheck, Sparkles, Square, Sun, Workflow } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Toaster } from 'sonner'
import { useQuery, useQueryClient } from '@tanstack/react-query'

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
  SessionSummary,
} from '@agent-kernel/shared'

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
  setSessionModel,
  updateQueuedMessage,
  useControlPlane,
  useSession,
} from './session.js'
import { backgroundTerminalTasks } from './background-terminal.js'
import { resolveHostEndpoint, type ResolvedHostEndpoint } from './host-endpoint.js'
import { cn } from './lib/utils.js'
import { withViewTransition } from './lib/viewTransition.js'
import { reconcilePendingUserMessages, visibleMessages, visibleTranscript } from './transcript.js'
import type { PendingUserTranscriptMessage } from './transcript.js'
import type { TimelineEntry } from './session.js'
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
  PREF_EXPLORER_OPEN,
  PREF_FILE_EXPLORER_FONT_SIZE,
  PREF_INSPECTOR_OPEN,
  PREF_LIVE_TOOL_ACTIVITY_TAIL_COUNT,
  PREF_SESSION_EXPLORER_FONT_SIZE,
  PREF_TOPBAR_OPEN,
  useBooleanPref,
  useNumberPref,
} from './lib/prefs.js'
import {
  DEFAULT_SESSION_VIEW_CACHE_MAX_MB,
  PREF_SESSION_VIEW_CACHE_MAX_MB,
  createSessionViewCache,
  sessionViewCacheMaxBytesFromMb,
} from './session-view-cache.js'
import { useInterventionDesktopNotifications } from './lib/desktop-notifications.js'
import { useRunningTitleIndicator } from './lib/running-title.js'
import { useTheme, type Theme } from './lib/theme.js'
import {
  useBackgroundShellToasts,
  useInactiveSessionSummaryToasts,
  useSessionToasts,
  useSubAgentToasts,
} from './session-toasts.js'

const MODEL_STORAGE_KEY = 'ak-model'
const PREF_SESSION_EXPLORER_SECTION_OPEN = 'ak-session-explorer-section-open'
const PREF_SESSION_FILES_OPEN = 'ak-session-files-open'
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
  const [sessionFilesOpen, setSessionFilesOpen] = useBooleanPref(PREF_SESSION_FILES_OPEN, true)
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
  const sessionExplorerFontSizePx = SESSION_EXPLORER_FONT_SIZE_PX[sessionExplorerFontSize] ?? SESSION_EXPLORER_FONT_SIZE_PX[DEFAULT_SESSION_EXPLORER_FONT_SIZE]
  const fileExplorerFontSizePx = FILE_EXPLORER_FONT_SIZE_PX[fileExplorerFontSize] ?? FILE_EXPLORER_FONT_SIZE_PX[DEFAULT_FILE_EXPLORER_FONT_SIZE]
  const sessionViewCacheRef = useRef(createSessionViewCache({ maxBytes: sessionViewCacheMaxBytesFromMb(sessionViewCacheMaxMb) }))
  const cachedSessionIdsRef = useRef<ReadonlySet<string>>(new Set())
  useEffect(() => {
    sessionViewCacheRef.current.setMaxBytes(sessionViewCacheMaxBytesFromMb(sessionViewCacheMaxMb))
  }, [sessionViewCacheMaxMb])
  const getCachedSessionView = useCallback(
    (sessionId: string) => sessionViewCacheRef.current.get(sessionId),
    [],
  )
  const wideLayout = useMinWidth(1024)
  const isMobile = useIsMobile()
  const { models, defaultModel, reload: reloadModels } = useModels()
  const [storedModel, setStoredModel] = useState<string | null>(() => {
    try {
      return localStorage.getItem(MODEL_STORAGE_KEY)
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

  const [hostEndpoint, setHostEndpoint] = useState<ResolvedHostEndpoint>(() => resolveHostEndpoint())
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
    cache: sessionViewCacheRef.current,
    ...(config.token !== undefined ? { token: config.token } : {}),
    onForked: (p) => {
      setForkingFromSeq(null)
      setConfig((prev) => ({ ...prev, sessionId: p.sessionId, explicit: true }))
    },
  })
  const selectedModelKey = useMemo(
    () => resolveModelKey(models, session.selectedModel) || session.selectedModel || '',
    [models, session.selectedModel],
  )
  const control = useControlPlane(session.socket)
  const controlSessionsRef = useRef<readonly SessionSummary[]>([])
  controlSessionsRef.current = control.sessions
  const currentSession = control.sessions.find(
    (s) => s.sessionId === config.sessionId,
  )
  const activeSessionId = currentSession?.sessionId ?? null

  useEffect(() => {
    if (!control.sessionsLoaded) return
    const nextIds = new Set(control.sessions.map((s) => s.sessionId))
    for (const removedId of removedSessionIds(cachedSessionIdsRef.current, nextIds)) sessionViewCacheRef.current.delete(removedId)
    cachedSessionIdsRef.current = nextIds
  }, [control.sessions, control.sessionsLoaded])

  useEffect(() => {
    const socket = session.socket
    if (!socket) return
    const onEventAppended = (payload: EventAppendedEvent): void => {
      if (payload.event.kind === 'clear') sessionViewCacheRef.current.delete(payload.sessionId)
    }
    socket.on('event:appended', onEventAppended)
    return () => {
      socket.off('event:appended', onEventAppended)
    }
  }, [session.socket])

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
    const level = session.contextSnapshot?.pressureLevel
    const status = session.state?.status
    const resting = status === 'idle' || status === 'done' || status === 'error'
    if (level === 'hard' && resting) {
      if (compactStatus.kind === 'idle') setCompactStatus({ kind: 'queued' })
      return
    }
    if (compactStatus.kind === 'queued') setCompactStatus({ kind: 'idle' })
  }, [session.contextSnapshot?.pressureLevel, session.state?.status, compactStatus.kind])

  useEffect(() => {
    if (session.status !== 'ready' || !session.socket || config.sessionId === null) return
    const normalizedSessionModel = resolveModelKey(models, session.selectedModel)
    if (normalizedSessionModel && normalizedSessionModel !== session.selectedModel) {
      setSessionModel(session.socket, config.sessionId, normalizedSessionModel)
      return
    }
  }, [
    session.status,
    session.socket,
    session.selectedModel,
    models,
    config.sessionId,
  ])

  const onModelChange = (model: string): void => {
    setStoredModel(model)
    try {
      localStorage.setItem(MODEL_STORAGE_KEY, model)
    } catch {}
    if (session.socket && config.sessionId !== null) {
      setSessionModel(session.socket, config.sessionId, model)
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

  const [consolidateToast, setConsolidateToast] = useState<
    { kind: 'success' | 'info' | 'error'; message: string } | null
  >(null)
  const consolidateToastTimer = useRef<number | null>(null)
  const runConsolidateMemory = useCallback((): void => {
    if (!session.socket || config.sessionId === null) return
    const socket = session.socket
    const requestId = crypto.randomUUID()
    const handler = (result: ConsolidateMemoryResult): void => {
      if (result.requestId !== requestId) return
      socket.off('server:memory_consolidated', handler)
      if (consolidateToastTimer.current !== null) {
        window.clearTimeout(consolidateToastTimer.current)
      }
      if (result.error) {
        setConsolidateToast({ kind: 'error', message: t('app.consolidateFailed', { error: result.error }) })
      } else if (result.saved.length > 0) {
        setConsolidateToast({
          kind: 'success',
          message: t('app.savedMemories', {
            count: result.saved.length,
            label: t(result.saved.length === 1 ? 'app.memory_one' : 'app.memory_other'),
            items: result.saved.join(', '),
          }),
        })
      } else {
        setConsolidateToast({
          kind: 'info',
          message: result.reason ?? t('app.nothingWorthSaving'),
        })
      }
      consolidateToastTimer.current = window.setTimeout(() => {
        setConsolidateToast(null)
        consolidateToastTimer.current = null
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
    sessionViewCacheRef.current.delete(config.sessionId)
    clearSession(session.socket, config.sessionId)
  }
  const pickWorkspaceForNew = async (
    workspaceId: string,
    workspaceName: string | undefined,
    cwd: string,
  ): Promise<void> => {
    if (!pendingWorkspacePick) return
    const { sessionId } = pendingWorkspacePick
    if (!session.socket) {
      setWorkspacePickError(t('app.socketNotConnected'))
      return
    }
    setWorkspacePickSubmitting(true)
    setWorkspacePickError(null)
    try {
      await createSessionWithAck(session.socket, {
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
    if (!session.socket) {
      setWorkspacePickError(t('app.socketNotConnected'))
      return
    }
    setWorkspacePickSubmitting(true)
    setWorkspacePickError(null)
    try {
      const cwd = `/tmp/agent-kernel-chat-${crypto.randomUUID()}`
      await createSessionWithAck(session.socket, {
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
    if (!session.socket) return
    for (const id of sessionIdsForCacheInvalidation(controlSessionsRef.current, sessionId, Boolean(options.cascade))) {
      sessionViewCacheRef.current.delete(id)
    }
    deleteSession(session.socket, sessionId, options)
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
  }, [config.sessionId, session.socket])
  const renameSessionAt = useCallback((sessionId: string, label: string): void => {
    if (!session.socket) return
    renameSession(session.socket, sessionId, label)
  }, [session.socket])
  const renameWorkspaceAt = useCallback((workspaceId: string, workspaceName: string): void => {
    if (!session.socket || workspaceId.length === 0) return
    renameWorkspace(session.socket, workspaceId, workspaceName)
  }, [session.socket])
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

  const currentCwd = session.state?.cwd ?? currentSession?.currentCwd ?? ''
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
      return await new Promise((resolve) => {
        const requestId = crypto.randomUUID()
        const timer = setTimeout(() => {
          socket.off('server:file_contents', handler)
          resolve({ error: 'timed out' })
        }, 5000)
        const handler = (result: FileContentsResult): void => {
          if (result.requestId !== requestId) return
          clearTimeout(timer)
          socket.off('server:file_contents', handler)
          if (result.error) resolve({ error: result.error })
          else resolve({ content: result.content ?? '' })
        }
        socket.on('server:file_contents', handler)
        socket.emit('client:read_file', {
          requestId,
          workspaceId,
          path,
        })
      })
    },
    [session.socket, currentSession?.workspaceId],
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
    <div className="h-dvh w-screen max-w-[100dvw] overflow-hidden bg-background text-foreground flex flex-col">
      <AppShellNav
        section={section}
        onSelect={handleSectionSelect}
        onOpenSettings={() => setSettingsOpen(true)}
        connectionStatus={hasSelectedSession ? <ConnectionStatus status={session.status} /> : null}
        collapsed={!topbarOpen}
        onCollapse={() => setTopbarOpen(false)}
        onExpand={() => setTopbarOpen(true)}
      />
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
                    {sessionExplorerSectionOpen && sessionFilesOpen ? (
                      <ResizablePanelGroup direction="vertical" autoSaveId="ak-left-sidebar-rows-v2" className="min-h-0 flex-1">
                        <ResizablePanel id="session-explorer" order={1} defaultSize={62} minSize={28} className="flex min-h-0 flex-col">
                          <SidebarSectionToggle
                            icon={<Menu className="h-3.5 w-3.5" />}
                            label="Session explorer"
                            open={sessionExplorerSectionOpen}
                            onToggle={() => setSessionExplorerSectionOpen(false)}
                            action={<SidebarCollapseButton onCollapse={() => setExplorerOpen(false)} />}
                            data-testid="session-explorer-sidebar-toggle"
                          />
                          <div className="min-h-0 flex-1">
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
                          </div>
                        </ResizablePanel>
                        <ResizableHandle withHandle />
                        <ResizablePanel id="file-explorer" order={2} defaultSize={38} minSize={22} className="flex min-h-0 flex-col">
                          <SidebarSectionToggle
                            icon={<Files className="h-3.5 w-3.5" />}
                            label="File explorer"
                            open={sessionFilesOpen}
                            onToggle={() => setSessionFilesOpen(false)}
                            data-testid="session-files-sidebar-toggle"
                          />
                          <div className="min-h-0 flex-1" data-testid="session-files-sidebar">
                            <Suspense fallback={<div className="p-3 text-xs text-sidebar-foreground/60">Loading files...</div>}>
                              <SessionFilesPanel
                                mode="sidebar"
                                socket={session.socket}
                                workspaceId={fileExplorerWorkspaceId}
                                sessionId={activeSessionId}
                                cwd={currentCwd}
                                fontSizePx={fileExplorerFontSizePx}
                              />
                            </Suspense>
                          </div>
                        </ResizablePanel>
                      </ResizablePanelGroup>
                    ) : sessionExplorerSectionOpen && !sessionFilesOpen ? (
                      <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)_auto]">
                        <SidebarSectionToggle
                          icon={<Menu className="h-3.5 w-3.5" />}
                          label="Session explorer"
                          open={sessionExplorerSectionOpen}
                          onToggle={() => setSessionExplorerSectionOpen(!sessionExplorerSectionOpen)}
                          action={<SidebarCollapseButton onCollapse={() => setExplorerOpen(false)} />}
                          data-testid="session-explorer-sidebar-toggle"
                        />
                        <div className="min-h-0 overflow-hidden">
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
                        </div>
                        <SidebarSectionToggle
                          icon={<Files className="h-3.5 w-3.5" />}
                          label="File explorer"
                          open={sessionFilesOpen}
                          onToggle={() => setSessionFilesOpen(!sessionFilesOpen)}
                          data-testid="session-files-sidebar-toggle"
                        />
                      </div>
                    ) : !sessionExplorerSectionOpen && sessionFilesOpen ? (
                      <div className="grid h-full min-h-0 grid-rows-[auto_auto_minmax(0,1fr)]">
                        <SidebarSectionToggle
                          icon={<Menu className="h-3.5 w-3.5" />}
                          label="Session explorer"
                          open={sessionExplorerSectionOpen}
                          onToggle={() => setSessionExplorerSectionOpen(!sessionExplorerSectionOpen)}
                          action={<SidebarCollapseButton onCollapse={() => setExplorerOpen(false)} />}
                          data-testid="session-explorer-sidebar-toggle"
                        />
                        <SidebarSectionToggle
                          icon={<Files className="h-3.5 w-3.5" />}
                          label="File explorer"
                          open={sessionFilesOpen}
                          onToggle={() => setSessionFilesOpen(!sessionFilesOpen)}
                          data-testid="session-files-sidebar-toggle"
                        />
                        <div className="min-h-0 overflow-hidden" data-testid="session-files-sidebar">
                          <Suspense fallback={<div className="p-3 text-xs text-sidebar-foreground/60">Loading files...</div>}>
                            <SessionFilesPanel
                              mode="sidebar"
                              socket={session.socket}
                              workspaceId={fileExplorerWorkspaceId}
                              sessionId={activeSessionId}
                              cwd={currentCwd}
                              fontSizePx={fileExplorerFontSizePx}
                            />
                          </Suspense>
                        </div>
                      </div>
                    ) : (
                      <div className="flex h-full min-h-0 flex-col">
                        <SidebarSectionToggle
                          icon={<Menu className="h-3.5 w-3.5" />}
                          label="Session explorer"
                          open={sessionExplorerSectionOpen}
                          onToggle={() => setSessionExplorerSectionOpen(!sessionExplorerSectionOpen)}
                          action={<SidebarCollapseButton onCollapse={() => setExplorerOpen(false)} />}
                          data-testid="session-explorer-sidebar-toggle"
                        />
                        <SidebarSectionToggle
                          icon={<Files className="h-3.5 w-3.5" />}
                          label="File explorer"
                          open={sessionFilesOpen}
                          onToggle={() => setSessionFilesOpen(!sessionFilesOpen)}
                          data-testid="session-files-sidebar-toggle"
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
                  <div className="relative grid flex-1 min-h-0 grid-rows-[minmax(0,1fr)_auto] overflow-hidden">
                    <div
                      className="flex min-h-0 flex-col bg-background"
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
                    <div className="min-h-0 pb-[env(safe-area-inset-bottom)]">
                      {session.lastError ? (
                        <div
                          className="px-3 py-2 text-xs text-rose-700 dark:text-rose-300 bg-rose-50 dark:bg-rose-950/40 border-t border-rose-200 dark:border-rose-900"
                          data-testid="session-error"
                        >
                          [{session.lastError.scope}] {session.lastError.message}
                        </div>
                      ) : null}
                      {sessionWorkspaceKnownOffline ? (
                        <div
                          className="px-3 py-2 text-xs text-amber-800 dark:text-amber-200 bg-amber-50 dark:bg-amber-950/40 border-t border-amber-200 dark:border-amber-900"
                          data-testid="workspace-offline-banner"
                        >
                          workspace <span className="font-mono">{currentSession?.workspaceName ?? currentSession?.workspaceId}</span> is offline — start its executor to send messages.
                        </div>
                      ) : null}
                      {consolidateToast ? (
                        <div
                          className={cn(
                            'px-3 py-2 text-xs border-t',
                            consolidateToast.kind === 'success' &&
                              'text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-900',
                            consolidateToast.kind === 'error' &&
                              'text-rose-700 dark:text-rose-300 bg-rose-50 dark:bg-rose-950/40 border-rose-200 dark:border-rose-900',
                            consolidateToast.kind === 'info' &&
                              'text-sky-700 dark:text-sky-300 bg-sky-50 dark:bg-sky-950/40 border-sky-200 dark:border-sky-900',
                          )}
                          data-testid="consolidate-toast"
                        >
                          {consolidateToast.message}
                        </div>
                      ) : null}
                      <ContextPressureBanner
                        state={session.state}
                        contextSnapshot={session.contextSnapshot}
                        compactRunning={compactStatus.kind === 'running'}
                        suppressed={awaitingAck || compactStatus.kind === 'running'}
                        onCompactNow={runCompactNow}
                      />
                      <ComposerFlipContainer
                        showApproval={session.pendingApprovals.length > 0}
                        front={
                          <Composer
                          disabled={session.status !== 'ready' || sessionWorkspaceKnownOffline}
                          model={selectedModelKey || preferredModel}
                          models={models}
                          onModelChange={onModelChange}
                          approvalMode={session.state?.approvalMode ?? 'auto'}
                          onApprovalModeChange={onApprovalModeChange}
                          state={session.state}
                          config={session.config}
                          contextSnapshot={session.contextSnapshot}
                          queuedMessages={visibleQueuedMessages}
                          timeline={session.timeline}
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
                            if (mode === 'queue') {
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
                                  mode,
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
                            if (mode === 'steer') suppressNextWaitingNotification.current = true
                            if (mode === 'steer' && session.contextSnapshot?.pressureLevel === 'hard') {
                              if (compactResetTimer.current !== null) {
                                window.clearTimeout(compactResetTimer.current)
                                compactResetTimer.current = null
                              }
                              const startSeq = session.timeline.at(-1)?.seq ?? 0
                              compactStartSeq.current = startSeq
                              inferredCompactSeq.current = startSeq
                              setCompactStatus({
                                kind: 'running',
                                startedAt: Date.now(),
                                tokensBefore: session.state?.usage.inputTokens ?? 0,
                              })
                            }
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
          className="left-0 top-0 h-dvh w-[min(22rem,100vw)] max-w-none !translate-x-0 !translate-y-0 overflow-hidden p-0 gap-0 sm:rounded-none"
          data-testid="explorer-drawer"
        >
          <DialogHeader className="sr-only">
            <DialogTitle>{t('common.explorer')}</DialogTitle>
            <DialogDescription>{t('app.explorerDescription')}</DialogDescription>
          </DialogHeader>
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
            fontSizePx={sessionExplorerFontSizePx}
            getCachedSessionView={getCachedSessionView}
            onOpenSessionInfo={openExplorerDrawerSessionInfo}
            onWorkspaceInfo={openExplorerDrawerWorkspaceInfo}
          />
        </DialogContent>
      </Dialog>
      <Dialog open={inspectorDrawerOpen && !wideLayout && hasSelectedSession} onOpenChange={setInspectorDrawerOpen}>
        <DialogContent
          className="right-0 top-0 h-dvh w-[min(26rem,100vw)] max-w-none !left-auto !translate-x-0 !translate-y-0 overflow-hidden p-0 gap-0 sm:rounded-none"
          data-testid="inspector-drawer-mobile"
        >
          <DialogHeader className="sr-only">
            <DialogTitle>{t('app.openInspector')}</DialogTitle>
            <DialogDescription>{t('app.inspectorDescription')}</DialogDescription>
          </DialogHeader>
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
        selectedModel={metadataIsCurrentSession ? session.selectedModel : null}
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
          target={workspaceFileViewTarget}
        />
      </Suspense>
      <CommandPalette
        open={commandPaletteOpen}
        onOpenChange={setCommandPaletteOpen}
        commands={commandPaletteCommands}
      />
      <Toaster position="bottom-right" richColors closeButton theme={effectiveTheme} />
      </div>
    </div>
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
  return status === 'idle' || status === 'done' || status === 'error'
}

function isCompactTerminalEvent(kind: string): boolean {
  return kind === 'messages_replaced'
}

function isCompactionSuccess(event: { kind: string; reason?: string }): boolean {
  return event.kind === 'messages_replaced' && event.reason === 'compaction'
}

function compactFailureMessage(event: { kind: string; reason?: string }): string {
  return 'compact failed'
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
  return status === 'loading' || status === 'thinking' || status === 'executing_tools' || status === 'awaiting_approval'
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
  return status === 'idle' || status === 'done' || status === 'error'
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

function SidebarSectionToggle({
  icon,
  label,
  open,
  onToggle,
  action,
  ...props
}: {
  icon: ReactNode
  label: string
  open: boolean
  onToggle(): void
  action?: ReactNode
} & ButtonHTMLAttributes<HTMLButtonElement>): JSX.Element {
  return (
    <div className="flex h-9 w-full flex-none items-center border-b border-sidebar-border">
      <button
        type="button"
        className="flex h-full min-w-0 flex-1 items-center gap-2 px-2 text-left text-xs font-medium hover:bg-sidebar-accent"
        onClick={onToggle}
        aria-expanded={open}
        {...props}
      >
        {icon}
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronUp className="h-3.5 w-3.5" />}
      </button>
      {action ? <div className="flex h-full flex-none items-center px-1">{action}</div> : null}
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
