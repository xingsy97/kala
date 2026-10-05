import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { parseExecutorCliArgs } from './cli-args.js'
import { readExecutorRuntimeConfig } from './executor-config.js'
import { parseDashboardMcpServers, parseMcpServerDeclaration, parseMcpServers } from './mcp-config.js'
import { readDashboardMcpServers } from './mcp-managed-config.js'

describe('MCP server configuration', () => {
  it('parses repeated structured CLI declarations through the shared validator', () => {
    const one = '{"name":"one","command":"node","args":["a"],"env":{"TOKEN":"secret"}}'
    const two = '{"name":"two","command":"python","args":[]}'
    expect(parseExecutorCliArgs(['--mcp', one, `--mcp=${two}`]).mcpServers).toEqual([
      { name: 'one', command: 'node', args: ['a'], env: { TOKEN: 'secret' } },
      { name: 'two', command: 'python', args: [] },
    ])
  })

  it('parses MCP_SERVERS arrays and rejects duplicates, unknown fields, and invalid names', () => {
    expect(parseMcpServers('[{"name":"git","command":"npx","args":["server"]}]')).toHaveLength(1)
    expect(() => parseMcpServers('[{"name":"same","command":"a","args":[]},{"name":"same","command":"b","args":[]}]')).toThrow('duplicate server name')
    expect(() => parseMcpServerDeclaration('{"name":"bad name","command":"server","args":[]}')).toThrow('name must match')
    expect(() => parseMcpServerDeclaration('{"name":"ok","command":"node","args":[],"shell":true}')).toThrow('unknown field')
  })

  it('rejects Dashboard env values and unknown fields while retaining shared bounds', () => {
    expect(parseDashboardMcpServers([{ name: 'safe', command: 'node', args: ['server.js'] }])).toEqual([
      { name: 'safe', command: 'node', args: ['server.js'] },
    ])
    expect(() => parseDashboardMcpServers([{ name: 'secret', command: 'node', args: [], env: { TOKEN: 'value' } }])).toThrow('unknown field: env')
    expect(() => parseDashboardMcpServers([{ name: 'extra', command: 'node', args: [], shell: true }])).toThrow('unknown field: shell')
    expect(() => parseDashboardMcpServers(Array.from({ length: 17 }, (_, index) => ({ name: `s${index}`, command: 'node', args: [] })))).toThrow('at most 16')
  })

  it('refuses Dashboard reads through symlinks and from configs containing env', () => {
    const root = mkdtempSync(join(tmpdir(), 'kala-mcp-safe-config-'))
    try {
      const target = join(root, 'target.json')
      writeFileSync(target, JSON.stringify({ mcpServers: [{ name: 'secret', command: 'node', args: [], env: { TOKEN: 'value' } }] }), { mode: 0o600 })
      expect(() => readDashboardMcpServers(target)).toThrow('unknown field: env')
      if (process.platform !== 'win32') {
        const link = join(root, 'link.json')
        symlinkSync(target, link)
        expect(() => readDashboardMcpServers(link)).toThrow('regular file')
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('supports MCP declarations in managed Executor config', () => {
    const root = mkdtempSync(join(tmpdir(), 'kala-mcp-config-'))
    try {
      const path = join(root, 'config.json')
      writeFileSync(path, JSON.stringify({
        version: 1, host: 'https://host', sandboxRoots: ['/workspace'], credentialFile: '/credential',
        privilegeMode: 'restricted', mcpServers: [{ name: 'managed', command: 'node', args: ['server.js'] }],
      }))
      chmodSync(path, 0o600)
      expect(readExecutorRuntimeConfig(path).mcpServers).toEqual([{ name: 'managed', command: 'node', args: ['server.js'] }])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
