/**
 * Host-side lexical memory retrieval prototype.
 *
 * Reads workspace/global `.agent-kernel/memory/*.md` notes, scores each note
 * against a query using token overlap plus small recency/confidence weights,
 * and fits the top matches into an explicit token budget. Emits a JSON
 * artifact so dashboards and eval runners can see which memories the host
 * *would* include, without changing kernel state or injecting hidden memory.
 *
 * This is deliberately non-embedding: no external service dependency, no
 * kernel or reducer state, no protocol change. It builds directly on
 * `buildMemoryIndex` so `.tombstoned` notes are automatically excluded and
 * frontmatter provenance stays intact.
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { estimateStringTokens } from '@agent-kernel/shared/token-estimation'

import { buildMemoryIndex, type MemoryIndexEntry } from './memory-index.js'

export type MemoryRetrievalHit = {
  scope: MemoryIndexEntry['scope']
  key: string
  path: string
  score: number
  matchedTerms: readonly string[]
  estimatedTokens: number
  bodyChars: number
}

export type MemoryRetrievalBudget = {
  maxTokens: number
  usedTokens: number
  droppedForBudget: number
}

export type MemoryRetrievalArtifact = {
  schemaVersion: 1
  generatedAt: string
  query: string
  workspaceRoot?: string
  includeGlobal: boolean
  hitCount: number
  budget: MemoryRetrievalBudget
  hits: readonly MemoryRetrievalHit[]
  reasonCodes: readonly string[]
  warnings: readonly string[]
}

export type MemoryRetrievalInput = {
  rootDir: string
  workspaceRoot?: string
  includeGlobal?: boolean
  query: string
  maxTokens?: number
  maxHits?: number
  outputFilename?: string
  now?: () => Date
}

const DEFAULT_MAX_TOKENS = 2048
const DEFAULT_MAX_HITS = 8
const RECENCY_HALF_LIFE_DAYS = 30

export async function retrieveMemory(
  input: MemoryRetrievalInput,
): Promise<{ artifact: MemoryRetrievalArtifact; artifactPath: string }> {
  const queryTerms = tokenize(input.query)
  const maxTokens = input.maxTokens ?? DEFAULT_MAX_TOKENS
  const maxHits = input.maxHits ?? DEFAULT_MAX_HITS
  const nowDate = (input.now ?? (() => new Date()))()

  const { index } = await buildMemoryIndex({
    rootDir: input.rootDir,
    ...(input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : {}),
    includeGlobal: input.includeGlobal ?? false,
  })
  const activeEntries = index.entries.filter((entry) => entry.status === 'active')

  const scored: MemoryRetrievalHit[] = []
  for (const entry of activeEntries) {
    const body = await readEntryBody(entry)
    if (body === undefined) continue
    const matched = scoreEntry(queryTerms, entry, body, nowDate)
    if (matched.score <= 0) continue
    scored.push({
      scope: entry.scope,
      key: entry.key,
      path: entry.path,
      score: matched.score,
      matchedTerms: matched.terms,
      bodyChars: body.length,
      estimatedTokens: estimateStringTokens(body),
    })
  }
  scored.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key))
  const selected: MemoryRetrievalHit[] = []
  let usedTokens = 0
  let droppedForBudget = 0
  for (const hit of scored) {
    if (selected.length >= maxHits) break
    if (usedTokens + hit.estimatedTokens > maxTokens && selected.length > 0) {
      droppedForBudget += 1
      continue
    }
    selected.push(hit)
    usedTokens += hit.estimatedTokens
  }
  const reasonCodes: string[] = []
  if (queryTerms.length === 0) reasonCodes.push('empty_query')
  if (activeEntries.length === 0) reasonCodes.push('no_active_memories')
  if (scored.length === 0 && activeEntries.length > 0) reasonCodes.push('no_lexical_matches')
  if (droppedForBudget > 0) reasonCodes.push('budget_dropped_hits')
  if (selected.length > 0) reasonCodes.push('hits_selected')

  const artifact: MemoryRetrievalArtifact = {
    schemaVersion: 1,
    generatedAt: nowDate.toISOString(),
    query: input.query,
    ...(input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : {}),
    includeGlobal: input.includeGlobal ?? false,
    hitCount: selected.length,
    budget: { maxTokens, usedTokens, droppedForBudget },
    hits: selected,
    reasonCodes,
    warnings: index.warnings,
  }
  await mkdir(input.rootDir, { recursive: true })
  const outputFilename = input.outputFilename ?? 'memory-retrieval.json'
  const artifactPath = join(input.rootDir, outputFilename)
  await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8')
  return { artifact, artifactPath }
}

async function readEntryBody(entry: MemoryIndexEntry): Promise<string | undefined> {
  if (!existsSync(entry.path)) return undefined
  try {
    const text = await readFile(entry.path, 'utf8')
    return stripFrontmatter(text)
  } catch {
    return undefined
  }
}

function stripFrontmatter(text: string): string {
  const lines = text.split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return text
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === '---') return lines.slice(i + 1).join('\n').trim()
  }
  return text
}

function scoreEntry(
  queryTerms: readonly string[],
  entry: MemoryIndexEntry,
  body: string,
  now: Date,
): { score: number; terms: readonly string[] } {
  const haystack = tokenize(`${entry.key} ${entry.description ?? ''} ${entry.name ?? ''} ${body}`)
  const haystackSet = new Set(haystack)
  const matched = queryTerms.filter((term) => haystackSet.has(term))
  if (matched.length === 0) return { score: 0, terms: [] }
  const overlap = matched.length / Math.max(1, queryTerms.length)
  const confidenceBoost = typeof entry.confidence === 'number' && Number.isFinite(entry.confidence)
    ? Math.min(1, Math.max(0, entry.confidence)) * 0.2
    : 0
  const recencyBoost = recencyBoostFor(entry.generatedAt, now)
  return { score: overlap + confidenceBoost + recencyBoost, terms: matched }
}

function recencyBoostFor(generatedAt: string | undefined, now: Date): number {
  if (!generatedAt) return 0
  const then = Date.parse(generatedAt)
  if (!Number.isFinite(then)) return 0
  const days = Math.max(0, (now.getTime() - then) / (1000 * 60 * 60 * 24))
  return 0.15 * Math.pow(0.5, days / RECENCY_HALF_LIFE_DAYS)
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'is',
  'are', 'was', 'were', 'be', 'been', 'being', 'this', 'that', 'these', 'those',
  'it', 'its', 'from', 'by', 'as', 'at', 'we', 'i', 'you', 'they', 'so',
])

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s./_-]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 0 && !STOPWORDS.has(token))
}

export function resolveGlobalMemoryRoot(): string {
  return join(homedir(), '.agent-kernel', 'memory')
}
