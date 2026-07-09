import { mkdtempSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  MAX_RESULTS_FILE_BYTES,
  MAX_RESULTS_FILE_COUNT,
  MAX_RESULTS_TOTAL_BYTES,
  ResultsSourceError,
  resolveSweBenchResults,
} from './swebench-results-source.js'

describe('resolveSweBenchResults', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'swebench-results-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes each file under grade-results and reports counts', async () => {
    const result = await resolveSweBenchResults({
      rootDir: dir,
      runId: 'run-a',
      source: {
        kind: 'inline',
        files: {
          'instance_results.jsonl': '{"instance_id":"a","resolved":true}\n',
          'summary.json': '{"total":1}',
        },
      },
    })

    expect(result.resultsDir).toBe(join(dir, 'run-a', 'grade-results'))
    expect(result.fileCount).toBe(2)
    expect(result.bytes).toBeGreaterThan(0)
    expect(result.writtenFiles).toHaveLength(2)

    const first = await readFile(join(result.resultsDir, 'instance_results.jsonl'), 'utf8')
    expect(first).toBe('{"instance_id":"a","resolved":true}\n')
    const second = await readFile(join(result.resultsDir, 'summary.json'), 'utf8')
    expect(second).toBe('{"total":1}')
  })

  it('rejects empty payloads with 400', async () => {
    await expect(
      resolveSweBenchResults({ rootDir: dir, runId: 'run-b', source: { kind: 'inline', files: {} } }),
    ).rejects.toMatchObject({
      name: 'ResultsSourceError',
      httpStatus: 400,
      code: 'results_empty',
    })
  })

  it('rejects unsafe file names (traversal, slashes)', async () => {
    for (const bad of ['../evil', 'a/b', 'a\\b', 'has space', '']) {
      await expect(
        resolveSweBenchResults({
          rootDir: dir,
          runId: 'run-c',
          source: { kind: 'inline', files: { [bad]: 'x' } },
        }),
      ).rejects.toBeInstanceOf(ResultsSourceError)
    }
  })

  it('rejects when a single file exceeds MAX_RESULTS_FILE_BYTES with 413', async () => {
    const oversize = 'x'.repeat(MAX_RESULTS_FILE_BYTES + 1)
    await expect(
      resolveSweBenchResults({
        rootDir: dir,
        runId: 'run-d',
        source: { kind: 'inline', files: { 'big.jsonl': oversize } },
      }),
    ).rejects.toMatchObject({
      name: 'ResultsSourceError',
      httpStatus: 413,
      code: 'results_file_too_large',
    })
  })

  it('rejects when total exceeds MAX_RESULTS_TOTAL_BYTES with 413', async () => {
    const near = 'x'.repeat(MAX_RESULTS_FILE_BYTES)
    const files: Record<string, string> = {}
    const chunks = Math.ceil(MAX_RESULTS_TOTAL_BYTES / MAX_RESULTS_FILE_BYTES) + 2
    for (let i = 0; i < chunks; i += 1) files[`f${i}.jsonl`] = near
    await expect(
      resolveSweBenchResults({
        rootDir: dir,
        runId: 'run-e',
        source: { kind: 'inline', files },
      }),
    ).rejects.toMatchObject({
      name: 'ResultsSourceError',
      httpStatus: 413,
      code: 'results_total_too_large',
    })
  })

  it('rejects when file count exceeds MAX_RESULTS_FILE_COUNT with 413', async () => {
    const files: Record<string, string> = {}
    for (let i = 0; i < MAX_RESULTS_FILE_COUNT + 1; i += 1) files[`f${i}.json`] = 'x'
    await expect(
      resolveSweBenchResults({
        rootDir: dir,
        runId: 'run-f',
        source: { kind: 'inline', files },
      }),
    ).rejects.toMatchObject({
      name: 'ResultsSourceError',
      httpStatus: 413,
      code: 'results_too_many',
    })
  })

  it('rejects non-string values with 400', async () => {
    await expect(
      resolveSweBenchResults({
        rootDir: dir,
        runId: 'run-g',
        source: { kind: 'inline', files: { 'a.jsonl': 42 as unknown as string } },
      }),
    ).rejects.toMatchObject({
      name: 'ResultsSourceError',
      httpStatus: 400,
      code: 'results_invalid_content',
    })
  })
})
