import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  GenerationUpdater,
  checksumFor,
  compareSemVer,
  generationLinkPlan,
  normalizeTag,
  type SignedUpdateManifest,
  type UpdateLifecycle,
} from './update.js'

const roots: string[] = []
const manifestUrl = 'https://updates.example/manifest.json'
const artifactUrl = 'https://updates.example/executor.cjs'

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'executor-updater-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function fixture(overrides: Partial<SignedUpdateManifest> = {}, artifact = Buffer.from('healthy executor')) {
  const manifest: SignedUpdateManifest = {
    version: 1,
    release: '1.2.0',
    channel: 'stable',
    protocol: { min: 2, max: 4 },
    artifact: {
      url: artifactUrl,
      size: artifact.byteLength,
      sha256: createHash('sha256').update(artifact).digest('hex'),
      file: 'agent-kernel-executor.cjs',
    },
    ...overrides,
  }
  const signed = JSON.stringify(manifest)
  const envelope = Buffer.from(JSON.stringify({ signed, signature: 'test-signature' }))
  const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
    const url = String(input)
    if (url === manifestUrl) return new Response(envelope)
    if (url === artifactUrl) return new Response(artifact)
    return new Response(null, { status: 404 })
  })
  return { artifact, manifest, signed, fetch }
}

function lifecycle(overrides: Partial<UpdateLifecycle> = {}): UpdateLifecycle {
  return {
    selfTest: vi.fn(async () => undefined),
    drain: vi.fn(async () => undefined),
    restart: vi.fn(async () => undefined),
    health: vi.fn(async () => undefined),
    reconnect: vi.fn(async () => undefined),
    ...overrides,
  }
}

async function existingGeneration(root: string): Promise<string> {
  const path = join(root, 'generations', '1.1.0')
  await mkdir(path, { recursive: true })
  await writeFile(join(path, 'agent-kernel-executor.cjs'), 'old executor')
  await symlink(path, join(root, 'current'), process.platform === 'win32' ? 'junction' : 'dir')
  return path
}

function updater(root: string, fetch: typeof globalThis.fetch, hooks: UpdateLifecycle, verifier = { verify: async () => true }) {
  return new GenerationUpdater({
    installationSource: 'dashboard-native',
    manifestUrl,
    currentVersion: '1.1.0',
    channel: 'stable',
    protocol: 3,
    root,
    verifier,
    lifecycle: hooks,
    fetch,
    timeoutMs: 1_000,
    maxArtifactBytes: 1024,
  })
}

describe('generation updater', () => {
  it('stages, self-tests and atomically advances healthy generations', async () => {
    const root = await tempRoot()
    const old = await existingGeneration(root)
    const data = fixture()
    const hooks = lifecycle()

    const result = await updater(root, data.fetch, hooks).run()
    const plan = generationLinkPlan(root, '1.2.0')

    expect(result).toEqual({ status: 'updated', release: '1.2.0', generation: plan.generation })
    expect(resolve(root, await readlink(plan.current))).toBe(plan.generation)
    expect(resolve(root, await readlink(plan.previous))).toBe(old)
    expect(await readFile(join(plan.generation, 'agent-kernel-executor.cjs'), 'utf8')).toBe('healthy executor')
    expect((hooks.selfTest as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]).toBeLessThan((hooks.drain as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!)
    expect(hooks.restart).toHaveBeenCalledWith({ reason: 'activate', current: plan.generation, previous: old })
    expect(hooks.health).toHaveBeenCalledOnce()
    expect(hooks.reconnect).toHaveBeenCalledOnce()
  })

  it('does not self-update package-manager or container installations', async () => {
    for (const installationSource of ['package-manager', 'container'] as const) {
      const root = await tempRoot()
      const fetch = vi.fn<typeof globalThis.fetch>()
      const result = await new GenerationUpdater({
        installationSource, manifestUrl, currentVersion: '1.0.0', channel: 'stable', protocol: 3,
        root, lifecycle: lifecycle(), fetch,
      }).run()
      expect(result).toEqual({ status: 'skipped', reason: 'externally-managed' })
      expect(fetch).not.toHaveBeenCalled()
    }
  })

  it('fails closed without a verifier and rejects a bad signature', async () => {
    const root = await tempRoot()
    const data = fixture()
    await expect(new GenerationUpdater({
      installationSource: 'dashboard-native', manifestUrl, currentVersion: '1.1.0', channel: 'stable',
      protocol: 3, root, lifecycle: lifecycle(), fetch: data.fetch,
    }).run()).rejects.toThrow('verifier is not configured')
    expect(data.fetch).not.toHaveBeenCalled()

    await expect(updater(root, data.fetch, lifecycle(), { verify: async () => false }).run())
      .rejects.toThrow('signature verification failed')
    expect(data.fetch).toHaveBeenCalledTimes(1)
  })

  it('rejects corrupt artifacts before staging or draining', async () => {
    const root = await tempRoot()
    const data = fixture({ artifact: { url: artifactUrl, size: 7, sha256: '0'.repeat(64) } }, Buffer.from('corrupt'))
    const hooks = lifecycle()

    await expect(updater(root, data.fetch, hooks).run()).rejects.toThrow('checksum mismatch')
    expect(hooks.selfTest).not.toHaveBeenCalled()
    expect(hooks.drain).not.toHaveBeenCalled()
  })

  it('rejects incompatible channel, protocol, and invalid SemVer manifests', async () => {
    for (const override of [
      { channel: 'beta' as const },
      { protocol: { min: 5, max: 6 } },
      { release: '../not-semver' },
    ]) {
      const data = fixture(override)
      const hooks = lifecycle()
      await expect(updater(await tempRoot(), data.fetch, hooks).run()).rejects.toThrow()
      expect(data.fetch).toHaveBeenCalledTimes(1)
      expect(hooks.selfTest).not.toHaveBeenCalled()
    }
  })

  it('rolls back when service restart fails', async () => {
    const root = await tempRoot()
    const old = await existingGeneration(root)
    const data = fixture()
    let restarts = 0
    const hooks = lifecycle({ restart: vi.fn(async () => { if (restarts++ === 0) throw new Error('restart failed') }) })

    await expect(updater(root, data.fetch, hooks).run()).rejects.toThrow('restart failed')
    expect(resolve(root, await readlink(join(root, 'current')))).toBe(old)
    expect(hooks.restart).toHaveBeenNthCalledWith(2, {
      reason: 'rollback', current: old, previous: generationLinkPlan(root, '1.2.0').generation,
    })
  })

  it('rolls back and reconnects when post-restart health fails', async () => {
    const root = await tempRoot()
    const old = await existingGeneration(root)
    const data = fixture()
    const hooks = lifecycle({ health: vi.fn(async () => { throw new Error('health failed') }) })

    await expect(updater(root, data.fetch, hooks).run()).rejects.toThrow('health failed')
    expect(resolve(root, await readlink(join(root, 'current')))).toBe(old)
    expect(hooks.restart).toHaveBeenLastCalledWith({
      reason: 'rollback', current: old, previous: generationLinkPlan(root, '1.2.0').generation,
    })
    expect(hooks.reconnect).toHaveBeenCalledOnce()
  })
})

describe('executor update helpers', () => {
  it('finds checksums and compares semantic versions', () => {
    const sums = ['aaa111  dashboard.cjs', 'bbb222  agent-kernel-executor.cjs'].join('\n')
    expect(checksumFor(sums, 'agent-kernel-executor.cjs')).toBe('bbb222')
    expect(checksumFor(sums, 'missing.cjs')).toBeNull()
    expect(compareSemVer('1.2.0', '1.1.9')).toBeGreaterThan(0)
    expect(compareSemVer('1.2.0-beta.2', '1.2.0')).toBeLessThan(0)
  })

  it('normalizes legacy update tags', () => {
    expect(normalizeTag(' v0.1.1 ')).toBe('v0.1.1')
    expect(normalizeTag('latest')).toBeNull()
    expect(normalizeTag(undefined)).toBeNull()
  })
})
