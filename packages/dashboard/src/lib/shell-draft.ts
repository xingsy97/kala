import type { Socket } from 'socket.io-client'

import type {
  DashboardClientToServerEvents,
  DashboardServerToClientEvents,
} from '@agent-kernel/shared'
import type { ExecutorOs } from '@agent-kernel/shared'

import { workspaceExec } from './workspace-exec.js'

type DashboardSocket = Socket<DashboardServerToClientEvents, DashboardClientToServerEvents>

export type ShellDraftExecutionResult = {
  command: string
  stdout: string
  stderr: string
  exitCode: number | null
  durationMs: number
  stdoutTruncated?: boolean
  stderrTruncated?: boolean
  error?: string
}

export async function executeShellDraft(
  socket: DashboardSocket,
  workspaceId: string,
  command: string,
  options: { cwd?: string; os?: ExecutorOs } = {},
): Promise<ShellDraftExecutionResult> {
  const argv = options.os === 'win32'
    ? ['powershell.exe', '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '-']
    : ['/bin/sh', '-s']
  const result = await workspaceExec(socket, workspaceId, argv, {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    stdin: command,
    timeoutMs: 30_000,
    ackTimeoutMs: 32_000,
    maxOutputBytes: 64 * 1024,
  })
  return {
    command,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    ...(result.truncated && result.truncated.stdoutBytes > result.stdout.length ? { stdoutTruncated: true } : {}),
    ...(result.truncated && result.truncated.stderrBytes > result.stderr.length ? { stderrTruncated: true } : {}),
    ...(result.error ? { error: result.error.message } : {}),
  }
}

export function formatShellDraft(result: ShellDraftExecutionResult): string {
  const sections = [
    'Shell command:',
    fenced('shell', result.command),
    `Exit code: ${result.exitCode ?? 'unavailable'}${result.durationMs === undefined ? '' : ` (${result.durationMs} ms)`}`,
  ]
  if (result.stdout || !result.stderr) {
    sections.push(`Output${result.stdoutTruncated ? ' (truncated)' : ''}:`, fenced('text', result.stdout || '(empty)'))
  }
  if (result.stderr) {
    sections.push(`Error output${result.stderrTruncated ? ' (truncated)' : ''}:`, fenced('text', result.stderr))
  }
  if (result.error) sections.push(`Execution error: ${result.error}`)
  return sections.join('\n\n')
}

function fenced(language: string, value: string): string {
  const longest = Math.max(0, ...Array.from(value.matchAll(/`+/g), (match) => match[0].length))
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return `${fence}${language}\n${value}\n${fence}`
}
