import { describe, expect, it } from 'vitest'
import { operationalError, OperationalMetrics } from './operational-metrics.js'

describe('OperationalMetrics', () => {
  it('keeps only bounded low-cardinality labels', () => {
    const metrics = new OperationalMetrics()
    metrics.increment('agent_turns_total', 'Completed turns', { component: 'host', outcome: 'ok', session_id: 'secret-session', prompt: 'private' })
    const output = metrics.render()
    expect(output).toContain('agent_turns_total{component="host",outcome="ok"} 1')
    expect(output).not.toContain('secret-session')
    expect(output).not.toContain('private')
  })
})

describe('operationalError', () => {
  it('redacts credential-like values and bounds user-safe text', () => {
    const error = operationalError({ code: 'provider_failed', component: 'llm', operation: 'call', outcome: 'error', retryable: true, safeMessage: `authorization: super-secret ${'x'.repeat(400)}` })
    expect(error.safeMessage).toContain('authorization=[redacted]')
    expect(error.safeMessage).not.toContain('super-secret')
    expect(error.safeMessage.length).toBeLessThanOrEqual(240)
  })
})
