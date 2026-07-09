// Per-bad-case annotations. Stored as an append-only JSONL inside the run
// directory so we do not introduce a new registry. Each line represents the
// LATEST annotation for a given (runId, instanceId); readers replay the file
// and keep the last write per instanceId (see readBadCaseAnnotations).

import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { sweBenchRunLayout } from '../swebench/swebench.js'
import { terminalBenchRunLayout } from '../terminal-bench/terminal-bench.js'

export type BadCaseLabel =
  | 'not-a-bug'
  | 'needs-more-context'
  | 'model-limitation'
  | 'infra-flake'
  | 'worth-retraining'

export type BadCaseAnnotation = {
  runId: string
  instanceId: string
  label: BadCaseLabel
  note?: string
  updatedAt: string
}

export const BAD_CASE_LABELS: readonly BadCaseLabel[] = [
  'not-a-bug',
  'needs-more-context',
  'model-limitation',
  'infra-flake',
  'worth-retraining',
]

export type AnnotateBadCaseInput = {
  rootDir: string
  runId: string
  instanceId: string
  label: BadCaseLabel
  note?: string
  now?: () => Date
}

function annotationsPath(rootDir: string, runId: string): string {
  // Prefer the SWE-bench layout root; both layouts co-locate the run dir at
  // the same rootDir/runId path.
  const swe = sweBenchRunLayout(rootDir, runId)
  const tb = terminalBenchRunLayout(rootDir, runId)
  return existsSync(tb.rootDir) && !existsSync(swe.trialsDir)
    ? join(tb.rootDir, 'badcase-annotations.jsonl')
    : join(swe.rootDir, 'badcase-annotations.jsonl')
}

export async function annotateBadCase(input: AnnotateBadCaseInput): Promise<BadCaseAnnotation> {
  if (!BAD_CASE_LABELS.includes(input.label)) {
    throw new Error(`unknown bad-case label: ${input.label}`)
  }
  const now = (input.now ?? (() => new Date()))()
  const annotation: BadCaseAnnotation = {
    runId: input.runId,
    instanceId: input.instanceId,
    label: input.label,
    ...(input.note ? { note: input.note } : {}),
    updatedAt: now.toISOString(),
  }
  const path = annotationsPath(input.rootDir, input.runId)
  await mkdir(join(input.rootDir, input.runId), { recursive: true })
  const existing = existsSync(path) ? await readFile(path, 'utf8') : ''
  const next = (existing.endsWith('\n') || existing.length === 0 ? existing : existing + '\n') + JSON.stringify(annotation) + '\n'
  await writeFile(path, next, 'utf8')
  return annotation
}

export async function readBadCaseAnnotations(rootDir: string, runId: string): Promise<Map<string, BadCaseAnnotation>> {
  const path = annotationsPath(rootDir, runId)
  const map = new Map<string, BadCaseAnnotation>()
  if (!existsSync(path)) return map
  const raw = await readFile(path, 'utf8')
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue
    try {
      const row = JSON.parse(line) as BadCaseAnnotation
      map.set(row.instanceId, row)
    } catch {
      // ignore malformed rows
    }
  }
  return map
}
