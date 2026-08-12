import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  applyLegacyIdentityMigration,
  discoverLegacyExecutorProfiles,
  discoverLegacyIdentityMigration,
} from './legacy-identity-migration.js'

const WORKSPACE_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const TOKEN = 'ak_exec_INVALID_TEST_PLACEHOLDER_1'

describe('legacy executor identity migration', () => {
  let root: string
  let legacyRoot: string
  let targetDir: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ak-legacy-migration-'))
    legacyRoot = join(root, 'legacy')
    targetDir = join(root, 'target', 'identity')
    mkdirSync(legacyRoot, { recursive: true })
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('discovers default and named profiles without mutating legacy files', () => {
    writeFileSync(join(legacyRoot, 'workspace-id'), `${WORKSPACE_ID}\n`)
    writeFileSync(join(legacyRoot, 'executor-token'), `${TOKEN}\n`)
    writeFileSync(join(legacyRoot, 'install-source'), 'package-manager\n')
    const named = join(legacyRoot, 'profiles', 'dev')
    mkdirSync(named, { recursive: true })
    writeFileSync(join(named, 'workspace-id'), `${WORKSPACE_ID}\n`)
    const before = statSync(join(legacyRoot, 'executor-token')).mtimeMs

    expect(discoverLegacyExecutorProfiles(legacyRoot)).toEqual(['default', 'dev'])
    const plan = discoverLegacyIdentityMigration({ legacyRoot, targetDir })

    expect(plan).toMatchObject({
      version: 1,
      canApply: true,
      conflicts: [],
      identity: {
        profile: 'default',
        workspaceId: WORKSPACE_ID,
        installationSource: 'package-manager',
        token: { present: true },
      },
      operations: [
        { kind: 'copy', file: 'workspace-id', mode: '0600' },
        { kind: 'copy', file: 'executor-token', mode: '0600' },
      ],
    })
    expect(JSON.stringify(plan)).not.toContain(TOKEN)
    expect(statSync(join(legacyRoot, 'executor-token')).mtimeMs).toBe(before)
    expect(existsSync(targetDir)).toBe(false)
  })

  it('discovers a named profile and defaults an unmarked legacy CJS source', () => {
    const dir = join(legacyRoot, 'profiles', 'release')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'workspace-id'), `${WORKSPACE_ID}\n`)

    const plan = discoverLegacyIdentityMigration({ legacyRoot, profile: 'release', targetDir })

    expect(plan.identity).toMatchObject({
      profile: 'release',
      profileDir: dir,
      workspaceId: WORKSPACE_ID,
      installationSource: 'legacy-cjs',
      token: { present: false },
    })
  })

  it('reports potential active and existing-target conflicts and fails closed', () => {
    writeFileSync(join(legacyRoot, 'workspace-id'), `${WORKSPACE_ID}\n`)
    writeFileSync(join(legacyRoot, 'executor.lock'), '4321\n')
    mkdirSync(join(legacyRoot, 'executor.lock.lock'))
    mkdirSync(targetDir, { recursive: true })

    const plan = discoverLegacyIdentityMigration({ legacyRoot, targetDir })

    expect(plan.canApply).toBe(false)
    expect(plan.conflicts).toEqual([
      expect.objectContaining({ kind: 'active-executor', pid: 4321, profile: 'default' }),
      expect.objectContaining({ kind: 'target-exists', path: targetDir, profile: 'default' }),
    ])
    expect(() => applyLegacyIdentityMigration(plan)).toThrow(/not safe to apply/)
  })

  it('atomically copies identity into a private target after explicit apply', () => {
    writeFileSync(join(legacyRoot, 'workspace-id'), `${WORKSPACE_ID}\n`)
    writeFileSync(join(legacyRoot, 'executor-token'), `${TOKEN}\n`)
    const plan = discoverLegacyIdentityMigration({ legacyRoot, targetDir })

    applyLegacyIdentityMigration(plan)

    expect(readFileSync(join(targetDir, 'workspace-id'), 'utf8')).toBe(`${WORKSPACE_ID}\n`)
    expect(readFileSync(join(targetDir, 'executor-token'), 'utf8')).toBe(`${TOKEN}\n`)
    expect(readFileSync(join(legacyRoot, 'workspace-id'), 'utf8')).toBe(`${WORKSPACE_ID}\n`)
    if (process.platform !== 'win32') {
      expect(statSync(targetDir).mode & 0o777).toBe(0o700)
      expect(statSync(join(targetDir, 'workspace-id')).mode & 0o777).toBe(0o600)
      expect(statSync(join(targetDir, 'executor-token')).mode & 0o777).toBe(0o600)
    }
  })

  it('rechecks target, activity, and identity after discovery', () => {
    writeFileSync(join(legacyRoot, 'workspace-id'), `${WORKSPACE_ID}\n`)
    const targetPlan = discoverLegacyIdentityMigration({ legacyRoot, targetDir })
    mkdirSync(targetDir, { recursive: true })
    expect(() => applyLegacyIdentityMigration(targetPlan)).toThrow(/target already exists/)

    rmSync(targetDir, { recursive: true })
    const activePlan = discoverLegacyIdentityMigration({ legacyRoot, targetDir })
    mkdirSync(join(legacyRoot, 'executor.lock.lock'))
    expect(() => applyLegacyIdentityMigration(activePlan)).toThrow(/still be active/)

    rmSync(join(legacyRoot, 'executor.lock.lock'), { recursive: true })
    const changedPlan = discoverLegacyIdentityMigration({ legacyRoot, targetDir })
    writeFileSync(join(legacyRoot, 'workspace-id'), '01BX5ZZKBKACTAV9WEVGEMMVRZ\n')
    expect(() => applyLegacyIdentityMigration(changedPlan)).toThrow(/changed after discovery/)
    expect(existsSync(targetDir)).toBe(false)
  })

  it('rejects symlinked identity material', () => {
    if (process.platform === 'win32') return
    const realId = join(root, 'real-workspace-id')
    writeFileSync(realId, `${WORKSPACE_ID}\n`)
    // chmod confirms discovery does not need write access before replacing with a symlink.
    chmodSync(realId, 0o400)
    const link = join(legacyRoot, 'workspace-id')
    symlinkSync(realId, link)

    expect(() => discoverLegacyIdentityMigration({ legacyRoot, targetDir })).toThrow(/unsafe legacy identity file/)
  })
})
