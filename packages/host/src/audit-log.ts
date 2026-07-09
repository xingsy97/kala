import { mkdir, appendFile } from 'node:fs/promises'
import { join } from 'node:path'

export type AuditActor =
  | { kind: 'anonymous' }
  | { kind: 'token'; label?: string }
  | { kind: 'github_user'; login: string; id?: number }
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

export const noopAuditLogger: AuditLogger = {
  log() {},
}

export function createAuditLogger(rootDir: string): AuditLogger {
  return {
    log(entry) {
      const ts = entry.ts ?? new Date().toISOString()
      const day = ts.slice(0, 10)
      const line = JSON.stringify({ ...entry, ts }) + '\n'
      void mkdir(rootDir, { recursive: true })
        .then(() => appendFile(join(rootDir, `audit-${day}.jsonl`), line, 'utf8'))
        .catch(() => undefined)
    },
  }
}
