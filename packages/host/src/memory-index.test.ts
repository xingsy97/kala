import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { parseEnhancementCli } from './ops-cli.js'
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
      status: 'active',
      description: 'User prefers concise answers',
      confidence: 0.9,
      sessionId: 's1',
    })
    expect(await readFile(result.indexPath, 'utf8')).toContain('user-style')
  })

  it('indexes tombstoned memory entries for auditability', async () => {
    const memoryDir = join(dir, '.agent-kernel', 'memory')
    const tombstoneDir = join(memoryDir, '.tombstones')
    mkdirSync(tombstoneDir, { recursive: true })
    writeFileSync(join(tombstoneDir, 'old-rule.2026-07-09T00-00-00-000Z.md'), 'prefer yarn', 'utf8')
    writeFileSync(join(tombstoneDir, 'old-rule.2026-07-09T00-00-00-000Z.md.json'), JSON.stringify({
      schemaVersion: 1,
      scope: 'workspace',
      key: 'old-rule',
      deletedAt: '2026-07-09T00:00:00.000Z',
      originalPath: join(memoryDir, 'old-rule.md'),
      archivedPath: join(tombstoneDir, 'old-rule.2026-07-09T00-00-00-000Z.md'),
    }), 'utf8')

    const result = await buildMemoryIndex({ rootDir: join(dir, 'out'), workspaceRoot: dir })

    expect(result.index.entries).toHaveLength(1)
    expect(result.index.entries[0]).toMatchObject({
      scope: 'workspace',
      key: 'old-rule',
      status: 'tombstoned',
      deletedAt: '2026-07-09T00:00:00.000Z',
    })
    expect(result.index.entries[0]?.archivedPath).toContain('old-rule.2026-07-09T00-00-00-000Z.md')
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

  it('parses memory retrieve CLI arguments', () => {
    expect(parseEnhancementCli([
      'enhancement',
      'memory',
      'retrieve',
      '--root-dir',
      'runs/m',
      '--workspace-root',
      '/repo',
      '--include-global',
      '--query',
      'react hooks conventions',
      '--max-tokens',
      '1024',
      '--max-hits',
      '4',
      '--output',
      'custom.json',
    ])).toMatchObject({
      kind: 'memory-retrieve',
      rootDir: 'runs/m',
      workspaceRoot: '/repo',
      includeGlobal: true,
      query: 'react hooks conventions',
      maxTokens: 1024,
      maxHits: 4,
      outputFilename: 'custom.json',
    })
  })

  it('flags stale memories older than the threshold', async () => {
    const memoryDir = join(dir, '.agent-kernel', 'memory')
    mkdirSync(memoryDir, { recursive: true })
    writeFileSync(join(memoryDir, 'fresh.md'), [
      '---',
      'name: fresh',
      'generatedAt: 2026-07-01T00:00:00.000Z',
      '---',
      'still relevant',
    ].join('\n'), 'utf8')
    writeFileSync(join(memoryDir, 'old.md'), [
      '---',
      'name: old',
      'generatedAt: 2025-01-01T00:00:00.000Z',
      '---',
      'ancient advice',
    ].join('\n'), 'utf8')

    const result = await buildMemoryIndex({
      rootDir: join(dir, 'out'),
      workspaceRoot: dir,
      staleAfterDays: 90,
      now: () => new Date('2026-07-09T00:00:00.000Z'),
    })

    expect(result.index.staleWarnings).toHaveLength(1)
    expect(result.index.staleWarnings[0]).toMatchObject({
      scope: 'workspace',
      key: 'old',
      reasonCode: 'stale_memory',
      generatedAt: '2025-01-01T00:00:00.000Z',
    })
    expect(result.index.staleWarnings[0]!.ageDays).toBeGreaterThan(500)
  })

  it('flags duplicate keys across workspace and global scopes as conflicts', async () => {
    const workspaceMemoryDir = join(dir, '.agent-kernel', 'memory')
    const globalMemoryDir = join(dir, 'home', '.agent-kernel', 'memory')
    mkdirSync(workspaceMemoryDir, { recursive: true })
    mkdirSync(globalMemoryDir, { recursive: true })
    writeFileSync(join(workspaceMemoryDir, 'style.md'), '---\nname: style\n---\nuse tabs', 'utf8')
    writeFileSync(join(globalMemoryDir, 'style.md'), '---\nname: style\n---\nuse spaces', 'utf8')

    const originalHome = process.env.HOME
    process.env.HOME = join(dir, 'home')
    try {
      const result = await buildMemoryIndex({
        rootDir: join(dir, 'out'),
        workspaceRoot: dir,
        includeGlobal: true,
      })
      const conflicts = result.index.conflictWarnings
      expect(conflicts.length).toBeGreaterThanOrEqual(1)
      const keyConflict = conflicts.find((c) => c.reasonCode === 'duplicate_key_across_scopes')
      expect(keyConflict?.key).toBe('style')
      expect(keyConflict?.entries.map((e) => e.scope).sort()).toEqual(['global', 'workspace'])
    } finally {
      if (originalHome === undefined) delete process.env.HOME
      else process.env.HOME = originalHome
    }
  })

  it('does not flag tombstoned entries as stale or conflicting', async () => {
    const memoryDir = join(dir, '.agent-kernel', 'memory')
    const tombstoneDir = join(memoryDir, '.tombstones')
    mkdirSync(tombstoneDir, { recursive: true })
    writeFileSync(join(tombstoneDir, 'style.2025-01-01T00-00-00-000Z.md'), 'obsolete', 'utf8')
    writeFileSync(join(tombstoneDir, 'style.2025-01-01T00-00-00-000Z.md.json'), JSON.stringify({
      schemaVersion: 1,
      scope: 'workspace',
      key: 'style',
      deletedAt: '2025-01-01T00:00:00.000Z',
      originalPath: join(memoryDir, 'style.md'),
      archivedPath: join(tombstoneDir, 'style.2025-01-01T00-00-00-000Z.md'),
    }), 'utf8')
    writeFileSync(join(memoryDir, 'style.md'), '---\nname: style\n---\ncurrent', 'utf8')

    const result = await buildMemoryIndex({
      rootDir: join(dir, 'out'),
      workspaceRoot: dir,
      now: () => new Date('2026-07-09T00:00:00.000Z'),
    })

    expect(result.index.staleWarnings).toHaveLength(0)
    expect(result.index.conflictWarnings).toHaveLength(0)
  })
})
