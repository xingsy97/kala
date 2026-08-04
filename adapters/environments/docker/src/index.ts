import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { SandboxDescriptorSchema, type SandboxPolicy } from '@agent-kernel/eval-protocol'
import type { EvaluationSandboxProvider, SandboxCollectedArtifacts, SandboxCreateInput, SandboxExecRequest, SandboxExecutionTarget } from '@agent-kernel/eval-sdk'
import type { SandboxProviderPlugin } from '@agent-kernel/eval-sdk'
import { commandOk, containedHostPath, environmentLock, relativeArtifactPath, runProcess, runProcessToFile, safeInstanceName, sandboxPath, snapshotDirectory, withTemporaryDirectory } from '@agent-kernel/eval-environment-common'

type DockerState = { container: string; input: SandboxCreateInput; resolvedImageDigest: string; artifactRoot: string }

export class DockerSandboxProvider implements EvaluationSandboxProvider {
  readonly descriptor = SandboxDescriptorSchema.parse({ schemaVersion: 1, providerId: 'docker', kind: 'docker', version: '0.0.0', protocolVersions: [1], capabilities: ['preflight', 'create', 'execute', 'snapshot', 'collect', 'destroy', 'verify-destroyed', 'reap-orphans'] })
  private readonly states = new Map<string, DockerState>()
  constructor(private readonly dockerBinary = process.env.AGENT_EVAL_DOCKER_BINARY ?? 'docker') {}

  async preflight(policy: SandboxPolicy) {
    const errors: Array<{ code: string; message: string }> = []
    if (policy.provider !== 'docker') errors.push({ code: 'PROVIDER_MISMATCH', message: 'sandbox policy does not target Docker' })
    if (policy.network.mode !== 'denied') errors.push({ code: 'NETWORK_ALLOWLIST_UNSUPPORTED', message: 'Docker destination allowlists require an installation network-policy plugin' })
    const result = await commandOk(this.dockerBinary, ['version', '--format', '{{.Server.Version}}'], 10_000).catch((error: unknown) => ({ exitCode: 1, stderr: error instanceof Error ? error.message : String(error), stdout: '' }))
    if (result.exitCode !== 0) errors.push({ code: 'DOCKER_UNAVAILABLE', message: 'Docker daemon is unavailable: ' + result.stderr.slice(0, 300) })
    if (result.exitCode === 0) {
      const image = await commandOk(this.dockerBinary, ['image', 'inspect', policy.imageDigest], 30_000).catch((error: unknown) => ({ exitCode: 1, stderr: error instanceof Error ? error.message : String(error), stdout: '' }))
      if (image.exitCode !== 0) errors.push({ code: 'DOCKER_IMAGE_UNAVAILABLE', message: 'pinned Docker image is unavailable locally: ' + policy.imageDigest })
    }
    return { ok: errors.length === 0, errors, warnings: [], resolvedVersion: result.stdout.trim() || undefined }
  }

  async create(input: SandboxCreateInput): Promise<SandboxExecutionTarget> {
    const preflight = await this.preflight(input.policy)
    if (!preflight.ok) throw new Error(preflight.errors.map((error) => error.code + ': ' + error.message).join('; '))
    const container = safeInstanceName('eval-docker', input.trialId)
    const args = ['create', '--name', container, '--hostname', 'eval-sandbox', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--label', 'agent-eval.managed=true', '--label', 'agent-eval.worker=' + input.workerId, '--label', 'agent-eval.trial=' + input.trialId,
      '--cpus', String(input.policy.resources.cpu), '--memory', String(input.policy.resources.memoryMb) + 'm', '--memory-swap', String(input.policy.resources.memoryMb) + 'm',
      '--pids-limit', String(input.policy.resources.pids), '--tmpfs', '/tmp:rw,noexec,nosuid,size=256m', '--tmpfs', '/workspace:rw,exec,nosuid,size=' + String(input.policy.resources.diskMb) + 'm',
      '--tmpfs', '/artifacts:rw,noexec,nosuid,size=256m', input.policy.imageDigest, 'sh', '-ceu', 'trap : TERM INT; sleep infinity & wait']
    const created = await commandOk(this.dockerBinary, args, 5 * 60_000)
    if (created.exitCode !== 0) throw new Error('Docker container creation failed: ' + created.stderr.slice(0, 1_000))
    try {
      const started = await commandOk(this.dockerBinary, ['start', container], 60_000)
      if (started.exitCode !== 0) throw new Error('Docker container start failed: ' + started.stderr.slice(0, 1_000))
      const inspected = await commandOk(this.dockerBinary, ['image', 'inspect', '--format', '{{index .RepoDigests 0}}', input.policy.imageDigest], 30_000)
      const artifactRoot = await containedHostPath(input.workerDataDir, join(resolve(input.workerDataDir), 'collected', container), false)
      const state = { container, input, resolvedImageDigest: inspected.stdout.trim() || input.policy.imageDigest, artifactRoot }
      this.states.set(container, state)
      return new DockerExecutionTarget(this, state)
    } catch (error) { await commandOk(this.dockerBinary, ['rm', '--force', '--volumes', container], 60_000).catch(() => undefined); throw error }
  }

  async collect(target: SandboxExecutionTarget): Promise<SandboxCollectedArtifacts> {
    const state = this.state(target)
    await this.extractDirectory(state, '/artifacts', state.artifactRoot, 'Docker artifact collection')
    const version = await commandOk(this.dockerBinary, ['version', '--format', '{{.Server.Version}}'], 10_000)
    return { environmentLock: await environmentLock({ policy: state.input.policy, task: state.input.task, resolvedImageDigest: state.resolvedImageDigest, toolchainVersions: { docker: version.stdout.trim() || 'unknown' } }), artifactRoot: state.artifactRoot, cleanupEvidence: { container: state.container, collectedAt: new Date().toISOString() } }
  }

  async destroy(target: SandboxExecutionTarget): Promise<void> {
    const state = this.state(target); const result = await commandOk(this.dockerBinary, ['rm', '--force', '--volumes', state.container], 120_000)
    if (result.exitCode !== 0 && !/No such container/iu.test(result.stderr)) throw new Error('Docker sandbox deletion failed: ' + result.stderr.slice(0, 1_000)); this.states.delete(state.container)
  }
  async verifyDestroyed(target: SandboxExecutionTarget): Promise<boolean> { const result = await commandOk(this.dockerBinary, ['inspect', target.sandboxId], 10_000); return result.exitCode !== 0 && /No such object|No such container/iu.test(result.stderr) }
  async reapOrphans(workerId: string): Promise<readonly string[]> {
    const listed = await commandOk(this.dockerBinary, ['ps', '--all', '--quiet', '--filter', 'label=agent-eval.managed=true', '--filter', 'label=agent-eval.worker=' + workerId], 30_000)
    if (listed.exitCode !== 0) throw new Error('Docker orphan discovery failed: ' + listed.stderr.slice(0, 1_000))
    const containers = listed.stdout.split('\n').map((value) => value.trim()).filter(Boolean)
    for (const container of containers) { const removed = await commandOk(this.dockerBinary, ['rm', '--force', '--volumes', container], 120_000); if (removed.exitCode !== 0 && !/No such container/iu.test(removed.stderr)) throw new Error('Docker orphan cleanup failed: ' + removed.stderr.slice(0, 1_000)) }
    return containers
  }

  async execute(state: DockerState, request: SandboxExecRequest, signal?: AbortSignal) {
    const args = ['exec', '--interactive']
    if (request.cwd) args.push('--workdir', sandboxPath(request.cwd))
    const environment = Object.entries(request.env ?? {})
    for (const [key] of environment) if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) throw new Error('invalid sandbox environment variable: ' + key)
    const environmentFile = environment.length > 0 ? '/tmp/agent-eval-env-' + randomUUID() : undefined
    try {
      if (environmentFile) {
        const body = environment.map(([key, value]) => key + '=' + shellLiteral(value)).join('\n') + '\n'
        const written = await runProcess({ command: this.dockerBinary, args: ['exec', '--interactive', state.container, 'sh', '-ceu', 'umask 077; cat > "$1"; chmod 0600 "$1"', 'write-env', environmentFile], stdin: body, timeoutMs: 30_000, signal })
        if (written.exitCode !== 0) throw new Error('Docker environment injection failed: ' + written.stderr.slice(0, 1_000))
      }
      args.push(state.container, ...(environmentFile ? ['sh', '-ceu', 'set -a; . "$1"; set +a; shift; exec "$@"', 'load-env', environmentFile, ...request.argv] : request.argv))
      return await runProcess({ command: this.dockerBinary, args, stdin: request.stdin, timeoutMs: request.timeoutMs, signal, onStdout: request.onStdout, onStderr: request.onStderr, onAbort: async () => { await commandOk(this.dockerBinary, ['kill', '--signal', 'KILL', state.container], 30_000).catch(() => undefined) } })
    } finally {
      if (environmentFile) await commandOk(this.dockerBinary, ['exec', state.container, 'rm', '-f', environmentFile], 10_000).catch(() => undefined)
    }
  }
  async putArchive(state: DockerState, archivePath: string, destination: string) {
    const relativeArchive = relativeArtifactPath(archivePath)
    const source = await containedHostPath(state.input.workerDataDir, join(resolve(state.input.workerDataDir), relativeArchive), true)
    const archive = await readFile(source)
    verifyTaskArchive(state.input, relativeArchive, archive)
    const target = sandboxPath(destination)
    const extracted = await runProcess({ command: this.dockerBinary, args: ['exec', '--interactive', state.container, 'sh', '-ceu', 'mkdir -p "$1"; tar -xf - -C "$1"', 'extract', target], stdin: archive, timeoutMs: 120_000 })
    if (extracted.exitCode !== 0) throw new Error('Docker archive extraction failed: ' + extracted.stderr.slice(0, 1_000))
  }
  async getArchive(state: DockerState, source: string, archivePath: string) {
    const target = await containedHostPath(state.input.workerDataDir, archivePath, false)
    await this.writeDirectoryArchive(state, source, target, 'Docker archive download')
  }
  async snapshot(state: DockerState) {
    return await withTemporaryDirectory(join(resolve(state.input.workerDataDir), 'snapshots'), state.container + '-', async (directory) => {
      await this.extractDirectory(state, '/workspace', directory, 'Docker workspace snapshot')
      return await snapshotDirectory(directory)
    })
  }
  private async writeDirectoryArchive(state: DockerState, source: string, destination: string, operation: string): Promise<void> {
    const packed = await runProcessToFile({
      command: this.dockerBinary, args: ['exec', state.container, 'tar', '-cf', '-', '-C', sandboxPath(source), '.'],
      destination, timeoutMs: 120_000,
    })
    if (packed.exitCode !== 0 || packed.timedOut) throw new Error(operation + ' failed: ' + packed.stderr.slice(0, 1_000))
  }
  private async extractDirectory(state: DockerState, source: string, destination: string, operation: string): Promise<void> {
    await rm(destination, { recursive: true, force: true })
    await mkdir(destination, { recursive: true, mode: 0o700 })
    const archive = destination + '.tar-' + randomUUID()
    try {
      await this.writeDirectoryArchive(state, source, archive, operation)
      const extracted = await commandOk(process.env.AGENT_EVAL_TAR_BINARY ?? 'tar', ['--extract', '--file', archive, '--directory', destination, '--no-same-owner', '--no-same-permissions'], 120_000)
      if (extracted.exitCode !== 0 || extracted.timedOut) throw new Error(operation + ' failed: ' + extracted.stderr.slice(0, 1_000))
    } finally {
      await rm(archive, { force: true })
    }
  }
  private state(target: SandboxExecutionTarget): DockerState { const state = this.states.get(target.sandboxId); if (!state) throw new Error('unknown Docker sandbox: ' + target.sandboxId); return state }
}

class DockerExecutionTarget implements SandboxExecutionTarget {
  readonly sandboxId; readonly descriptor; readonly workspacePath = '/workspace'
  constructor(private readonly provider: DockerSandboxProvider, private readonly state: DockerState) { this.sandboxId = state.container; this.descriptor = provider.descriptor }
  async execute(request: SandboxExecRequest, signal?: AbortSignal) { return await this.provider.execute(this.state, request, signal) }
  async putArchive(archivePath: string, destination: string) { await this.provider.putArchive(this.state, archivePath, destination) }
  async getArchive(source: string, archivePath: string) { await this.provider.getArchive(this.state, source, archivePath) }
  async snapshot() { return await this.provider.snapshot(this.state) }
}

export function createDockerProvider(): DockerSandboxProvider { return new DockerSandboxProvider() }
export const evaluationPlugins: readonly SandboxProviderPlugin[] = [{ kind: 'sandbox-provider', descriptor: createDockerProvider().descriptor, create: createDockerProvider }]

function verifyTaskArchive(input: SandboxCreateInput, archiveRef: string, archive: Uint8Array): void {
  if (input.task.repository.kind !== 'artifact' || input.task.repository.archiveRef !== archiveRef) throw new Error('sandbox archive upload is not the declared task repository')
  const actual = createHash('sha256').update(archive).digest('hex')
  if (actual !== input.task.repository.archiveSha256) throw new Error('task repository archive SHA-256 mismatch')
}

function shellLiteral(value: string): string {
  if (value.includes('\0') || value.includes('\n') || value.includes('\r')) throw new Error('sandbox environment values cannot contain NUL or newlines')
  return "'" + value.replaceAll("'", "'\"'\"'") + "'"
}
