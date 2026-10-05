import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import type { AgentConfig } from '@agent-kernel/kernel'
import { schema, type ExecutorAnnounce, type McpToolDescriptor } from '@agent-kernel/shared'

import {
  mcpToolsForWorkspace,
  mergeMcpTools,
  validateMcpToolDescriptors,
} from './mcp-tools.js'

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function descriptor(name = 'docs__search', inputSchema: Record<string, unknown> = {
  type: 'object',
  properties: { query: { type: 'string' } },
}): McpToolDescriptor {
  return {
    name,
    description: 'Search documentation',
    inputSchema,
    schemaHash: createHash('sha256').update(canonicalJson(inputSchema)).digest('hex'),
  }
}

function announce(workspaceId: string, tools: McpToolDescriptor[] | undefined): ExecutorAnnounce {
  return {
    executorId: `executor-${workspaceId}`,
    workspaceId,
    workspaceName: workspaceId,
    tools: ['bash', ...(tools ?? []).map((tool) => tool.name)],
    ...(tools ? { mcpTools: tools } : {}),
    runtime: 'node',
    runtimeVersion: 'test',
  }
}

describe('MCP tool descriptors', () => {
  it('accepts a valid descriptor and maps it to an approval-required executor tool', () => {
    const tool = descriptor()
    expect(validateMcpToolDescriptors(announce('workspace-a', [tool]), new Set(['bash']))).toEqual([tool])

    const config = mergeMcpTools({ tools: [] } satisfies AgentConfig, [tool])
    expect(config.tools).toEqual([{
      name: 'docs__search',
      description: 'Search documentation',
      inputSchema: tool.inputSchema,
      schemaHash: tool.schemaHash,
      version: tool.schemaHash,
      requiresApproval: true,
      executionKind: 'executor',
      executionHandler: 'docs__search',
    }])
  })

  it('rejects invalid hashes, non-object schemas, duplicates, missing executable names, and Host collisions', () => {
    const valid = descriptor()
    expect(() => validateMcpToolDescriptors(
      announce('workspace-a', [{ ...valid, schemaHash: '0'.repeat(64) }]),
      new Set(),
    )).toThrow('hash mismatch')
    expect(() => validateMcpToolDescriptors(
      announce('workspace-a', [descriptor('docs__bad', { type: 'string' })]),
      new Set(),
    )).toThrow('type must be object')
    expect(() => validateMcpToolDescriptors(
      announce('workspace-a', [valid, valid]),
      new Set(),
    )).toThrow('duplicate')
    expect(() => validateMcpToolDescriptors(
      { tools: ['bash'], mcpTools: [valid] },
      new Set(),
    )).toThrow('missing from Executor tool catalog')
    expect(() => validateMcpToolDescriptors(
      announce('workspace-a', [descriptor('host__tool')]),
      new Set(['host__tool']),
    )).toThrow('conflicts with Host tool')
  })

  it('strictly validates descriptor names, JSON values, hashes, fields, and count while accepting legacy announcements', () => {
    const base = announce('workspace-a', undefined)
    expect(schema.ExecutorAnnounceSchema.safeParse(base).success).toBe(true)
    expect(schema.ExecutorAnnounceSchema.safeParse({
      ...base,
      mcpTools: [{ ...descriptor('invalid.name') }],
    }).success).toBe(false)
    expect(schema.ExecutorAnnounceSchema.safeParse({
      ...base,
      mcpTools: [{ ...descriptor('unprefixed') }],
    }).success).toBe(false)
    expect(schema.ExecutorAnnounceSchema.safeParse({
      ...base,
      mcpTools: [{ ...descriptor('docs__') }],
    }).success).toBe(false)
    expect(schema.ExecutorAnnounceSchema.safeParse({
      ...base,
      mcpTools: [descriptor('docs__123')],
    }).success).toBe(true)
    expect(schema.ExecutorAnnounceSchema.safeParse({
      ...base,
      mcpTools: [{ ...descriptor(), schemaHash: 'ABC' }],
    }).success).toBe(false)
    expect(schema.ExecutorAnnounceSchema.safeParse({
      ...base,
      mcpTools: [{ ...descriptor(), extraApprovalExemption: true }],
    }).success).toBe(false)
    expect(schema.ExecutorAnnounceSchema.safeParse({
      ...base,
      mcpTools: [{ ...descriptor(), inputSchema: { type: 'object', bad: undefined } }],
    }).success).toBe(false)
    expect(schema.ExecutorAnnounceSchema.safeParse({
      ...base,
      mcpTools: Array.from({ length: 513 }, (_, index) => descriptor(`s__t${index}`)),
    }).success).toBe(false)
  })

  it('selects descriptors only from the requested live workspace', () => {
    const first = descriptor('first__search')
    const second = descriptor('second__search')
    const executors = [announce('workspace-a', [first]), announce('workspace-b', [second])]

    expect(mcpToolsForWorkspace(executors, 'workspace-a')).toEqual([first])
    expect(mcpToolsForWorkspace(executors, 'workspace-b')).toEqual([second])
    expect(mcpToolsForWorkspace(executors, 'workspace-missing')).toBeUndefined()
    expect(mcpToolsForWorkspace(executors, undefined)).toBeUndefined()
  })
})
