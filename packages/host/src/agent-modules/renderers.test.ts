import { describe, expect, it } from 'vitest'

import { resolveAgentModule, renderToolDescription, stableHash } from './renderers.js'
import type { AgentModule, ToolDefinition } from './types.js'

const baseTool: ToolDefinition = {
  name: 'demo',
  inputSchema: { type: 'object' },
  requiresApproval: false,
  prompt: {
    purpose: 'Run demo behavior.',
    whenToUse: ['When a test needs a tool.'],
    constraints: ['Keep inputs small.'],
    failureHandling: ['Return a clear error.'],
  },
  policy: { risk: 'read', approvalDefault: 'auto' },
  execution: { kind: 'host', handler: 'demo-handler' },
}

function moduleWith(tools: readonly ToolDefinition[]): AgentModule {
  return {
    id: 'test-module',
    version: '1.0.0',
    label: 'Test Module',
    systemPrompt: {
      id: 'test-prompt',
      version: '1.0.0',
      label: 'Test Prompt',
      render: () => 'system prompt',
    },
    toolsets: [{
      id: 'test-toolset',
      version: '2.0.0',
      label: 'Test Toolset',
      provideTools: () => tools,
    }],
  }
}

describe('agent module renderers', () => {
  it('renders toolset provenance, policy, and execution metadata into ToolSchema', () => {
    const resolved = resolveAgentModule(moduleWith([baseTool]), { mode: 'coding', skills: [] })

    expect(resolved.systemPrompt).toBe('system prompt')
    expect(resolved.tools[0]).toMatchObject({
      name: 'demo',
      toolsetId: 'test-toolset',
      toolsetVersion: '2.0.0',
      risk: 'read',
      executionKind: 'host',
      executionHandler: 'demo-handler',
    })
    expect(resolved.metadata).toMatchObject({
      id: 'test-module',
      version: '1.0.0',
      label: 'Test Module',
      toolsets: [{ id: 'test-toolset', version: '2.0.0', label: 'Test Toolset', toolCount: 1 }],
    })
    expect(resolved.config.agentModule?.toolRegistryHash).toBe(resolved.metadata.toolRegistryHash)
  })

  it('formats prompt sections into provider-facing tool descriptions', () => {
    expect(renderToolDescription(baseTool)).toContain('Use when:\n- When a test needs a tool.')
    expect(renderToolDescription(baseTool)).toContain('Failure handling:\n- Return a clear error.')
  })

  it('produces stable hashes independent of object key insertion order', () => {
    expect(stableHash({ b: 2, a: 1 })).toBe(stableHash({ a: 1, b: 2 }))
  })

  it('rejects duplicate tool names across toolsets', () => {
    expect(() => resolveAgentModule(moduleWith([baseTool, { ...baseTool }]), { mode: 'coding', skills: [] }))
      .toThrow(/duplicate tool name/)
  })
})
