import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises'
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

const DEFAULT_MAX_HASH_BYTES = 25 * 1024 * 1024

export async function buildArtifactManifest(
  input: BuildArtifactManifestInput,
): Promise<{ manifest: ArtifactManifest; manifestPath: string }> {
  const rootDir = input.rootDir
  const outputPath = input.outputPath ?? join(rootDir, 'artifact-manifest.json')
  const maxHashBytes = input.maxHashBytes ?? DEFAULT_MAX_HASH_BYTES
  const outputRelative = normalizeRelative(rootDir, outputPath)
  const files = await collectFiles(rootDir)
  const entries: ArtifactManifestEntry[] = []

  for (const filePath of files) {
    const artifactPath = normalizeRelative(rootDir, filePath)
    if (artifactPath === outputRelative) continue
    const fileStat = await stat(filePath)
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
    const dirents = await readdir(dir, { withFileTypes: true })
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
  if (inPath(path, 'rollouts')) return 'rl_rollout_sidecar'
  if (inPath(path, 'trials')) return 'eval_trial'
  if (path.endsWith('/summary.json')) return 'eval_summary'
  if (path === 'worker-plan.json' || path.endsWith('/worker-plan.json')) return 'eval_worker_plan'
  if (path === 'progress.json' || path.endsWith('/progress.json')) return 'eval_progress'
  if (path.endsWith('/scores.json')) return 'eval_score'
  if (inPath(path, 'judge') || path.endsWith('/judge-trace.json')) return 'eval_judge'
  if (path.endsWith('/profile.json')) return 'profile'
  if (path.endsWith('/reliability-audit.json')) return 'reliability_audit'
  if (path.endsWith('/reliability-chaos.json')) return 'reliability_chaos'
  if (path.endsWith('/memory-index.json')) return 'memory_index'
  if (path.endsWith('/subagent-graph.json')) return 'subagent_graph'
  if (path.endsWith('/eval-comparison.json')) return 'eval_comparison'
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
