import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { executorProfileDir, loadOrCreateWorkspaceId, normalizeExecutorProfile, workspaceIdPath } from './workspace-id.js'

describe('loadOrCreateWorkspaceId', () => {
  let dir: string
  let path: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ak-ws-id-'))
    path = join(dir, 'workspace-id')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('mints a fresh ULID when the file is missing', () => {
    expect(existsSync(path)).toBe(false)
    const id = loadOrCreateWorkspaceId(path)
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(existsSync(path)).toBe(true)
    expect(readFileSync(path, 'utf8').trim()).toBe(id)
  })

  it('reads the same id back on subsequent calls', () => {
    const first = loadOrCreateWorkspaceId(path)
    const second = loadOrCreateWorkspaceId(path)
    const third = loadOrCreateWorkspaceId(path)
    expect(second).toBe(first)
    expect(third).toBe(first)
  })

  it('creates the parent directory if missing', () => {
    const nested = join(dir, 'nested', 'sub', 'workspace-id')
    const id = loadOrCreateWorkspaceId(nested)
    expect(existsSync(nested)).toBe(true)
    expect(readFileSync(nested, 'utf8').trim()).toBe(id)
  })

  it('refuses to boot with a corrupted id file', () => {
    writeFileSync(path, 'not-a-ulid', 'utf8')
    expect(() => loadOrCreateWorkspaceId(path)).toThrow(/Invalid workspace id/)
  })

  it('uses an isolated workspace id path for a named profile', () => {
    const profilePath = workspaceIdPath('dev')
    expect(profilePath).toMatch(/\.agent-kernel\/profiles\/dev\/workspace-id$/)
    expect(executorProfileDir('dev')).toMatch(/\.agent-kernel\/profiles\/dev$/)
  })

  it('keeps the default profile on the legacy workspace id path', () => {
    expect(workspaceIdPath('default')).toMatch(/\.agent-kernel\/workspace-id$/)
    expect(workspaceIdPath(undefined)).toMatch(/\.agent-kernel\/workspace-id$/)
  })

  it('rejects unsafe profile names', () => {
    expect(normalizeExecutorProfile('dev')).toBe('dev')
    expect(normalizeExecutorProfile('default')).toBeUndefined()
    expect(() => normalizeExecutorProfile('../dev')).toThrow(/Invalid executor profile/)
    expect(() => normalizeExecutorProfile('dev/profile')).toThrow(/Invalid executor profile/)
  })
})
