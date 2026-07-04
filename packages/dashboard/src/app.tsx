import { useEffect, useState } from 'react'

import { ApprovalsPanel } from './features/chat/ApprovalsPanel.js'
import { ChatPanel } from './features/chat/ChatPanel.js'
import { Composer } from './features/chat/Composer.js'
import { InspectorPanel } from './features/inspector/InspectorPanel.js'
import { respondApproval, useSession } from './session.js'

const DEFAULT_HOST = 'http://localhost:3000'

export function App(): JSX.Element {
  const [config, setConfig] = useState(() => readInitialConfig())

  useEffect(() => {
    const params = new URLSearchParams({
      host: config.host,
      sessionId: config.sessionId,
    })
    if (config.token) params.set('token', config.token)
    const next = `?${params.toString()}`
    if (window.location.search !== next) {
      window.history.replaceState(null, '', next)
    }
  }, [config])

  const session = useSession({
    ...config,
    onForked: (p) => {
      setConfig((prev) => ({ ...prev, sessionId: p.sessionId }))
    },
  })

  return (
    <div className="h-screen w-screen grid grid-cols-1 md:grid-cols-[1fr_400px] bg-slate-950 text-slate-100">
      <div className="flex flex-col border-r border-slate-800 min-h-0">
        <ConnectionBar
          config={config}
          onChange={setConfig}
          status={session.status}
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
          <div className="flex-1 min-h-0 overflow-y-auto">
            <ChatPanel messages={session.state?.messages ?? []} />
          </div>
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
            }}
          />
          {session.lastError ? (
            <div className="px-3 py-2 text-xs text-rose-300 bg-rose-950/40 border-t border-rose-900">
              [{session.lastError.scope}] {session.lastError.message}
            </div>
          ) : null}
          <Composer
            disabled={session.status !== 'ready'}
            onSubmit={(text) => {
              session.socket?.emit('client:user_message', {
                sessionId: config.sessionId,
                text,
              })
            }}
          />
        </div>
      </div>
      <div className="min-h-0 overflow-hidden">
        <InspectorPanel
          state={session.state}
          timeline={session.timeline}
          onFork={(cursor) => {
            session.socket?.emit('client:fork', {
              sourceSessionId: config.sessionId,
              cursor,
            })
          }}
        />
      </div>
    </div>
  )
}

type Config = {
  host: string
  sessionId: string
  token?: string
}

function readInitialConfig(): Config {
  const url = new URL(window.location.href)
  const host = url.searchParams.get('host') ?? DEFAULT_HOST
  const sessionId = url.searchParams.get('sessionId') ?? 'demo'
  const token = url.searchParams.get('token') ?? undefined
  return { host, sessionId, ...(token !== undefined ? { token } : {}) }
}

function ConnectionBar({
  config,
  onChange,
  status,
}: {
  config: Config
  onChange(next: Config): void
  status: string
}): JSX.Element {
  return (
    <div className="p-3 border-b border-slate-800 grid grid-cols-[1fr_1fr_auto] gap-2 text-xs items-center">
      <input
        value={config.host}
        onChange={(e) => onChange({ ...config, host: e.target.value })}
        className="bg-slate-900 border border-slate-700 rounded px-2 py-1 font-mono"
        placeholder="host URL"
      />
      <input
        value={config.sessionId}
        onChange={(e) => onChange({ ...config, sessionId: e.target.value })}
        className="bg-slate-900 border border-slate-700 rounded px-2 py-1 font-mono"
        placeholder="session id"
      />
      <span
        className={
          status === 'ready'
            ? 'text-emerald-400'
            : status === 'error' || status === 'disconnected'
              ? 'text-rose-400'
              : 'text-slate-400'
        }
      >
        {status}
      </span>
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
    <div className="px-3 py-2 border-b border-amber-900 bg-amber-950/30 text-xs text-amber-200 flex items-center gap-2">
      <span>
        forked from{' '}
        <span className="font-mono">
          {parentSessionId}
          {parentCursor !== null ? `@${parentCursor}` : ''}
        </span>
      </span>
      <button
        onClick={onGoParent}
        className="ml-auto text-amber-300 hover:text-amber-100 underline"
      >
        go to parent
      </button>
    </div>
  )
}
