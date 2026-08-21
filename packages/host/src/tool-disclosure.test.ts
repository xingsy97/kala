import { describe, expect, it } from 'vitest'
import type { ToolSchema } from '@agent-kernel/kernel'
import { activateTools, searchToolCatalog, toolCatalogRevision, visibleTools } from './tool-disclosure.js'

const tools: ToolSchema[] = [
  { name: 'tool_search', description: 'discover', inputSchema: {}, requiresApproval: false },
  { name: 'read_file', description: 'read source', inputSchema: {}, requiresApproval: false },
  { name: 'write_file', description: 'write source files', inputSchema: {}, requiresApproval: true, version: '1.0.0', schemaHash: 'sha256:w' },
  { name: 'webfetch', description: 'fetch a web page over network', inputSchema: {}, requiresApproval: false },
]

describe('progressive Tool disclosure', () => {
  it('creates a stable catalog revision from identity fields', () => {
    expect(toolCatalogRevision(tools)).toBe(toolCatalogRevision(tools.map((tool) => ({ ...tool }))))
    expect(toolCatalogRevision(tools)).not.toBe(toolCatalogRevision(tools.map((tool) => tool.name === 'write_file' ? { ...tool, version: '2.0.0' } : tool)))
  })

  it('keeps core and discovery visible and adds activated Tools in catalog order', () => {
    expect(visibleTools(tools, 'progressive', new Set()).map((tool) => tool.name)).toEqual(['tool_search', 'read_file'])
    expect(visibleTools(tools, 'progressive', new Set(['webfetch'])).map((tool) => tool.name)).toEqual(['tool_search', 'read_file', 'webfetch'])
    expect(visibleTools(tools, 'legacy_full', new Set())).toBe(tools)
  })

  it('searches purpose and activates only locked names', () => {
    expect(searchToolCatalog(tools, 'network page')[0]?.name).toBe('webfetch')
    expect([...activateTools(tools, new Set(), ['write_file'])]).toEqual(['write_file'])
    expect(() => activateTools(tools, new Set(), ['unknown'])).toThrow(/locked catalog/)
  })
})
