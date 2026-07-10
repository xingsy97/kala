import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { fetchHuggingFaceRows, type HuggingFaceFetchInput } from '../hf-datasets-server.js'
import { sweBenchRunLayout } from './swebench.js'

export const MAX_INLINE_INSTANCES_BYTES = 20 * 1024 * 1024

export type ResolveInstancesInput = {
  rootDir: string
  runId: string
  source: InstancesSource
  huggingFaceOverrides?: Pick<HuggingFaceFetchInput, 'baseUrl' | 'fetchImpl'>
}

export type InstancesSource =
  | { kind: 'inline'; content: string }
  | {
      kind: 'huggingface'
      datasetRef: string
      config?: string
      split?: string
      limit?: number
      hfToken?: string
    }

export type ResolveInstancesResult = {
  instancesJsonlPath: string
  rowCount: number
  bytes: number
  source: {
    kind: InstancesSource['kind']
    datasetRef?: string
    config?: string
    split?: string
    limit?: number
    requestCount?: number
    totalRows?: number
  }
}

export async function resolveSweBenchInstances(
  input: ResolveInstancesInput,
): Promise<ResolveInstancesResult> {
  if (!input.rootDir.trim()) throw new Error('rootDir is required')
  if (!input.runId.trim()) throw new Error('runId is required')
  const layout = sweBenchRunLayout(input.rootDir, input.runId)
  await mkdir(dirname(layout.instancesPath), { recursive: true })
  if (input.source.kind === 'inline') return persistInline(input.source.content, layout.instancesPath)
  return persistHuggingFace(input, layout.instancesPath)
}

async function persistInline(content: string, destPath: string): Promise<ResolveInstancesResult> {
  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes > MAX_INLINE_INSTANCES_BYTES) {
    throw new InstancesSourceError(
      `inline instances payload is ${bytes} bytes, exceeds ${MAX_INLINE_INSTANCES_BYTES} bytes limit`,
      { code: 'inline_too_large', httpStatus: 413 },
    )
  }
  const rows = parseJsonlContent(content)
  const canonical = `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`
  await writeFile(destPath, canonical, 'utf8')
  return {
    instancesJsonlPath: destPath,
    rowCount: rows.length,
    bytes: Buffer.byteLength(canonical, 'utf8'),
    source: { kind: 'inline' },
  }
}

async function persistHuggingFace(
  input: ResolveInstancesInput,
  destPath: string,
): Promise<ResolveInstancesResult> {
  if (input.source.kind !== 'huggingface') throw new Error('unreachable')
  const result = await fetchHuggingFaceRows({
    datasetRef: input.source.datasetRef,
    ...(input.source.config ? { config: input.source.config } : {}),
    ...(input.source.split ? { split: input.source.split } : {}),
    ...(input.source.limit !== undefined ? { limit: input.source.limit } : {}),
    ...(input.source.hfToken ? { hfToken: input.source.hfToken } : {}),
    ...(input.huggingFaceOverrides?.baseUrl ? { baseUrl: input.huggingFaceOverrides.baseUrl } : {}),
    ...(input.huggingFaceOverrides?.fetchImpl ? { fetchImpl: input.huggingFaceOverrides.fetchImpl } : {}),
  })
  const rows = result.rows.map((row, index) => coerceRow(row, index))
  const canonical = `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`
  await writeFile(destPath, canonical, 'utf8')
  return {
    instancesJsonlPath: destPath,
    rowCount: rows.length,
    bytes: Buffer.byteLength(canonical, 'utf8'),
    source: {
      kind: 'huggingface',
      datasetRef: result.datasetRef,
      config: result.config,
      split: result.split,
      ...(input.source.limit !== undefined ? { limit: input.source.limit } : {}),
      requestCount: result.requestCount,
      totalRows: result.totalRows,
    },
  }
}

function parseJsonlContent(content: string): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = []
  const lines = content.split('\n')
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!.trim()
    if (line.length === 0) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch (err) {
      throw new InstancesSourceError(
        `inline instances line ${index + 1} is not valid JSON: ${(err as Error).message}`,
        { code: 'inline_invalid_json', httpStatus: 400 },
      )
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new InstancesSourceError(
        `inline instances line ${index + 1} must be a JSON object`,
        { code: 'inline_invalid_shape', httpStatus: 400 },
      )
    }
    const row = parsed as Record<string, unknown>
    if (typeof row.instance_id !== 'string' || row.instance_id.trim().length === 0) {
      throw new InstancesSourceError(
        `inline instances line ${index + 1} missing required string instance_id`,
        { code: 'inline_missing_instance_id', httpStatus: 400 },
      )
    }
    rows.push(row)
  }
  if (rows.length === 0) {
    throw new InstancesSourceError('inline instances payload is empty', {
      code: 'inline_empty',
      httpStatus: 400,
    })
  }
  return rows
}

function coerceRow(row: Record<string, unknown>, index: number): Record<string, unknown> {
  if (typeof row.instance_id !== 'string' || row.instance_id.trim().length === 0) {
    throw new InstancesSourceError(
      `huggingface row ${index} missing required string instance_id`,
      { code: 'huggingface_missing_instance_id', httpStatus: 502 },
    )
  }
  return row
}

export class InstancesSourceError extends Error {
  readonly code: string
  readonly httpStatus: number
  constructor(message: string, options: { code: string; httpStatus: number }) {
    super(message)
    this.name = 'InstancesSourceError'
    this.code = options.code
    this.httpStatus = options.httpStatus
  }
}
