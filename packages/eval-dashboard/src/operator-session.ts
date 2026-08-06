import type { CommittedAcknowledgement, EvaluationCommand } from '@agent-kernel/eval-protocol'

const SESSION_KEY = 'agent-eval-operator-session-v1'
const COMMAND_KEY = 'agent-eval-operator-command-v1'

export type OperatorSession = { schemaVersion: 1; sessionId: string; createdAt: string }
export type StoredOperatorCommand = {
  schemaVersion: 1
  sessionId: string
  command: EvaluationCommand
  state: 'pending' | 'committed' | 'failed'
  updatedAt: string
  acknowledgement?: CommittedAcknowledgement
  error?: string
}

export function operatorSession(storage: Storage = globalThis.localStorage): OperatorSession {
  const existing = parseSession(storage.getItem(SESSION_KEY))
  if (existing) return existing
  const created = { schemaVersion: 1 as const, sessionId: 'operator-' + randomIdentifier(), createdAt: new Date().toISOString() }
  storage.setItem(SESSION_KEY, JSON.stringify(created))
  return created
}

export function operatorCommandEnvelope(session: OperatorSession): Pick<EvaluationCommand, 'schemaVersion' | 'commandId' | 'idempotencyKey' | 'submittedAt'> {
  const suffix = randomIdentifier()
  return { schemaVersion: 1, commandId: session.sessionId + ':' + suffix, idempotencyKey: session.sessionId + ':' + suffix, submittedAt: new Date().toISOString() }
}

export function loadOperatorCommand(storage: Storage = globalThis.localStorage): StoredOperatorCommand | undefined {
  try {
    const parsed = JSON.parse(storage.getItem(COMMAND_KEY) ?? 'null') as Partial<StoredOperatorCommand> | null
    if (!parsed || parsed.schemaVersion !== 1 || typeof parsed.sessionId !== 'string' || !parsed.command || !['pending', 'committed', 'failed'].includes(String(parsed.state)) || typeof parsed.updatedAt !== 'string') return undefined
    return parsed as StoredOperatorCommand
  } catch { return undefined }
}

export function saveOperatorCommand(record: StoredOperatorCommand, storage: Storage = globalThis.localStorage): StoredOperatorCommand {
  const safeRecord = removeSecrets(record) as StoredOperatorCommand
  storage.setItem(COMMAND_KEY, JSON.stringify(safeRecord))
  return safeRecord
}

export function clearOperatorCommand(storage: Storage = globalThis.localStorage): void {
  storage.removeItem(COMMAND_KEY)
}

const SECRET_KEY = /^(?:access[-_]?token|api[-_]?key|authorization|bearer|password|refresh[-_]?token|secret|session[-_]?token|token)$/iu

function removeSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(removeSecrets)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).filter(([key]) => !SECRET_KEY.test(key)).map(([key, entry]) => [key, removeSecrets(entry)]))
}

function parseSession(value: string | null): OperatorSession | undefined {
  try {
    const parsed = JSON.parse(value ?? 'null') as Partial<OperatorSession> | null
    if (!parsed || parsed.schemaVersion !== 1 || typeof parsed.sessionId !== 'string' || !/^operator-[A-Za-z0-9._:-]+$/u.test(parsed.sessionId) || typeof parsed.createdAt !== 'string') return undefined
    return parsed as OperatorSession
  } catch { return undefined }
}

function randomIdentifier(): string {
  const value = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36)
  return value.replace(/[^A-Za-z0-9._:-]/gu, '-')
}
