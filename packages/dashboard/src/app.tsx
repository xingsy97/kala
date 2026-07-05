import { useEffect, useMemo, useRef, useState } from 'react'
import { Moon, PanelRight, PanelRightClose, Sun } from 'lucide-react'

import type { ModelInfo, ServerModelsPayload } from '@agent-kernel/shared'

import { Button } from './components/ui/button.js'
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from './components/ui/resizable.js'
import { ScrollArea } from './components/ui/scroll-area.js'
import { ActivityBar, type CompactStatus } from './features/chat/ActivityBar.js'
import { ApprovalsPanel } from './features/chat/ApprovalsPanel.js'
import { ChatPanel } from './features/chat/ChatPanel.js'
import { Composer } from './features/chat/Composer.js'
import { TodoDock } from './features/chat/TodoDock.js'
import { Explorer } from './features/explorer/Explorer.js'
import { WorkspacePicker } from './features/explorer/WorkspacePicker.js'
import { InspectorPanel } from './features/inspector/InspectorPanel.js'
import {
  createSession,
  deleteSession,
  respondApproval,
  setSessionModel,
  type TimelineEntry,
  useControlPlane,
  useSession,
} from './session.js'
import { visibleMessages } from './transcript.js'

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

export function App(): JSX.Element {
  const [config, setConfig] = useState(() => readInitialConfig())
  const [highlightIndex, setHighlightIndex] = useState<number | null>(null)
  const [inspectorOpen, setInspectorOpen] = useState(true)
  const [pendingWorkspacePick, setPendingWorkspacePick] = useState<
    { sessionId: string } | null
  >(null)
  const [compactStatus, setCompactStatus] = useState<CompactStatus>({ kind: 'idle' })
  const compactResetTimer = useRef<number | null>(null)
  const compactStartSeq = useRef<number | null>(null)
  const [theme, toggleTheme] = useTheme()
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

  const control = useControlPlane(session.socket)

  const selectSession = (sessionId: string): void => {
    setConfig((prev) => ({ ...prev, sessionId, explicit: true }))
  }
  const newSession = (): void => {
    const online = control.executors
    if (online.length === 0) {
      // No daemon attached  -  session lands in Unassigned, no binding to
      // record. Rare, but not worth hard-blocking the button.
      selectSession(crypto.randomUUID())
      return
    }
    if (online.length === 1) {
      const only = online[0]!
      const id = crypto.randomUUID()
      if (session.socket) {
        createSession(session.socket, id, only.workspaceId, only.workspaceName)
      }
      selectSession(id)
      return
    }
    setPendingWorkspacePick({ sessionId: crypto.randomUUID() })
  }
  const pickWorkspaceForNew = (
    workspaceId: string,
    workspaceName: string | undefined,
  ): void => {
    if (!pendingWorkspacePick) return
    const { sessionId } = pendingWorkspacePick
    if (session.socket) {
      createSession(session.socket, sessionId, workspaceId, workspaceName)
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

  // A bound session (`workspaceId` set) is only useful while its executor is
  // attached. Legacy sessions without workspaceId keep working through the
  // host's sticky-map fallback, so treat them as online.
  const sessionWorkspaceOnline = useMemo(() => {
    if (!currentSession?.workspaceId) return true
    return control.executors.some(
      (e) => e.workspaceId === currentSession.workspaceId,
    )
  }, [currentSession?.workspaceId, control.executors])

  return (
    <div className="h-screen w-screen bg-white text-slate-900 dark:bg-slate-950 dark:text-slate-100 overflow-hidden">
      <div className="hidden" data-testid="login-column-hidden" />
      <ResizablePanelGroup direction="horizontal" autoSaveId="ak-outer-cols-v2">
        <ResizablePanel
          defaultSize={22}
          minSize={14}
          maxSize={45}
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
        <ResizablePanel defaultSize={inspectorOpen ? 54 : 78} minSize={30}>
          <div className="h-full flex flex-col min-w-0 min-h-0">
            <SessionToolbar
              sessionLabel={sessionLabel}
              onToggleInspector={() => setInspectorOpen((v) => !v)}
              inspectorOpen={inspectorOpen}
              theme={theme}
              onToggleTheme={toggleTheme}
            />
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
                  messages={chatMessages}
                  highlightIndex={highlightIndex}
                />
              </ScrollArea>
              <ApprovalsPanel
                approvals={session.pendingApprovals}
                onDecision={(callId, decision) => {
                  if (!session.socket) return
                  respondApproval(
                    session.socket,
                    config.sessionId,
                    callId,
                    decision,
                  )
                  session.dismissApproval(callId)
                }}
              />
              <TodoDock todos={session.state?.todos ?? []} />
              <ActivityBar
                state={session.state}
                compactStatus={compactStatus}
              />
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
                  workspace{' '}
                  <span className="font-mono">
                    {currentSession?.workspaceName ?? currentSession?.workspaceId}
                  </span>{' '}
                  is offline  -  start its executor to send messages.
                </div>
              ) : null}
              <Composer
                disabled={session.status !== 'ready' || !sessionWorkspaceOnline}
                model={session.selectedModel ?? preferredModel}
                models={models}
                onModelChange={onModelChange}
                status={session.status}
                state={session.state}
                compacting={compactStatus.kind === 'running'}
                onCompact={() => {
                  if (!hasCompactableContent(session.state)) {
                    setCompactStatus({
                      kind: 'empty',
                      message: 'send a message before compacting context',
                    })
                    scheduleCompactIdle(6000)
                    return
                  }
                  if (session.state && !isResting(session.state.status)) {
                    setCompactStatus({
                      kind: 'error',
                      message: 'wait for the current turn to finish before compacting',
                    })
                    scheduleCompactIdle(6000)
                    return
                  }
                  if (compactResetTimer.current !== null) {
                    window.clearTimeout(compactResetTimer.current)
                    compactResetTimer.current = null
                  }
                  compactStartSeq.current = session.timeline.at(-1)?.seq ?? 0
                  setCompactStatus({ kind: 'running' })
                  session.socket?.emit('client:compact', {
                    sessionId: config.sessionId,
                  })
                  if (!config.explicit) {
                    setConfig((prev) => ({ ...prev, explicit: true }))
                  }
                }}
                onSubmit={(text) => {
                  session.socket?.emit('client:user_message', {
                    sessionId: config.sessionId,
                    text,
                  })
                  if (!config.explicit) {
                    setConfig((prev) => ({ ...prev, explicit: true }))
                  }
                }}
              />
            </div>
          </div>
        </ResizablePanel>
        {inspectorOpen ? (
          <>
            <ResizableHandle withHandle />
            <ResizablePanel
              defaultSize={24}
              minSize={15}
              maxSize={50}
              data-testid="inspector-panel"
            >
              <div
                className="h-full border-l border-slate-200 dark:border-slate-800 min-h-0 overflow-hidden"
                data-testid="inspector-drawer"
              >
                <InspectorPanel
                  state={session.state}
                  timeline={session.timeline}
                  visibleMessagesCount={chatMessages.length}
                  onFork={(cursor) => {
                    session.socket?.emit('client:fork', {
                      sourceSessionId: config.sessionId,
                      cursor,
                    })
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
      <WorkspacePicker
        open={pendingWorkspacePick !== null}
        workspaces={control.executors}
        onPick={pickWorkspaceForNew}
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

function SessionToolbar({
  sessionLabel,
  onToggleInspector,
  inspectorOpen,
  theme,
  onToggleTheme,
}: {
  sessionLabel: string
  onToggleInspector(): void
  inspectorOpen: boolean
  theme: Theme
  onToggleTheme(): void
}): JSX.Element {
  return (
    <div
      className="px-3 py-2 border-b border-slate-200 dark:border-slate-800 flex items-center gap-2 text-sm min-w-0"
      data-testid="session-toolbar"
    >
      <span
        className="truncate font-medium min-w-0 flex-1"
        title={sessionLabel}
        data-testid="session-label"
      >
        {sessionLabel}
      </span>
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
    </div>
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
