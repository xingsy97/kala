import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { sweBenchRunLayout } from '../swebench/swebench.js'

export const MAX_RESULTS_FILE_BYTES = 20 * 1024 * 1024
export const MAX_RESULTS_TOTAL_BYTES = 40 * 1024 * 1024
export const MAX_RESULTS_FILE_COUNT = 100
const FILE_NAME_PATTERN = /^[A-Za-z0-9._-]+(?:\.[A-Za-z0-9]+)?$/

export type ResultsSource = {
  kind: 'inline'
  files: Record<string, string>
}

export type ResolveResultsInput = {
  rootDir: string
  runId: string
  source: ResultsSource
}

export type ResolveResultsResult = {
  resultsDir: string
  fileCount: number
  bytes: number
  writtenFiles: readonly string[]
}

export async function resolveSweBenchResults(
  input: ResolveResultsInput,
): Promise<ResolveResultsResult> {
  if (!input.rootDir.trim()) throw new Error('rootDir is required')
  if (!input.runId.trim()) throw new Error('runId is required')
  const layout = sweBenchRunLayout(input.rootDir, input.runId)
  await mkdir(layout.gradeResultsDir, { recursive: true })

  const entries = Object.entries(input.source.files)
  if (entries.length === 0) {
    throw new ResultsSourceError('inline results payload is empty', {
      code: 'results_empty',
      httpStatus: 400,
    })
  }
  if (entries.length > MAX_RESULTS_FILE_COUNT) {
    throw new ResultsSourceError(
      `inline results payload has ${entries.length} files, exceeds ${MAX_RESULTS_FILE_COUNT}`,
      { code: 'results_too_many', httpStatus: 413 },
    )
  }

  let totalBytes = 0
  for (const [name, content] of entries) {
    if (!FILE_NAME_PATTERN.test(name) || name.includes('..') || name.includes('/') || name.includes('\\')) {
      throw new ResultsSourceError(
        `results file name '${name}' is not safe`,
        { code: 'results_unsafe_name', httpStatus: 400 },
      )
    }
    if (typeof content !== 'string') {
      throw new ResultsSourceError(
        `results file '${name}' must be a string`,
        { code: 'results_invalid_content', httpStatus: 400 },
      )
    }
    const bytes = Buffer.byteLength(content, 'utf8')
    if (bytes > MAX_RESULTS_FILE_BYTES) {
      throw new ResultsSourceError(
        `results file '${name}' is ${bytes} bytes, exceeds ${MAX_RESULTS_FILE_BYTES}`,
        { code: 'results_file_too_large', httpStatus: 413 },
      )
    }
    totalBytes += bytes
    if (totalBytes > MAX_RESULTS_TOTAL_BYTES) {
      throw new ResultsSourceError(
        `total results payload exceeds ${MAX_RESULTS_TOTAL_BYTES} bytes`,
        { code: 'results_total_too_large', httpStatus: 413 },
      )
    }
  }

  const written: string[] = []
  for (const [name, content] of entries) {
    const destPath = join(layout.gradeResultsDir, name)
    await writeFile(destPath, content, 'utf8')
    written.push(destPath)
  }

  return {
    resultsDir: layout.gradeResultsDir,
    fileCount: entries.length,
    bytes: totalBytes,
    writtenFiles: written,
  }
}

export class ResultsSourceError extends Error {
  readonly code: string
  readonly httpStatus: number
  constructor(message: string, options: { code: string; httpStatus: number }) {
    super(message)
    this.name = 'ResultsSourceError'
    this.code = options.code
    this.httpStatus = options.httpStatus
  }
}
