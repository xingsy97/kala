import { createHash, randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { lstat, mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'

import { readJsonFile, writeAtomicFile } from './atomic-json-file.js'

export type DashboardReleaseManifest = {
  schemaVersion: 1
  product: 'agent-runlab-dashboard'
  version: string
  builtAt: string
  source: { revision: string; snapshotSha256: string; dirty: boolean }
  protocol: { min: string; max: string }
  assetDigest: string
  files: readonly { path: string; bytes: number; sha256: string }[]
}

export type DashboardRouteState = {
  schemaVersion: 1
  generation: number
  releaseId: string
  releaseDigest: string
  assetDigest: string
  version: string
  protocol: { min: string; max: string }
  activatedAt: string
}

export type DashboardDeploymentRequest = {
  schemaVersion: 1
  action: 'deploy' | 'rollback'
  operationId: string
  deploymentId: string
  requestedAt: string
  expectedGeneration: number
  releaseId: string
  releaseDigest: string
  manifestSha256: string
  archiveSha256?: string
  stagedReleaseDir?: string
}

export type DashboardDeploymentReceipt = {
  schemaVersion: 1
  receiptRevision: number
  action: 'deploy' | 'rollback'
  operationId: string
  deploymentId: string
  phase: 'accepted' | 'completed' | 'failed'
  requestedAt: string
  updatedAt: string
  expectedGeneration: number
  observedGeneration?: number
  releaseId: string
  releaseDigest: string
  previousReleaseId?: string
  error?: { code: string; message: string }
}

export type DashboardPublicVerification = {
  releaseId: string
  generation: number
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.ico': 'image/x-icon', '.woff': 'font/woff',
  '.woff2': 'font/woff2', '.map': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8',
}
const API_EXACT = new Set(['/models', '/settings', '/memo', '/metrics', '/organization', '/install', '/install.ps1'])
const API_PREFIXES = [
  '/socket.io/', '/runtime/', '/internal/', '/settings/', '/auth/', '/push/', '/api/', '/user/', '/organization/',
  '/artifacts/', '/session-artifacts/', '/router/', '/enhancement/', '/install/', '/release-assets/', '/themes/',
]

export function isDedicatedDashboardRequest(request: IncomingMessage): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false
  const path = new URL(request.url ?? '/', 'http://ingress.invalid').pathname
  if (API_EXACT.has(path) || API_PREFIXES.some((prefix) => path.startsWith(prefix))) return false
  if (path === '/docs/index' || path === '/docs/content') return false
  if (path === '/' || request.headers.accept?.includes('text/html')) return true
  return extname(path).length > 0
}

export async function serveDedicatedDashboard(options: {
  request: IncomingMessage
  response: ServerResponse
  statePath: string
  releasesRoot: string
}): Promise<boolean> {
  if (!isDedicatedDashboardRequest(options.request)) return false
  const state = await readDashboardRouteState(options.statePath).catch(() => undefined)
  if (!state) return false
  const releaseRoot = resolveRelease(options.releasesRoot, state.releaseId)
  const assetsRoot = join(releaseRoot, 'assets')
  let requested: string
  try { requested = decodeURIComponent(new URL(options.request.url ?? '/', 'http://ingress.invalid').pathname) } catch { send(options.response, 400, 'bad request'); return true }
  const relative = requested.replace(/^\/+|\/+$/gu, '') || 'index.html'
  const normalized = normalize(relative)
  if (normalized === '..' || normalized.startsWith(`..${sep}`) || normalized.includes(`\0`)) { send(options.response, 400, 'bad request'); return true }
  let file = resolve(assetsRoot, normalized)
  if (!within(assetsRoot, file)) { send(options.response, 400, 'bad request'); return true }
  try {
    const value = await stat(file)
    if (value.isDirectory()) file = join(file, 'index.html')
  } catch {
    if (extname(file)) { send(options.response, 404, 'not found'); return true }
    file = join(assetsRoot, 'index.html')
  }
  if (!within(assetsRoot, file)) { send(options.response, 400, 'bad request'); return true }
  let body: Buffer
  try {
    const value = await lstat(file)
    if (!value.isFile() || value.isSymbolicLink()) throw new Error('not a regular file')
    body = await readFile(file)
  } catch { send(options.response, 404, 'not found'); return true }
  const name = file.slice(assetsRoot.length + 1).replaceAll(sep, '/')
  const immutable = name !== 'index.html' && /(?:^|[._-])[a-f0-9]{8,}(?:[._-]|$)/iu.test(name)
  options.response.writeHead(200, {
    'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'content-length': String(body.length),
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache, must-revalidate',
    'x-content-type-options': 'nosniff',
    'x-agent-runlab-dashboard-release': state.releaseId,
    'x-agent-runlab-dashboard-generation': String(state.generation),
  })
  options.response.end(options.request.method === 'HEAD' ? undefined : body)
  return true
}

export async function readDashboardRouteState(path: string): Promise<DashboardRouteState | undefined> {
  const value = await readJsonFile<unknown>(path)
  if (value === undefined) return undefined
  const state = record(value, 'dashboard route state')
  exact(state, ['schemaVersion', 'generation', 'releaseId', 'releaseDigest', 'assetDigest', 'version', 'protocol', 'activatedAt'], 'dashboard route state')
  if (state.schemaVersion !== 1 || !Number.isSafeInteger(state.generation) || Number(state.generation) < 1) throw new Error('invalid dashboard route generation')
  return { schemaVersion: 1, generation: Number(state.generation), releaseId: id(state.releaseId, 'releaseId'), releaseDigest: digest(state.releaseDigest), assetDigest: digest(state.assetDigest), version: text(state.version, 'version'), protocol: protocol(state.protocol), activatedAt: timestamp(state.activatedAt) }
}

export async function writeDashboardRouteState(path: string, state: DashboardRouteState): Promise<void> {
  parseDashboardRouteState(state)
  await writeAtomicFile(path, `${JSON.stringify(state, null, 2)}\n`, 0o640)
}

export async function verifyDashboardPublicRoute(
  origin: string,
  expected: DashboardPublicVerification,
  timeoutMs = 15_000,
): Promise<void> {
  const url = new URL('/', origin)
  const deadline = Date.now() + timeoutMs
  let lastFailure = 'no response'
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { headers: { accept: 'text/html' }, signal: AbortSignal.timeout(Math.min(3_000, Math.max(1, deadline - Date.now()))) })
      const releaseId = response.headers.get('x-agent-runlab-dashboard-release')
      const generation = Number(response.headers.get('x-agent-runlab-dashboard-generation'))
      if (response.ok && releaseId === expected.releaseId && generation === expected.generation) return
      lastFailure = `HTTP ${response.status}, release ${releaseId ?? 'missing'}, generation ${Number.isSafeInteger(generation) ? generation : 'missing'}`
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error)
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  }
  throw new Error(`Dashboard public verification failed: ${lastFailure}`)
}

export function parseDashboardRouteState(value: unknown): DashboardRouteState {
  const state = record(value, 'dashboard route state')
  exact(state, ['schemaVersion', 'generation', 'releaseId', 'releaseDigest', 'assetDigest', 'version', 'protocol', 'activatedAt'], 'dashboard route state')
  if (state.schemaVersion !== 1 || !Number.isSafeInteger(state.generation) || Number(state.generation) < 1) throw new Error('invalid dashboard route generation')
  return { schemaVersion: 1, generation: Number(state.generation), releaseId: id(state.releaseId, 'releaseId'), releaseDigest: digest(state.releaseDigest), assetDigest: digest(state.assetDigest), version: text(state.version, 'version'), protocol: protocol(state.protocol), activatedAt: timestamp(state.activatedAt) }
}

export function parseDashboardManifest(value: unknown): DashboardReleaseManifest {
  const manifest = record(value, 'dashboard manifest')
  exact(manifest, ['schemaVersion', 'product', 'version', 'builtAt', 'source', 'protocol', 'assetDigest', 'files'], 'dashboard manifest')
  if (manifest.schemaVersion !== 1 || manifest.product !== 'agent-runlab-dashboard') throw new Error('unsupported dashboard manifest')
  const source = record(manifest.source, 'dashboard source')
  exact(source, ['revision', 'snapshotSha256', 'dirty'], 'dashboard source')
  if (typeof source.dirty !== 'boolean' || !/^[a-f0-9]{40}$/u.test(String(source.revision))) throw new Error('invalid dashboard source identity')
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) throw new Error('dashboard manifest files are required')
  const files = manifest.files.map((entry) => {
    const file = record(entry, 'dashboard file')
    exact(file, ['path', 'bytes', 'sha256'], 'dashboard file')
    const path = safeAssetPath(file.path)
    if (!Number.isSafeInteger(file.bytes) || Number(file.bytes) < 0) throw new Error('invalid dashboard file size')
    return { path, bytes: Number(file.bytes), sha256: digest(file.sha256) }
  })
  if (new Set(files.map((file) => file.path)).size !== files.length || !files.some((file) => file.path === 'index.html')) throw new Error('invalid dashboard file set')
  const assetDigest = digest(manifest.assetDigest)
  if (hashFiles(files) !== assetDigest) throw new Error('dashboard asset digest mismatch')
  return { schemaVersion: 1, product: 'agent-runlab-dashboard', version: text(manifest.version, 'version'), builtAt: timestamp(manifest.builtAt), source: { revision: String(source.revision), snapshotSha256: digest(source.snapshotSha256), dirty: source.dirty }, protocol: protocol(manifest.protocol), assetDigest, files }
}

export function parseDashboardRequest(value: unknown): DashboardDeploymentRequest {
  const input = record(value, 'dashboard deployment request')
  exact(input, ['schemaVersion', 'action', 'operationId', 'deploymentId', 'requestedAt', 'expectedGeneration', 'releaseId', 'releaseDigest', 'manifestSha256', 'archiveSha256', 'stagedReleaseDir'], 'dashboard deployment request')
  if (input.schemaVersion !== 1 || (input.action !== 'deploy' && input.action !== 'rollback')) throw new Error('unsupported dashboard deployment request')
  if (!Number.isSafeInteger(input.expectedGeneration) || Number(input.expectedGeneration) < 0) throw new Error('invalid expected dashboard generation')
  const result: DashboardDeploymentRequest = { schemaVersion: 1, action: input.action, operationId: id(input.operationId, 'operationId'), deploymentId: id(input.deploymentId, 'deploymentId'), requestedAt: timestamp(input.requestedAt), expectedGeneration: Number(input.expectedGeneration), releaseId: id(input.releaseId, 'releaseId'), releaseDigest: digest(input.releaseDigest), manifestSha256: digest(input.manifestSha256) }
  if (input.action === 'deploy') {
    if (typeof input.stagedReleaseDir !== 'string' || !input.stagedReleaseDir || input.archiveSha256 === undefined) throw new Error('deploy request requires staged release and archive digest')
    return { ...result, stagedReleaseDir: input.stagedReleaseDir, archiveSha256: digest(input.archiveSha256) }
  }
  if (input.stagedReleaseDir !== undefined || input.archiveSha256 !== undefined) throw new Error('rollback request cannot stage an archive')
  return result
}

export function dashboardReleaseDigest(manifestBytes: Uint8Array): string { return createHash('sha256').update(manifestBytes).digest('hex') }
export function hashFiles(files: readonly { path: string; bytes: number; sha256: string }[]): string { return createHash('sha256').update(JSON.stringify([...files].sort((a, b) => a.path.localeCompare(b.path)))).digest('hex') }
export function resolveRelease(root: string, releaseId: string): string { const release = resolve(root, id(releaseId, 'releaseId')); if (!within(resolve(root), release)) throw new Error('dashboard release escapes root'); return release }

export async function syncDirectory(path: string): Promise<void> { const directory = await open(path, 'r'); try { await directory.sync() } finally { await directory.close() } }
export async function createIncomingDirectory(target: string): Promise<string> { const incoming = `${target}.incoming-${process.pid}-${randomBytes(8).toString('hex')}`; await mkdir(incoming, { recursive: false, mode: 0o700 }); return incoming }
export async function publishIncoming(incoming: string, target: string): Promise<void> { await rename(incoming, target); await syncDirectory(dirname(target)) }
export async function discardIncoming(path: string): Promise<void> { await rm(path, { recursive: true, force: true }) }

function send(response: ServerResponse, status: number, message: string): void { response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }); response.end(message) }
function within(root: string, candidate: string): boolean { const base = resolve(root); const value = resolve(candidate); return value === base || value.startsWith(`${base}${sep}`) }
function safeAssetPath(value: unknown): string { const path = text(value, 'asset path').replaceAll('\\', '/'); if (path.startsWith('/') || path.split('/').some((part) => !part || part === '.' || part === '..') || path.includes('\0')) throw new Error('unsafe dashboard asset path'); return path }
function record(value: unknown, name: string): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`); return value as Record<string, unknown> }
function exact(value: Record<string, unknown>, fields: readonly string[], name: string): void { const allowed = new Set(fields); const unknown = Object.keys(value).filter((key) => !allowed.has(key)); if (unknown.length) throw new Error(`${name} contains unknown fields: ${unknown.join(', ')}`) }
function id(value: unknown, name: string): string { const result = text(value, name); if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(result)) throw new Error(`invalid ${name}`); return result }
function text(value: unknown, name: string): string { if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`); return value.trim() }
function digest(value: unknown): string { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) throw new Error('invalid SHA-256 digest'); return value }
function timestamp(value: unknown): string { const result = text(value, 'timestamp'); if (!Number.isFinite(Date.parse(result))) throw new Error('invalid timestamp'); return result }
function protocol(value: unknown): { min: string; max: string } { const result = record(value, 'protocol range'); exact(result, ['min', 'max'], 'protocol range'); return { min: text(result.min, 'protocol min'), max: text(result.max, 'protocol max') } }
