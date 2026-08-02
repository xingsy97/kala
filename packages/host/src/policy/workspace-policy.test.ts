import { describe, expect, it } from 'vitest'
import { evaluateWorkspaceToolPolicy } from './workspace-policy.js'

describe('workspace tool policy', () => {
  it('fails closed for tools, network, timeout and output limits', () => {
    const policy = { allowedTools: ['read_file', 'bash'], deniedTools: ['bash'], network: 'deny' as const, maxTimeoutSeconds: 30, maxOutputBytes: 100 }
    expect(evaluateWorkspaceToolPolicy(policy, { tool: 'write_file' }).allowed).toBe(false)
    expect(evaluateWorkspaceToolPolicy(policy, { tool: 'bash' }).allowed).toBe(false)
    expect(evaluateWorkspaceToolPolicy(policy, { tool: 'read_file', needsNetwork: true }).allowed).toBe(false)
    expect(evaluateWorkspaceToolPolicy(policy, { tool: 'read_file', timeoutSeconds: 31 }).allowed).toBe(false)
    expect(evaluateWorkspaceToolPolicy(policy, { tool: 'read_file', outputBytes: 101 }).allowed).toBe(false)
    expect(evaluateWorkspaceToolPolicy(policy, { tool: 'read_file' })).toEqual({ allowed: true })
  })
})
