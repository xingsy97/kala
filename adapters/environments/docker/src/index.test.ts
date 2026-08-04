import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { commandOk, containedHostPath, environmentLock, readFile, runProcess, runProcessToFile, safeInstanceName, sandboxPath } = vi.hoisted(() => ({
  commandOk: vi.fn(), containedHostPath: vi.fn(), environmentLock: vi.fn(), readFile: vi.fn(), runProcess: vi.fn(), runProcessToFile: vi.fn(), safeInstanceName: vi.fn(), sandboxPath: vi.fn(),
}))

vi.mock('node:fs/promises', async (loadOriginal) => ({ ...(await loadOriginal<typeof import('node:fs/promises')>()), readFile }))

vi.mock('@agent-kernel/eval-environment-common', () => ({
  commandOk,
  containedHostPath,
  environmentLock,
  relativeArtifactPath: (value: string) => value,
  runProcess,
  runProcessToFile,
  safeInstanceName,
  sandboxPath,
  snapshotDirectory: vi.fn(),
  withTemporaryDirectory: vi.fn(),
}))

import { DockerSandboxProvider } from './index.js'

describe('DockerSandboxProvider orphan ownership', () => {
  beforeEach(() => {
    commandOk.mockReset(); containedHostPath.mockReset(); environmentLock.mockReset(); readFile.mockReset(); runProcess.mockReset(); runProcessToFile.mockReset(); safeInstanceName.mockReset(); sandboxPath.mockReset()
    sandboxPath.mockImplementation((value: string) => value)
  })

  it('discovers and deletes only managed containers owned by the current worker', async () => {
    commandOk.mockImplementation(async (_command: string, args: readonly string[]) => {
      if (args[0] === 'ps') return { exitCode: 0, stdout: 'owned-one\nowned-two\n', stderr: '' }
      if (args[0] === 'rm') return { exitCode: 0, stdout: '', stderr: '' }
      throw new Error('unexpected Docker command: ' + args.join(' '))
    })

    const provider = new DockerSandboxProvider('docker-fixture')
    await expect(provider.reapOrphans('worker-a')).resolves.toEqual(['owned-one', 'owned-two'])

    expect(commandOk).toHaveBeenNthCalledWith(1, 'docker-fixture', [
      'ps', '--all', '--quiet',
      '--filter', 'label=agent-eval.managed=true',
      '--filter', 'label=agent-eval.worker=worker-a',
    ], 30_000)
    expect(commandOk.mock.calls.filter(([, args]) => args[0] === 'rm').map(([, args]) => args)).toEqual([
      ['rm', '--force', '--volumes', 'owned-one'],
      ['rm', '--force', '--volumes', 'owned-two'],
    ])
  })

  it('does not issue deletion when no instance matches both ownership labels', async () => {
    commandOk.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' })
    const provider = new DockerSandboxProvider('docker-fixture')

    await expect(provider.reapOrphans('worker-a')).resolves.toEqual([])
    expect(commandOk).toHaveBeenCalledOnce()
    expect(commandOk.mock.calls.some(([, args]) => args[0] === 'rm')).toBe(false)
  })

  it('creates an executable workspace while keeping temporary and artifact mounts non-executable', async () => {
    commandOk.mockImplementation(async (_command: string, args: readonly string[]) => {
      if (args[0] === 'version') return { exitCode: 0, stdout: '29.6.0', stderr: '' }
      if (args[0] === 'image' && args[1] === 'inspect') return { exitCode: 0, stdout: '[]', stderr: '' }
      if (args[0] === 'create') return { exitCode: 1, stdout: '', stderr: 'fixture stop after argv capture' }
      throw new Error('unexpected Docker command: ' + args.join(' '))
    })
    const provider = new DockerSandboxProvider('docker-fixture')
    await expect(provider.create({ workerId: 'worker', trialId: 'trial', workerDataDir: '/tmp/worker', task: {} as never, policy: { provider: 'docker', imageDigest: 'alpine@sha256:fixture', readOnlyBase: true, ephemeralOverlay: true, resources: { cpu: 1, memoryMb: 256, diskMb: 1024, pids: 128 }, network: { mode: 'denied', allowedDestinations: [] }, artifactAllowlist: [] } })).rejects.toThrow('container creation failed')
    const args = commandOk.mock.calls.find(([, value]) => value[0] === 'create')![1]
    expect(args).toContain('/workspace:rw,exec,nosuid,size=1024m')
    expect(args).toContain('/tmp:rw,noexec,nosuid,size=256m')
    expect(args).toContain('/artifacts:rw,noexec,nosuid,size=256m')
  })

  it('streams the verified repository archive into the workspace on a read-only rootfs', async () => {
    const archive = Buffer.from('fixture tar bytes')
    const digest = createHash('sha256').update(archive).digest('hex')
    containedHostPath.mockResolvedValue('/worker/fixtures/repository.tar')
    readFile.mockResolvedValue(archive)
    sandboxPath.mockReturnValue('/workspace')
    runProcess.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '', startedAt: '', completedAt: '', timedOut: false })
    const provider = new DockerSandboxProvider('docker-fixture')
    const state = { container: 'trial', input: { workerDataDir: '/worker', task: { repository: { kind: 'artifact', archiveRef: 'fixtures/repository.tar', archiveSha256: digest } } } }

    await provider.putArchive(state as never, 'fixtures/repository.tar', '/workspace')

    expect(commandOk).not.toHaveBeenCalled()
    expect(runProcess).toHaveBeenCalledWith({
      command: 'docker-fixture',
      args: ['exec', '--interactive', 'trial', 'sh', '-ceu', 'mkdir -p "$1"; tar -xf - -C "$1"', 'extract', '/workspace'],
      stdin: archive,
      timeoutMs: 120_000,
    })
  })

  it('streams collected artifacts through the Worker filesystem instead of a daemon-local docker cp target', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'eval-docker-collect-'))
    const artifactRoot = join(directory, 'collected')
    safeInstanceName.mockReturnValue('trial')
    containedHostPath.mockResolvedValue(artifactRoot)
    environmentLock.mockResolvedValue({ schemaVersion: 1 })
    runProcessToFile.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '', startedAt: '', completedAt: '', timedOut: false })
    commandOk.mockImplementation(async (command: string, args: readonly string[]) => {
      if (args[0] === 'version') return { exitCode: 0, stdout: '29.6.0', stderr: '' }
      if (args[0] === 'create' || args[0] === 'start') return { exitCode: 0, stdout: '', stderr: '' }
      if (args[0] === 'image') return { exitCode: 0, stdout: 'node@sha256:' + 'a'.repeat(64), stderr: '' }
      if (command === (process.env.AGENT_EVAL_TAR_BINARY ?? 'tar') && args[0] === '--extract') return { exitCode: 0, stdout: '', stderr: '' }
      throw new Error('unexpected command: ' + command + ' ' + args.join(' '))
    })
    const provider = new DockerSandboxProvider('docker-fixture')
    try {
      const target = await provider.create({ workerId: 'worker', trialId: 'trial', workerDataDir: directory, task: {} as never, policy: { provider: 'docker', imageDigest: 'node@sha256:' + 'a'.repeat(64), readOnlyBase: true, ephemeralOverlay: true, resources: { cpu: 1, memoryMb: 256, diskMb: 1024, pids: 128 }, network: { mode: 'denied', allowedDestinations: [] }, artifactAllowlist: [] } })
      await expect(provider.collect(target)).resolves.toMatchObject({ artifactRoot })
      expect(runProcessToFile).toHaveBeenCalledWith({
        command: 'docker-fixture', args: ['exec', 'trial', 'tar', '-cf', '-', '-C', '/artifacts', '.'],
        destination: expect.stringMatching(/collected\.tar-[0-9a-f-]+$/u), timeoutMs: 120_000,
      })
      expect(commandOk).not.toHaveBeenCalledWith('docker-fixture', expect.arrayContaining(['cp']), expect.anything())
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('keeps environment secrets out of host argv and removes the 0600 guest file', async () => {
    const secret = 'docker-secret-that-must-not-enter-host-argv'
    commandOk.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '', startedAt: '', completedAt: '', timedOut: false })
    runProcess.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '', startedAt: '', completedAt: '', timedOut: false })
    const provider = new DockerSandboxProvider('docker-fixture')
    const state = { container: 'trial', input: {} }

    await provider.execute(state as never, { argv: ['agent-cli', '--run'], env: { MODEL_API_KEY: secret }, stdin: 'agent input', timeoutMs: 1_000 })

    const hostArgv = [
      ...runProcess.mock.calls.flatMap((call) => (call[0] as { args: readonly string[] }).args),
      ...commandOk.mock.calls.flatMap((call) => call[1] as readonly string[]),
    ].join(' ')
    expect(hostArgv).not.toContain(secret)
    expect(runProcess.mock.calls[0]?.[0]).toMatchObject({
      command: 'docker-fixture',
      args: ['exec', '--interactive', 'trial', 'sh', '-ceu', expect.stringContaining('chmod 0600'), 'write-env', expect.stringMatching(/^\/tmp\/agent-eval-env-/u)],
      stdin: "MODEL_API_KEY='" + secret + "'\n",
    })
    expect(runProcess.mock.calls[1]?.[0]).toMatchObject({
      args: ['exec', '--interactive', 'trial', 'sh', '-ceu', expect.stringContaining('set -a'), 'load-env', expect.stringMatching(/^\/tmp\/agent-eval-env-/u), 'agent-cli', '--run'],
      stdin: 'agent input',
    })
    expect(commandOk).toHaveBeenCalledWith('docker-fixture', ['exec', 'trial', 'rm', '-f', expect.stringMatching(/^\/tmp\/agent-eval-env-/u)], 10_000)
  })
})
