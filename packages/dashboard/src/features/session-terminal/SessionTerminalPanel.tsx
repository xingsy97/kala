import { useCallback, useEffect, useRef, useState } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Terminal as XTerm } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { Eraser, Loader2, Play, RefreshCw, Square } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import type { ServerTerminalExit, ServerTerminalOutput, TerminalCreateResult, TerminalKillResult } from '@agent-kernel/shared'
import { Button } from '../../components/ui/button.js'
import { randomId } from '../../lib/random-id.js'
import type { DashboardSocket } from '../../session.js'

type TerminalStatus = 'idle' | 'starting' | 'running' | 'exited' | 'error'

export function SessionTerminalPanel({
  socket,
  workspaceId,
  sessionId,
  cwd,
  online = true,
}: {
  socket: DashboardSocket | null
  workspaceId?: string
  sessionId: string
  cwd?: string
  online?: boolean
}): JSX.Element {
  const { t } = useTranslation()
  const hostRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<XTerm | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const terminalIdRef = useRef<string | null>(null)
  const identityRef = useRef(`${workspaceId ?? ''}:${sessionId}`)
  const [terminalId, setTerminalIdState] = useState<string | null>(null)
  const [status, setStatus] = useState<TerminalStatus>('idle')
  const [error, setError] = useState<string | null>(null)

  const setTerminalId = useCallback((value: string | null): void => {
    terminalIdRef.current = value
    setTerminalIdState(value)
  }, [])

  useEffect(() => {
    const term = new XTerm({ cursorBlink: true, fontSize: 12, convertEol: true, rows: 12, theme: { background: '#0b0f14' } })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon())
    term.loadAddon(new SearchAddon())
    terminalRef.current = term
    fitRef.current = fit
    if (hostRef.current) {
      term.open(hostRef.current)
      fit.fit()
    }
    return () => {
      // A panel detach must not kill the Session PTY. Explicit Kill and Session
      // deletion are the only terminal-destruction paths.
      term.dispose()
      terminalRef.current = null
      fitRef.current = null
    }
  }, [])

  useEffect(() => {
    const identity = `${workspaceId ?? ''}:${sessionId}`
    if (identityRef.current === identity) return
    identityRef.current = identity
    setTerminalId(null)
    setStatus('idle')
    setError(null)
    terminalRef.current?.clear()
    terminalRef.current?.write('\u001bc')
  }, [sessionId, setTerminalId, workspaceId])

  useEffect(() => {
    if (!socket) return
    const onOutput = (payload: ServerTerminalOutput): void => {
      if (payload.workspaceId !== workspaceId || payload.sessionId !== sessionId || payload.terminalId !== terminalIdRef.current) return
      terminalRef.current?.write(payload.data)
    }
    const onExit = (payload: ServerTerminalExit): void => {
      if (payload.workspaceId !== workspaceId || payload.sessionId !== sessionId || payload.terminalId !== terminalIdRef.current) return
      setStatus('exited')
      terminalRef.current?.writeln(`\r\n[${t('terminal.exited', { code: payload.exitCode ?? payload.signal ?? t('terminal.unknown') })}]`)
    }
    socket.on('server:terminal_output', onOutput)
    socket.on('server:terminal_exit', onExit)
    return () => {
      socket.off('server:terminal_output', onOutput)
      socket.off('server:terminal_exit', onExit)
    }
  }, [sessionId, socket, t, workspaceId])

  useEffect(() => {
    const term = terminalRef.current
    if (!term || !socket || !workspaceId || !terminalId || status !== 'running') return
    const disposable = term.onData((data) => socket.emit('terminal:input', { workspaceId, sessionId, terminalId, data }))
    term.focus()
    return () => disposable.dispose()
  }, [sessionId, socket, status, terminalId, workspaceId])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const fitAndResize = (): void => {
      fitRef.current?.fit()
      const term = terminalRef.current
      const id = terminalIdRef.current
      if (!term || !socket || !workspaceId || !id || status !== 'running') return
      socket.emit('terminal:resize', { workspaceId, sessionId, terminalId: id, cols: term.cols, rows: term.rows })
    }
    const observer = new ResizeObserver(fitAndResize)
    observer.observe(host)
    fitAndResize()
    return () => observer.disconnect()
  }, [sessionId, socket, status, workspaceId])

  const start = useCallback(async (): Promise<void> => {
    if (!socket || !workspaceId || !online) return
    setStatus('starting')
    setError(null)
    fitRef.current?.fit()
    const term = terminalRef.current
    const result = await createTerminal(socket, { workspaceId, sessionId, cwd, cols: term?.cols ?? 100, rows: term?.rows ?? 12 })
    if (result.error || !result.terminalId) {
      setStatus('error')
      setError(result.error ?? t('terminal.startFailed'))
      return
    }
    setTerminalId(result.terminalId)
    setStatus('running')
    if (result.replay) term?.write(result.replay)
    if (!result.reused && result.cwd) term?.writeln(t('terminal.connected', { cwd: result.cwd }))
    fitRef.current?.fit()
    term?.focus()
  }, [cwd, online, sessionId, setTerminalId, socket, t, workspaceId])

  const kill = useCallback(async (): Promise<boolean> => {
    if (!socket || !workspaceId || !terminalIdRef.current) return false
    const result = await killTerminal(socket, { workspaceId, sessionId, terminalId: terminalIdRef.current })
    if (!result.killed) {
      if (result.error) setError(result.error)
      return false
    }
    setStatus('exited')
    return true
  }, [sessionId, socket, workspaceId])

  const restart = useCallback(async (): Promise<void> => {
    if (status === 'running' && !(await kill())) return
    setTerminalId(null)
    await start()
  }, [kill, setTerminalId, start, status])

  const sendKey = (data: string): void => {
    const id = terminalIdRef.current
    if (!socket || !workspaceId || !id || status !== 'running') return
    socket.emit('terminal:input', { workspaceId, sessionId, terminalId: id, data })
    terminalRef.current?.focus()
  }

  const disabled = !socket || !workspaceId || !online
  const statusLabel = !online ? t('terminal.offline') : error ? `${t(`terminal.status.${status}`)} · ${error}` : t(`terminal.status.${status}`)

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#0b0f14] text-white" data-testid="session-terminal-panel">
      <div className="flex min-h-10 flex-none flex-wrap items-center gap-1 border-b border-white/10 bg-card px-2 py-1 text-card-foreground">
        <span className="mr-auto truncate text-xs text-muted-foreground" data-testid="terminal-status">{statusLabel}</span>
        <Button size="sm" className="h-7 gap-1.5" disabled={disabled || status === 'starting' || status === 'running'} onClick={() => void start()}>
          {status === 'starting' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}{t('terminal.start')}
        </Button>
        <Button size="icon" variant="ghost" className="h-7 w-7" disabled={disabled || status === 'starting'} onClick={() => void restart()} title={t('terminal.restart')} aria-label={t('terminal.restart')}><RefreshCw className="h-3.5 w-3.5" /></Button>
        <Button size="icon" variant="ghost" className="h-7 w-7" disabled={!terminalId || status !== 'running'} onClick={() => void kill()} title={t('terminal.kill')} aria-label={t('terminal.kill')}><Square className="h-3.5 w-3.5" /></Button>
        <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => terminalRef.current?.clear()} title={t('terminal.clear')} aria-label={t('terminal.clear')}><Eraser className="h-3.5 w-3.5" /></Button>
      </div>
      {!online ? <div className="border-b border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">{t('terminal.offlineHelp')}</div> : null}
      <div
        ref={hostRef}
        className="min-h-0 min-w-0 flex-1 cursor-text overflow-hidden p-1"
        data-testid="terminal-viewport"
        onPointerDown={() => terminalRef.current?.focus()}
        onTouchStart={() => terminalRef.current?.focus()}
      />
      <div className="flex flex-none gap-1 overflow-x-auto border-t border-white/10 bg-card p-1 text-card-foreground md:hidden" data-testid="terminal-touch-keys">
        {([[t('terminal.keys.esc'), '\u001b'], [t('terminal.keys.tab'), '\t'], ['Ctrl+C', '\u0003'], ['↑', '\u001b[A'], ['↓', '\u001b[B'], ['←', '\u001b[D'], ['→', '\u001b[C']] as const).map(([label, data]) => (
          <Button key={label} size="sm" variant="outline" className="h-9 min-w-11 flex-none px-2 font-mono text-xs" disabled={status !== 'running'} onClick={() => sendKey(data)}>{label}</Button>
        ))}
      </div>
    </div>
  )
}

async function createTerminal(socket: DashboardSocket, payload: { workspaceId: string; sessionId: string; cwd?: string; cols: number; rows: number }): Promise<TerminalCreateResult> {
  return await new Promise((resolve) => {
    const requestId = randomId()
    const timer = window.setTimeout(() => resolve({ requestId, workspaceId: payload.workspaceId, sessionId: payload.sessionId, error: 'timed out' }), 5000)
    socket.emit('terminal:create', { requestId, ...payload }, (result) => {
      window.clearTimeout(timer)
      resolve(result)
    })
  })
}

async function killTerminal(socket: DashboardSocket, payload: { workspaceId: string; sessionId: string; terminalId: string }): Promise<TerminalKillResult> {
  return await new Promise((resolve) => {
    const requestId = randomId()
    const timer = window.setTimeout(() => resolve({ requestId, workspaceId: payload.workspaceId, sessionId: payload.sessionId, terminalId: payload.terminalId, killed: false, error: 'timed out' }), 5000)
    socket.emit('terminal:kill', { requestId, ...payload }, (result) => {
      window.clearTimeout(timer)
      resolve(result)
    })
  })
}
