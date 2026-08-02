import { describe, expect, it } from 'vitest'
import { OrganizationConcurrencyGate, resolveEnterpriseModel } from './enterprise-policy.js'

describe('enterprise model policy', () => {
  const policy = { allowedModels: ['a', 'b'], defaultModel: 'a', lockedModel: 'b', maxConcurrentCalls: 1, monthlyTokenLimit: 100, fallbackModels: ['a', 'denied'] }
  it('enforces lock, allow-list, quota and fallback filtering', () => {
    expect(resolveEnterpriseModel(policy, 'a', 99)).toEqual({ model: 'b', fallbacks: ['a'] })
    expect(() => resolveEnterpriseModel(policy, 'a', 100)).toThrow('quota')
  })
  it('enforces per-organization concurrency', async () => {
    const gate = new OrganizationConcurrencyGate(); let release!: () => void
    const first = gate.run('org_a', 1, () => new Promise<void>((resolve) => { release = resolve }))
    await expect(gate.run('org_a', 1, async () => undefined)).rejects.toThrow('concurrency')
    await expect(gate.run('org_b', 1, async () => 'ok')).resolves.toBe('ok')
    release(); await first
  })
})
