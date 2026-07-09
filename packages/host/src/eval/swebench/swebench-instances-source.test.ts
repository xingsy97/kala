import { mkdtempSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  InstancesSourceError,
  MAX_INLINE_INSTANCES_BYTES,
  resolveSweBenchInstances,
} from './swebench-instances-source.js'

describe('resolveSweBenchInstances - inline', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'swebench-inline-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes canonical JSONL and reports row count for a valid inline payload', async () => {
    const content = '{"instance_id":"a","repo":"x"}\n{"instance_id":"b","repo":"y"}\n'
    const result = await resolveSweBenchInstances({
      rootDir: dir,
      runId: 'run-inline',
      source: { kind: 'inline', content },
    })

    expect(result.rowCount).toBe(2)
    expect(result.source.kind).toBe('inline')
    expect(result.instancesJsonlPath).toBe(join(dir, 'run-inline', 'instances.jsonl'))
    const persisted = await readFile(result.instancesJsonlPath, 'utf8')
    expect(persisted).toBe(content)
  })

  it('tolerates blank lines between rows', async () => {
    const content = '{"instance_id":"a"}\n\n{"instance_id":"b"}\n\n'
    const result = await resolveSweBenchInstances({
      rootDir: dir,
      runId: 'run-inline-blanks',
      source: { kind: 'inline', content },
    })
    expect(result.rowCount).toBe(2)
    const persisted = await readFile(result.instancesJsonlPath, 'utf8')
    expect(persisted.split('\n').filter((line) => line.length > 0)).toHaveLength(2)
  })

  it('rejects rows missing instance_id with a 400', async () => {
    await expect(
      resolveSweBenchInstances({
        rootDir: dir,
        runId: 'run-bad',
        source: { kind: 'inline', content: '{"repo":"x"}\n' },
      }),
    ).rejects.toMatchObject({ name: 'InstancesSourceError', httpStatus: 400, code: 'inline_missing_instance_id' })
  })

  it('rejects malformed JSON lines with a 400', async () => {
    await expect(
      resolveSweBenchInstances({
        rootDir: dir,
        runId: 'run-bad-json',
        source: { kind: 'inline', content: '{"instance_id":"a"}\nnot-json\n' },
      }),
    ).rejects.toBeInstanceOf(InstancesSourceError)
  })

  it('rejects empty payloads with a 400', async () => {
    await expect(
      resolveSweBenchInstances({
        rootDir: dir,
        runId: 'run-empty',
        source: { kind: 'inline', content: '\n\n' },
      }),
    ).rejects.toMatchObject({ code: 'inline_empty', httpStatus: 400 })
  })

  it('rejects payloads over the size limit with a 413', async () => {
    const oneLine = `${JSON.stringify({ instance_id: 'a', filler: 'x'.repeat(1024) })}\n`
    const repeatCount = Math.ceil(MAX_INLINE_INSTANCES_BYTES / oneLine.length) + 1
    const content = oneLine.repeat(repeatCount)
    await expect(
      resolveSweBenchInstances({
        rootDir: dir,
        runId: 'run-huge',
        source: { kind: 'inline', content },
      }),
    ).rejects.toMatchObject({ code: 'inline_too_large', httpStatus: 413 })
  })

  it('rejects arrays and non-object JSON with a 400', async () => {
    await expect(
      resolveSweBenchInstances({
        rootDir: dir,
        runId: 'run-array',
        source: { kind: 'inline', content: '[1,2,3]\n' },
      }),
    ).rejects.toMatchObject({ code: 'inline_invalid_shape', httpStatus: 400 })
  })
})

describe('resolveSweBenchInstances - huggingface', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'swebench-hf-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('paginates through datasets-server responses and writes canonical JSONL', async () => {
    const requestUrls: string[] = []
    const fakeFetch: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      requestUrls.push(url)
      const params = new URL(url).searchParams
      const offset = Number(params.get('offset') ?? '0')
      const length = Number(params.get('length') ?? '100')
      const total = 5
      const start = offset
      const end = Math.min(offset + length, total)
      const rows = []
      for (let i = start; i < end; i++) {
        rows.push({ row_idx: i, row: { instance_id: `hf-${i}`, repo: 'org/repo' } })
      }
      return new Response(JSON.stringify({ rows, num_rows_total: total }), { status: 200 })
    }

    const result = await resolveSweBenchInstances({
      rootDir: dir,
      runId: 'run-hf',
      source: {
        kind: 'huggingface',
        datasetRef: 'princeton-nlp/SWE-bench_Lite',
        limit: 3,
      },
      huggingFaceOverrides: {
        baseUrl: 'http://private-2.example.com',
        fetchImpl: fakeFetch,
      },
    })

    expect(result.rowCount).toBe(3)
    expect(result.source.kind).toBe('huggingface')
    expect(result.source.datasetRef).toBe('princeton-nlp/SWE-bench_Lite')
    expect(result.source.limit).toBe(3)
    expect(requestUrls.length).toBeGreaterThanOrEqual(1)
    const persisted = await readFile(result.instancesJsonlPath, 'utf8')
    const lines = persisted.trim().split('\n')
    expect(lines).toHaveLength(3)
    expect(JSON.parse(lines[0]!)).toMatchObject({ instance_id: 'hf-0' })
  })

  it('forwards a bearer token to datasets-server', async () => {
    let capturedAuth: string | null = null
    const fakeFetch: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers ?? {})
      capturedAuth = headers.get('authorization')
      return new Response(
        JSON.stringify({ rows: [{ row_idx: 0, row: { instance_id: 'x' } }], num_rows_total: 1 }),
        { status: 200 },
      )
    }

    await resolveSweBenchInstances({
      rootDir: dir,
      runId: 'run-hf-token',
      source: {
        kind: 'huggingface',
        datasetRef: 'org/private',
        hfToken: 'secret-token',
      },
      huggingFaceOverrides: { baseUrl: 'http://private-2.example.com', fetchImpl: fakeFetch },
    })

    expect(capturedAuth).toBe('Bearer secret-token')
  })

  it('rejects a dataset row missing instance_id with a 502', async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response(
        JSON.stringify({ rows: [{ row_idx: 0, row: { repo: 'no-id' } }], num_rows_total: 1 }),
        { status: 200 },
      )

    await expect(
      resolveSweBenchInstances({
        rootDir: dir,
        runId: 'run-hf-bad',
        source: { kind: 'huggingface', datasetRef: 'org/broken' },
        huggingFaceOverrides: { baseUrl: 'http://private-2.example.com', fetchImpl: fakeFetch },
      }),
    ).rejects.toMatchObject({ code: 'huggingface_missing_instance_id', httpStatus: 502 })
  })
})
