import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Archive, BarChart3, Boxes, Eraser, FolderOpen, Info, ListChecks, Menu, Moon, PanelRight, PanelRightClose, Plus, Settings, ShieldCheck, Sparkles, Square, Sun } from 'lucide-react'
import { Toaster } from 'sonner'

import type {
  ConsolidateMemoryResult,
  FileContentsResult,
  FileListEntry,
  FileListResult,
  ModelInfo,
  OverflowContentsResult,
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
import { ChatPanel } from './features/chat/ChatPanel.js'
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
import { Explorer } from './features/explorer/Explorer.js'
import { WorkspacePicker } from './features/explorer/WorkspacePicker.js'
import { InspectorPanel } from './features/inspector/InspectorPanel.js'
import { SettingsDialog } from './features/settings/SettingsDialog.js'
import { ArtifactExplorerDialog } from './features/artifacts/ArtifactExplorerDialog.js'
import {
  cancelSession,
  clearSession,
  createSessionWithAck,
  deleteQueuedMessage,
  deleteSession,
  reorderQueuedMessage,
  renameSession,
  respondApproval,
  setSessionApprovalMode,
  setSessionModel,
  updateQueuedMessage,
  useControlPlane,
  useSession,
} from './session.js'
import { backgroundTerminalTasks } from './background-terminal.js'
import { cn } from './lib/utils.js'
import { withViewTransition } from './lib/viewTransition.js'
import { visibleMessages, visibleTranscript } from './transcript.js'
import { useInterventionDesktopNotifications } from './lib/desktop-notifications.js'
import {
  useBackgroundShellToasts,
  useSessionToasts,
  useSubAgentToasts,
} from './session-toasts.js'

type Theme = 'dark' | 'light'

const MODEL_STORAGE_KEY = 'ak-model'
const COMPACT_WATCHDOG_MS = 75_000

/**
 * Fetch the host's advertised models on mount. The host reads them from
 * `~/.claude/settings.json` and `~/.codex/config.toml`; hardcoding a list here
 * would drift away from what the host actually accepts.
 */
function useModels(): { models: readonly ModelInfo[]; defaultModel: string; reload(): void } {
  const [state, setState] = useState<{
    models: readonly ModelInfo[]
    defaultModel: string
  }>({ models: [], defaultModel: '' })
  const [version, setVersion] = useState(0)
  useEffect(() => {
    let cancelled = false
    void fetch('/models', { cache: 'no-store' })
      .then((r) => (r.ok ? (r.json() as Promise<ServerModelsPayload>) : null))
      .then((payload) => {
        if (cancelled || !payload) return
        setState({
          models: payload.models,
          defaultModel: payload.defaultModel,
        })
      })
      .catch(() => {
        // Non-fatal: dashboard just shows an empty picker until config is fixed.
      })
    return () => {
      cancelled = true
    }
  }, [version])
  return { ...state, reload: () => setVersion((v) => v + 1) }
}

function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      const stored = localStorage.getItem('ak-theme')
      if (stored === 'light' || stored === 'dark') return stored
    } catch {}
    return 'dark'
  })
  useEffect(() => {
    const root = document.documentElement
    if (theme === 'dark') root.classList.add('dark')
    else root.classList.remove('dark')
    try { localStorage.setItem('ak-theme', theme) } catch {}
  }, [theme])
  return [theme, () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))]
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

export function App(): JSX.Element {
  const [config, setConfig] = useState(() => readInitialConfig())
  const [highlightIndex, setHighlightIndex] = useState<number | null>(null)
  const [inspectorOpen, setInspectorOpen] = useState(true)
  const [pendingWorkspacePick, setPendingWorkspacePick] = useState<
    { sessionId: string; workspaceId?: string } | null
  >(null)
  const [workspacePickError, setWorkspacePickError] = useState<string | null>(null)
  const [workspacePickSubmitting, setWorkspacePickSubmitting] = useState(false)
  const [connectWorkspaceOpen, setConnectWorkspaceOpen] = useState(false)
  const [explorerDrawerOpen, setExplorerDrawerOpen] = useState(false)
  const [cwdDialogOpen, setCwdDialogOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [artifactsOpen, setArtifactsOpen] = useState(false)
  const [artifactInitialMode, setArtifactInitialMode] = useState<'artifacts' | 'eval' | 'profiles' | 'memory'>('artifacts')
  const [metadataOpen, setMetadataOpen] = useState(false)
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false)
  const [workspaceInfoId, setWorkspaceInfoId] = useState<string | null>(null)
  const [compactStatus, setCompactStatus] = useState<CompactStatus>({ kind: 'idle' })
  const compactResetTimer = useRef<number | null>(null)
  const compactStartSeq = useRef<number | null>(null)
  const [theme, toggleTheme] = useTheme()
  const wideLayout = useMinWidth(1180)
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
    if (storedModel && models.some((m) => m.id === storedModel)) return storedModel
    if (defaultModel && models.some((m) => m.id === defaultModel)) return defaultModel
    return models[0]?.id ?? ''
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
    const params = new URLSearchParams({ sessionId: config.sessionId })
    if (config.token) params.set('token', config.token)
    const next = `?${params.toString()}`
    if (window.location.search !== next) {
      window.history.replaceState(null, '', next)
    }
  }, [config])

  const session = useSession({
    host: window.location.origin,
    sessionId: config.sessionId,
    ...(config.token !== undefined ? { token: config.token } : {}),
    onForked: (p) => {
      setConfig((prev) => ({ ...prev, sessionId: p.sessionId, explicit: true }))
    },
  })

  useEffect(() => {
    setCompactStatus({ kind: 'idle' })
    compactStartSeq.current = null
  }, [config.sessionId])

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
    if (last?.event.kind !== 'compact_replaced') return
    if (last.seq <= compactStartSeq.current) return
    compactStartSeq.current = null
    setCompactStatus({ kind: 'done' })
    scheduleCompactIdle(2500)
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
        message: 'compact did not finish after the host timeout window',
      })
    }, COMPACT_WATCHDOG_MS)
    return () => window.clearTimeout(timer)
  }, [compactStatus])

  // If the host already has a per-session model on record, that's the truth
  // (persists across reloads because host keeps it in memory). Only push the
  // client's `preferredModel` when the host has nothing  -  otherwise a fresh
  // page load would clobber a previously-picked model with the localStorage
  // default and defeat the whole purpose of remembering the choice.
  useEffect(() => {
    if (session.status !== 'ready' || !session.socket) return
    if (session.selectedModel) return
    if (!preferredModel) return
    setSessionModel(session.socket, config.sessionId, preferredModel)
  }, [
    session.status,
    session.socket,
    session.selectedModel,
    preferredModel,
    config.sessionId,
  ])

  const onModelChange = (model: string): void => {
    setStoredModel(model)
    try {
      localStorage.setItem(MODEL_STORAGE_KEY, model)
    } catch {}
    if (session.socket) {
      setSessionModel(session.socket, config.sessionId, model)
    }
  }

  const onApprovalModeChange = (mode: import('@agent-kernel/kernel').ApprovalMode): void => {
    if (!session.socket) return
    setSessionApprovalMode(session.socket, config.sessionId, mode)
  }

  const runCompactNow = (): void => {
    if (!hasCompactableContent(session.state)) {
      setCompactStatus({ kind: 'empty', message: 'send a message before compacting context' })
      scheduleCompactIdle(6000)
      return
    }
    if (session.state && !isResting(session.state.status)) {
      setCompactStatus({ kind: 'error', message: 'wait for the current turn to finish before compacting' })
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
    if (!session.socket) return
    const socket = session.socket
    const requestId = crypto.randomUUID()
    const handler = (result: ConsolidateMemoryResult): void => {
      if (result.requestId !== requestId) return
      socket.off('server:memory_consolidated', handler)
      if (consolidateToastTimer.current !== null) {
        window.clearTimeout(consolidateToastTimer.current)
      }
      if (result.error) {
        setConsolidateToast({ kind: 'error', message: `Consolidate memory failed: ${result.error}` })
      } else if (result.saved.length > 0) {
        setConsolidateToast({
          kind: 'success',
          message: `Saved ${result.saved.length} memor${result.saved.length === 1 ? 'y' : 'ies'}: ${result.saved.join(', ')}`,
        })
      } else {
        setConsolidateToast({
          kind: 'info',
          message: result.reason ?? 'Nothing worth saving',
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

  const control = useControlPlane(session.socket)

  const selectSession = (sessionId: string): void => {
    withViewTransition(() => setConfig((prev) => ({ ...prev, sessionId, explicit: true })))
  }
  const newSession = (workspaceId?: string): void => {
    setWorkspacePickError(null)
    setWorkspacePickSubmitting(false)
    setPendingWorkspacePick({
      sessionId: crypto.randomUUID(),
      ...(workspaceId !== undefined ? { workspaceId } : {}),
    })
  }
  const clearCurrentSession = (): void => {
    if (!session.socket) return
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
      setWorkspacePickError('dashboard socket is not connected')
      return
    }
    setWorkspacePickSubmitting(true)
    setWorkspacePickError(null)
    try {
      await createSessionWithAck(session.socket, sessionId, workspaceId, workspaceName, cwd)
      selectSession(sessionId)
      setPendingWorkspacePick(null)
    } catch (err) {
      setWorkspacePickError(err instanceof Error ? err.message : String(err))
    } finally {
      setWorkspacePickSubmitting(false)
    }
  }
  const deleteSessionAt = (sessionId: string): void => {
    if (!session.socket) return
    deleteSession(session.socket, sessionId)
    if (sessionId === config.sessionId) {
      const next = nextSessionSelection({
        sessions: control.sessions.filter((s) => s.sessionId !== sessionId),
        currentSessionId: sessionId,
        explicit: true,
      })
      setMetadataOpen(false)
      setCwdDialogOpen(false)
      if (next) {
        selectSession(next.sessionId)
      } else {
        setConfig((prev) => ({
          ...prev,
          sessionId: crypto.randomUUID(),
          explicit: false,
        }))
      }
    }
  }
  const renameSessionAt = (sessionId: string, label: string): void => {
    if (!session.socket) return
    renameSession(session.socket, sessionId, label)
  }

  const currentSession = control.sessions.find(
    (s) => s.sessionId === config.sessionId,
  )
  const hasSelectedSession = currentSession !== undefined
  const currentWorkspaceExecutor = useMemo(() => {
    if (!currentSession?.workspaceId) return undefined
    return control.executors.find(
      (e) => e.workspaceId === currentSession.workspaceId,
    )
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
    setCwdDialogOpen(false)
  }, [hasSelectedSession])

  useEffect(() => {
    if (workspaceInfoId === null || workspaceInfoExists) return
    setWorkspaceInfoId(null)
  }, [workspaceInfoExists, workspaceInfoId])

  useEffect(() => {
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
        ? `${overrideLabel.slice(0, 40)} - `
        : overrideLabel
      : firstMsg
        ? firstMsg.length > 40
          ? `${firstMsg.slice(0, 40)} - `
          : firstMsg
        : 'new session'
  const chatMessages = visibleMessages(
    session.state?.messages ?? [],
    session.timeline,
    session.streamingText,
  )
  const chatItems = visibleTranscript(
    session.state?.messages ?? [],
    session.timeline,
    session.streamingText,
  )
  const backgroundTasks = backgroundTerminalTasks(session.timeline)
  const taskItems = useMemo(() => tasksFromTimeline(session.timeline), [session.timeline])

  const pendingApprovalsCount = session.pendingApprovals.length
  // Pinned-to-bottom is owned by ChatPanel/VirtualTranscript now; we mirror
  // it up here only so a session switch or a first-load reset can force a
  // jump-to-bottom (see scrollToBottomToken below). Virtuoso reports
  // `atBottom` back to us via `onChatPinnedChange`  -  we forward that but
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

  useInterventionDesktopNotifications({
    sessionId: config.sessionId,
    sessionLabel,
    pendingApprovalsCount,
    pendingApprovalSummary: session.pendingApprovals[0],
    lastError: session.lastError,
    connectionStatus: session.status,
    workspaceOnline: hasSelectedSession ? sessionWorkspaceOnline : null,
    workspaceLabel: currentSession?.workspaceName ?? currentSession?.workspaceId,
  })

  useSessionToasts({
    sessionId: config.sessionId,
    sessionLabel,
    connectionStatus: session.status,
    pendingApprovals: session.pendingApprovals,
    lastError: session.lastError,
  })
  useSubAgentToasts(session.socket)
  useBackgroundShellToasts(backgroundTasks)

  const openCwdDialog = (): void => {
    setCwdDialogOpen(true)
  }

  const openArtifacts = (mode: 'artifacts' | 'eval' | 'profiles' | 'memory' = 'artifacts'): void => {
    setArtifactInitialMode(mode)
    setArtifactsOpen(true)
  }

  const commandPaletteCommands = useMemo<readonly CommandPaletteItem[]>(() => {
    const cmds: CommandPaletteItem[] = []
    const socket = session.socket
    const canRun = hasSelectedSession && socket !== null

    cmds.push(
      {
        id: 'session.new',
        group: 'Session',
        label: 'New session',
        hint: 'Create a session in an attached workspace.',
        icon: Plus,
        keywords: ['create', 'start'],
        disabled: control.executors.length === 0,
        disabledReason: 'No workspace online',
        run: () => newSession(),
      },
      {
        id: 'session.info',
        group: 'Session',
        label: 'Session info',
        hint: 'Open metadata for the selected session.',
        icon: Info,
        keywords: ['metadata', 'details'],
        disabled: !hasSelectedSession,
        disabledReason: 'No session selected',
        run: () => setMetadataOpen(true),
      },
      {
        id: 'session.change-cwd',
        group: 'Session',
        label: 'Change cwd',
        hint: 'Change the current workspace directory.',
        icon: FolderOpen,
        keywords: ['directory', 'folder'],
        disabled: !hasSelectedSession || !sessionWorkspaceOnline,
        disabledReason: !hasSelectedSession ? 'No session selected' : 'Workspace is offline',
        run: openCwdDialog,
      },
      {
        id: 'session.compact',
        group: 'Session',
        label: 'Compact context',
        hint: 'Summarise older transcript context.',
        icon: Archive,
        keywords: ['summarize', 'shrink'],
        disabled: !canRun || !hasCompactableContent(session.state),
        disabledReason: !canRun ? 'No active session' : 'Nothing to compact yet',
        run: runCompactNow,
      },
      {
        id: 'session.consolidate-memory',
        group: 'Session',
        label: 'Consolidate memory',
        hint: 'Merge durable memory notes through the memory flow.',
        icon: ListChecks,
        keywords: ['memory'],
        disabled: !canRun,
        disabledReason: 'No active session',
        run: () => runConsolidateMemory(),
      },
      {
        id: 'session.cancel',
        group: 'Session',
        label: 'Stop current turn',
        hint: 'Ask the host to cancel the active run.',
        icon: Square,
        keywords: ['stop', 'abort'],
        disabled: !canRun,
        disabledReason: 'No active session',
        run: () => {
          if (socket) cancelSession(socket, config.sessionId)
        },
      },
      {
        id: 'session.clear',
        group: 'Session',
        label: 'Clear session',
        hint: 'Reset the transcript and runtime state for this session.',
        icon: Eraser,
        keywords: ['reset'],
        disabled: !canRun,
        disabledReason: 'No active session',
        run: () => {
          if (socket) clearSession(socket, config.sessionId)
        },
      },
    )

    cmds.push({
      id: 'workspace.connect',
      group: 'Workspace',
      label: 'Connect workspace - ',
      hint: 'Attach an executor to a workspace directory.',
      icon: FolderOpen,
      keywords: ['attach', 'executor'],
      run: () => setConnectWorkspaceOpen(true),
    })

    cmds.push(
      {
        id: 'view.settings',
        group: 'View',
        label: 'Open settings',
        hint: 'Configure models and dashboard settings.',
        icon: Settings,
        keywords: ['preferences', 'config'],
        run: () => setSettingsOpen(true),
      },
      {
        id: 'view.eval',
        group: 'View',
        label: 'Open eval dashboard',
        hint: 'Inspect benchmark runs, trial evidence, and comparisons.',
        icon: BarChart3,
        keywords: ['swebench', 'benchmark', 'comparison', 'score'],
        run: () => openArtifacts('eval'),
      },
      {
        id: 'view.artifacts',
        group: 'View',
        label: 'Open artifacts',
        hint: 'Inspect host artifact manifests and run outputs.',
        icon: Boxes,
        keywords: ['manifest', 'trace', 'eval'],
        run: () => openArtifacts('artifacts'),
      },
      {
        id: 'view.toggle-theme',
        group: 'View',
        label: theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme',
        hint: 'Toggle dashboard color scheme.',
        icon: theme === 'dark' ? Sun : Moon,
        keywords: ['dark', 'light', 'appearance'],
        run: () => toggleTheme(),
      },
      {
        id: 'view.toggle-inspector',
        group: 'View',
        label: inspectorOpen ? 'Hide inspector' : 'Show inspector',
        hint: 'Toggle the debugger side panel.',
        icon: inspectorOpen ? PanelRightClose : PanelRight,
        keywords: ['debug', 'panel'],
        disabled: !wideLayout || !hasSelectedSession,
        disabledReason: !wideLayout ? 'Inspector is only available on wide layouts' : 'No session selected',
        run: () => setInspectorOpen((value) => !value),
      },
      {
        id: 'view.open-explorer',
        group: 'View',
        label: 'Open explorer',
        hint: wideLayout ? 'Explorer is already visible.' : 'Open the workspace/session drawer.',
        icon: Menu,
        keywords: ['sidebar', 'drawer'],
        run: () => setExplorerDrawerOpen(true),
      },
    )

    for (const mode of APPROVAL_MODES) {
      cmds.push({
        id: `runtime.approval-${mode.value}`,
        group: 'Runtime',
        label: `Approval: ${mode.label}`,
        hint: mode.hint,
        icon: ShieldCheck,
        keywords: ['approval', 'safety', mode.value],
        disabled: !canRun,
        disabledReason: 'No active session',
        run: () => {
          if (socket) setSessionApprovalMode(socket, config.sessionId, mode.value)
        },
      })
    }

    for (const modelInfo of models) {
      cmds.push({
        id: `runtime.model-${modelInfo.id}`,
        group: 'Runtime',
        label: `Model: ${modelInfo.label ?? modelInfo.id}`,
        hint: `Use ${modelInfo.id} for the active session.`,
        icon: Sparkles,
        keywords: ['model', 'switch', modelInfo.id],
        disabled: !canRun,
        disabledReason: 'No active session',
        run: () => onModelChange(modelInfo.id),
      })
    }

    return cmds
  }, [
    config.sessionId,
    control.executors.length,
    hasSelectedSession,
    inspectorOpen,
    models,
    onModelChange,
    runCompactNow,
    runConsolidateMemory,
    session.socket,
    session.state,
    sessionWorkspaceOnline,
    theme,
    toggleTheme,
    wideLayout,
  ])

  const submitCwd = (cwd: string): void => {
    if (!cwd || !session.socket) return
    session.socket.emit('client:set_cwd', {
      sessionId: config.sessionId,
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
      if (!socket) return { error: 'not connected' }
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
          sessionId: config.sessionId,
          callId,
        })
      })
    },
    [session.socket, config.sessionId],
  )

  return (
    <div className="h-dvh w-screen bg-background text-foreground overflow-hidden">
      <div className="hidden" data-testid="login-column-hidden" />
      <ResizablePanelGroup direction="horizontal" autoSaveId="ak-outer-cols-v5">
        {wideLayout ? (
          <>
            <ResizablePanel
              defaultSize={20}
              minSize={17}
              maxSize={22}
              className="min-w-[240px] bg-sidebar text-sidebar-foreground"
              data-testid="explorer-panel"
            >
              <div className="h-full">
                <Explorer
                  executors={control.executors}
                  sessions={control.sessions}
                  selectedSessionId={config.sessionId}
                  onSelect={selectSession}
                  onNewSession={newSession}
                  onConnectWorkspace={() => setConnectWorkspaceOpen(true)}
                  onDelete={deleteSessionAt}
                  onRename={renameSessionAt}
                  onOpenSessionInfo={(sid) => {
                    if (sid !== config.sessionId) selectSession(sid)
                    setMetadataOpen(true)
                  }}
                  onWorkspaceInfo={setWorkspaceInfoId}
                />
              </div>
            </ResizablePanel>
            <ResizableHandle withHandle />
          </>
        ) : null}
        <ResizablePanel
          defaultSize={wideLayout ? 80 : 100}
          minSize={wideLayout ? 78 : 100}
          className="bg-background"
          data-testid="workbench-panel"
        >
          <div className="h-full flex min-h-0 min-w-0 flex-col" data-testid="workbench">
            <WorkbenchToolbar
              sessionLabel={sessionLabel}
              cwd={currentCwd}
              status={session.status}
              onOpenExplorer={() => setExplorerDrawerOpen(true)}
              explorerAvailable={!wideLayout}
              onChangeCwd={openCwdDialog}
              onOpenEval={() => openArtifacts('eval')}
              onOpenArtifacts={() => openArtifacts('artifacts')}
              onOpenSettings={() => setSettingsOpen(true)}
              onToggleInspector={() => setInspectorOpen((v) => !v)}
              inspectorOpen={wideLayout && inspectorOpen}
              inspectorAvailable={wideLayout && hasSelectedSession}
              theme={theme}
              onToggleTheme={toggleTheme}
              sessionSelected={hasSelectedSession}
            />
            {!hasSelectedSession ? (
              <NoSessionArea
                onNewSession={newSession}
                hasSessions={control.sessions.length > 0}
                data-testid="no-session-placeholder"
              />
            ) : (
            <ResizablePanelGroup direction="horizontal" autoSaveId="ak-workbench-cols-v1" className="min-h-0 flex-1">
              <ResizablePanel
                defaultSize={wideLayout ? (inspectorOpen ? 74 : 100) : 100}
                minSize={wideLayout ? 70 : 100}
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
                        pendingApprovals={session.pendingApprovals}
                        onReadOverflow={readOverflow}
                        parentSessionId={config.sessionId}
                        socket={session.socket}
                        onApprovalDecision={(callId, decision) => {
                          if (!session.socket) return
                          respondApproval(session.socket, config.sessionId, callId, decision)
                        }}
                        onEditAndRerun={(seq, text) => {
                          if (!session.socket) return
                          session.socket.emit('client:fork', {
                            sourceSessionId: config.sessionId,
                            cursor: seq - 1,
                            seedMessage: text,
                          })
                        }}
                        onSuggest={(text) => {
                          if (!session.socket || session.status !== 'ready' || !sessionWorkspaceOnline) return
                          session.socket.emit('client:user_message', {
                            sessionId: config.sessionId,
                            text,
                            mode: 'steer',
                          })
                          if (!config.explicit) setConfig((prev) => ({ ...prev, explicit: true }))
                        }}
                        footerSlot={
                          <>
                            <InlineStatusRow
                              state={session.state}
                              streamingActive={session.streamingText.length > 0}
                              onCancel={() => {
                                if (!session.socket) return
                                cancelSession(session.socket, config.sessionId)
                              }}
                            />
                            {compactStatus.kind !== 'idle' ? (
                              <CompactFeedbackRow
                                kind={compactStatus.kind}
                                message={
                                  compactStatus.kind === 'empty' || compactStatus.kind === 'error'
                                    ? compactStatus.message
                                    : undefined
                                }
                                startedAt={
                                  compactStatus.kind === 'running' ? compactStatus.startedAt : undefined
                                }
                                tokensBefore={
                                  compactStatus.kind === 'running' ? compactStatus.tokensBefore : undefined
                                }
                                onDismiss={
                                  compactStatus.kind === 'running'
                                    ? undefined
                                    : () => setCompactStatus({ kind: 'idle' })
                                }
                              />
                            ) : null}
                          </>
                        }
                      />
                    </div>
                    <div className="min-h-0">
                      {session.lastError ? (
                        <div
                          className="px-3 py-2 text-xs text-rose-700 dark:text-rose-300 bg-rose-50 dark:bg-rose-950/40 border-t border-rose-200 dark:border-rose-900"
                          data-testid="session-error"
                        >
                          [{session.lastError.scope}] {session.lastError.message}
                        </div>
                      ) : null}
                      {!sessionWorkspaceOnline ? (
                        <div
                          className="px-3 py-2 text-xs text-amber-800 dark:text-amber-200 bg-amber-50 dark:bg-amber-950/40 border-t border-amber-200 dark:border-amber-900"
                          data-testid="workspace-offline-banner"
                        >
                          workspace <span className="font-mono">{currentSession?.workspaceName ?? currentSession?.workspaceId}</span> is offline  -  start its executor to send messages.
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
                        compactRunning={compactStatus.kind === 'running'}
                        onCompactNow={runCompactNow}
                      />
                      <ComposerFlipContainer
                        showApproval={session.pendingApprovals.length > 0}
                        front={
                          <Composer
                          disabled={session.status !== 'ready' || !sessionWorkspaceOnline}
                          model={session.selectedModel ?? preferredModel}
                          models={models}
                          onModelChange={onModelChange}
                          approvalMode={session.state?.approvalMode ?? 'auto'}
                          onApprovalModeChange={onApprovalModeChange}
                          state={session.state}
                          config={session.config}
                          queuedMessages={session.queuedMessages}
                          onQueuedReorder={(id, beforeId) => {
                            if (session.socket) reorderQueuedMessage(session.socket, config.sessionId, id, beforeId)
                          }}
                          onQueuedUpdate={(id, text) => {
                            if (session.socket) updateQueuedMessage(session.socket, config.sessionId, id, text)
                          }}
                          onQueuedDelete={(id) => {
                            if (session.socket) deleteQueuedMessage(session.socket, config.sessionId, id)
                          }}
                          onCompact={runCompactNow}
                          onClearSession={clearCurrentSession}
                          onCancel={() => {
                            if (!session.socket) return
                            cancelSession(session.socket, config.sessionId)
                          }}
                          onConsolidateMemory={runConsolidateMemory}
                          workspaceOnline={sessionWorkspaceOnline}
                          onListFiles={listWorkspaceFiles}
                          onReadFile={readWorkspaceFile}
                          footerExtras={
                            <>
                              <BackgroundShellsButton
                                socket={session.socket}
                                workspaceId={currentSession?.workspaceId}
                                fallbackTasks={backgroundTasks}
                              />
                              <TasksButton todos={taskItems} />
                            </>
                          }
                          onSubmit={(text, mode, images, extraBlocks) => {
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
                                ]
                              : undefined
                            session.socket?.emit('client:user_message', {
                              sessionId: config.sessionId,
                              text,
                              mode,
                              ...(content ? { content } : {}),
                            })
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
                            if (!session.socket) return
                            respondApproval(session.socket, config.sessionId, callId, decision)
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
                        timeline={session.timeline}
                        visibleMessagesCount={chatMessages.length}
                        socket={session.socket}
                        parentSessionId={session.parentSessionId}
                        parentCursor={session.parentCursor}
                        onFork={(cursor) => {
                          session.socket?.emit('client:fork', { sourceSessionId: config.sessionId, cursor })
                        }}
                        onJumpToMessage={(index) => {
                          setHighlightIndex(index)
                          const el = document.getElementById(`msg-${index}`)
                          if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
                          window.setTimeout(() => {
                            setHighlightIndex((cur) => (cur === index ? null : cur))
                          }, 1400)
                        }}
                      />
                    </div>
                  </ResizablePanel>
                </>
              ) : null}
            </ResizablePanelGroup>
            )}
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
      <Dialog open={explorerDrawerOpen} onOpenChange={setExplorerDrawerOpen}>
        <DialogContent
          className="left-0 top-0 h-dvh w-[min(22rem,100vw)] max-w-none !translate-x-0 !translate-y-0 overflow-hidden p-0 gap-0 sm:rounded-none"
          data-testid="explorer-drawer"
        >
          <DialogHeader className="sr-only">
            <DialogTitle>Explorer</DialogTitle>
            <DialogDescription>Workspace and session navigation</DialogDescription>
          </DialogHeader>
          <Explorer
            executors={control.executors}
            sessions={control.sessions}
            selectedSessionId={config.sessionId}
            onSelect={(sid) => {
              selectSession(sid)
              setExplorerDrawerOpen(false)
            }}
            onNewSession={(workspaceId) => {
              newSession(workspaceId)
              setExplorerDrawerOpen(false)
            }}
            onConnectWorkspace={() => {
              setExplorerDrawerOpen(false)
              setConnectWorkspaceOpen(true)
            }}
            onDelete={deleteSessionAt}
            onRename={renameSessionAt}
            onOpenSessionInfo={(sid) => {
              if (sid !== config.sessionId) selectSession(sid)
              setExplorerDrawerOpen(false)
              setMetadataOpen(true)
            }}
            onWorkspaceInfo={(workspaceId) => {
              setExplorerDrawerOpen(false)
              setWorkspaceInfoId(workspaceId)
            }}
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
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} onModelsChanged={reloadModels} />
      <ArtifactExplorerDialog
        open={artifactsOpen}
        initialMode={artifactInitialMode}
        onOpenChange={setArtifactsOpen}
        onOpenSession={(sessionId) => {
          selectSession(sessionId)
          setArtifactsOpen(false)
        }}
      />
      <SessionMetadataDialog
        open={metadataOpen}
        onOpenChange={setMetadataOpen}
        sessionId={config.sessionId}
        summary={currentSession}
        state={session.state}
        selectedModel={session.selectedModel}
        {...(executorHost !== undefined ? { executorHost } : {})}
        onRename={(label) => renameSessionAt(config.sessionId, label)}
        onOpenChangeCwdDialog={openCwdDialog}
        onChangeApprovalMode={onApprovalModeChange}
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
      />
      <CommandPalette
        open={commandPaletteOpen}
        onOpenChange={setCommandPaletteOpen}
        commands={commandPaletteCommands}
      />
      <Toaster position="bottom-right" richColors closeButton theme={theme} />
    </div>
  )
}

function hasCompactableContent(state: import('@agent-kernel/kernel').AgentState | null): boolean {
  return state?.messages.some((m) => m.role !== 'system') ?? false
}

function isEditable(el: HTMLElement): boolean {
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return true
  if (el.isContentEditable) return true
  return false
}

function isResting(status: import('@agent-kernel/kernel').AgentState['status']): boolean {
  return status === 'idle' || status === 'done' || status === 'error'
}

export function sessionExists(
  sessions: readonly SessionSummary[],
  sessionId: string | null | undefined,
): boolean {
  return Boolean(sessionId && sessions.some((s) => s.sessionId === sessionId))
}

export function nextSessionSelection({
  sessions,
  currentSessionId,
  explicit,
}: {
  sessions: readonly SessionSummary[]
  currentSessionId: string
  explicit: boolean
}): SessionSummary | null {
  if (sessions.length === 0) return null
  const currentExists = sessionExists(sessions, currentSessionId)
  if (explicit && currentExists) return null
  const candidates = currentExists ? sessions : sessions.filter((s) => s.sessionId !== currentSessionId)
  return candidates.find((s) => s.eventCount > 0) ?? candidates[0] ?? null
}

type Config = {
  sessionId: string
  explicit: boolean
  token?: string
}

function readInitialConfig(): Config {
  const url = new URL(window.location.href)
  const fromUrl = url.searchParams.get('sessionId')
  const sessionId = fromUrl ?? crypto.randomUUID()
  const explicit = fromUrl !== null
  const token = url.searchParams.get('token') ?? undefined
  return { sessionId, explicit, ...(token !== undefined ? { token } : {}) }
}

function NoSessionArea({
  onNewSession,
  hasSessions,
}: {
  onNewSession(): void
  hasSessions: boolean
}): JSX.Element {
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
          No session selected
        </h1>
        <p className="text-sm text-muted-foreground">
          {hasSessions
            ? 'Pick a session from the sidebar, or start a new one.'
            : 'Create your first session to start a conversation with the agent.'}
        </p>
        <Button type="button" onClick={onNewSession} data-testid="no-session-new-button">
          New session
        </Button>
      </div>
    </div>
  )
}

function WorkbenchToolbar({
  sessionLabel,
  cwd,
  status,
  onOpenExplorer,
  explorerAvailable,
  onChangeCwd,
  onOpenEval,
  onOpenArtifacts,
  onOpenSettings,
  onToggleInspector,
  inspectorOpen,
  inspectorAvailable,
  theme,
  onToggleTheme,
  sessionSelected,
}: {
  sessionLabel: string
  cwd: string
  status: string
  onOpenExplorer(): void
  explorerAvailable: boolean
  onChangeCwd(): void
  onOpenEval(): void
  onOpenArtifacts(): void
  onOpenSettings(): void
  onToggleInspector(): void
  inspectorOpen: boolean
  inspectorAvailable: boolean
  theme: Theme
  onToggleTheme(): void
  sessionSelected: boolean
}): JSX.Element {
  return (
    <div
      className="flex min-h-12 flex-none items-center gap-1.5 bg-card px-2 py-2 text-sm text-card-foreground backdrop-blur-md sm:gap-2 sm:px-3"
      data-testid="workbench-toolbar"
    >
      {explorerAvailable ? (
        <Button
          variant="ghost"
          size="icon"
          onClick={onOpenExplorer}
          title="Open explorer"
          aria-label="open explorer"
          data-testid="explorer-toggle"
          className="flex-none"
        >
          <Menu className="h-4 w-4" />
        </Button>
      ) : null}
      <span
        className="min-w-0 max-w-[38vw] truncate font-medium sm:max-w-none"
        title={sessionSelected ? sessionLabel : 'no session selected'}
        data-testid="session-label"
      >
        {sessionSelected ? sessionLabel : 'no session selected'}
      </span>
      {sessionSelected ? (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={onChangeCwd}
        title={cwd ? `change session cwd: ${cwd}` : 'set session cwd'}
        data-testid="cwd-button"
        className="hidden min-w-0 max-w-[34vw] justify-start gap-1.5 px-2 text-xs text-muted-foreground dark:text-muted-foreground sm:inline-flex lg:max-w-[45%]"
      >
        <FolderOpen className="h-3.5 w-3.5 flex-none" />
        <span className="min-w-0 truncate font-mono" data-testid="cwd-label">
          {cwd || 'cwd unset'}
        </span>
      </Button>
      ) : null}
      <span className="min-w-0 flex-1" />
      {sessionSelected ? <ConnectionStatus status={status} /> : null}
      <Button
        variant="ghost"
        size="icon"
        onClick={onOpenEval}
        title="Eval dashboard"
        aria-label="open eval dashboard"
        data-testid="eval-dashboard-button"
      >
        <BarChart3 className="h-4 w-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        onClick={onOpenArtifacts}
        title="Artifacts"
        aria-label="open artifacts"
        data-testid="artifacts-button"
      >
        <Boxes className="h-4 w-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        onClick={onOpenSettings}
        title="Settings"
        aria-label="open settings"
        data-testid="settings-button"
      >
        <Settings className="h-4 w-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        onClick={onToggleTheme}
        title={theme === 'dark' ? 'switch to light mode' : 'switch to dark mode'}
        data-testid="theme-toggle"
        aria-label="toggle theme"
      >
        {theme === 'dark' ? (
          <Sun className="h-4 w-4" />
        ) : (
          <Moon className="h-4 w-4" />
        )}
      </Button>
      {inspectorAvailable ? (
        <Button
          variant="ghost"
          size="icon"
          onClick={onToggleInspector}
          title={inspectorOpen ? 'hide inspector' : 'show inspector'}
          aria-label={inspectorOpen ? 'hide inspector' : 'show inspector'}
          data-testid="inspector-toggle"
        >
          {inspectorOpen ? (
            <PanelRightClose className="h-4 w-4" />
          ) : (
            <PanelRight className="h-4 w-4" />
          )}
        </Button>
      ) : null}
    </div>
  )
}

function ConnectionStatus({ status }: { status: string }): JSX.Element {
  const label = hostStatusLabel(status)
  return (
    <div
      className="inline-flex h-7 w-7 flex-none items-center justify-center rounded-md hover:bg-accent/60 transition-colors"
      data-testid="connection-status"
      data-status={status}
      title={label}
      aria-label={label}
    >
      <span className={cn('h-2 w-2 rounded-full', statusDot(status))} />
    </div>
  )
}

function hostStatusLabel(status: string): string {
  if (status === 'ready') return 'Connected'
  if (status === 'connecting') return 'Connecting'
  if (status === 'disconnected') return 'Disconnected'
  if (status === 'error') return 'Connection error'
  return status
}

function statusDot(status: string): string {
  if (status === 'ready') return 'bg-emerald-500'
  if (status === 'error' || status === 'disconnected') return 'bg-rose-500'
  if (status === 'connecting') return 'bg-amber-500 animate-pulse'
  return 'bg-muted'
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
