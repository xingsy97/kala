import { createHash, randomBytes } from 'node:crypto'
import { chmod, lstat, mkdir, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

import type { RuntimeLogger } from './logger.js'

export const EXECUTOR_INSTALLATION_SOURCES = [
  'package-manager',
  'dashboard-native',
  'legacy-cjs',
  'container',
] as const
export type ExecutorInstallationSource = (typeof EXECUTOR_INSTALLATION_SOURCES)[number]
export type UpdateChannel = 'stable' | 'beta' | 'nightly'

export type SignedUpdateManifest = {
  version: 1
  release: string
  channel: UpdateChannel
  protocol: { min: number; max: number }
  artifact: { url: string; size: number; sha256: string; file?: string }
}

export type ManifestEnvelope = { signed: string; signature: string }
export interface Verifier {
  verify(signed: string, signature: string): boolean | Promise<boolean>
}
export interface UpdateLifecycle {
  selfTest(generationPath: string, manifest: SignedUpdateManifest): Promise<void>
  drain(): Promise<void>
  restart(plan: RestartPlan): Promise<void>
  health(manifest: SignedUpdateManifest): Promise<void>
  reconnect(manifest: SignedUpdateManifest): Promise<void>
  rollbackHealth?(previousGeneration: string): Promise<void>
}
export type RestartPlan = {
  reason: 'activate' | 'rollback'
  current: string
  previous?: string
}
export type GenerationLinkPlan = {
  root: string
  generation: string
  staging: string
  current: string
  previous: string
}
export type GenerationUpdateResult =
  | { status: 'updated'; release: string; generation: string }
  | { status: 'current'; release: string }
  | { status: 'skipped'; reason: 'externally-managed' | 'unsupported-source' }

export type GenerationUpdaterOptions = {
  installationSource: ExecutorInstallationSource
  manifestUrl: string
  currentVersion?: string
  channel: UpdateChannel
  protocol: number
  root: string
  verifier?: Verifier
  lifecycle: UpdateLifecycle
  fetch?: typeof globalThis.fetch
  timeoutMs?: number
  maxManifestBytes?: number
  maxArtifactBytes?: number
}

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MANIFEST_BYTES = 64 * 1024
const DEFAULT_ARTIFACT_BYTES = 128 * 1024 * 1024
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const SHA256 = /^[a-f0-9]{64}$/

export class GenerationUpdater {
  readonly #options: GenerationUpdaterOptions

  constructor(options: GenerationUpdaterOptions) {
    this.#options = options
  }

  async run(): Promise<GenerationUpdateResult> {
    const opts = this.#options
    if (opts.installationSource === 'package-manager' || opts.installationSource === 'container') {
      return { status: 'skipped', reason: 'externally-managed' }
    }
    if (opts.installationSource !== 'dashboard-native') {
      return { status: 'skipped', reason: 'unsupported-source' }
    }
    if (!opts.verifier) throw new Error('signed update manifest verifier is not configured')

    const envelope = parseEnvelope(
      await downloadBytes(opts.manifestUrl, opts.maxManifestBytes ?? DEFAULT_MANIFEST_BYTES, opts),
    )
    if (!(await opts.verifier.verify(envelope.signed, envelope.signature))) {
      throw new Error('update manifest signature verification failed')
    }
    const manifest = parseManifest(envelope.signed)
    validateCompatibility(manifest, opts)
    if (opts.currentVersion && compareSemVer(manifest.release, opts.currentVersion) <= 0) {
      return { status: 'current', release: manifest.release }
    }

    const artifactUrl = new URL(manifest.artifact.url, opts.manifestUrl).toString()
    const artifact = await downloadBytes(
      artifactUrl,
      Math.min(manifest.artifact.size, opts.maxArtifactBytes ?? DEFAULT_ARTIFACT_BYTES),
      opts,
    )
    if (artifact.byteLength !== manifest.artifact.size) {
      throw new Error(`artifact size mismatch: expected ${manifest.artifact.size}, received ${artifact.byteLength}`)
    }
    const digest = createHash('sha256').update(artifact).digest('hex')
    if (digest !== manifest.artifact.sha256) throw new Error('artifact checksum mismatch')

    const plan = generationLinkPlan(opts.root, manifest.release)
    const executable = safeArtifactName(manifest.artifact.file)
    await mkdir(plan.root, { recursive: true })
    await rm(plan.generation, { recursive: true, force: true })
    await mkdir(plan.generation, { recursive: true })
    await writeFile(join(plan.generation, executable), artifact, { mode: 0o755, flag: 'wx' })
    await chmod(join(plan.generation, executable), 0o755)
    await writeFile(join(plan.generation, 'manifest.json'), envelope.signed, { flag: 'wx' })
    await opts.lifecycle.selfTest(plan.generation, manifest)
    await atomicSymlink(plan.staging, plan.generation)

    const oldCurrent = await readSymlinkTarget(plan.current)
    await opts.lifecycle.drain()
    try {
      if (oldCurrent) await atomicSymlink(plan.previous, oldCurrent)
      await atomicSymlink(plan.current, plan.generation)
      await rm(plan.staging, { force: true })
      await opts.lifecycle.restart({
        reason: 'activate',
        current: plan.generation,
        ...(oldCurrent ? { previous: oldCurrent } : {}),
      })
      await opts.lifecycle.health(manifest)
      await opts.lifecycle.reconnect(manifest)
      return { status: 'updated', release: manifest.release, generation: plan.generation }
    } catch (error) {
      if (oldCurrent) {
        await atomicSymlink(plan.current, oldCurrent)
        try {
          await opts.lifecycle.restart({ reason: 'rollback', current: oldCurrent, previous: plan.generation })
          if (opts.lifecycle.rollbackHealth) await opts.lifecycle.rollbackHealth(oldCurrent)
          else await opts.lifecycle.reconnect(manifest)
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], 'update failed and rollback recovery failed')
        }
      }
      throw error
    }
  }
}

export function generationLinkPlan(root: string, release: string): GenerationLinkPlan {
  const safeRelease = parseSemVer(release).normalized
  const absoluteRoot = resolve(root)
  return {
    root: absoluteRoot,
    generation: join(absoluteRoot, 'generations', safeRelease),
    staging: join(absoluteRoot, 'staging'),
    current: join(absoluteRoot, 'current'),
    previous: join(absoluteRoot, 'previous'),
  }
}

function parseEnvelope(bytes: Buffer): ManifestEnvelope {
  let value: unknown
  try {
    value = JSON.parse(bytes.toString('utf8'))
  } catch {
    throw new Error('update manifest envelope is not valid JSON')
  }
  if (!isRecord(value) || typeof value.signed !== 'string' || typeof value.signature !== 'string' || !value.signature) {
    throw new Error('update manifest envelope is invalid')
  }
  return { signed: value.signed, signature: value.signature }
}

export function parseManifest(signed: string): SignedUpdateManifest {
  let value: unknown
  try {
    value = JSON.parse(signed)
  } catch {
    throw new Error('signed update manifest is not valid JSON')
  }
  if (!isRecord(value) || value.version !== 1 || typeof value.release !== 'string' ||
      !isChannel(value.channel) || !isRecord(value.protocol) || !isRecord(value.artifact) ||
      !Number.isSafeInteger(value.protocol.min) || !Number.isSafeInteger(value.protocol.max) ||
      typeof value.artifact.url !== 'string' || (!/^https:\/\//u.test(value.artifact.url) && !/^\.\/[A-Za-z0-9_.-]+$/u.test(value.artifact.url)) ||
      !Number.isSafeInteger(value.artifact.size) || (value.artifact.size as number) <= 0 ||
      typeof value.artifact.sha256 !== 'string' || !SHA256.test(value.artifact.sha256) ||
      (value.artifact.file !== undefined && typeof value.artifact.file !== 'string')) {
    throw new Error('signed update manifest has an invalid schema')
  }
  parseSemVer(value.release)
  return value as SignedUpdateManifest
}

function validateCompatibility(manifest: SignedUpdateManifest, opts: GenerationUpdaterOptions): void {
  if (manifest.channel !== opts.channel) {
    throw new Error(`update channel mismatch: expected ${opts.channel}, received ${manifest.channel}`)
  }
  if (manifest.protocol.min > manifest.protocol.max || opts.protocol < manifest.protocol.min || opts.protocol > manifest.protocol.max) {
    throw new Error(`update protocol ${opts.protocol} is incompatible with ${manifest.protocol.min}-${manifest.protocol.max}`)
  }
  if (manifest.artifact.size > (opts.maxArtifactBytes ?? DEFAULT_ARTIFACT_BYTES)) {
    throw new Error(`artifact exceeds maximum size of ${opts.maxArtifactBytes ?? DEFAULT_ARTIFACT_BYTES} bytes`)
  }
}

async function downloadBytes(url: string, maxBytes: number, opts: GenerationUpdaterOptions): Promise<Buffer> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  timer.unref?.()
  try {
    const response = await (opts.fetch ?? globalThis.fetch)(url, {
      signal: controller.signal,
      headers: { accept: 'application/json, application/octet-stream', 'user-agent': 'agent-kernel-executor' },
    })
    if (!response.ok) throw new Error(`download failed ${url}: ${response.status}`)
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`download exceeds maximum size of ${maxBytes} bytes`)
    if (!response.body) throw new Error(`download failed ${url}: empty body`)
    const chunks: Uint8Array[] = []
    let total = 0
    const reader = response.body.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.byteLength
        if (total > maxBytes) throw new Error(`download exceeds maximum size of ${maxBytes} bytes`)
        chunks.push(value)
      }
    } finally {
      reader.releaseLock()
    }
    return Buffer.concat(chunks, total)
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`download timed out after ${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`, { cause: error })
    throw error
  } finally {
    clearTimeout(timer)
  }
}

async function atomicSymlink(linkPath: string, target: string): Promise<void> {
  await mkdir(dirname(linkPath), { recursive: true })
  const temporary = `${linkPath}.tmp-${randomBytes(6).toString('hex')}`
  await symlink(target, temporary, process.platform === 'win32' ? 'junction' : 'dir')
  try {
    await rename(temporary, linkPath)
  } catch (error) {
    await rm(linkPath, { force: true })
    await rename(temporary, linkPath).catch(async (renameError) => {
      await rm(temporary, { force: true })
      throw new AggregateError([error, renameError], `failed to publish symlink ${linkPath}`)
    })
  }
}

async function readSymlinkTarget(path: string): Promise<string | undefined> {
  try {
    const stat = await lstat(path)
    if (!stat.isSymbolicLink()) throw new Error(`refusing to replace non-symlink update pointer: ${path}`)
    return resolve(dirname(path), await readlink(path))
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return undefined
    throw error
  }
}

function safeArtifactName(value: string | undefined): string {
  const name = value ?? 'agent-kernel-executor.cjs'
  if (basename(name) !== name || name === '.' || name === '..') throw new Error('artifact file name is unsafe')
  return name
}

type ParsedSemVer = { major: number; minor: number; patch: number; prerelease: string[]; normalized: string }
function parseSemVer(value: string): ParsedSemVer {
  const match = SEMVER.exec(value.trim().replace(/^v/u, ''))
  if (!match) throw new Error(`invalid semantic version: ${value}`)
  const normalized = `${match[1]}.${match[2]}.${match[3]}${match[4] ? `-${match[4]}` : ''}`
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease: match[4]?.split('.') ?? [], normalized }
}

export function compareSemVer(left: string, right: string): number {
  const a = parseSemVer(left)
  const b = parseSemVer(right)
  for (const key of ['major', 'minor', 'patch'] as const) if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1
  if (a.prerelease.length === 0 || b.prerelease.length === 0) return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length === 0 ? 1 : -1
  const count = Math.max(a.prerelease.length, b.prerelease.length)
  for (let i = 0; i < count; i++) {
    const x = a.prerelease[i]
    const y = b.prerelease[i]
    if (x === undefined || y === undefined) return x === y ? 0 : x === undefined ? -1 : 1
    if (x === y) continue
    const xn = /^\d+$/u.test(x) ? Number(x) : undefined
    const yn = /^\d+$/u.test(y) ? Number(y) : undefined
    if (xn !== undefined && yn !== undefined) return xn < yn ? -1 : 1
    if (xn !== undefined || yn !== undefined) return xn !== undefined ? -1 : 1
    return x < y ? -1 : 1
  }
  return 0
}

function isChannel(value: unknown): value is UpdateChannel {
  return value === 'stable' || value === 'beta' || value === 'nightly'
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

// Legacy CLI adapter. It retains the old reminder flags, but intentionally has
// no restart implementation and cannot auto-update without a configured signer.
type LegacyOptions = { repo: string; currentTag?: string; autoUpdate: boolean; argv: readonly string[]; logger: RuntimeLogger }
export async function checkExecutorUpdate(opts: LegacyOptions): Promise<void> {
  const response = await fetch(`https://api.github.com/repos/${opts.repo}/releases/latest`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'agent-kernel-executor' },
  })
  if (!response.ok) throw new Error(`GitHub latest release request failed: ${response.status}`)
  const latest = await response.json() as { tag_name?: string; html_url?: string }
  const current = normalizeTag(opts.currentTag)
  const release = normalizeTag(latest.tag_name)
  if (!release || release === current) return
  if (opts.autoUpdate) {
    opts.logger.warn({ current: current ?? 'unknown', latest: release }, 'executor auto-update requires a dashboard-native signed manifest and verifier')
    return
  }
  opts.logger.info({ current: current ?? 'unknown', latest: release, url: latest.html_url }, 'executor update available; use the installation source to update')
}

export function checksumFor(text: string, asset: string): string | null {
  for (const line of text.split('\n')) {
    const [sum, file] = line.trim().split(/\s+/, 2)
    if (file === asset && sum) return sum
  }
  return null
}
export function normalizeTag(tag: string | undefined): string | null {
  if (!tag || tag === 'latest') return null
  return tag.trim()
}
