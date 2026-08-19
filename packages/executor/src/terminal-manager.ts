import process from 'node:process'
import { spawn as spawnChild } from 'node:child_process'
import { ulid } from 'ulid'

import type {
  ClientTerminalCloseSession,
  ClientTerminalCreate,
  ClientTerminalInput,
  ClientTerminalKill,
  ClientTerminalResize,
  ServerTerminalExit,
  ServerTerminalOutput,
  TerminalCreateResult,
  TerminalKillResult,
} from '@agent-kernel/shared'

import type { Sandbox } from './sandbox.js'

type TerminalProcess = {
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: NodeJS.Signals): void
  onData(cb: (data: string) => void): void
  onExit(cb: (event: { exitCode: number; signal: number | string | null }) => void): void
}

type NodePtyModule = {
  spawn(
    shell: string,
    args: readonly string[],
    options: {
      name: string
      cols: number
      rows: number
      cwd: string
      env: NodeJS.ProcessEnv
    },
  ): TerminalProcess
}

async function tryLoadNodePty(): Promise<NodePtyModule | undefined> {
  if (process.env.AGENT_KERNEL_TERMINAL_DISABLE_PTY === '1') return undefined
  try {
    const mod = await import('node-pty') as NodePtyModule | { default?: NodePtyModule }
    return 'spawn' in mod ? mod : mod.default
  } catch {
    return undefined
  }
}

function createFallbackTerminal(input: {
  shell: string
  cwd: string
  env: NodeJS.ProcessEnv
}): TerminalProcess {
  // Release executors are shipped as a single CJS/SEA artifact. Native
  // node-pty cannot always be loaded beside that artifact, so on Unix use the
  // ubiquitous `script` utility as a real PTY bridge instead of launching the
  // shell over plain pipes. A pipe-backed shell does not echo keystrokes and
  // made the dashboard look completely unable to accept input.
  const command = process.platform === 'win32' ? input.shell : 'script'
  const args = process.platform === 'darwin'
    ? ['-q', '/dev/null', input.shell]
    : process.platform === 'win32'
      ? []
      : ['-qfec', input.shell, '/dev/null']
  const child = spawnChild(command, args, {
    cwd: input.cwd,
    env: input.env,
    stdio: 'pipe',
  })

  return {
    write(data) {
      // Windows pipe shells and the last-resort non-PTY path do not have a
      // terminal line discipline to translate Return (CR) into newline (LF).
      // Normalize here as well; it is harmless for `script` and makes Enter
      // execute commands even before an older Executor is upgraded to PTY.
      child.stdin.write(data.replaceAll('\r', '\n'))
    },
    resize() {
      // Plain pipes do not expose terminal dimensions. The dashboard still
      // receives output, but full-screen TUI programs require node-pty.
    },
    kill(signal = 'SIGTERM') {
      child.kill(signal)
    },
    onData(cb) {
      child.stdout.on('data', (chunk) => cb(String(chunk)))
      child.stderr.on('data', (chunk) => cb(String(chunk)))
    },
    onExit(cb) {
      child.on('exit', (exitCode, signal) => cb({ exitCode: exitCode ?? 0, signal }))
    },
  }
}

async function spawnTerminal(input: {
  shell: string
  cwd: string
  cols: number
  rows: number
  env: NodeJS.ProcessEnv
}): Promise<TerminalProcess> {
  const nodePty = await tryLoadNodePty()
  if (nodePty) {
    try {
      return nodePty.spawn(input.shell, [], {
        name: 'xterm-256color',
        cols: input.cols,
        rows: input.rows,
        cwd: input.cwd,
        env: input.env,
      })
    } catch {
      // node-pty's JavaScript can load from a single-file CJS release while its
      // platform native module (for example conpty.node on Windows) is absent.
      // That failure happens at spawn(), not import(), so fall back here instead
      // of surfacing a broken Terminal to the user.
    }
  }
  return createFallbackTerminal(input)
}

export type TerminalManager = {
  activeCount(): number
  create(payload: ClientTerminalCreate): Promise<TerminalCreateResult>
  input(payload: ClientTerminalInput): void
  resize(payload: ClientTerminalResize): void
  kill(payload: ClientTerminalKill): TerminalKillResult
  closeSession(payload: ClientTerminalCloseSession): void
  closeAll(): void
}

const TERMINAL_REPLAY_MAX_BYTES = 1024 * 1024

function appendReplay(current: Buffer, data: string): Buffer {
  const next = Buffer.concat([current, Buffer.from(data)])
  return next.byteLength <= TERMINAL_REPLAY_MAX_BYTES
    ? next
    : next.subarray(next.byteLength - TERMINAL_REPLAY_MAX_BYTES)
}

export function createTerminalManager(input: {
  sandbox: Sandbox
  emitOutput(payload: ServerTerminalOutput): void
  emitExit(payload: ServerTerminalExit): void
}): TerminalManager {
  type TerminalRecord = {
    workspaceId: string
    sessionId: string
    terminalId: string
    cwd: string
    terminal: TerminalProcess
    exited: boolean
    replay: Buffer
  }
  const terminals = new Map<string, TerminalRecord>()
  const sessionTerminals = new Map<string, TerminalRecord>()
  const pendingCreates = new Map<string, Promise<TerminalCreateResult>>()

  const keyOf = (workspaceId: string, sessionId: string, terminalId: string): string => `${workspaceId}:${sessionId}:${terminalId}`
  const sessionKeyOf = (workspaceId: string, sessionId: string): string => `${workspaceId}:${sessionId}`

  const closeRecord = (record: TerminalRecord): void => {
    if (!record.exited) record.terminal.kill('SIGTERM')
    terminals.delete(keyOf(record.workspaceId, record.sessionId, record.terminalId))
    if (sessionTerminals.get(sessionKeyOf(record.workspaceId, record.sessionId)) === record) {
      sessionTerminals.delete(sessionKeyOf(record.workspaceId, record.sessionId))
    }
  }

  return {
    activeCount() {
      return terminals.size + pendingCreates.size
    },
    async create(payload) {
      const sessionKey = sessionKeyOf(payload.workspaceId, payload.sessionId)
      const existing = sessionTerminals.get(sessionKey)
      if (existing && !existing.exited) {
        return {
          requestId: payload.requestId,
          workspaceId: payload.workspaceId,
          sessionId: payload.sessionId,
          terminalId: existing.terminalId,
          cwd: existing.cwd,
          reused: true,
          replay: existing.replay.toString(),
        }
      }
      const pending = pendingCreates.get(sessionKey)
      if (pending) {
        const result = await pending
        return { ...result, requestId: payload.requestId, reused: result.terminalId !== undefined }
      }
      const creating = (async (): Promise<TerminalCreateResult> => {
        const requestedCwd = payload.cwd?.trim() || process.cwd()
        try {
        const cwd = await input.sandbox.resolve(requestedCwd)
        const terminalId = ulid()
        const shell = process.env.SHELL || (process.platform === 'win32' ? 'cmd.exe' : '/bin/sh')
        const terminal = await spawnTerminal({
          shell,
          cols: payload.cols ?? 80,
          rows: payload.rows ?? 24,
          cwd,
          env: {
            ...process.env,
            TERM: process.env.TERM || 'xterm-256color',
          },
        })
        const record: TerminalRecord = { workspaceId: payload.workspaceId, sessionId: payload.sessionId, terminalId, cwd, terminal, exited: false, replay: Buffer.alloc(0) }
        terminals.set(keyOf(payload.workspaceId, payload.sessionId, terminalId), record)
        sessionTerminals.set(sessionKey, record)
        terminal.onData((data) => {
          record.replay = appendReplay(record.replay, data)
          input.emitOutput({ workspaceId: payload.workspaceId, sessionId: payload.sessionId, terminalId, data })
        })
        terminal.onExit(({ exitCode, signal }) => {
          record.exited = true
          terminals.delete(keyOf(payload.workspaceId, payload.sessionId, terminalId))
          if (sessionTerminals.get(sessionKey) === record) sessionTerminals.delete(sessionKey)
          input.emitExit({ workspaceId: payload.workspaceId, sessionId: payload.sessionId, terminalId, exitCode, signal: signal === 0 ? null : String(signal) })
        })
        return { requestId: payload.requestId, workspaceId: payload.workspaceId, sessionId: payload.sessionId, terminalId, cwd }
        } catch (err) {
          return {
            requestId: payload.requestId,
            workspaceId: payload.workspaceId,
            sessionId: payload.sessionId,
            error: err instanceof Error ? err.message : String(err),
          }
        }
      })()
      pendingCreates.set(sessionKey, creating)
      try {
        return await creating
      } finally {
        if (pendingCreates.get(sessionKey) === creating) pendingCreates.delete(sessionKey)
      }
    },
    input(payload) {
      const record = terminals.get(keyOf(payload.workspaceId, payload.sessionId, payload.terminalId))
      if (!record || record.exited) return
      record.terminal.write(payload.data)
    },
    resize(payload) {
      const record = terminals.get(keyOf(payload.workspaceId, payload.sessionId, payload.terminalId))
      if (!record || record.exited) return
      record.terminal.resize(payload.cols, payload.rows)
    },
    kill(payload) {
      const key = keyOf(payload.workspaceId, payload.sessionId, payload.terminalId)
      const record = terminals.get(key)
      if (!record) return { requestId: payload.requestId, workspaceId: payload.workspaceId, sessionId: payload.sessionId, terminalId: payload.terminalId, killed: false, error: 'terminal not found' }
      // Retire the record before acknowledging Kill. Restart creates a new PTY
      // immediately after this ACK; waiting for the asynchronous child exit
      // event leaves the old record reusable and sends input to a dying PTY.
      record.exited = true
      terminals.delete(key)
      const sessionKey = sessionKeyOf(payload.workspaceId, payload.sessionId)
      if (sessionTerminals.get(sessionKey) === record) sessionTerminals.delete(sessionKey)
      record.terminal.kill('SIGTERM')
      return { requestId: payload.requestId, workspaceId: payload.workspaceId, sessionId: payload.sessionId, terminalId: payload.terminalId, killed: true }
    },
    closeSession(payload) {
      const sessionKey = sessionKeyOf(payload.workspaceId, payload.sessionId)
      const record = sessionTerminals.get(sessionKey)
      if (record) {
        closeRecord(record)
        return
      }
      const pending = pendingCreates.get(sessionKey)
      if (pending) void pending.then(() => {
        const created = sessionTerminals.get(sessionKey)
        if (created) closeRecord(created)
      })
    },
    closeAll() {
      for (const record of [...terminals.values()]) closeRecord(record)
      terminals.clear()
      sessionTerminals.clear()
    },
  }
}
