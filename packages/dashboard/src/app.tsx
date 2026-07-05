import { useEffect, useMemo, useRef, useState } from 'react'
import { FolderOpen, Moon, PanelRight, PanelRightClose, Sun } from 'lucide-react'

import type { ModelInfo, ServerModelsPayload } from '@agent-kernel/shared'

import { Button } from './components/ui/button.js'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './components/ui/dialog.js'
import { Input } from './components/ui/input.js'
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from './components/ui/resizable.js'
import { ScrollArea } from './components/ui/scroll-area.js'
import { ActivityBar, type CompactStatus } from './features/chat/ActivityBar.js'
import { ApprovalsPanel } from './features/chat/ApprovalsPanel.js'
import { BackgroundTerminalPanel } from './features/chat/BackgroundTerminalPanel.js'
import { ChatPanel } from './features/chat/ChatPanel.js'
import { Composer } from './features/chat/Composer.js'
import { ContextPressureBanner } from './features/chat/ContextPressureBanner.js'
import { TodoDock } from './features/chat/TodoDock.js'
import { Explorer } from './features/explorer/Explorer.js'
import { WorkspacePicker } from './features/explorer/WorkspacePicker.js'
import { InspectorPanel } from './features/inspector/InspectorPanel.js'
import {
  createSession,
  deleteSession,
  respondApproval,
  setSessionApprovalMode,
  setSessionModel,
  type TimelineEntry,
  useControlPlane,
  useSession,
} from './session.js'
import { backgroundTerminalTasks } from './background-terminal.js'
import { cn } from './lib/utils.js'
import { visibleMessages, visibleTranscript } from './transcript.js'

type Theme = 'dark' | 'light'

const MODEL_STORAGE_KEY = 'ak-model'
const COMPACT_WATCHDOG_MS = 75_000

/**
 * Fetch the host's advertised models on mount. The host reads them from
 * `~/.claude/settings.json` and `~/.codex/config.toml`; hardcoding a list here
 * would drift away from what the host actually accepts.
 */
function useModels(): { models: readonly ModelInfo[]; defaultModel: string } {
  const [state, setState] = useState<{
    models: readonly ModelInfo[]
    defaultModel: string
  }>({ models: [], defaultModel: '' })
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
  }, [])
  return state
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
    { sessionId: string } | null
  >(null)
  const [cwdDialogOpen, setCwdDialogOpen] = useState(false)
  const [cwdDraft, setCwdDraft] = useState('')
  const [compactStatus, setCompactStatus] = useState<CompactStatus>({ kind: 'idle' })
  const compactResetTimer = useRef<number | null>(null)
  const compactStartSeq = useRef<number | null>(null)
  const [theme, toggleTheme] = useTheme()
  const wideLayout = useMinWidth(1024)
  const { models, defaultModel } = useModels()
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

  const control = useControlPlane(session.socket)

  const selectSession = (sessionId: string): void => {
    setConfig((prev) => ({ ...prev, sessionId, explicit: true }))
  }
  const newSession = (): void => {
    setPendingWorkspacePick({ sessionId: crypto.randomUUID() })
  }
  const pickWorkspaceForNew = (
    workspaceId: string,
    workspaceName: string | undefined,
    cwd: string,
  ): void => {
    if (!pendingWorkspacePick) return
    const { sessionId } = pendingWorkspacePick
    if (session.socket) {
      createSession(session.socket, sessionId, workspaceId, workspaceName, cwd)
    }
    selectSession(sessionId)
    setPendingWorkspacePick(null)
  }
  const deleteSessionAt = (sessionId: string): void => {
    if (!session.socket) return
    deleteSession(session.socket, sessionId)
    if (sessionId === config.sessionId) {
      const next = control.sessions.find((s) => s.sessionId !== sessionId)
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

  const currentSession = control.sessions.find(
    (s) => s.sessionId === config.sessionId,
  )

  useEffect(() => {
    if (config.explicit) return
    if (control.sessions.length === 0) return
    const latest = control.sessions.find((s) => s.eventCount > 0) ?? control.sessions[0]
    if (!latest) return
    if (latest.sessionId === config.sessionId) return
    setConfig((prev) => ({
      ...prev,
      sessionId: latest.sessionId,
      explicit: true,
    }))
  }, [config.explicit, config.sessionId, control.sessions])

  const currentCwd = session.state?.cwd ?? currentSession?.currentCwd ?? ''
  const firstMsg = currentSession?.firstUserMessage
  const sessionLabel = firstMsg
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

  // A bound session (`workspaceId` set) is only useful while its executor is
  // attached. Legacy sessions without workspaceId keep working through the
  // host's sticky-map fallback, so treat them as online.
  const sessionWorkspaceOnline = useMemo(() => {
    if (!currentSession?.workspaceId) return true
    return control.executors.some(
      (e) => e.workspaceId === currentSession.workspaceId,
    )
  }, [currentSession?.workspaceId, control.executors])

  const openCwdDialog = (): void => {
    setCwdDraft(currentCwd)
    setCwdDialogOpen(true)
  }

  const submitCwd = (): void => {
    const cwd = cwdDraft.trim()
    if (!cwd || !session.socket) return
    session.socket.emit('client:set_cwd', {
      sessionId: config.sessionId,
      cwd,
    })
    setCwdDialogOpen(false)
    if (!config.explicit) {
      setConfig((prev) => ({ ...prev, explicit: true }))
    }
  }

  return (
    <div className="h-screen w-screen bg-white text-slate-900 dark:bg-slate-950 dark:text-slate-100 overflow-hidden">
      <div className="hidden" data-testid="login-column-hidden" />
      <ResizablePanelGroup direction="horizontal" autoSaveId="ak-outer-cols-v5">
        {wideLayout ? (
          <>
            <ResizablePanel
              defaultSize={20}
              minSize={17}
              maxSize={22}
              className="min-w-[240px]"
              data-testid="explorer-panel"
            >
              <div className="h-full border-r border-slate-200 dark:border-slate-800">
                <Explorer
                  executors={control.executors}
                  sessions={control.sessions}
                  selectedSessionId={config.sessionId}
                  onSelect={selectSession}
                  onNewSession={newSession}
                  onDelete={deleteSessionAt}
                />
              </div>
            </ResizablePanel>
            <ResizableHandle withHandle />
          </>
        ) : null}
        <ResizablePanel
          defaultSize={wideLayout ? 80 : 100}
          minSize={wideLayout ? 78 : 100}
          data-testid="workbench-panel"
        >
          <div className="h-full flex min-h-0 min-w-0 flex-col" data-testid="workbench">
            <WorkbenchToolbar
              sessionLabel={sessionLabel}
              cwd={currentCwd}
              status={session.status}
              onChangeCwd={openCwdDialog}
              onToggleInspector={() => setInspectorOpen((v) => !v)}
              inspectorOpen={wideLayout && inspectorOpen}
              inspectorAvailable={wideLayout}
              theme={theme}
              onToggleTheme={toggleTheme}
            />
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
                      onGoParent={() =>
                        setConfig((prev) => ({
                          ...prev,
                          sessionId: session.parentSessionId ?? prev.sessionId,
                        }))
                      }
                    />
                  ) : null}
                  <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
                    <ScrollArea className="flex-1 min-h-0" data-testid="chat-panel">
                      <ChatPanel
                        items={chatItems}
                        highlightIndex={highlightIndex}
                        onEditAndRerun={(seq, text) => {
                          if (!session.socket) return
                          session.socket.emit('client:fork', {
                            sourceSessionId: config.sessionId,
                            cursor: seq - 1,
                            seedMessage: text,
                          })
                        }}
                      />
                    </ScrollArea>
                    <ApprovalsPanel
                      approvals={session.pendingApprovals}
                      onDecision={(callId, decision) => {
                        if (!session.socket) return
                        respondApproval(session.socket, config.sessionId, callId, decision)
                        session.dismissApproval(callId)
                      }}
                    />
                    <TodoDock todos={session.state?.todos ?? []} />
                    <BackgroundTerminalPanel tasks={backgroundTasks} />
                    <ActivityBar state={session.state} compactStatus={compactStatus} />
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
                    <ContextPressureBanner
                      state={session.state}
                      compactRunning={compactStatus.kind === 'running'}
                      onCompactNow={runCompactNow}
                    />
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
                      onCompact={runCompactNow}
                      onSubmit={(text, mode, images) => {
                        const imageBlocks = images ?? []
                        const content = imageBlocks.length > 0
                          ? [
                              ...(text.length > 0
                                ? [{ type: 'text' as const, text }]
                                : []),
                              ...imageBlocks,
                            ]
                          : undefined
                        session.socket?.emit('client:user_message', {
                          sessionId: config.sessionId,
                          text,
                          mode,
                          ...(content ? { content } : {}),
                        })
                        if (!config.explicit) setConfig((prev) => ({ ...prev, explicit: true }))
                      }}
                    />
                  </div>
                </div>
              </ResizablePanel>
              {wideLayout && inspectorOpen ? (
                <>
                  <ResizableHandle withHandle />
                  <ResizablePanel defaultSize={26} minSize={22} maxSize={36} data-testid="inspector-panel">
                    <div className="h-full border-l border-slate-200 dark:border-slate-800 min-h-0 overflow-hidden" data-testid="inspector-drawer">
                      <InspectorPanel
                        state={session.state}
                        config={session.config}
                        timeline={session.timeline}
                        visibleMessagesCount={chatMessages.length}
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
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
      <CwdDialog
        open={cwdDialogOpen}
        value={cwdDraft}
        onValueChange={setCwdDraft}
        onSubmit={submitCwd}
        onOpenChange={setCwdDialogOpen}
      />
      <WorkspacePicker
        open={pendingWorkspacePick !== null}
        workspaces={control.executors}
        socket={session.socket}
        onCreate={({ workspaceId, workspaceName, cwd }) =>
          pickWorkspaceForNew(workspaceId, workspaceName, cwd)
        }
        onCancel={() => setPendingWorkspacePick(null)}
      />
    </div>
  )
}

function hasCompactableContent(state: import('@agent-kernel/kernel').AgentState | null): boolean {
  return state?.messages.some((m) => m.role !== 'system') ?? false
}

function isResting(status: import('@agent-kernel/kernel').AgentState['status']): boolean {
  return status === 'idle' || status === 'done' || status === 'error'
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

function WorkbenchToolbar({
  sessionLabel,
  cwd,
  status,
  onChangeCwd,
  onToggleInspector,
  inspectorOpen,
  inspectorAvailable,
  theme,
  onToggleTheme,
}: {
  sessionLabel: string
  cwd: string
  status: string
  onChangeCwd(): void
  onToggleInspector(): void
  inspectorOpen: boolean
  inspectorAvailable: boolean
  theme: Theme
  onToggleTheme(): void
}): JSX.Element {
  return (
    <div
      className="h-10 flex-none px-3 border-b border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950 flex items-center gap-2 text-sm min-w-0"
      data-testid="workbench-toolbar"
    >
      <span
        className="truncate font-medium min-w-0"
        title={sessionLabel}
        data-testid="session-label"
      >
        {sessionLabel}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={onChangeCwd}
        title={cwd ? `change session cwd: ${cwd}` : 'set session cwd'}
        data-testid="cwd-button"
        className="min-w-0 max-w-[45%] justify-start gap-1.5 px-2 text-xs text-slate-600 dark:text-slate-300"
      >
        <FolderOpen className="h-3.5 w-3.5 flex-none" />
        <span className="min-w-0 truncate font-mono" data-testid="cwd-label">
          {cwd || 'cwd unset'}
        </span>
      </Button>
      <span className="min-w-0 flex-1" />
      <ConnectionStatus status={status} />
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
      className="inline-flex h-7 flex-none items-center gap-1.5 rounded-md border border-slate-200 bg-slate-50 px-2 text-[11px] text-slate-600 dark:border-slate-800 dark:bg-slate-900/70 dark:text-slate-300"
      data-testid="connection-status"
      data-status={status}
      title={label}
      aria-label={label}
    >
      <span className={cn('h-2 w-2 rounded-full', statusDot(status))} />
      <span className="hidden sm:inline">{label}</span>
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
  return 'bg-slate-400'
}

function CwdDialog({
  open,
  value,
  onValueChange,
  onSubmit,
  onOpenChange,
}: {
  open: boolean
  value: string
  onValueChange(value: string): void
  onSubmit(): void
  onOpenChange(open: boolean): void
}): JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Change session cwd</DialogTitle>
          <DialogDescription>
            Tool calls for this session will run from this directory after the host accepts it.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault()
            onSubmit()
          }}
        >
          <Input
            value={value}
            onChange={(e) => onValueChange(e.target.value)}
            placeholder="/tmp/project"
            data-testid="cwd-input"
            autoFocus
          />
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">Cancel</Button>
            </DialogClose>
            <Button type="submit" data-testid="cwd-save-button" disabled={value.trim().length === 0}>
              Save cwd
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function LineageBar({
  parentSessionId,
  parentCursor,
  onGoParent,
}: {
  parentSessionId: string
  parentCursor: number | null
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
        variant="link"
        size="sm"
        onClick={onGoParent}
        className="ml-auto h-auto p-0 text-amber-700 dark:text-amber-300"
      >
        go to parent
      </Button>
    </div>
  )
}
