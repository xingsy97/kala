import { describe, expect, it } from 'vitest'
import { decideNetworkPolicy, normalizeNetworkTarget, type NetworkPolicy } from './network-audit.js'

const policy: NetworkPolicy = { version: 1, policyId: 'p', revision: 'r1', defaultAction: 'deny', rules: [{ ruleId: 'docs', action: 'allow', hostPatterns: ['*.example.com'], schemes: ['https'], ports: [443] }] }

describe('network policy audit', () => {
  it('normalizes targets without retaining path or query', () => {
    expect(normalizeNetworkTarget('https://Docs.Example.com/a?secret=x')).toEqual({ scheme: 'https', hostname: 'docs.example.com', port: 443 })
  })
  it('matches wildcard DNS label boundaries', () => {
    expect(decideNetworkPolicy(policy, { toolName: 'webfetch', executionLocation: 'executor', url: 'https://docs.example.com/a' })).toMatchObject({ action: 'allow', matchedRuleId: 'docs' })
    expect(decideNetworkPolicy(policy, { toolName: 'webfetch', executionLocation: 'executor', url: 'https://example.com/' }).action).toBe('deny')
    expect(decideNetworkPolicy(policy, { toolName: 'webfetch', executionLocation: 'executor', url: 'https://evil.example.invalid/' }).action).toBe('deny')
  })
  it('rejects URL credentials and unsupported schemes', () => {
    expect(() => normalizeNetworkTarget('https://' + 'u' + ':' + 'p' + '@example.com')).toThrow(/credentials/)
    expect(() => normalizeNetworkTarget('file:///tmp/a')).toThrow(/http or https/)
  })
})
