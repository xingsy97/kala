import { mkdtempSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  ContentInputError,
  MAX_UPLOAD_CONTENT_BYTES,
  resolveContentToPath,
} from './content-inputs.js'

describe('resolveContentToPath', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'content-inputs-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns the explicit path when provided', async () => {
    const result = await resolveContentToPath(
      { path: '/tmp/x.jsonl' },
      { action: 'eval-score-session', field: 'sessionLog', extension: '.jsonl', rootDir: dir },
    )
    expect(result).toBe('/tmp/x.jsonl')
  })

  it('writes inline content under uploads/<action>/<uuid>/<field>.<ext>', async () => {
    const result = await resolveContentToPath(
      { content: '{"a":1}\n' },
      { action: 'eval-score-session', field: 'sessionLog', extension: '.jsonl', rootDir: dir },
    )
    expect(result).toMatch(new RegExp(`^${dir}/uploads/eval-score-session/[0-9a-f-]{36}/sessionLog\\.jsonl$`))
    const roundTrip = await readFile(result, 'utf8')
    expect(roundTrip).toBe('{"a":1}\n')
  })

  it('normalizes an extension without leading dot', async () => {
    const result = await resolveContentToPath(
      { content: 'hi' },
      { action: 'eval-judge-score', field: 'prompt', extension: 'txt', rootDir: dir },
    )
    expect(result.endsWith('/prompt.txt')).toBe(true)
  })

  it('accepts an empty extension', async () => {
    const result = await resolveContentToPath(
      { content: 'raw' },
      { action: 'eval-judge-score', field: 'prompt', extension: '', rootDir: dir },
    )
    expect(result.endsWith('/prompt')).toBe(true)
  })

  it('resolves a sessionId through the resolver when neither path nor content is provided', async () => {
    const result = await resolveContentToPath(
      { sessionId: 'abc123' },
      {
        action: 'profile-session',
        field: 'sessionLog',
        extension: '.jsonl',
        rootDir: dir,
        sessionResolver: async (id) => `/sessions/${id}.jsonl`,
      },
    )
    expect(result).toBe('/sessions/abc123.jsonl')
  })

  it('rejects content exceeding maxBytes with 413', async () => {
    const oversize = 'x'.repeat(MAX_UPLOAD_CONTENT_BYTES + 1)
    await expect(
      resolveContentToPath(
        { content: oversize },
        { action: 'eval-judge-score', field: 'prompt', extension: '.json', rootDir: dir },
      ),
    ).rejects.toMatchObject({
      name: 'ContentInputError',
      code: 'content_too_large',
      httpStatus: 413,
    })
  })

  it('rejects non-string content with 400', async () => {
    await expect(
      resolveContentToPath(
        { content: 42 as unknown as string },
        { action: 'eval-judge-score', field: 'prompt', extension: '.json', rootDir: dir },
      ),
    ).rejects.toMatchObject({
      name: 'ContentInputError',
      code: 'content_invalid_type',
      httpStatus: 400,
    })
  })

  it('rejects unsafe field or action names', async () => {
    await expect(
      resolveContentToPath(
        { content: 'ok' },
        { action: 'eval-judge-score', field: '../bad', extension: '.json', rootDir: dir },
      ),
    ).rejects.toBeInstanceOf(ContentInputError)
    await expect(
      resolveContentToPath(
        { content: 'ok' },
        { action: '../bad', field: 'prompt', extension: '.json', rootDir: dir },
      ),
    ).rejects.toBeInstanceOf(ContentInputError)
  })

  it('errors when nothing is provided and no session resolver applies', async () => {
    await expect(
      resolveContentToPath(
        {},
        { action: 'eval-judge-score', field: 'prompt', extension: '.json', rootDir: dir },
      ),
    ).rejects.toMatchObject({
      name: 'ContentInputError',
      code: 'content_missing',
      httpStatus: 400,
    })
  })
})
