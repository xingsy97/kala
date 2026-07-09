import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, normalize, posix } from 'node:path'

import { unzipSync } from 'fflate'
import { parse as parseJsonc } from 'jsonc-parser'

const OPEN_VSX_BASE_URL = process.env.AGENT_KERNEL_OPEN_VSX_BASE_URL ?? 'https://open-vsx.org'
const CACHE_DIR = process.env.AGENT_KERNEL_VSCODE_THEME_CACHE_DIR ?? join(homedir(), '.cache', 'agent-kernel', 'vscode-themes')
const FETCH_TIMEOUT_MS = 15_000
const MAX_JSON_BYTES = 2 * 1024 * 1024
const MAX_VSIX_BYTES = 30 * 1024 * 1024

export type MarketplaceThemeSearchResult = {
  namespace: string
  name: string
  displayName: string
  description: string
  version: string
  verified: boolean
  downloadCount: number
  iconUrl?: string
}

export type MarketplaceThemeContribution = {
  id: string
  label: string
  uiTheme: string
  path: string
}

export type MarketplaceThemeExtension = MarketplaceThemeSearchResult & {
  themes: MarketplaceThemeContribution[]
}

export type MarketplaceThemePayload = {
  extension: MarketplaceThemeExtension
  theme: unknown
}

type OpenVsxExtension = {
  namespace?: string
  name?: string
  displayName?: string
  description?: string
  version?: string
  verified?: boolean
  downloadCount?: number
  files?: { download?: string; icon?: string; manifest?: string }
}

type PackageManifest = {
  contributes?: {
    themes?: unknown
  }
}

export async function searchMarketplaceThemes(query: string): Promise<{ results: MarketplaceThemeSearchResult[] }> {
  const q = query.trim()
  const url = new URL('/api/-/search', OPEN_VSX_BASE_URL)
  url.searchParams.set('category', 'Themes')
  url.searchParams.set('size', '20')
  if (q) url.searchParams.set('query', q)
  const json = await fetchJson(url.toString(), MAX_JSON_BYTES) as { extensions?: OpenVsxExtension[] }
  return { results: (json.extensions ?? []).map(toSearchResult).filter(Boolean) as MarketplaceThemeSearchResult[] }
}

export async function readMarketplaceThemeExtension(namespace: string, name: string): Promise<MarketplaceThemeExtension> {
  const metadata = await fetchExtensionMetadata(namespace, name)
  const manifest = await readPackageManifest(metadata)
  const themes = normalizeThemeContributions(manifest)
  return { ...toSearchResult(metadata), themes }
}

export async function readMarketplaceTheme(namespace: string, name: string, themeId: string): Promise<MarketplaceThemePayload> {
  const metadata = await fetchExtensionMetadata(namespace, name)
  const vsix = await readVsix(metadata)
  const manifest = parseJsonFile(vsix, 'extension/package.json') as PackageManifest
  const themes = normalizeThemeContributions(manifest)
  const contribution = themes.find((theme) => theme.id === themeId || theme.label === themeId)
  if (!contribution) throw new HttpThemeError(404, 'theme not found in extension')
  const theme = readThemeJson(vsix, contribution.path)
  const extension = { ...toSearchResult(metadata), themes }
  return { extension, theme }
}

export class HttpThemeError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

async function fetchExtensionMetadata(namespace: string, name: string): Promise<OpenVsxExtension> {
  const cleanNamespace = encodeURIComponent(namespace.trim())
  const cleanName = encodeURIComponent(name.trim())
  if (!cleanNamespace || !cleanName) throw new HttpThemeError(400, 'extension namespace and name are required')
  const json = await fetchJson(`${OPEN_VSX_BASE_URL}/api/${cleanNamespace}/${cleanName}`, MAX_JSON_BYTES) as OpenVsxExtension
  if (!json.files?.download) throw new HttpThemeError(404, 'extension download is not available')
  return json
}

async function readPackageManifest(metadata: OpenVsxExtension): Promise<PackageManifest> {
  if (metadata.files?.manifest) {
    try {
      return await fetchJson(metadata.files.manifest, MAX_JSON_BYTES) as PackageManifest
    } catch {}
  }
  const vsix = await readVsix(metadata)
  return parseJsonFile(vsix, 'extension/package.json') as PackageManifest
}

async function readVsix(metadata: OpenVsxExtension): Promise<Record<string, Uint8Array>> {
  const downloadUrl = metadata.files?.download
  if (!downloadUrl) throw new HttpThemeError(404, 'extension download is not available')
  await mkdir(CACHE_DIR, { recursive: true })
  const cachePath = join(CACHE_DIR, `${safeName(metadata.namespace)}.${safeName(metadata.name)}-${safeName(metadata.version)}.vsix`)
  let bytes: Uint8Array
  if (existsSync(cachePath)) bytes = new Uint8Array(await readFile(cachePath))
  else {
    bytes = await fetchBytes(downloadUrl, MAX_VSIX_BYTES)
    await writeFile(cachePath, bytes)
  }
  return unzipSync(bytes)
}

function normalizeThemeContributions(manifest: PackageManifest): MarketplaceThemeContribution[] {
  const themes = Array.isArray(manifest.contributes?.themes) ? manifest.contributes.themes : []
  return themes.flatMap((entry, index) => {
    if (!entry || typeof entry !== 'object') return []
    const value = entry as { id?: unknown; label?: unknown; uiTheme?: unknown; path?: unknown }
    const label = typeof value.label === 'string' && value.label.trim() ? value.label.trim() : `Theme ${index + 1}`
    const path = typeof value.path === 'string' ? value.path : ''
    if (!path) return []
    return [{
      id: typeof value.id === 'string' && value.id.trim() ? value.id.trim() : label,
      label,
      uiTheme: typeof value.uiTheme === 'string' ? value.uiTheme : 'vs-dark',
      path,
    }]
  })
}

function readThemeJson(files: Record<string, Uint8Array>, contributionPath: string): unknown {
  const entryPath = normalizeExtensionPath(contributionPath)
  const theme = parseJsonFile(files, entryPath) as Record<string, unknown> & { include?: unknown }
  if (typeof theme.include === 'string' && theme.include.trim()) {
    const includePath = normalizeExtensionPath(posix.join(posix.dirname(entryPath), theme.include))
    const included = parseJsonFile(files, includePath) as Record<string, unknown>
    return { ...included, ...theme, colors: { ...(included.colors as object | undefined), ...(theme.colors as object | undefined) } }
  }
  return theme
}

function parseJsonFile(files: Record<string, Uint8Array>, path: string): unknown {
  const bytes = files[path]
  if (!bytes) throw new HttpThemeError(404, `missing ${path}`)
  if (bytes.byteLength > MAX_JSON_BYTES) throw new HttpThemeError(413, `${path} is too large`)
  return parseJsonc(new TextDecoder().decode(bytes)) as unknown
}

function normalizeExtensionPath(path: string): string {
  const clean = normalize(path.replace(/^\.\//u, '')).replaceAll('\\', '/')
  const full = clean.startsWith('extension/') ? clean : `extension/${clean}`
  if (full.includes('../')) throw new HttpThemeError(400, 'theme path escapes extension root')
  return full
}

async function fetchJson(url: string, maxBytes: number): Promise<unknown> {
  const bytes = await fetchBytes(url, maxBytes)
  return parseJsonc(new TextDecoder().decode(bytes)) as unknown
}

async function fetchBytes(url: string, maxBytes: number): Promise<Uint8Array> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json, application/octet-stream;q=0.9' } })
    if (!res.ok) throw new HttpThemeError(res.status, `Open VSX request failed: HTTP ${res.status}`)
    const contentLength = Number(res.headers.get('content-length') ?? '0')
    if (contentLength > maxBytes) throw new HttpThemeError(413, 'Open VSX response is too large')
    const buffer = new Uint8Array(await res.arrayBuffer())
    if (buffer.byteLength > maxBytes) throw new HttpThemeError(413, 'Open VSX response is too large')
    return buffer
  } catch (err) {
    if (err instanceof HttpThemeError) throw err
    throw new HttpThemeError(502, err instanceof Error ? err.message : String(err))
  } finally {
    clearTimeout(timeout)
  }
}

function toSearchResult(extension: OpenVsxExtension): MarketplaceThemeSearchResult {
  return {
    namespace: String(extension.namespace ?? ''),
    name: String(extension.name ?? ''),
    displayName: String(extension.displayName ?? extension.name ?? ''),
    description: String(extension.description ?? ''),
    version: String(extension.version ?? ''),
    verified: extension.verified === true,
    downloadCount: typeof extension.downloadCount === 'number' ? extension.downloadCount : 0,
    ...(extension.files?.icon ? { iconUrl: extension.files.icon } : {}),
  }
}

function safeName(value: unknown): string {
  return String(value ?? 'unknown').replace(/[^a-zA-Z0-9._-]/gu, '_')
}
