import { mkdtempSync, rmSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { ToolCatalogArtifact } from '@agent-kernel/shared/enhancement'

import { parseEnhancementCli } from './ops-cli.js'
import { buildToolCatalogDiff, diffToolCatalogs } from './tool-catalog-diff.js'

function tool(overrides: Partial<ToolCatalogArtifact['tools'][number]> & { name: string }): ToolCatalogArtifact['tools'][number] {
  return {
    name: overrides.name,
    requiresApproval: overrides.requiresApproval ?? false,
    kind: overrides.kind ?? 'executor',
    skillBacked: overrides.skillBacked ?? false,
    descriptionChars: overrides.descriptionChars ?? 32,
    schemaHash: overrides.schemaHash ?? 'hash-a',
  }
}

function catalog(tools: ToolCatalogArtifact['tools']): ToolCatalogArtifact {
  return { toolCount: tools.length, tools }
}

describe('tool catalog diff', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ak-tool-catalog-diff-'))
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('reports added, removed, changed, and unchanged tools', () => {
    const baseline = catalog([
      tool({ name: 'read', schemaHash: 'r1' }),
      tool({ name: 'write', schemaHash: 'w1', requiresApproval: false }),
      tool({ name: 'bash', schemaHash: 'b1' }),
    ])
    const candidate = catalog([
      tool({ name: 'read', schemaHash: 'r1' }),
      tool({ name: 'write', schemaHash: 'w2', requiresApproval: true }),
      tool({ name: 'grep', schemaHash: 'g1' }),
    ])

    const diff = buildToolCatalogDiff({
      baseline,
      candidate,
      baselinePath: 'baseline.json',
      candidatePath: 'candidate.json',
    })

    expect(diff.added.map((t) => t.name)).toEqual(['grep'])
    expect(diff.removed.map((t) => t.name)).toEqual(['bash'])
    expect(diff.changed).toHaveLength(1)
    expect(diff.changed[0]?.name).toBe('write')
    expect(diff.changed[0]?.changedFields.sort()).toEqual(['requiresApproval', 'schemaHash'])
    expect(diff.unchanged.map((t) => t.name)).toEqual(['read'])
    expect(diff.baselineToolCount).toBe(3)
    expect(diff.candidateToolCount).toBe(3)
  })

  it('writes a diff artifact from two catalog files', async () => {
    const baselinePath = join(dir, 'baseline.json')
    const candidatePath = join(dir, 'candidate.json')
    await writeFile(baselinePath, JSON.stringify(catalog([tool({ name: 'read' })])), 'utf8')
    await writeFile(candidatePath, JSON.stringify(catalog([tool({ name: 'read' }), tool({ name: 'grep' })])), 'utf8')

    const result = await diffToolCatalogs({ rootDir: dir, baselinePath, candidatePath })
    expect(result.diff.added.map((t) => t.name)).toEqual(['grep'])
    const persisted = JSON.parse(await readFile(result.diffPath, 'utf8'))
    expect(persisted.added).toHaveLength(1)
  })

  it('uses the latest catalog in a directory when given a directory path', async () => {
    const baselineDir = join(dir, 'baseline')
    const candidateDir = join(dir, 'candidate')
    await writeFile(join(dir, 'baseline.marker.json'), '{}', 'utf8')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(baselineDir, { recursive: true })
    await mkdir(candidateDir, { recursive: true })
    await writeFile(join(baselineDir, '01.json'), JSON.stringify(catalog([tool({ name: 'read' })])), 'utf8')
    await writeFile(join(baselineDir, '02.json'), JSON.stringify(catalog([tool({ name: 'read' }), tool({ name: 'write' })])), 'utf8')
    await writeFile(join(candidateDir, '03.json'), JSON.stringify(catalog([tool({ name: 'read' }), tool({ name: 'write' }), tool({ name: 'bash' })])), 'utf8')

    const result = await diffToolCatalogs({ rootDir: dir, baselinePath: baselineDir, candidatePath: candidateDir })
    expect(result.diff.added.map((t) => t.name)).toEqual(['bash'])
    expect(result.diff.baselineToolCount).toBe(2)
    expect(result.diff.candidateToolCount).toBe(3)
  })

  it('parses the CLI verb into a tool-catalog-diff command', () => {
    expect(
      parseEnhancementCli([
        'enhancement',
        'tool-catalog',
        'diff',
        '--baseline',
        'runs/a/tool-catalog/session-A/1.json',
        '--candidate',
        'runs/b/tool-catalog/session-A/1.json',
        '--root-dir',
        'runs/router/tool-catalog-diff',
        '--output',
        'diff.json',
      ]),
    ).toMatchObject({
      kind: 'tool-catalog-diff',
      baselinePath: 'runs/a/tool-catalog/session-A/1.json',
      candidatePath: 'runs/b/tool-catalog/session-A/1.json',
      rootDir: 'runs/router/tool-catalog-diff',
      outputFilename: 'diff.json',
    })
  })
})
