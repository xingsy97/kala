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
import { useInterfaceScale } from '../../lib/interface-scale.js'

type TerminalStatus = 'idle' | 'starting' | 'running' | 'exited' | 'error'

export function SessionTerminalPanel({
  socket,
  workspaceId,
  sessionId,
  cwd,
  online = true,
  autoStart = false,
  destroyOnUnmount = false,
}: {
  socket: DashboardSocket | null
  workspaceId?: string
  sessionId: string
  cwd?: string
  online?: boolean
  autoStart?: boolean
  destroyOnUnmount?: boolean
}): JSX.Element {
  const { t } = useTranslation()
  const interfaceScale = useInterfaceScale()
  const hostRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<XTerm | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const terminalIdRef = useRef<string | null>(null)
  const identityRef = useRef(`${workspaceId ?? ''}:${sessionId}`)
  const [terminalId, setTerminalIdState] = useState<string | null>(null)
  const [status, setStatus] = useState<TerminalStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const inputContextRef = useRef({ socket, workspaceId, sessionId, status })
  const autoStartedRef = useRef(false)
  const disposedRef = useRef(false)
  const fitFrameRef = useRef<number | null>(null)
  const lastSizeRef = useRef<{ terminalId: string; cols: number; rows: number } | null>(null)
  inputContextRef.current = { socket, workspaceId, sessionId, status }

  const setTerminalId = useCallback((value: string | null): void => {
    terminalIdRef.current = value
    lastSizeRef.current = null
    setTerminalIdState(value)
  }, [])

  const scheduleFitAndResize = useCallback((terminalIdOverride?: string): void => {
    if (fitFrameRef.current !== null) cancelAnimationFrame(fitFrameRef.current)
    fitFrameRef.current = requestAnimationFrame(() => {
      fitFrameRef.current = requestAnimationFrame(() => {
        fitFrameRef.current = null
        const host = hostRef.current
        const term = terminalRef.current
        const fit = fitRef.current
        if (!host || !term || !fit || host.clientWidth <= 0 || host.clientHeight <= 0) return
        fit.fit()
        const id = terminalIdOverride ?? terminalIdRef.current
        if (!socket || !workspaceId || !id || term.cols <= 0 || term.rows <= 0) return
        const previous = lastSizeRef.current
        if (previous?.terminalId === id && previous.cols === term.cols && previous.rows === term.rows) return
        lastSizeRef.current = { terminalId: id, cols: term.cols, rows: term.rows }
        socket.emit('terminal:resize', { workspaceId, sessionId, terminalId: id, cols: term.cols, rows: term.rows })
      })
    })
  }, [sessionId, socket, workspaceId])

  useEffect(() => {
    const term = new XTerm({ cursorBlink: true, fontSize: 12, convertEol: true, rows: 12, theme: { background: '#0b0f14' } })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon())
    term.loadAddon(new SearchAddon())
    terminalRef.current = term
    fitRef.current = fit
    const inputDisposable = term.onData((data) => {
      const current = inputContextRef.current
      const id = terminalIdRef.current
      if (!current.socket || !current.workspaceId || !id || current.status !== 'running') return
      current.socket.emit('terminal:input', {
        workspaceId: current.workspaceId,
        sessionId: current.sessionId,
        terminalId: id,
        data,
      })
    })
    if (hostRef.current) {
      term.open(hostRef.current)
      fit.fit()
    }
    return () => {
      // A panel detach must not kill the Session PTY. Explicit Kill and Session
      // deletion are the only terminal-destruction paths.
      inputDisposable.dispose()
      term.dispose()
      terminalRef.current = null
      fitRef.current = null
      if (fitFrameRef.current !== null) cancelAnimationFrame(fitFrameRef.current)
    }
  }, [])

  useEffect(() => {
    if (terminalRef.current) terminalRef.current.options.fontSize = Math.round(12 * interfaceScale)
    scheduleFitAndResize()
  }, [interfaceScale, scheduleFitAndResize])

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
    if (status === 'running' && terminalId) terminalRef.current?.focus()
  }, [status, terminalId])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const observer = new ResizeObserver(() => scheduleFitAndResize())
    observer.observe(host)
    if (host.parentElement) observer.observe(host.parentElement)
    const onLayoutChange = (): void => scheduleFitAndResize()
    let active = true
    window.addEventListener('resize', onLayoutChange)
    document.addEventListener('visibilitychange', onLayoutChange)
    void document.fonts?.ready.then(() => {
      if (active) onLayoutChange()
    })
    scheduleFitAndResize()
    return () => {
      observer.disconnect()
      active = false
      window.removeEventListener('resize', onLayoutChange)
      document.removeEventListener('visibilitychange', onLayoutChange)
    }
  }, [scheduleFitAndResize])

  const start = useCallback(async (): Promise<void> => {
    if (!socket || !workspaceId || !online) return
    setStatus('starting')
    setError(null)
    fitRef.current?.fit()
    const term = terminalRef.current
    const result = await createTerminal(socket, { workspaceId, sessionId, cwd, cols: term?.cols ?? 100, rows: term?.rows ?? 12 })
    if (disposedRef.current) {
      if (result.terminalId && destroyOnUnmount) {
        void killTerminal(socket, { workspaceId, sessionId, terminalId: result.terminalId })
      }
      return
    }
    if (result.error || !result.terminalId) {
      setStatus('error')
      setError(result.error ?? t('terminal.startFailed'))
      return
    }
    setTerminalId(result.terminalId)
    setStatus('running')
    if (result.replay) term?.write(result.replay)
    if (!result.reused && result.cwd) term?.writeln(t('terminal.connected', { cwd: result.cwd }))
    scheduleFitAndResize(result.terminalId)
    term?.focus()
  }, [cwd, destroyOnUnmount, online, scheduleFitAndResize, sessionId, setTerminalId, socket, t, workspaceId])

  useEffect(() => {
    if (!autoStart || autoStartedRef.current || !socket || !workspaceId || !online) return
    autoStartedRef.current = true
    void start()
  }, [autoStart, online, socket, start, workspaceId])

  useEffect(() => () => {
    disposedRef.current = true
    const id = terminalIdRef.current
    if (destroyOnUnmount && socket && workspaceId && id) {
      void killTerminal(socket, { workspaceId, sessionId, terminalId: id })
    }
  }, [destroyOnUnmount, sessionId, socket, workspaceId])

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
    <div className="flex h-full min-h-0 flex-col bg-[#0b0f14] text-white" data-testid="session-terminal-panel" data-terminal-status={status}>
      <div className="relative flex min-h-10 flex-none flex-nowrap items-center gap-1.5 overflow-hidden border-b border-border/35 bg-card/95 px-2 py-1 text-card-foreground sm:px-3" data-testid="terminal-toolbar">
        <span className="inline-flex min-w-0 flex-1 items-center gap-2 truncate text-xs text-muted-foreground" data-testid="terminal-status"><span className={`h-1.5 w-1.5 flex-none rounded-full ${!online || status === 'error' ? 'bg-rose-500' : status === 'running' ? 'bg-emerald-500' : status === 'starting' ? 'animate-pulse bg-amber-500' : 'bg-muted-foreground/50'}`} />{statusLabel}</span>
        <Button size="sm" className="h-11 flex-none gap-1.5 rounded-lg px-3 sm:h-8" disabled={disabled || status === 'starting' || status === 'running'} onClick={() => void start()}>
          {status === 'starting' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}{t('terminal.start')}
        </Button>
        <Button size="icon" variant="ghost" className="h-11 w-11 flex-none rounded-lg sm:h-8 sm:w-8" disabled={disabled || status === 'starting'} onClick={() => void restart()} title={t('terminal.restart')} aria-label={t('terminal.restart')}><RefreshCw className="h-3.5 w-3.5" /></Button>
        <Button size="icon" variant="ghost" className="h-11 w-11 flex-none rounded-lg sm:h-8 sm:w-8" disabled={!terminalId || status !== 'running'} onClick={() => void kill()} title={t('terminal.kill')} aria-label={t('terminal.kill')}><Square className="h-3.5 w-3.5" /></Button>
        <Button size="icon" variant="ghost" className="h-11 w-11 flex-none rounded-lg sm:h-8 sm:w-8" onClick={() => terminalRef.current?.clear()} title={t('terminal.clear')} aria-label={t('terminal.clear')}><Eraser className="h-3.5 w-3.5" /></Button>
        {status === 'starting' ? <span className="ak-terminal-connecting absolute inset-x-0 bottom-0 h-px" aria-hidden="true" /> : null}
      </div>
      {!online ? <div className="border-b border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-200" role="status">{t('terminal.offlineHelp')}</div> : null}
      <div
        ref={hostRef}
        className="min-h-0 min-w-0 flex-1 cursor-text overflow-hidden p-1.5 outline-none ring-inset focus-within:ring-1 focus-within:ring-primary/50 [&_.xterm]:h-full"
        data-testid="terminal-viewport"
        onPointerDown={() => terminalRef.current?.focus()}
        onTouchStart={() => terminalRef.current?.focus()}
      />
      <div className="flex flex-none gap-1.5 overflow-x-auto border-t border-border/40 bg-card px-2 py-1.5 text-card-foreground md:hidden" data-testid="terminal-touch-keys">
        {([[t('terminal.keys.esc'), '\u001b'], [t('terminal.keys.tab'), '\t'], ['Ctrl+C', '\u0003'], ['↑', '\u001b[A'], ['↓', '\u001b[B'], ['←', '\u001b[D'], ['→', '\u001b[C']] as const).map(([label, data]) => (
          <Button key={label} size="sm" variant="outline" className="h-11 min-w-11 flex-none px-2 font-mono text-xs" disabled={status !== 'running'} onClick={() => sendKey(data)}>{label}</Button>
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
