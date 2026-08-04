import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { commandOk, runProcess } = vi.hoisted(() => ({ commandOk: vi.fn(), runProcess: vi.fn() }))

vi.mock('./process.js', () => ({ commandOk, runProcess }))

import { canonicalLxdImageDigest, configureLxdHosts, configureLxdLoopback, configureLxdNetwork, LxdSandboxProvider, waitForExec } from './lxd.js'

describe('LxdSandboxProvider orphan ownership', () => {
  beforeEach(() => { commandOk.mockReset() })

  it('deletes only managed instances owned by the current worker', async () => {
    commandOk.mockImplementation(async (...call: unknown[]) => {
      const args = call.find(Array.isArray) as readonly string[] | undefined
      if (!args) throw new Error('unexpected LXD invocation')
      if (args[0] === 'list') {
        return {
          exitCode: 0, stderr: '', stdout: JSON.stringify([
            { name: 'owned', config: { 'user.agent-eval.managed': 'true', 'user.agent-eval.worker': 'worker-a' } },
            { name: 'other-worker', config: { 'user.agent-eval.managed': 'true', 'user.agent-eval.worker': 'worker-b' } },
            { name: 'unmanaged', config: { 'user.agent-eval.worker': 'worker-a' } },
            { name: 'production-agent-runlab-host', config: {} },
          ]),
        }
      }
      if (args[0] === 'network' && args[1] === 'list') return { exitCode: 0, stderr: '', stdout: '[]' }
      if (args[0] === 'network' && args[1] === 'acl' && args[2] === 'list') return { exitCode: 0, stderr: '', stdout: '[]' }
      if (args[0] === 'delete') return { exitCode: 0, stdout: '', stderr: '' }
      throw new Error('unexpected LXD command: ' + args.join(' '))
    })
    const provider = new LxdSandboxProvider({ kind: 'lxd-container', storagePool: 'fixture', lxcBinary: 'lxc-fixture' })

    await expect(provider.reapOrphans('worker-a')).resolves.toEqual(['owned'])
    expect(commandOk.mock.calls.filter(([, args]) => args[0] === 'delete').map(([, args]) => args)).toEqual([
      ['delete', '--force', 'owned'],
    ])
  })

  it('rejects malformed discovery output without deleting anything', async () => {
    commandOk.mockResolvedValue({ exitCode: 0, stdout: 'not-json', stderr: '' })
    const provider = new LxdSandboxProvider({ kind: 'lxd-vm', storagePool: 'fixture', lxcBinary: 'lxc-fixture' })

    await expect(provider.reapOrphans('worker-a')).rejects.toThrow('invalid JSON')
    expect(commandOk.mock.calls.some(([, args]) => args[0] === 'delete')).toBe(false)
  })
})

describe('LxdSandboxProvider allowlist validation', () => {
  beforeEach(() => { commandOk.mockReset() })

  it('accepts a hostname locked to an immutable IPv4 destination', async () => {
    commandOk.mockResolvedValue({ exitCode: 0, stdout: '6.8', stderr: '' })
    const provider = new LxdSandboxProvider({ kind: 'lxd-container', storagePool: 'fixture', lxcBinary: 'lxc-fixture' })
    const result = await provider.preflight({ provider: 'lxd-container', imageDigest: 'local:' + 'a'.repeat(64), readOnlyBase: true, ephemeralOverlay: true, resources: { cpu: 1, memoryMb: 512, diskMb: 1024, pids: 128 }, network: { mode: 'allowlist', allowedDestinations: ['provider.example=203.0.113.8:443'] }, artifactAllowlist: [] })
    expect(result.ok).toBe(true)
  })
})

describe('LXD guest readiness', () => {
  beforeEach(() => { commandOk.mockReset() })

  it('waits for systemd readiness after lxc exec starts accepting commands', async () => {
    commandOk
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })

    await expect(waitForExec('lxc-fixture', 'trial', 2_000)).resolves.toBeUndefined()
    expect(commandOk.mock.calls.map(([, args]) => args)).toEqual([
      ['exec', 'trial', '--force-noninteractive', '--', 'true'],
      ['exec', 'trial', '--force-noninteractive', '--', 'sh', '-ceu', expect.stringContaining('SystemState')],
      ['exec', 'trial', '--force-noninteractive', '--', 'true'],
      ['exec', 'trial', '--force-noninteractive', '--', 'sh', '-ceu', expect.stringContaining('SystemState')],
    ])
  })

  it('configures an allowlisted network without relying on a guest DHCP service', async () => {
    commandOk.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' })

    await expect(configureLxdNetwork('lxc-fixture', 'trial', { address: '192.0.2.7/29', gateway: '192.0.2.6' }, 30_000)).resolves.toBeUndefined()
    expect(commandOk).toHaveBeenCalledWith('lxc-fixture', [
      'exec', 'trial', '--force-noninteractive', '--', 'sh', '-ceu',
      expect.stringContaining('/usr/local/bin/busybox'),
      'configure-network', '192.0.2.7/29', '192.0.2.6',
    ], 30_000)
  })

  it('brings isolated loopback up for local deploy and health verification', async () => {
    commandOk.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' })
    await expect(configureLxdLoopback('lxc-fixture', 'trial', 30_000)).resolves.toBeUndefined()
    expect(commandOk).toHaveBeenCalledWith('lxc-fixture', [
      'exec', 'trial', '--force-noninteractive', '--', 'sh', '-ceu',
      expect.stringContaining('127.0.0.1/8'),
    ], 30_000)
  })

  it('pins an allowlisted TLS hostname in the guest hosts file', async () => {
    commandOk.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' })
    await expect(configureLxdHosts('lxc-fixture', 'trial', [{ hostname: 'provider.example', address: '203.0.113.8' }], 30_000)).resolves.toBeUndefined()
    expect(commandOk).toHaveBeenCalledWith('lxc-fixture', [
      'exec', 'trial', '--force-noninteractive', '--', 'sh', '-ceu',
      'printf %s "$1" >> /etc/hosts', 'configure-hosts', '203.0.113.8 provider.example\n',
    ], 30_000)
  })

  it('reports a failed explicit network configuration', async () => {
    commandOk.mockResolvedValue({ exitCode: 127, stdout: '', stderr: 'trial image has no ip command' })

    await expect(configureLxdNetwork('lxc-fixture', 'trial', { address: '192.0.2.7/29', gateway: '192.0.2.6' }, 30_000))
      .rejects.toThrow('LXD allowlisted network configuration failed')
  })

  it('preserves the canonical local fingerprint form in environment evidence', () => {
    const fingerprint = 'a'.repeat(64)
    expect(canonicalLxdImageDigest(fingerprint, 'local:' + fingerprint)).toBe('local:' + fingerprint)
    expect(canonicalLxdImageDigest('sha256:remote', 'images:ubuntu/24.04')).toBe('sha256:remote')
  })
})

describe('LXD guest environment injection', () => {
  beforeEach(() => { commandOk.mockReset(); runProcess.mockReset() })

  it('keeps secrets out of host argv and deletes the 0600 guest file after execution', async () => {
    const workerDataDir = await mkdtemp(join(tmpdir(), 'eval-lxd-environment-'))
    const secret = 'credential-value-that-must-not-enter-argv'
    let pushedBody = ''
    commandOk.mockImplementation(async (_command: string, args: readonly string[]) => {
      if (args[0] === 'file' && args[1] === 'push') pushedBody = await readFile(args[2]!, 'utf8')
      return { exitCode: 0, stdout: '', stderr: '', startedAt: '', completedAt: '', timedOut: false }
    })
    runProcess.mockResolvedValue({ exitCode: 0, stdout: 'ok', stderr: '', startedAt: '', completedAt: '', timedOut: false })
    const provider = new LxdSandboxProvider({ kind: 'lxd-container', storagePool: 'fixture', lxcBinary: 'lxc-fixture' })
    const state = { instance: 'trial', input: { workerDataDir, policy: { resources: { pids: 64, memoryMb: 512 } } } }
    try {
      await provider.execute(state as never, { argv: ['agent-cli', '--run'], env: { MODEL_API_KEY: secret }, timeoutMs: 1_000 })

      const hostArgv = [
        ...commandOk.mock.calls.flatMap((call) => call[1] as readonly string[]),
        ...runProcess.mock.calls.flatMap((call) => (call[0] as { args: readonly string[] }).args),
      ]
      expect(hostArgv.join(' ')).not.toContain(secret)
      expect(pushedBody).toContain("MODEL_API_KEY='" + secret + "'")
      expect(commandOk).toHaveBeenCalledWith('lxc-fixture', [
        'file', 'push', expect.stringContaining('/environment/env-'), expect.stringMatching(/^trial\/tmp\/eval-transfer\/env-/u), '--mode', '0600', '--uid', '0', '--gid', '0',
      ], 30_000)
      expect(commandOk).toHaveBeenCalledWith('lxc-fixture', ['file', 'delete', expect.stringMatching(/^trial\/tmp\/eval-transfer\/env-/u)], 10_000)
      expect(await readdir(join(workerDataDir, 'environment'))).toEqual([])
    } finally {
      await rm(workerDataDir, { recursive: true, force: true })
    }
  })
})
