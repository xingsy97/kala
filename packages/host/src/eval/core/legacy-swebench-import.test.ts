import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { importLegacySweBench } from './legacy-swebench-import.js'

describe('legacy SWE-bench import', () => {
  it('writes a new read-only reference without changing source files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'legacy-swebench-'))
    const source = join(root, 'source')
    const output = join(root, 'output')
    await mkdir(source)
    const files: Record<string, string> = {
      'run-summary.json': JSON.stringify({ agent_runlab: { resolved: 23 } }),
      'model-controlled-run-summary.json': JSON.stringify({ comparisons: { sonnet: {} } }),
      'failure-taxonomy.json': JSON.stringify({ cases: { a: {} } }),
      'pairwise-comparison.jsonl': '{"instance_id":"a"}\n',
      'model-controlled-comparison.jsonl': '{"instance_id":"a","model":"sonnet"}\n',
    }
    await Promise.all(Object.entries(files).map(([name, content]) => writeFile(join(source, name), content)))
    const result = await importLegacySweBench({ sourceDir: source, outputRoot: output, now: () => new Date('2026-07-26T00:00:00Z') })
    expect(result.imported).toMatchObject({ source: { kind: 'legacy-readonly' }, headline: { agent_runlab: { resolved: 23 } } })
    await Promise.all(Object.entries(files).map(async ([name, content]) => expect(await readFile(join(source, name), 'utf8')).toBe(content)))
    expect(JSON.parse(await readFile(result.path, 'utf8'))).toMatchObject({ schemaVersion: 1 })
  })

  it('refuses to write inside the protected source', async () => {
    const root = await mkdtemp(join(tmpdir(), 'legacy-swebench-'))
    await expect(importLegacySweBench({ sourceDir: root, outputRoot: join(root, 'index') })).rejects.toThrow('outside')
  })
})

