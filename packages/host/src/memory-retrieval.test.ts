import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { retrieveMemory } from './memory-retrieval.js'

describe('retrieveMemory', () => {
  let root: string
  let workspace: string
  let memoryDir: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ak-mem-'))
    workspace = mkdtempSync(join(tmpdir(), 'ak-mem-ws-'))
    memoryDir = join(workspace, '.agent-kernel', 'memory')
    mkdirSync(memoryDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(workspace, { recursive: true, force: true })
  })

  function writeNote(name: string, frontmatter: Record<string, string | number>, body: string): void {
    const yaml = Object.entries(frontmatter)
      .map(([key, value]) => `${key}: ${value}`)
      .join('\n')
    const content = `---\n${yaml}\n---\n\n${body}\n`
    writeFileSync(join(memoryDir, `${name}.md`), content, 'utf8')
  }

  it('scores notes by lexical overlap and returns highest scoring hit', async () => {
    writeNote('project-style', { name: 'project-style', description: 'formatting rules', type: 'project' },
      'We follow strict TypeScript ESM imports with .js suffix in this project.')
    writeNote('unrelated', { name: 'unrelated', description: 'weather notes', type: 'user' },
      'The forecast predicts thunderstorms on the weekend.')

    const { artifact } = await retrieveMemory({
      rootDir: root,
      workspaceRoot: workspace,
      query: 'typescript imports',
      now: () => new Date('2026-07-09T00:00:00Z'),
    })

    expect(artifact.hitCount).toBe(1)
    expect(artifact.hits[0]!.key).toBe('project-style')
    expect(artifact.hits[0]!.matchedTerms).toContain('typescript')
    expect(artifact.reasonCodes).toContain('hits_selected')
  })

  it('respects the max token budget and reports dropped_for_budget', async () => {
    const bigBody = `keyword ${'x'.repeat(2000)}`
    writeNote('note-a', { name: 'note-a', description: 'keyword hit A' }, bigBody)
    writeNote('note-b', { name: 'note-b', description: 'keyword hit B' }, bigBody)
    writeNote('note-c', { name: 'note-c', description: 'keyword hit C' }, bigBody)

    const { artifact } = await retrieveMemory({
      rootDir: root,
      workspaceRoot: workspace,
      query: 'keyword',
      maxTokens: 600,
      now: () => new Date('2026-07-09T00:00:00Z'),
    })

    expect(artifact.hitCount).toBeGreaterThanOrEqual(1)
    expect(artifact.hitCount).toBeLessThan(3)
    expect(artifact.budget.droppedForBudget).toBeGreaterThan(0)
    expect(artifact.reasonCodes).toContain('budget_dropped_hits')
  })

  it('emits empty_query and no_lexical_matches reason codes', async () => {
    writeNote('a', { name: 'a' }, 'nothing related here')
    const emptyQuery = await retrieveMemory({
      rootDir: root,
      workspaceRoot: workspace,
      query: '   ',
    })
    expect(emptyQuery.artifact.reasonCodes).toContain('empty_query')

    const noMatch = await retrieveMemory({
      rootDir: root,
      workspaceRoot: workspace,
      query: 'zzzzz-unfindable-word',
    })
    expect(noMatch.artifact.reasonCodes).toContain('no_lexical_matches')
    expect(noMatch.artifact.hitCount).toBe(0)
  })

  it('excludes tombstoned notes via buildMemoryIndex', async () => {
    writeNote('active-note', { name: 'active-note' }, 'about typescript imports')
    const tombstoneDir = join(memoryDir, '.tombstones')
    mkdirSync(tombstoneDir, { recursive: true })
    writeFileSync(
      join(tombstoneDir, 'stale-note.json'),
      JSON.stringify({ key: 'stale-note', deletedAt: '2026-07-01T00:00:00Z', archivedPath: 'somewhere' }),
      'utf8',
    )

    const { artifact } = await retrieveMemory({
      rootDir: root,
      workspaceRoot: workspace,
      query: 'typescript',
    })

    expect(artifact.hits.map((hit) => hit.key)).toEqual(['active-note'])
  })

  it('writes an artifact JSON file with hits and budget metadata', async () => {
    writeNote('project-style', { name: 'project-style' }, 'react hooks conventions')

    const { artifactPath } = await retrieveMemory({
      rootDir: root,
      workspaceRoot: workspace,
      query: 'react hooks',
    })

    const contents = JSON.parse(await readFile(artifactPath, 'utf8'))
    expect(contents.schemaVersion).toBe(1)
    expect(contents.hitCount).toBe(1)
    expect(contents.budget.maxTokens).toBeGreaterThan(0)
    expect(contents.hits[0].key).toBe('project-style')
  })

  it('boosts entries with higher confidence', async () => {
    writeNote('low', { name: 'low', confidence: 0.1 }, 'typescript esm imports guidance')
    writeNote('high', { name: 'high', confidence: 0.9 }, 'typescript esm imports guidance')

    const { artifact } = await retrieveMemory({
      rootDir: root,
      workspaceRoot: workspace,
      query: 'typescript',
    })

    expect(artifact.hits[0]!.key).toBe('high')
    expect(artifact.hits[1]!.key).toBe('low')
  })

  it('ignores stopwords in the query', async () => {
    writeNote('note', { name: 'note' }, 'this is about migrations')

    const { artifact } = await retrieveMemory({
      rootDir: root,
      workspaceRoot: workspace,
      query: 'is a the',
    })

    expect(artifact.reasonCodes).toContain('empty_query')
    expect(artifact.hitCount).toBe(0)
  })
})
