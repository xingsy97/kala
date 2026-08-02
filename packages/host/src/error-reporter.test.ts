import { describe, expect, it, vi } from 'vitest'
import { GlitchTipErrorReporter } from './error-reporter.js'

describe('GlitchTip error reporter', () => {
  it('redacts credential-shaped text and returns a traceable event id', async () => {
    const fetchImpl = vi.fn(async (_url, init) => { expect(String(init?.body)).not.toContain('supersecret'); return new Response(null, { status: 200 }) })
    const reporter = new GlitchTipErrorReporter({ endpoint: 'https://errors.test/api/1/store/', projectKey: 'key', fetchImpl })
    const result = await reporter.capture({ code: 'failure', component: 'host', operation: 'call', outcome: 'error', retryable: true, safeMessage: 'token=supersecret' })
    expect(result.eventId).toHaveLength(32)
  })
})
