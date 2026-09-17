import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createSandbox } from './sandbox.js'
import { workspaceExec } from './workspace-exec.js'
import { workspaceReadBinary } from './workspace-read-binary.js'

describe('workspaceExec', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ak-wsx-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('runs a simple command and captures stdout', async () => {
    const sandbox = createSandbox({ roots: [root] })
    const res = await workspaceExec(
      { requestId: 'r1', workspaceId: 'w', argv: ['/bin/echo', 'hello'] },
      sandbox,
    )
    expect(res.exitCode).toBe(0)
    expect(res.stdout.trim()).toBe('hello')
    expect(res.error).toBeUndefined()
  })

  it('captures non-zero exit codes without treating them as errors', async () => {
    const sandbox = createSandbox({ roots: [root] })
    const res = await workspaceExec(
      { requestId: 'r2', workspaceId: 'w', argv: ['/bin/sh', '-c', 'exit 7'] },
      sandbox,
    )
    expect(res.exitCode).toBe(7)
    expect(res.error).toBeUndefined()
  })

  it('rejects cwd outside the sandbox', async () => {
    const sandbox = createSandbox({ roots: [root] })
    const res = await workspaceExec(
      { requestId: 'r3', workspaceId: 'w', cwd: '/etc', argv: ['/bin/pwd'] },
      sandbox,
    )
    expect(res.error?.code).toBe('EACCES')
    expect(res.exitCode).toBeNull()
  })

  it('surfaces ENOENT for a missing binary', async () => {
    const sandbox = createSandbox({ roots: [root] })
    const res = await workspaceExec(
      { requestId: 'r4', workspaceId: 'w', argv: ['/no/such/binary'] },
      sandbox,
    )
    expect(res.error?.code).toBe('ENOENT')
  })

  it('kills long-running processes past timeoutMs and reports ETIMEDOUT', async () => {
    const sandbox = createSandbox({ roots: [root] })
    const res = await workspaceExec(
      { requestId: 'r5', workspaceId: 'w', argv: ['/bin/sleep', '5'], timeoutMs: 150 },
      sandbox,
    )
    expect(res.error?.code).toBe('ETIMEDOUT')
    expect(res.durationMs).toBeGreaterThanOrEqual(100)
  })

  it('records truncation without dropping the stream', async () => {
    const sandbox = createSandbox({ roots: [root] })
    // 8KB of output but cap at 1KB.
    const res = await workspaceExec(
      { requestId: 'r6', workspaceId: 'w', argv: ['/bin/sh', '-c', 'head -c 8192 /dev/urandom | base64'], maxOutputBytes: 1024 },
      sandbox,
    )
    expect(res.truncated).toBeDefined()
    expect(res.truncated!.stdoutBytes).toBeGreaterThan(1024)
  })
})

describe('workspaceReadBinary', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ak-wsrb-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('reads a small text file and detects text/plain', async () => {
    writeFileSync(join(root, 'a.txt'), 'hello world\n')
    const sandbox = createSandbox({ roots: [root] })
    const res = await workspaceReadBinary(
      { requestId: 'r1', workspaceId: 'w', path: join(root, 'a.txt') },
      sandbox,
    )
    expect(res.error).toBeUndefined()
    expect(Buffer.from(res.base64, 'base64').toString()).toBe('hello world\n')
    expect(res.mime).toBe('text/plain')
  })

  it('resolves relative reads against the supplied cwd', async () => {
    mkdirSync(join(root, 'pkg'), { recursive: true })
    writeFileSync(join(root, 'pkg', 'local.md'), '# local\n')
    const sandbox = createSandbox({ roots: [root] })
    const res = await workspaceReadBinary(
      { requestId: 'r1-cwd', workspaceId: 'w', path: 'local.md', cwd: join(root, 'pkg') },
      sandbox,
    )
    expect(res.error).toBeUndefined()
    expect(Buffer.from(res.base64, 'base64').toString()).toBe('# local\n')
  })

  it('detects PNG magic bytes', async () => {
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0])
    writeFileSync(join(root, 'a.png'), buf)
    const sandbox = createSandbox({ roots: [root] })
    const res = await workspaceReadBinary(
      { requestId: 'r2', workspaceId: 'w', path: join(root, 'a.png') },
      sandbox,
    )
    expect(res.mime).toBe('image/png')
  })

  it('truncates when file exceeds maxBytes and reports it', async () => {
    const big = Buffer.alloc(4096, 0x41)
    writeFileSync(join(root, 'big.bin'), big)
    const sandbox = createSandbox({ roots: [root] })
    const res = await workspaceReadBinary(
      { requestId: 'r3', workspaceId: 'w', path: join(root, 'big.bin'), maxBytes: 512 },
      sandbox,
    )
    expect(res.truncated).toEqual({ maxBytes: 512 })
    expect(Buffer.from(res.base64, 'base64').length).toBe(512)
    expect(res.size).toBe(4096)
  })

  it('reads ranged chunks for large dashboard downloads without loading the whole file', async () => {
    const big = Buffer.from('0123456789abcdef')
    writeFileSync(join(root, 'big.bin'), big)
    const sandbox = createSandbox({ roots: [root] })
    const first = await workspaceReadBinary(
      { requestId: 'r3a', workspaceId: 'w', path: join(root, 'big.bin'), maxBytes: 5 },
      sandbox,
    )
    const second = await workspaceReadBinary(
      { requestId: 'r3b', workspaceId: 'w', path: join(root, 'big.bin'), offset: 5, maxBytes: 5 },
      sandbox,
    )
    const final = await workspaceReadBinary(
      { requestId: 'r3c', workspaceId: 'w', path: join(root, 'big.bin'), offset: 10, maxBytes: 10 },
      sandbox,
    )
    expect(Buffer.from(first.base64, 'base64').toString()).toBe('01234')
    expect(Buffer.from(second.base64, 'base64').toString()).toBe('56789')
    expect(Buffer.from(final.base64, 'base64').toString()).toBe('abcdef')
    expect(first.offset).toBe(0)
    expect(second.offset).toBe(5)
    expect(final.offset).toBe(10)
    expect(first.truncated).toEqual({ maxBytes: 5 })
    expect(second.truncated).toEqual({ maxBytes: 5 })
    expect(final.truncated).toBeUndefined()
    expect(final.size).toBe(big.length)
  })

  it('rejects paths outside the sandbox', async () => {
    const sandbox = createSandbox({ roots: [root] })
    const res = await workspaceReadBinary(
      { requestId: 'r4', workspaceId: 'w', path: '/etc/passwd' },
      sandbox,
    )
    expect(res.error?.code).toBe('EACCES')
  })

  it('rejects directories', async () => {
    mkdirSync(join(root, 'sub'))
    const sandbox = createSandbox({ roots: [root] })
    const res = await workspaceReadBinary(
      { requestId: 'r5', workspaceId: 'w', path: join(root, 'sub') },
      sandbox,
    )
    expect(res.error?.code).toBe('EINVAL')
  })
})
