import { mkdir, open } from 'node:fs/promises'
import { join } from 'node:path'

export type AuditActor =
  | { kind: 'anonymous' }
  | { kind: 'token'; label?: string }
  | { kind: 'github_user'; login: string; id?: number }
  | { kind: 'ingress'; principal: string; organizationId: string; role: 'owner' | 'admin' | 'member' | 'viewer' }
  | { kind: 'executor'; executorId?: string; workspaceId?: string; label?: string }
  | { kind: 'system' }

export type AuditOutcome = 'ok' | 'denied' | 'error'

export type AuditEntry = {
  ts?: string
  action: string
  actor: AuditActor
  target?: Record<string, unknown>
  outcome: AuditOutcome
  refs?: Record<string, unknown>
  metadata?: Record<string, unknown>
  error?: string
}

export type AuditLogger = {
  log(entry: AuditEntry): void
}

export type ManagedAuditLogger = AuditLogger & {
  readonly failureCount: number
  flush(): Promise<void>
  close(): Promise<void>
}

export const noopAuditLogger: AuditLogger = {
  log() {},
}

export function createAuditLogger(
  rootDir: string,
  options: { onError?(error: unknown, entry: AuditEntry): void } = {},
): ManagedAuditLogger {
  let tail = Promise.resolve()
  let closed = false
  let failures = 0

  const fail = (error: unknown, entry: AuditEntry): void => {
    failures++
    options.onError?.(error, entry)
  }

  const logger: ManagedAuditLogger = {
    get failureCount() { return failures },
    log(entry) {
      if (closed) {
        fail(new Error('audit logger is closed'), entry)
        return
      }
      let ts: string
      let line: string
      try {
        ts = entry.ts ?? new Date().toISOString()
        line = JSON.stringify({ ...entry, ts }) + '\n'
      } catch (error) {
        fail(error, entry)
        return
      }
      tail = tail.then(async () => {
        await mkdir(rootDir, { recursive: true, mode: 0o700 })
        const file = await open(join(rootDir, `audit-${ts.slice(0, 10)}.jsonl`), 'a', 0o600)
        try {
          await file.chmod(0o600)
          await file.writeFile(line, 'utf8')
        } finally {
          await file.close()
        }
      }).catch((error: unknown) => { fail(error, entry) })
    },
    async flush() {
      await tail
    },
    async close() {
      if (closed) return
      closed = true
      await tail
    },
  }
  return logger
}
