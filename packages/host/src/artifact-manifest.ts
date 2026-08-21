import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'

export type BuildArtifactManifestInput = {
  rootDir: string
  outputPath?: string
  maxHashBytes?: number
}

export type ArtifactManifestEntry = {
  path: string
  kind: string
  mediaType: string
  bytes: number
  mtime: string
  sha256?: string
  hashSkippedReason?: string
}

export type ArtifactManifest = {
  schemaVersion: 1
  generatedAt: string
  rootDir: string
  entries: ArtifactManifestEntry[]
  summary: {
    entryCount: number
    totalBytes: number
    hashedCount: number
    hashSkippedCount: number
    kinds: Record<string, number>
  }
}

export type ArtifactManifestPage = ArtifactManifest & {
  page: {
    limit: number
    returnedEntries: number
    totalEntries: number
    hasMore: boolean
    nextCursor?: string
    snapshotId: string
  }
}

export function pageArtifactManifest(input: {
  manifest: ArtifactManifest
  snapshotId: string
  offset: number
  limit: number
  kinds?: ReadonlySet<string>
}): ArtifactManifestPage {
  const entries = input.kinds && input.kinds.size > 0
    ? input.manifest.entries.filter((entry) => input.kinds!.has(entry.kind))
    : input.manifest.entries
  const offset = Math.min(input.offset, entries.length)
  const end = Math.min(offset + input.limit, entries.length)
  const hasMore = end < entries.length
  const filterKey = [...(input.kinds ?? [])].sort().join(',')
  return {
    ...input.manifest,
    entries: entries.slice(offset, end),
    page: {
      limit: input.limit,
      returnedEntries: end - offset,
      totalEntries: entries.length,
      hasMore,
      ...(hasMore ? { nextCursor: encodeManifestCursor(input.snapshotId, end, filterKey) } : {}),
      snapshotId: input.snapshotId,
    },
  }
}

export function encodeManifestCursor(snapshotId: string, offset: number, filterKey = ''): string {
  return Buffer.from(JSON.stringify({ snapshotId, offset, filterKey }), 'utf8').toString('base64url')
}

export function decodeManifestCursor(cursor: string): { snapshotId: string; offset: number; filterKey: string } {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { snapshotId?: unknown; offset?: unknown; filterKey?: unknown }
    if (typeof parsed.snapshotId !== 'string' || parsed.snapshotId.length < 1 || parsed.snapshotId.length > 128) throw new Error('invalid snapshot')
    if (!Number.isSafeInteger(parsed.offset) || Number(parsed.offset) < 0) throw new Error('invalid offset')
    if (typeof parsed.filterKey !== 'string' || parsed.filterKey.length > 4096) throw new Error('invalid filter')
    return { snapshotId: parsed.snapshotId, offset: Number(parsed.offset), filterKey: parsed.filterKey }
  } catch {
    throw new Error('invalid artifact manifest cursor')
  }
}

const DEFAULT_MAX_HASH_BYTES = 25 * 1024 * 1024

export async function buildArtifactManifest(
  input: BuildArtifactManifestInput,
): Promise<{ manifest: ArtifactManifest; manifestPath: string }> {
  const rootDir = input.rootDir
  const outputPath = input.outputPath ?? join(rootDir, 'artifact-manifest.json')
  const maxHashBytes = input.maxHashBytes ?? DEFAULT_MAX_HASH_BYTES
  const outputRelative = normalizeRelative(rootDir, outputPath)
  await mkdir(rootDir, { recursive: true })
  const files = await collectFiles(rootDir)
  const entries: ArtifactManifestEntry[] = []

  for (const filePath of files) {
    const artifactPath = normalizeRelative(rootDir, filePath)
    if (artifactPath === outputRelative) continue
    const fileStat = await stat(filePath).catch((err: unknown) => {
      if (isNodeErrorCode(err, 'ENOENT')) return undefined
      throw err
    })
    if (!fileStat) continue
    const base = baseEntry(artifactPath, fileStat.size, fileStat.mtime.toISOString())
    if (fileStat.size > maxHashBytes) {
      entries.push({
        ...base,
        hashSkippedReason: `file exceeds maxHashBytes (${maxHashBytes})`,
      })
      continue
    }
    entries.push({ ...base, sha256: await hashFile(filePath) })
  }

  entries.sort((a, b) => a.path.localeCompare(b.path))
  const manifest: ArtifactManifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    rootDir,
    entries,
    summary: summarize(entries),
  }
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return { manifest, manifestPath: outputPath }
}

async function collectFiles(rootDir: string): Promise<string[]> {
  const out: string[] = []

  async function visit(dir: string): Promise<void> {
    const dirents = await readdir(dir, { withFileTypes: true }).catch((err: unknown) => {
      if (isNodeErrorCode(err, 'ENOENT')) return []
      throw err
    })
    for (const dirent of dirents) {
      const child = join(dir, dirent.name)
      if (dirent.isDirectory()) {
        await visit(child)
        continue
      }
      if (dirent.isFile()) out.push(child)
    }
  }

  await visit(rootDir)
  return out
}

function isNodeErrorCode(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code?: unknown }).code === code
}

function baseEntry(path: string, bytes: number, mtime: string): Omit<ArtifactManifestEntry, 'sha256' | 'hashSkippedReason'> {
  return {
    path,
    kind: inferKind(path),
    mediaType: inferMediaType(path),
    bytes,
    mtime,
  }
}

function inferKind(path: string): string {
  if (inPath(path, 'llm') && path.endsWith('.request.json')) return 'llm_request'
  if (inPath(path, 'llm') && path.endsWith('.response.json')) return 'llm_response'
  if (inPath(path, 'traces') || path.endsWith('.openinference.json')) return 'trace'
  if (inPath(path, 'message-assembly')) return 'message_assembly'
  if (inPath(path, 'router-decisions')) return 'router_decision'
  if (inPath(path, 'tool-catalog')) return 'tool_catalog'
  if (inPath(path, 'compaction-summaries')) return 'compaction_summary_validation'
  if (inPath(path, 'rl-token-segments')) return 'rl_token_segments'
  if (inPath(path, 'rl-token-captures')) return 'rl_token_capture'
  if (inPath(path, 'rl-trajectories')) return 'rl_trajectory'
  if (inPath(path, 'rl-rewards')) return 'rl_reward'
  if (inPath(path, 'rl-sample-validations')) return 'rl_sample_validation'
  if (inPath(path, 'rl-rollouts')) return 'rl_rollout_result'
  if (inPath(path, 'rl-tasks')) return 'rl_task_pool'
  if (inPath(path, 'rl-adapters')) return 'rl_adapter'
  if (inPath(path, 'rollouts')) return 'rl_rollout_sidecar'
  if (path.endsWith('/profile.json')) return 'profile'
  if (path.endsWith('/reliability-audit.json')) return 'reliability_audit'
  if (path.endsWith('/reliability-chaos.json')) return 'reliability_chaos'
  if (path.endsWith('/reliability-gate.json')) return 'reliability_gate'
  if (path.endsWith('/crash-kill-report.json')) return 'reliability_crash_kill'
  if (path.endsWith('/tool-catalog-diff.json')) return 'tool_catalog_diff'
  if (path.endsWith('/executor-capabilities.json')) return 'executor_capabilities'
  if (path.endsWith('/memory-index.json')) return 'memory_index'
  if (path.endsWith('/memory-retrieval.json') || (inPath(path, 'memory-retrieval'))) return 'memory_retrieval'
  if (path.endsWith('/subagent-graph.json')) return 'subagent_graph'
  if (inPath(path, 'subagent-policies')) return 'subagent_policy'
  if (path.endsWith('.diff') || path.endsWith('.patch')) return 'diff'
  if (path.endsWith('.jsonl')) return 'jsonl_log'
  if (path.endsWith('.log')) return 'log'
  if (path.endsWith('.json')) return 'json'
  return 'file'
}

function inPath(path: string, segment: string): boolean {
  return path === segment || path.startsWith(`${segment}/`) || path.includes(`/${segment}/`)
}

function inferMediaType(path: string): string {
  if (path.endsWith('.json')) return 'application/json'
  if (path.endsWith('.jsonl')) return 'application/jsonl'
  if (path.endsWith('.diff') || path.endsWith('.patch')) return 'text/x-diff'
  if (path.endsWith('.log') || path.endsWith('.txt') || path.endsWith('.md')) return 'text/plain'
  return 'application/octet-stream'
}

function summarize(entries: readonly ArtifactManifestEntry[]): ArtifactManifest['summary'] {
  const kinds: Record<string, number> = {}
  let totalBytes = 0
  let hashedCount = 0
  for (const entry of entries) {
    kinds[entry.kind] = (kinds[entry.kind] ?? 0) + 1
    totalBytes += entry.bytes
    if (entry.sha256) hashedCount++
  }
  return {
    entryCount: entries.length,
    totalBytes,
    hashedCount,
    hashSkippedCount: entries.length - hashedCount,
    kinds: Object.fromEntries(Object.entries(kinds).sort(([a], [b]) => a.localeCompare(b))),
  }
}

function normalizeRelative(rootDir: string, path: string): string {
  return relative(rootDir, path).split(sep).join('/')
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', resolve)
  })
  return hash.digest('hex')
}

export type PruneArtifactsInput = {
  rootDir: string
  olderThanDays?: number
  maxTotalBytes?: number
  kinds?: readonly string[]
  dryRun?: boolean
  outputPath?: string
  now?: Date
}

export type PruneArtifactsRemoval = {
  path: string
  kind: string
  bytes: number
  mtime: string
  reason: 'age' | 'size_budget'
}

export type PruneArtifactsReport = {
  schemaVersion: 1
  generatedAt: string
  rootDir: string
  dryRun: boolean
  policy: {
    olderThanDays?: number
    maxTotalBytes?: number
    kinds?: string[]
  }
  before: { entryCount: number; totalBytes: number }
  after: { entryCount: number; totalBytes: number }
  removed: PruneArtifactsRemoval[]
  kept: number
  protected: { path: string; reason: string }[]
}

const PROTECTED_PATH_MATCHERS: Array<{ match: (path: string) => boolean; reason: string }> = [
  { match: (p) => p === 'artifact-prune.json' || p.endsWith('/artifact-prune.json'), reason: 'prune_report' },
]

export async function pruneArtifacts(
  input: PruneArtifactsInput,
): Promise<{ report: PruneArtifactsReport; reportPath: string }> {
  const { rootDir } = input
  const now = input.now ?? new Date()
  const dryRun = input.dryRun ?? false
  const outputPath = input.outputPath ?? join(rootDir, 'artifact-prune.json')
  const outputRelative = normalizeRelative(rootDir, outputPath)

  await mkdir(rootDir, { recursive: true })
  const { manifest } = await buildArtifactManifest({ rootDir, outputPath: join(rootDir, 'artifact-manifest.json') })

  const kindsFilter = input.kinds && input.kinds.length > 0 ? new Set(input.kinds) : undefined
  const cutoffMs = input.olderThanDays !== undefined
    ? now.getTime() - input.olderThanDays * 86_400_000
    : undefined

  const beforeTotalBytes = manifest.entries.reduce((sum, entry) => sum + entry.bytes, 0)

  const protectedList: PruneArtifactsReport['protected'] = []
  const eligible: ArtifactManifestEntry[] = []
  for (const entry of manifest.entries) {
    if (entry.path === outputRelative) {
      protectedList.push({ path: entry.path, reason: 'prune_report' })
      continue
    }
    const protection = PROTECTED_PATH_MATCHERS.find((m) => m.match(entry.path))
    if (protection) {
      protectedList.push({ path: entry.path, reason: protection.reason })
      continue
    }
    if (kindsFilter && !kindsFilter.has(entry.kind)) continue
    eligible.push(entry)
  }

  const removals: PruneArtifactsRemoval[] = []
  const remaining: ArtifactManifestEntry[] = []
  for (const entry of eligible) {
    if (cutoffMs !== undefined && Date.parse(entry.mtime) < cutoffMs) {
      removals.push({
        path: entry.path,
        kind: entry.kind,
        bytes: entry.bytes,
        mtime: entry.mtime,
        reason: 'age',
      })
      continue
    }
    remaining.push(entry)
  }

  if (input.maxTotalBytes !== undefined) {
    const untouchedBytes = manifest.entries
      .filter((entry) => !eligible.includes(entry))
      .reduce((sum, entry) => sum + entry.bytes, 0)
    let currentBytes = untouchedBytes + remaining.reduce((sum, entry) => sum + entry.bytes, 0)
    const sortedByAge = [...remaining].sort((a, b) => Date.parse(a.mtime) - Date.parse(b.mtime))
    while (currentBytes > input.maxTotalBytes && sortedByAge.length > 0) {
      const victim = sortedByAge.shift()!
      removals.push({
        path: victim.path,
        kind: victim.kind,
        bytes: victim.bytes,
        mtime: victim.mtime,
        reason: 'size_budget',
      })
      currentBytes -= victim.bytes
    }
  }

  if (!dryRun) {
    for (const removal of removals) {
      const absolute = join(rootDir, removal.path)
      await rm(absolute, { force: true }).catch((err: unknown) => {
        if (isNodeErrorCode(err, 'ENOENT')) return
        throw err
      })
    }
  }

  const removedSet = new Set(removals.map((r) => r.path))
  const afterEntries = manifest.entries.filter((entry) => !removedSet.has(entry.path))
  const afterTotalBytes = afterEntries.reduce((sum, entry) => sum + entry.bytes, 0)

  const report: PruneArtifactsReport = {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    rootDir,
    dryRun,
    policy: {
      ...(input.olderThanDays !== undefined ? { olderThanDays: input.olderThanDays } : {}),
      ...(input.maxTotalBytes !== undefined ? { maxTotalBytes: input.maxTotalBytes } : {}),
      ...(input.kinds && input.kinds.length > 0 ? { kinds: [...input.kinds] } : {}),
    },
    before: { entryCount: manifest.entries.length, totalBytes: beforeTotalBytes },
    after: { entryCount: afterEntries.length, totalBytes: afterTotalBytes },
    removed: removals,
    kept: afterEntries.length,
    protected: protectedList,
  }

  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  return { report, reportPath: outputPath }
}
