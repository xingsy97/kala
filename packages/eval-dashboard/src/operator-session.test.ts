import type { EvaluationCommand } from '@agent-kernel/eval-protocol'
import { beforeEach, describe, expect, it } from 'vitest'
import { loadOperatorCommand, operatorCommandEnvelope, operatorSession, saveOperatorCommand } from './operator-session.js'

describe('operator session persistence', () => {
  beforeEach(() => localStorage.clear())

  it('restores the same session and creates stable command envelope identifiers', () => {
    const first = operatorSession()
    const restored = operatorSession()
    const envelope = operatorCommandEnvelope(first)
    expect(restored).toEqual(first)
    expect(envelope.commandId).toBe(envelope.idempotencyKey)
    expect(envelope.commandId.startsWith(first.sessionId + ':')).toBe(true)
  })

  it.each(['pending', 'failed', 'committed'] as const)('restores a %s command state after refresh', (state) => {
    const session = operatorSession()
    const command: EvaluationCommand = { ...operatorCommandEnvelope(session), type: 'leaderboard.publish', runId: 'run-one' }
    const saved = saveOperatorCommand({ schemaVersion: 1, sessionId: session.sessionId, command, state, updatedAt: '2026-08-03T00:00:00.000Z', ...(state === 'failed' ? { error: 'retryable' } : {}) })
    expect(loadOperatorCommand()).toEqual(saved)
  })

  it('keeps command recovery while removing nested secret-shaped values from browser storage', () => {
    const session = operatorSession()
    const command = { ...operatorCommandEnvelope(session), type: 'leaderboard.publish', runId: 'run-one', metadata: { token: 'long-lived-secret', safe: 'kept' } } as unknown as EvaluationCommand
    const saved = saveOperatorCommand({ schemaVersion: 1, sessionId: session.sessionId, command, state: 'pending', updatedAt: '2026-08-03T00:00:00.000Z' })
    expect(JSON.stringify(localStorage)).not.toContain('long-lived-secret')
    expect(saved.command).toMatchObject({ runId: 'run-one', metadata: { safe: 'kept' } })
    expect(loadOperatorCommand()).toEqual(saved)
  })
})
