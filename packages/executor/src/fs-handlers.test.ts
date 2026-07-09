import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { listDirs, readWorkspaceFile } from './fs-handlers.js'
import { createSandbox } from './sandbox.js'

describe('filesystem inspection handlers', () => {
  let root: string

  beforeEach(() => {
    root = join(tmpdir(), `ak-fs-${randomUUID()}`)
    mkdirSync(root, { recursive: true })
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('lists directories and files with stable type metadata', async () => {
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'README.md'), 'hello', 'utf8')

    const result = await listDirs('r1', 'w1', root, createSandbox({ roots: [root] }))

    expect(result.error).toBeUndefined()
    expect(result.entries.map((entry) => ({ name: entry.name, type: entry.type }))).toEqual([
      { name: 'src', type: 'directory' },
      { name: 'README.md', type: 'file' },
    ])
  })

  it('returns a capped view for large text files', async () => {
    const path = join(root, 'large.txt')
    writeFileSync(path, 'x'.repeat(128), 'utf8')

    const result = await readWorkspaceFile({ requestId: 'r1', workspaceId: 'w1', path, maxBytes: 16 }, createSandbox({ roots: [root] }))

    expect(result.kind).toBe('too_large')
    expect(result.truncated).toBe(true)
    expect(result.size).toBe(128)
    expect(result.content).toBe('x'.repeat(16))
  })

  it('does not return binary file contents', async () => {
    const path = join(root, 'image.bin')
    writeFileSync(path, Buffer.from([0, 1, 2, 3, 4, 5]))

    const result = await readWorkspaceFile({ requestId: 'r1', workspaceId: 'w1', path }, createSandbox({ roots: [root] }))

    expect(result.kind).toBe('binary')
    expect(result.content).toBeUndefined()
    expect(result.error).toContain('EBINARY')
  })

  it('returns small image files as base64 views', async () => {
    const path = join(root, 'image.png')
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47])
    writeFileSync(path, bytes)

    const result = await readWorkspaceFile({ requestId: 'r1', workspaceId: 'w1', path }, createSandbox({ roots: [root] }))

    expect(result.kind).toBe('image')
    expect(result.encoding).toBe('base64')
    expect(result.mediaType).toBe('image/png')
    expect(result.content).toBe(bytes.toString('base64'))
  })

  it('returns PDF files as base64 views before binary probing', async () => {
    const path = join(root, 'report.pdf')
    const bytes = Buffer.from('%PDF-1.7\n\0binary-ish')
    writeFileSync(path, bytes)

    const result = await readWorkspaceFile({ requestId: 'r1', workspaceId: 'w1', path }, createSandbox({ roots: [root] }))

    expect(result.kind).toBe('pdf')
    expect(result.encoding).toBe('base64')
    expect(result.mediaType).toBe('application/pdf')
    expect(result.content).toBe(bytes.toString('base64'))
  })
})
