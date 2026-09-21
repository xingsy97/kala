import { mkdtempSync, rmSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { inProcessRlToolDispatcher, RL_WHITELIST } from './executor-dispatcher.js'

function effect(name: string, input: Record<string, unknown>, cwd?: string) {
  return { kind: 'call_tool' as const, callId: `c-${name}-${Math.random()}`, name, input, ...(cwd ? { cwd } : {}) }
}

describe('inProcessRlToolDispatcher', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ak-rldisp-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('exposes only the RL whitelist', () => {
    expect(RL_WHITELIST).toEqual(new Set([
      'read_file',
      'read_files',
      'write_file',
      'replace_in_file',
      'replace_many_in_file',
      'apply_file_patch',
      'bash',
      'ls',
      'grep',
      'glob',
    ]))
  })

  it('runs read/write against the sandboxed workspace', async () => {
    const disp = inProcessRlToolDispatcher(dir)
    const write = await disp.callTool('s1', effect('write_file', { path: join(dir, 'hello.txt'), content: 'hi' }))
    expect(write.ok).toBe(true)
    const read = await disp.callTool('s1', effect('read_file', { path: join(dir, 'hello.txt') }))
    expect(read.ok).toBe(true)
    expect(read.content).toContain('hi')
  })

  it('rejects disallowed tools', async () => {
    const disp = inProcessRlToolDispatcher(dir)
    const r = await disp.callTool('s1', effect('memory', { operation: 'read' }))
    expect(r.ok).toBe(false)
    expect(r.content).toMatch(/tool not enabled for rl/)
  })

  it('rejects paths outside the workspace root', async () => {
    await writeFile(join(dir, 'inside.txt'), 'x')
    const disp = inProcessRlToolDispatcher(dir)
    const outside = await disp.callTool('s1', effect('read_file', { path: '/etc/hostname' }))
    expect(outside.ok).toBe(false)
  })
})
