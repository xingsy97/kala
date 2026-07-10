/**
 * `tool-catalog diff` command: reads two `tool-catalog/<session>/<seq>.json`
 * artifacts (or two directories of catalogs) and writes a structured diff of
 * tools added, removed, and changed between them, using the artifact
 * `schemaHash` field to detect schema drift. This is the router doc's
 * dashboard-comparison entry point as a CLI + artifact, without adding router
 * state to the reducer.
 *
 * Reads inputs only. Diffing is purely derived; the artifact is intended for
 * dashboards, CI drift checks, and eval-run comparisons.
 */

import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { ToolCatalogArtifact } from '@agent-kernel/shared/enhancement'

export type ToolCatalogDiffInput = {
  rootDir: string
  baselinePath: string
  candidatePath: string
  outputFilename?: string
}

export type ToolCatalogDiffToolSummary = {
  name: string
  requiresApproval: boolean
  kind: string
  skillBacked: boolean
  descriptionChars: number
  schemaHash: string
}

export type ToolCatalogDiffChange = {
  name: string
  baseline: ToolCatalogDiffToolSummary
  candidate: ToolCatalogDiffToolSummary
  changedFields: readonly (keyof ToolCatalogDiffToolSummary)[]
}

export type ToolCatalogDiffArtifact = {
  generatedAt: string
  baselinePath: string
  candidatePath: string
  baselineToolCount: number
  candidateToolCount: number
  added: readonly ToolCatalogDiffToolSummary[]
  removed: readonly ToolCatalogDiffToolSummary[]
  changed: readonly ToolCatalogDiffChange[]
  unchanged: readonly ToolCatalogDiffToolSummary[]
}

export async function diffToolCatalogs(
  input: ToolCatalogDiffInput,
): Promise<{ diff: ToolCatalogDiffArtifact; diffPath: string }> {
  const baseline = await loadCatalog(input.baselinePath)
  const candidate = await loadCatalog(input.candidatePath)
  const diff = buildToolCatalogDiff({
    baseline,
    candidate,
    baselinePath: input.baselinePath,
    candidatePath: input.candidatePath,
  })
  await mkdir(input.rootDir, { recursive: true })
  const diffPath = join(input.rootDir, input.outputFilename ?? 'tool-catalog-diff.json')
  await writeFile(diffPath, `${JSON.stringify(diff, null, 2)}\n`, 'utf8')
  return { diff, diffPath }
}

export function buildToolCatalogDiff(input: {
  baseline: ToolCatalogArtifact
  candidate: ToolCatalogArtifact
  baselinePath: string
  candidatePath: string
}): ToolCatalogDiffArtifact {
  const baselineByName = new Map(input.baseline.tools.map((tool) => [tool.name, tool] as const))
  const candidateByName = new Map(input.candidate.tools.map((tool) => [tool.name, tool] as const))
  const added: ToolCatalogDiffToolSummary[] = []
  const removed: ToolCatalogDiffToolSummary[] = []
  const changed: ToolCatalogDiffChange[] = []
  const unchanged: ToolCatalogDiffToolSummary[] = []
  for (const [name, candidateTool] of candidateByName) {
    const baselineTool = baselineByName.get(name)
    if (!baselineTool) {
      added.push(candidateTool)
      continue
    }
    const changedFields = diffFields(baselineTool, candidateTool)
    if (changedFields.length === 0) {
      unchanged.push(candidateTool)
    } else {
      changed.push({ name, baseline: baselineTool, candidate: candidateTool, changedFields })
    }
  }
  for (const [name, baselineTool] of baselineByName) {
    if (!candidateByName.has(name)) removed.push(baselineTool)
  }
  return {
    generatedAt: new Date().toISOString(),
    baselinePath: input.baselinePath,
    candidatePath: input.candidatePath,
    baselineToolCount: input.baseline.toolCount,
    candidateToolCount: input.candidate.toolCount,
    added: added.sort(byName),
    removed: removed.sort(byName),
    changed: changed.sort((a, b) => a.name.localeCompare(b.name)),
    unchanged: unchanged.sort(byName),
  }
}

async function loadCatalog(path: string): Promise<ToolCatalogArtifact> {
  const info = await stat(path)
  if (info.isDirectory()) {
    const files = await readdir(path)
    const catalogs = files.filter((name) => name.endsWith('.json')).sort()
    const latest = catalogs[catalogs.length - 1]
    if (!latest) throw new Error(`no tool-catalog artifacts under ${path}`)
    return JSON.parse(await readFile(join(path, latest), 'utf8')) as ToolCatalogArtifact
  }
  return JSON.parse(await readFile(path, 'utf8')) as ToolCatalogArtifact
}

const COMPARED_FIELDS: readonly (keyof ToolCatalogDiffToolSummary)[] = [
  'requiresApproval',
  'kind',
  'skillBacked',
  'descriptionChars',
  'schemaHash',
]

function diffFields(baseline: ToolCatalogDiffToolSummary, candidate: ToolCatalogDiffToolSummary): readonly (keyof ToolCatalogDiffToolSummary)[] {
  const changed: (keyof ToolCatalogDiffToolSummary)[] = []
  for (const field of COMPARED_FIELDS) {
    if (baseline[field] !== candidate[field]) changed.push(field)
  }
  return changed
}

function byName(a: { name: string }, b: { name: string }): number {
  return a.name.localeCompare(b.name)
}
