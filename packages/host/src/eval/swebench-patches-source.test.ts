import { mkdtempSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  MAX_PATCH_BYTES,
  MAX_PATCH_COUNT,
  MAX_TOTAL_PATCH_BYTES,
  PatchesSourceError,
  resolveSweBenchPatches,
} from './swebench-patches-source.js'

describe('resolveSweBenchPatches', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'swebench-patches-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes each entry as <instance_id>.diff and reports counts', async () => {
    const result = await resolveSweBenchPatches({
      rootDir: dir,
      runId: 'run-a',
      source: {
        kind: 'inline',
        patches: {
          'astropy__astropy-12907': 'diff --git a/x b/x\n+one\n',
          'django__django-11039': 'diff --git a/y b/y\n+two\n',
        },
      },
    })

    expect(result.patchesDir).toBe(join(dir, 'run-a', 'patches'))
    expect(result.instanceCount).toBe(2)
    expect(result.bytes).toBeGreaterThan(0)
    expect(result.writtenFiles).toHaveLength(2)

    const first = await readFile(join(result.patchesDir, 'astropy__astropy-12907.diff'), 'utf8')
    expect(first).toBe('diff --git a/x b/x\n+one\n')
    const second = await readFile(join(result.patchesDir, 'django__django-11039.diff'), 'utf8')
    expect(second).toBe('diff --git a/y b/y\n+two\n')
  })

  it('rejects empty payloads with 400', async () => {
    await expect(
      resolveSweBenchPatches({ rootDir: dir, runId: 'run-b', source: { kind: 'inline', patches: {} } }),
    ).rejects.toMatchObject({
      name: 'PatchesSourceError',
      httpStatus: 400,
      code: 'patches_empty',
    })
  })

  it('rejects unsafe instance ids (path traversal, slashes)', async () => {
    for (const bad of ['../evil', 'a/b', 'a\\b', 'has space', '']) {
      await expect(
        resolveSweBenchPatches({
          rootDir: dir,
          runId: 'run-c',
          source: { kind: 'inline', patches: { [bad]: 'x' } },
        }),
      ).rejects.toBeInstanceOf(PatchesSourceError)
    }
  })

  it('rejects when a single patch exceeds MAX_PATCH_BYTES with 413', async () => {
    const oversize = 'x'.repeat(MAX_PATCH_BYTES + 1)
    await expect(
      resolveSweBenchPatches({
        rootDir: dir,
        runId: 'run-d',
        source: { kind: 'inline', patches: { 'inst-a': oversize } },
      }),
    ).rejects.toMatchObject({
      name: 'PatchesSourceError',
      httpStatus: 413,
      code: 'patch_too_large',
    })
  })

  it('rejects when total payload exceeds MAX_TOTAL_PATCH_BYTES with 413', async () => {
    const nearMax = 'x'.repeat(MAX_PATCH_BYTES)
    const patches: Record<string, string> = {}
    const chunks = Math.ceil(MAX_TOTAL_PATCH_BYTES / MAX_PATCH_BYTES) + 2
    for (let i = 0; i < chunks; i += 1) patches[`inst-${i}`] = nearMax
    await expect(
      resolveSweBenchPatches({
        rootDir: dir,
        runId: 'run-e',
        source: { kind: 'inline', patches },
      }),
    ).rejects.toMatchObject({
      name: 'PatchesSourceError',
      httpStatus: 413,
      code: 'patches_total_too_large',
    })
  })

  it('rejects when entry count exceeds MAX_PATCH_COUNT with 413', async () => {
    const patches: Record<string, string> = {}
    for (let i = 0; i < MAX_PATCH_COUNT + 1; i += 1) patches[`inst-${i}`] = 'x'
    await expect(
      resolveSweBenchPatches({
        rootDir: dir,
        runId: 'run-f',
        source: { kind: 'inline', patches },
      }),
    ).rejects.toMatchObject({
      name: 'PatchesSourceError',
      httpStatus: 413,
      code: 'patches_too_many',
    })
  })

  it('rejects non-string values with 400', async () => {
    await expect(
      resolveSweBenchPatches({
        rootDir: dir,
        runId: 'run-g',
        source: { kind: 'inline', patches: { 'inst-a': 42 as unknown as string } },
      }),
    ).rejects.toMatchObject({
      name: 'PatchesSourceError',
      httpStatus: 400,
      code: 'patches_invalid_content',
    })
  })

  it('requires rootDir and runId', async () => {
    await expect(
      resolveSweBenchPatches({ rootDir: '  ', runId: 'x', source: { kind: 'inline', patches: { a: 'b' } } }),
    ).rejects.toThrow(/rootDir is required/)
    await expect(
      resolveSweBenchPatches({ rootDir: dir, runId: '  ', source: { kind: 'inline', patches: { a: 'b' } } }),
    ).rejects.toThrow(/runId is required/)
  })
})
