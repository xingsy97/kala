import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { z } from 'zod'

import type { CatalogModel, LoadedModelCatalog } from './types.js'

const DEFAULT_URL = 'https://models.dev/api.json'
const DEFAULT_MAX_AGE_MS = 6 * 60 * 60 * 1_000

const LimitSchema = z.object({
  context: z.number().int().nonnegative(),
  input: z.number().int().nonnegative().optional(),
  output: z.number().int().nonnegative().optional(),
}).passthrough()
const ModelSchema = z.object({
  id: z.string().min(1),
  limit: LimitSchema,
}).passthrough()
const ProviderSchema = z.object({
  id: z.string().min(1).optional(),
  models: z.record(z.string(), ModelSchema),
}).passthrough()
const ModelsDevSchema = z.record(z.string(), ProviderSchema)

type CacheMetadata = {
  fetchedAt: string
  etag?: string
  lastModified?: string
}

export type ModelsDevCatalogOptions = {
  url?: string
  seedPath?: string
  cachePath?: string
  cacheMetadataPath?: string
  maxAgeMs?: number
  fetch?: typeof fetch
  timeoutMs?: number
  now?: () => Date
}

export class ModelsDevCatalog {
  readonly url: string
  readonly seedPath: string
  readonly cachePath: string
  readonly cacheMetadataPath: string
  readonly maxAgeMs: number
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number
  private readonly now: () => Date

  constructor(options: ModelsDevCatalogOptions = {}) {
    const cacheDir = join(homedir(), '.cache', 'agent-runlab', 'model-catalog')
    this.url = options.url ?? process.env.AGENT_RUNLAB_MODELS_DEV_URL ?? DEFAULT_URL
    this.seedPath = options.seedPath ?? process.env.AGENT_RUNLAB_MODELS_DEV_SEED ?? defaultSeedPath()
    this.cachePath = options.cachePath ?? process.env.AGENT_RUNLAB_MODELS_DEV_CACHE ?? join(cacheDir, 'models-dev.json')
    this.cacheMetadataPath = options.cacheMetadataPath ?? `${this.cachePath}.metadata.json`
    this.maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.timeoutMs = options.timeoutMs ?? 10_000
    this.now = options.now ?? (() => new Date())
  }

  async loadBestAvailable(): Promise<{ catalog?: LoadedModelCatalog; stale: boolean }> {
    const cacheMetadata = await readCacheMetadata(this.cacheMetadataPath)
    const cache = await this.loadCatalogFile(this.cachePath, 'models.dev-cache', cacheMetadata?.fetchedAt)
    if (cache) {
      const fetchedAt = Date.parse(cache.updatedAt)
      return { catalog: cache, stale: !Number.isFinite(fetchedAt) || this.now().getTime() - fetchedAt > this.maxAgeMs }
    }

    const seed = await this.loadCatalogFile(this.seedPath, 'models.dev-seed')
    return { ...(seed ? { catalog: seed } : {}), stale: true }
  }

  async refresh(): Promise<LoadedModelCatalog | undefined> {
    if (/^(?:1|true|yes)$/i.test(process.env.AGENT_RUNLAB_DISABLE_MODEL_CATALOG_REFRESH ?? '')) return undefined
    const metadata = await readCacheMetadata(this.cacheMetadataPath)
    const headers = new Headers()
    if (metadata?.etag) headers.set('If-None-Match', metadata.etag)
    if (metadata?.lastModified) headers.set('If-Modified-Since', metadata.lastModified)

    const response = await this.fetchImpl(this.url, { headers, signal: AbortSignal.timeout(this.timeoutMs) })
    if (response.status === 304) {
      const existing = await this.loadCatalogFile(this.cachePath, 'models.dev-cache', this.now().toISOString())
      if (!existing) return undefined
      await atomicWriteJson(this.cacheMetadataPath, {
        ...metadata,
        fetchedAt: existing.updatedAt,
      } satisfies CacheMetadata)
      return existing
    }
    if (!response.ok) throw new Error(`models.dev returned HTTP ${response.status}`)

    const raw = await response.text()
    const models = parseModelsDevCatalog(JSON.parse(raw) as unknown)
    const fetchedAt = this.now().toISOString()
    await atomicWrite(this.cachePath, raw.endsWith('\n') ? raw : `${raw}\n`)
    await atomicWriteJson(this.cacheMetadataPath, {
      fetchedAt,
      ...(response.headers.get('etag') ? { etag: response.headers.get('etag')! } : {}),
      ...(response.headers.get('last-modified') ? { lastModified: response.headers.get('last-modified')! } : {}),
    } satisfies CacheMetadata)
    return { models, source: 'models.dev-live', updatedAt: fetchedAt }
  }

  private async loadCatalogFile(
    path: string,
    source: LoadedModelCatalog['source'],
    updatedAt?: string,
  ): Promise<LoadedModelCatalog | undefined> {
    try {
      const [raw, info] = await Promise.all([readFile(path, 'utf8'), stat(path)])
      return {
        models: parseModelsDevCatalog(JSON.parse(raw) as unknown),
        source,
        updatedAt: updatedAt ?? info.mtime.toISOString(),
      }
    } catch {
      return undefined
    }
  }
}

export function parseModelsDevCatalog(value: unknown): CatalogModel[] {
  const providers = ModelsDevSchema.parse(value)
  return Object.entries(providers).flatMap(([providerKey, provider]) =>
    Object.entries(provider.models).flatMap(([modelKey, model]) => {
      if (model.limit.context <= 0) return []
      return [{
        providerId: provider.id ?? providerKey,
        modelId: model.id || modelKey,
        limits: {
          context: model.limit.context,
          ...(model.limit.input && model.limit.input > 0 ? { input: model.limit.input } : {}),
          ...(model.limit.output && model.limit.output > 0 ? { output: model.limit.output } : {}),
        },
      }]
    }),
  )
}

function defaultSeedPath(): string {
  const executableAdjacent = join(dirname(resolve(process.argv[1] ?? process.execPath)), 'kala-model-catalog-seed.json')
  const installed = join(homedir(), '.local', 'share', 'agent-runlab', 'model-catalog', 'models-dev-seed.json')
  const sourceTree = resolve(process.cwd(), 'resources', 'model-catalog', 'models-dev-seed.json')
  if (existsSync(installed)) return installed
  return existsSync(executableAdjacent) ? executableAdjacent : sourceTree
}

async function readCacheMetadata(path: string): Promise<CacheMetadata | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<CacheMetadata>
    return typeof parsed.fetchedAt === 'string' ? parsed as CacheMetadata : undefined
  } catch {
    return undefined
  }
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`)
}

async function atomicWrite(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporary, value, 'utf8')
  await rename(temporary, path)
}
