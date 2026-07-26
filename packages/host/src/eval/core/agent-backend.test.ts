import { describe, expect, it } from 'vitest'

import { getAgentBackend, listAgentBackends } from './agent-backend.js'

describe('agent backend registry', () => {
  it('makes Agent RunLab the production-capable real backend and isolates smoke', () => {
    const list = listAgentBackends()
    expect(list.map((entry) => entry.id)).toEqual(['agent-runlab', 'claude-code', 'custom-command', 'smoke'])
    expect(getAgentBackend('agent-runlab').descriptor).toMatchObject({ production: true, capabilities: { realAgent: true, sessionLog: true } })
    expect(getAgentBackend('smoke').descriptor).toMatchObject({ production: false, evidenceLevel: 'smoke', capabilities: { realAgent: false } })
  })

  it('builds the proven Agent RunLab runner command with benchmark environment placeholders', () => {
    const backend = getAgentBackend('agent-runlab')
    const config = { id: 'agent-runlab' as const, model: 'claude-sonnet-4-6', config: { maxTurns: 12 } }
    expect(backend.validate(config).ok).toBe(true)
    const command = backend.command(config)
    expect(command).toContain('run-agent-runlab-swebench.ts')
    expect(command).toContain('"$AGENT_KERNEL_SWEBENCH_PROMPT_FILE"')
    expect(command).toContain("'claude-sonnet-4-6'")
    expect(command).toContain("'12'")
  })

  it('requires explicit custom commands', () => {
    const backend = getAgentBackend('custom-command')
    expect(backend.validate({ id: 'custom-command', model: 'model', config: {} }).ok).toBe(false)
    expect(backend.validate({ id: 'custom-command', model: 'model', config: { command: 'agent run' } }).ok).toBe(true)
  })
})

