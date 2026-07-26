import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'

export type LegacySweBenchImport = {
  schemaVersion: 1
  importedAt: string
  source: {
    kind: 'legacy-readonly'
    path: string
    name: string
    hashes: Record<string, string>
  }
  headline: unknown
  modelControlled: unknown
  failureTaxonomy: unknown
}

const SOURCE_FILES = [
  'run-summary.json',
  'model-controlled-run-summary.json',
  'failure-taxonomy.json',
  'pairwise-comparison.jsonl',
  'model-controlled-comparison.jsonl',
] as const

export async function importLegacySweBench(input: {
  sourceDir: string
  outputRoot: string
  importId?: string
  now?: () => Date
}): Promise<{ path: string; imported: LegacySweBenchImport }> {
  const sourceDir = resolve(input.sourceDir)
  const outputRoot = resolve(input.outputRoot)
  if (outputRoot === sourceDir || outputRoot.startsWith(`${sourceDir}/`)) {
    throw new Error('legacy import output must be outside the protected source directory')
  }
  const before = await hashes(sourceDir)
  const headline = JSON.parse(await readFile(join(sourceDir, 'run-summary.json'), 'utf8')) as unknown
  const modelControlled = JSON.parse(await readFile(join(sourceDir, 'model-controlled-run-summary.json'), 'utf8')) as unknown
  const failureTaxonomy = JSON.parse(await readFile(join(sourceDir, 'failure-taxonomy.json'), 'utf8')) as unknown
  const imported: LegacySweBenchImport = {
    schemaVersion: 1,
    importedAt: (input.now ?? (() => new Date()))().toISOString(),
    source: { kind: 'legacy-readonly', path: sourceDir, name: basename(sourceDir), hashes: before },
    headline,
    modelControlled,
    failureTaxonomy,
  }
  const id = input.importId ?? `legacy-${basename(sourceDir)}`
  const directory = join(outputRoot, 'legacy-imports', id)
  const path = join(directory, 'import.json')
  await mkdir(directory, { recursive: true })
  await writeFile(path, `${JSON.stringify(imported, null, 2)}\n`, 'utf8')
  const after = await hashes(sourceDir)
  if (JSON.stringify(after) !== JSON.stringify(before)) throw new Error('protected legacy source changed during import')
  return { path, imported }
}

async function hashes(directory: string): Promise<Record<string, string>> {
  const entries = await Promise.all(SOURCE_FILES.map(async (name) => {
    const content = await readFile(join(directory, name))
    return [name, createHash('sha256').update(content).digest('hex')] as const
  }))
  return Object.fromEntries(entries)
}

