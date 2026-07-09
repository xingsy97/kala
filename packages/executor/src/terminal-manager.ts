import process from 'node:process'
import { spawn as spawnChild } from 'node:child_process'
import { ulid } from 'ulid'

import type {
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

function createPipeTerminal(input: {
  shell: string
  cwd: string
  env: NodeJS.ProcessEnv
}): TerminalProcess {
  const child = spawnChild(input.shell, [], {
    cwd: input.cwd,
    env: input.env,
    stdio: 'pipe',
  })

  return {
    write(data) {
      child.stdin.write(data)
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
    return nodePty.spawn(input.shell, [], {
      name: 'xterm-256color',
      cols: input.cols,
      rows: input.rows,
      cwd: input.cwd,
      env: input.env,
    })
  }
  return createPipeTerminal(input)
}

export type TerminalManager = {
  create(payload: ClientTerminalCreate): Promise<TerminalCreateResult>
  input(payload: ClientTerminalInput): void
  resize(payload: ClientTerminalResize): void
  kill(payload: ClientTerminalKill): TerminalKillResult
  closeAll(): void
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
  }
  const terminals = new Map<string, TerminalRecord>()

  const keyOf = (workspaceId: string, sessionId: string, terminalId: string): string => `${workspaceId}:${sessionId}:${terminalId}`

  return {
    async create(payload) {
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
        const record: TerminalRecord = { workspaceId: payload.workspaceId, sessionId: payload.sessionId, terminalId, cwd, terminal, exited: false }
        terminals.set(keyOf(payload.workspaceId, payload.sessionId, terminalId), record)
        terminal.onData((data) => {
          input.emitOutput({ workspaceId: payload.workspaceId, sessionId: payload.sessionId, terminalId, data })
        })
        terminal.onExit(({ exitCode, signal }) => {
          record.exited = true
          terminals.delete(keyOf(payload.workspaceId, payload.sessionId, terminalId))
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
      const record = terminals.get(keyOf(payload.workspaceId, payload.sessionId, payload.terminalId))
      if (!record) return { requestId: payload.requestId, workspaceId: payload.workspaceId, sessionId: payload.sessionId, terminalId: payload.terminalId, killed: false, error: 'terminal not found' }
      record.terminal.kill('SIGTERM')
      return { requestId: payload.requestId, workspaceId: payload.workspaceId, sessionId: payload.sessionId, terminalId: payload.terminalId, killed: true }
    },
    closeAll() {
      for (const record of terminals.values()) record.terminal.kill('SIGTERM')
      terminals.clear()
    },
  }
}
