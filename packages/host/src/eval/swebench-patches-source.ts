import { mkdir, writeFile } from 'node:fs/promises'

import { sweBenchRunLayout } from './swebench.js'

export const MAX_PATCH_BYTES = 2 * 1024 * 1024
export const MAX_TOTAL_PATCH_BYTES = 20 * 1024 * 1024
export const MAX_PATCH_COUNT = 500
const INSTANCE_ID_PATTERN = /^[A-Za-z0-9._-]+$/

export type PatchesSource = {
  kind: 'inline'
  patches: Record<string, string>
}

export type ResolvePatchesInput = {
  rootDir: string
  runId: string
  source: PatchesSource
}

export type ResolvePatchesResult = {
  patchesDir: string
  instanceCount: number
  bytes: number
  writtenFiles: readonly string[]
}

export async function resolveSweBenchPatches(
  input: ResolvePatchesInput,
): Promise<ResolvePatchesResult> {
  if (!input.rootDir.trim()) throw new Error('rootDir is required')
  if (!input.runId.trim()) throw new Error('runId is required')
  const layout = sweBenchRunLayout(input.rootDir, input.runId)
  await mkdir(layout.patchesDir, { recursive: true })

  const entries = Object.entries(input.source.patches)
  if (entries.length === 0) {
    throw new PatchesSourceError('inline patches payload is empty', {
      code: 'patches_empty',
      httpStatus: 400,
    })
  }
  if (entries.length > MAX_PATCH_COUNT) {
    throw new PatchesSourceError(
      `inline patches payload has ${entries.length} entries, exceeds ${MAX_PATCH_COUNT}`,
      { code: 'patches_too_many', httpStatus: 413 },
    )
  }

  let totalBytes = 0
  for (const [instanceId, content] of entries) {
    if (!INSTANCE_ID_PATTERN.test(instanceId)) {
      throw new PatchesSourceError(
        `patch key '${instanceId}' is not a safe instance id`,
        { code: 'patches_unsafe_key', httpStatus: 400 },
      )
    }
    if (typeof content !== 'string') {
      throw new PatchesSourceError(
        `patch for '${instanceId}' must be a string`,
        { code: 'patches_invalid_content', httpStatus: 400 },
      )
    }
    const bytes = Buffer.byteLength(content, 'utf8')
    if (bytes > MAX_PATCH_BYTES) {
      throw new PatchesSourceError(
        `patch for '${instanceId}' is ${bytes} bytes, exceeds ${MAX_PATCH_BYTES}`,
        { code: 'patch_too_large', httpStatus: 413 },
      )
    }
    totalBytes += bytes
    if (totalBytes > MAX_TOTAL_PATCH_BYTES) {
      throw new PatchesSourceError(
        `total patch payload exceeds ${MAX_TOTAL_PATCH_BYTES} bytes`,
        { code: 'patches_total_too_large', httpStatus: 413 },
      )
    }
  }

  const written: string[] = []
  for (const [instanceId, content] of entries) {
    const destPath = `${layout.patchesDir}/${instanceId}.diff`
    await writeFile(destPath, content, 'utf8')
    written.push(destPath)
  }

  return {
    patchesDir: layout.patchesDir,
    instanceCount: entries.length,
    bytes: totalBytes,
    writtenFiles: written,
  }
}

export class PatchesSourceError extends Error {
  readonly code: string
  readonly httpStatus: number
  constructor(message: string, options: { code: string; httpStatus: number }) {
    super(message)
    this.name = 'PatchesSourceError'
    this.code = options.code
    this.httpStatus = options.httpStatus
  }
}
