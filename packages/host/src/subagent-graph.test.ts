import { mkdtempSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createConfig, createInitialState } from '@agent-kernel/kernel'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { parseEnhancementCli } from './enhancement-cli.js'
import { writeHeader } from './store/log.js'
import { exportSubAgentGraph } from './subagent-graph.js'

describe('subagent graph export', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ak-subagent-graph-'))
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('exports parent-child session graph from log headers', async () => {
    const cfg = createConfig({ tools: [], systemPrompt: 'sys' })
    await writeHeader({
      path: join(dir, '2026_parent.jsonl'),
      sessionId: 'parent',
      config: cfg,
      initialState: createInitialState({ sessionId: 'parent', systemPrompt: 'sys' }),
      workspaceId: 'ws1',
    })
    await writeHeader({
      path: join(dir, '2026_child.jsonl'),
      sessionId: 'child',
      config: cfg,
      initialState: createInitialState({ sessionId: 'child', systemPrompt: 'sys' }),
      parentSessionId: 'parent',
      parentCursor: 7,
      workspaceId: 'ws1',
    })

    const result = await exportSubAgentGraph({ rootDir: join(dir, 'out'), sessionsDir: dir })

    expect(result.graph.nodes.map((node) => node.sessionId)).toEqual(['child', 'parent'])
    expect(result.graph.edges).toEqual([{ parentSessionId: 'parent', childSessionId: 'child', parentCursor: 7 }])
    expect(await readFile(result.graphPath, 'utf8')).toContain('parentCursor')
  })

  it('parses subagent graph CLI commands', () => {
    expect(parseEnhancementCli([
      'enhancement',
      'subagents',
      'graph',
      '--root-dir',
      'runs/s',
      '--sessions-dir',
      '/sessions',
    ])).toMatchObject({ kind: 'subagents-graph', rootDir: 'runs/s', sessionsDir: '/sessions' })
  })
})
