import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { ModelsDevCatalog, parseModelsDevCatalog } from './models-dev-catalog.js'

const rawCatalog = {
  openai: {
    id: 'openai',
    models: {
      'gpt-test': { id: 'gpt-test', limit: { context: 1000, input: 800, output: 200 } },
    },
  },
}

describe('ModelsDevCatalog', () => {
  it('validates and flattens models.dev data', () => {
    expect(parseModelsDevCatalog(rawCatalog)).toEqual([{
      providerId: 'openai',
      modelId: 'gpt-test',
      limits: { context: 1000, input: 800, output: 200 },
    }])
    expect(() => parseModelsDevCatalog({ openai: { models: { bad: { id: 'bad', limit: {} } } } })).toThrow()
    expect(parseModelsDevCatalog({ openai: { models: { image: { id: 'image', limit: { context: 0, output: 0 } } } } })).toEqual([])
  })

  it('falls back from a corrupt cache to the external seed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'model-catalog-'))
    const seedPath = join(dir, 'seed.json')
    const cachePath = join(dir, 'cache.json')
    await writeFile(seedPath, JSON.stringify(rawCatalog))
    await writeFile(cachePath, '{broken')
    const result = await new ModelsDevCatalog({ seedPath, cachePath }).loadBestAvailable()
    expect(result.catalog?.source).toBe('models.dev-seed')
    expect(result.catalog?.models[0]?.modelId).toBe('gpt-test')
  })

  it('persists a validated refresh atomically with cache validators', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'model-catalog-'))
    const cachePath = join(dir, 'cache.json')
    const metadataPath = join(dir, 'metadata.json')
    const client = new ModelsDevCatalog({
      seedPath: join(dir, 'missing.json'),
      cachePath,
      cacheMetadataPath: metadataPath,
      now: () => new Date('2026-07-26T12:00:00.000Z'),
      fetch: async () => new Response(JSON.stringify(rawCatalog), {
        status: 200,
        headers: { etag: '"version-1"', 'last-modified': 'Sun, 26 Jul 2026 12:00:00 GMT' },
      }),
    })
    expect((await client.refresh())?.source).toBe('models.dev-live')
    expect(JSON.parse(await readFile(cachePath, 'utf8'))).toEqual(rawCatalog)
    expect(JSON.parse(await readFile(metadataPath, 'utf8'))).toMatchObject({ etag: '"version-1"' })
  })

  it('handles 304 without replacing the cached catalog', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'model-catalog-'))
    const cachePath = join(dir, 'cache.json')
    const metadataPath = join(dir, 'metadata.json')
    await writeFile(cachePath, JSON.stringify(rawCatalog))
    await writeFile(metadataPath, JSON.stringify({ fetchedAt: '2026-07-25T00:00:00.000Z', etag: '"version-1"' }))
    let sentEtag: string | null = null
    const client = new ModelsDevCatalog({
      cachePath,
      cacheMetadataPath: metadataPath,
      now: () => new Date('2026-07-26T12:00:00.000Z'),
      fetch: async (_url, init) => {
        sentEtag = new Headers(init?.headers).get('if-none-match')
        return new Response(null, { status: 304 })
      },
    })
    expect((await client.refresh())?.models[0]?.modelId).toBe('gpt-test')
    expect(sentEtag).toBe('"version-1"')
  })
})
