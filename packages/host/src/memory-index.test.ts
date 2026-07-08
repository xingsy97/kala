import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { parseEnhancementCli } from './enhancement-cli.js'
import { buildMemoryIndex } from './memory-index.js'

describe('memory index export', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ak-memory-index-'))
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('indexes workspace memory metadata without reading it into kernel state', async () => {
    const memoryDir = join(dir, '.agent-kernel', 'memory')
    mkdirSync(memoryDir, { recursive: true })
    writeFileSync(join(memoryDir, 'user-style.md'), [
      '---',
      'name: user-style',
      'description: User prefers concise answers',
      'type: user',
      'source: consolidator',
      'confidence: 0.9',
      'sessionId: s1',
      '---',
      'Keep answers short.',
    ].join('\n'), 'utf8')

    const result = await buildMemoryIndex({ rootDir: join(dir, 'out'), workspaceRoot: dir })

    expect(result.index.entries).toHaveLength(1)
    expect(result.index.entries[0]).toMatchObject({
      scope: 'workspace',
      key: 'user-style',
      description: 'User prefers concise answers',
      confidence: 0.9,
      sessionId: 's1',
    })
    expect(await readFile(result.indexPath, 'utf8')).toContain('user-style')
  })

  it('parses memory index CLI commands', () => {
    expect(parseEnhancementCli([
      'enhancement',
      'memory',
      'index',
      '--root-dir',
      'runs/m',
      '--workspace-root',
      '/repo',
      '--include-global',
    ])).toMatchObject({ kind: 'memory-index', rootDir: 'runs/m', workspaceRoot: '/repo', includeGlobal: true })
  })
})
