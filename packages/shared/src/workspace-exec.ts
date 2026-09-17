/**
 * Wire types for dashboard→host→executor generic workspace observation.
 *
 * See docs/planning/roadmap-notes/workspace-exec-refactor.md for the
 * design + trust story. The dashboard imports these; the host uses them
 * for socket schemas; the executor implements the handlers.
 */

export type WorkspaceExecRequest = {
  requestId: string
  workspaceId: string
  cwd?: string
  argv: readonly string[]
  timeoutMs?: number
  stdin?: string
  maxOutputBytes?: number
}

export type WorkspaceExecError = {
  code: 'EACCES' | 'ENOENT' | 'ETIMEDOUT' | 'EINVAL' | 'EIO'
  message: string
}

export type WorkspaceExecResponse = {
  requestId: string
  stdout: string
  stderr: string
  exitCode: number | null
  durationMs: number
  truncated?: { stdoutBytes: number; stderrBytes: number }
  error?: WorkspaceExecError
}

export type WorkspaceReadBinaryRequest = {
  requestId: string
  workspaceId: string
  path: string
  cwd?: string
  offset?: number
  maxBytes?: number
}

export type WorkspaceReadBinaryError = {
  code: 'EACCES' | 'ENOENT' | 'EINVAL' | 'EIO'
  message: string
}

export type WorkspaceReadBinaryResponse = {
  requestId: string
  base64: string
  mime: string
  size: number
  offset?: number
  truncated?: { maxBytes: number }
  error?: WorkspaceReadBinaryError
}
