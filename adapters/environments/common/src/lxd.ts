import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { isIP } from 'node:net'

import { SandboxDescriptorSchema, type ResolvedTask, type SandboxPolicy } from '@agent-kernel/eval-protocol'
import type { EvaluationSandboxProvider, SandboxCollectedArtifacts, SandboxCreateInput, SandboxExecRequest, SandboxExecResult, SandboxExecutionTarget, SandboxSnapshot } from '@agent-kernel/eval-sdk'

import { containedHostPath, relativeArtifactPath, safeInstanceName, sandboxPath, snapshotDirectory, withTemporaryDirectory } from './files.js'
import { environmentLock } from './lock.js'
import { commandOk, runProcess } from './process.js'

type LxdKind = 'lxd-container' | 'lxd-vm'
type LxdNetwork = { network: string; acl: string; address: string; gateway: string; hosts: readonly { hostname: string; address: string }[] }
type LxdState = { instance: string; input: SandboxCreateInput; resolvedImageDigest: string; artifactRoot: string; network?: LxdNetwork }

export class LxdSandboxProvider implements EvaluationSandboxProvider {
  readonly descriptor
  private readonly states = new Map<string, LxdState>()

  constructor(private readonly options: { kind: LxdKind; storagePool: string; lxcBinary?: string; version?: string }) {
    this.descriptor = SandboxDescriptorSchema.parse({ schemaVersion: 1, providerId: options.kind, kind: options.kind, version: options.version ?? '0.0.0', protocolVersions: [1], capabilities: ['preflight', 'create', 'execute', 'snapshot', 'collect', 'destroy', 'verify-destroyed', 'reap-orphans'] })
  }

  async preflight(policy: SandboxPolicy) {
    const errors: Array<{ code: string; message: string }> = []
    if (policy.provider !== this.options.kind) errors.push({ code: 'PROVIDER_MISMATCH', message: 'sandbox policy does not target ' + this.options.kind })
    if (policy.network.mode === 'allowlist') {
      try { parseAllowedDestinations(policy.network.allowedDestinations) } catch (error) {
        errors.push({ code: 'NETWORK_ALLOWLIST_INVALID', message: error instanceof Error ? error.message : String(error) })
      }
    }
    const result = await commandOk(this.lxc, ['version'], 10_000).catch((error: unknown) => ({ exitCode: 1, stderr: error instanceof Error ? error.message : String(error) }))
    if (result.exitCode !== 0) errors.push({ code: 'LXD_UNAVAILABLE', message: 'LXD is unavailable: ' + result.stderr.slice(0, 300) })
    if (result.exitCode === 0 && /^local:[a-f0-9]{64}$/u.test(policy.imageDigest)) {
      const image = await commandOk(this.lxc, ['image', 'info', policy.imageDigest], 10_000).catch((error: unknown) => ({ exitCode: 1, stderr: error instanceof Error ? error.message : String(error) }))
      if (image.exitCode !== 0) errors.push({ code: 'LXD_IMAGE_UNAVAILABLE', message: 'pinned LXD image is unavailable: ' + policy.imageDigest })
    }
    return { ok: errors.length === 0, errors, warnings: [], resolvedVersion: result.exitCode === 0 && 'stdout' in result ? result.stdout.trim().split('\n')[0] || undefined : undefined }
  }

  async create(input: SandboxCreateInput): Promise<SandboxExecutionTarget> {
    const preflight = await this.preflight(input.policy)
    if (!preflight.ok) throw new Error(preflight.errors.map((error) => error.code + ': ' + error.message).join('; '))
    const instance = safeInstanceName('eval-' + (this.options.kind === 'lxd-vm' ? 'vm' : 'ct'), input.trialId)
    let network: LxdNetwork | undefined
    if (input.policy.network.mode === 'allowlist') network = await this.createAllowlistNetwork(input)
    const args = ['init', input.policy.imageDigest, instance, '--no-profiles', '--storage', this.options.storagePool,
      '--device', 'root,size=' + String(input.policy.resources.diskMb) + 'MiB',
      '--config', 'limits.cpu=' + String(input.policy.resources.cpu),
      '--config', 'limits.memory=' + String(input.policy.resources.memoryMb) + 'MiB',
      '--config', 'user.agent-eval.managed=true', '--config', 'user.agent-eval.worker=' + input.workerId, '--config', 'user.agent-eval.trial=' + input.trialId,
    ]
    if (network) args.push('--device', 'eth0,network=' + network.network)
    if (this.options.kind === 'lxd-vm') args.push('--vm')
    else {
      args.push('--config', 'security.privileged=false', '--config', 'limits.processes=' + String(input.policy.resources.pids))
      if (input.task.lxdInitMode === 'keepalive') args.push('--config', 'raw.lxc=lxc.init.cmd=/bin/sleep infinity')
    }
    const initialized = await commandOk(this.lxc, args, 10 * 60_000)
    if (initialized.exitCode !== 0) {
      if (network) await this.destroyAllowlistNetwork(network)
      throw new Error('LXD instance initialization failed: ' + initialized.stderr.slice(0, 1_000))
    }
    try {
      const started = await commandOk(this.lxc, ['start', instance], 5 * 60_000)
      if (started.exitCode !== 0) throw new Error('LXD instance start failed: ' + started.stderr.slice(0, 1_000))
      await waitForExec(this.lxc, instance, this.options.kind === 'lxd-vm' ? 180_000 : 30_000)
      await configureLxdLoopback(this.lxc, instance, 30_000)
      if (network) {
        await configureLxdNetwork(this.lxc, instance, network, 30_000)
        await configureLxdHosts(this.lxc, instance, network.hosts, 30_000)
        await waitForLxdNetworkReady(this.lxc, instance, 30_000)
      }
      const prepared = await this.exec(instance, { argv: ['mkdir', '-p', '/workspace', '/artifacts', '/tmp/eval-transfer'], timeoutMs: 30_000 })
      if (prepared.exitCode !== 0) throw new Error('LXD sandbox directory preparation failed: ' + prepared.stderr.slice(0, 1_000))
      const image = await commandOk(this.lxc, ['config', 'get', instance, 'volatile.base_image'], 10_000)
      const resolvedImageDigest = canonicalLxdImageDigest(image.stdout.trim(), input.policy.imageDigest)
      const artifactRoot = await containedHostPath(input.workerDataDir, join(resolve(input.workerDataDir), 'collected', instance), false)
      const state = { instance, input, resolvedImageDigest, artifactRoot, ...(network ? { network } : {}) }
      this.states.set(instance, state)
      return new LxdExecutionTarget(this, state)
    } catch (error) {
      await commandOk(this.lxc, ['delete', '--force', instance], 60_000).catch(() => undefined)
      if (network) await this.destroyAllowlistNetwork(network).catch(() => undefined)
      throw error
    }
  }

  async collect(target: SandboxExecutionTarget): Promise<SandboxCollectedArtifacts> {
    const state = this.state(target)
    const transferRoot = join(resolve(state.input.workerDataDir), 'transfers')
    await withTemporaryDirectory(transferRoot, state.instance + '-', async (directory) => {
      const pulled = await commandOk(this.lxc, ['file', 'pull', '--recursive', state.instance + '/artifacts', directory], 120_000)
      if (pulled.exitCode !== 0 && !/not found|doesn't exist/iu.test(pulled.stderr)) throw new Error('LXD artifact collection failed: ' + pulled.stderr.slice(0, 1_000))
      await rm(state.artifactRoot, { recursive: true, force: true })
      await mkdir(resolve(state.artifactRoot, '..'), { recursive: true, mode: 0o700 })
      await rename(join(directory, 'artifacts'), state.artifactRoot)
    })
    return {
      environmentLock: await environmentLock({ policy: state.input.policy, task: state.input.task, resolvedImageDigest: state.resolvedImageDigest, toolchainVersions: { lxd: await this.version() } }),
      artifactRoot: state.artifactRoot, cleanupEvidence: { instance: state.instance, collectedAt: new Date().toISOString() },
    }
  }

  async destroy(target: SandboxExecutionTarget): Promise<void> {
    const state = this.state(target)
    const result = await commandOk(this.lxc, ['delete', '--force', state.instance], 120_000)
    if (result.exitCode !== 0 && !/not found|doesn't exist/iu.test(result.stderr)) throw new Error('LXD sandbox deletion failed: ' + result.stderr.slice(0, 1_000))
    if (state.network) await this.destroyAllowlistNetwork(state.network)
  }

  async verifyDestroyed(target: SandboxExecutionTarget): Promise<boolean> {
    const result = await commandOk(this.lxc, ['info', target.sandboxId], 10_000)
    if (result.exitCode === 0 || !/not found|doesn't exist/iu.test(result.stderr + result.stdout)) return false
    const volumes = await commandOk(this.lxc, ['storage', 'volume', 'list', this.options.storagePool, '--format', 'csv'], 30_000)
    if (volumes.exitCode !== 0 || volumes.stdout.split('\n').some((line) => line.split(',')[1] === target.sandboxId)) return false
    const state = this.states.get(target.sandboxId)
    if (!state?.network) { this.states.delete(target.sandboxId); return true }
    const [network, acl] = await Promise.all([
      commandOk(this.lxc, ['network', 'show', state.network.network], 10_000),
      commandOk(this.lxc, ['network', 'acl', 'show', state.network.acl], 10_000),
    ])
    const destroyed = network.exitCode !== 0 && acl.exitCode !== 0
    if (destroyed) this.states.delete(target.sandboxId)
    return destroyed
  }

  async reapOrphans(workerId: string): Promise<readonly string[]> {
    const listed = await commandOk(this.lxc, ['list', '--format', 'json'], 30_000)
    if (listed.exitCode !== 0) throw new Error('LXD orphan discovery failed: ' + listed.stderr.slice(0, 1_000))
    let instances: unknown
    try { instances = JSON.parse(listed.stdout) } catch { throw new Error('LXD orphan discovery returned invalid JSON') }
    const names = Array.isArray(instances) ? instances.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return []
      const value = entry as Record<string, unknown>; const config = value.config && typeof value.config === 'object' ? value.config as Record<string, unknown> : {}
      return config['user.agent-eval.managed'] === 'true' && config['user.agent-eval.worker'] === workerId && typeof value.name === 'string' ? [value.name] : []
    }) : []
    for (const instance of names) { const removed = await commandOk(this.lxc, ['delete', '--force', instance], 120_000); if (removed.exitCode !== 0 && !/not found|doesn't exist/iu.test(removed.stderr)) throw new Error('LXD orphan cleanup failed: ' + removed.stderr.slice(0, 1_000)) }
    const networks = await this.managedNetworkNames(workerId)
    for (const network of networks) { const removed = await commandOk(this.lxc, ['network', 'delete', network], 120_000); if (removed.exitCode !== 0 && !/not found|doesn't exist/iu.test(removed.stderr)) throw new Error('LXD orphan network cleanup failed: ' + removed.stderr.slice(0, 1_000)) }
    const acls = await this.managedAclNames(workerId)
    for (const acl of acls) { const removed = await commandOk(this.lxc, ['network', 'acl', 'delete', acl], 120_000); if (removed.exitCode !== 0 && !/not found|doesn't exist/iu.test(removed.stderr)) throw new Error('LXD orphan ACL cleanup failed: ' + removed.stderr.slice(0, 1_000)) }
    return [...names, ...networks, ...acls]
  }

  async execute(state: LxdState, request: SandboxExecRequest, signal?: AbortSignal): Promise<SandboxExecResult> {
    const args = ['exec', state.instance, '--force-noninteractive']
    const environment = Object.entries(request.env ?? {})
    for (const [key] of environment) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || key.startsWith('LXD_')) throw new Error('invalid sandbox environment variable: ' + key)
    }
    const environmentFile = environment.length > 0 ? await this.pushEnvironmentFile(state, environment) : undefined
    try {
      if (this.options.kind === 'lxd-vm') {
        const unit = 'agent-eval-' + randomUUID()
        args.push('--', 'systemd-run', '--quiet', '--wait', '--collect', '--pipe', '--service-type=exec',
          '--unit=' + unit, '--setenv=AGENT_EVAL_SYSTEMD_UNIT=' + unit,
          '--property=TasksMax=' + String(state.input.policy.resources.pids),
          '--property=MemoryMax=' + String(state.input.policy.resources.memoryMb) + 'M')
        if (request.cwd) args.push('--working-directory=' + sandboxPath(request.cwd))
        args.push('--', ...(environmentFile ? ['sh', '-ceu', 'set -a; . "$1"; set +a; shift; exec "$@"', 'load-env', environmentFile, ...request.argv] : request.argv))
      } else {
        if (request.cwd) args.push('--cwd', sandboxPath(request.cwd))
        args.push('--', ...(environmentFile ? ['sh', '-ceu', 'set -a; . "$1"; set +a; shift; exec "$@"', 'load-env', environmentFile, ...request.argv] : request.argv))
      }
      return await runProcess({ command: this.lxc, args, stdin: request.stdin, timeoutMs: request.timeoutMs, signal, onStdout: request.onStdout, onStderr: request.onStderr, onAbort: async () => { await commandOk(this.lxc, ['stop', '--force', state.instance], 60_000).catch(() => undefined) } })
    } finally {
      if (environmentFile) await commandOk(this.lxc, ['file', 'delete', state.instance + environmentFile], 10_000).catch(() => undefined)
    }
  }

  private async pushEnvironmentFile(state: LxdState, environment: readonly (readonly [string, string])[]): Promise<string> {
    const directory = join(resolve(state.input.workerDataDir), 'environment')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const name = 'env-' + randomUUID()
    const local = join(directory, name)
    const remote = '/tmp/eval-transfer/' + name
    const body = environment.map(([key, value]) => key + '=' + shellLiteral(value)).join('\n') + '\n'
    await writeFile(local, body, { encoding: 'utf8', mode: 0o600 })
    try {
      const pushed = await commandOk(this.lxc, ['file', 'push', local, state.instance + remote, '--mode', '0600', '--uid', '0', '--gid', '0'], 30_000)
      if (pushed.exitCode !== 0) throw new Error('LXD environment injection failed: ' + pushed.stderr.slice(0, 1_000))
      return remote
    } finally { await rm(local, { force: true }) }
  }

  async putArchive(state: LxdState, archivePath: string, destination: string): Promise<void> {
    const relativeArchive = relativeArtifactPath(archivePath)
    const source = await containedHostPath(state.input.workerDataDir, join(resolve(state.input.workerDataDir), relativeArchive), true)
    if (state.input.task.repository.kind !== 'artifact' || state.input.task.repository.archiveRef !== relativeArchive) throw new Error('sandbox archive upload is not the declared task repository')
    const actual = createHash('sha256').update(await readFile(source)).digest('hex')
    if (actual !== state.input.task.repository.archiveSha256) throw new Error('task repository archive SHA-256 mismatch')
    const target = sandboxPath(destination)
    const remoteArchive = '/tmp/eval-transfer/input-' + Date.now().toString(36) + '.tar'
    const pushed = await commandOk(this.lxc, ['file', 'push', source, state.instance + remoteArchive], 120_000)
    if (pushed.exitCode !== 0) throw new Error('LXD archive upload failed: ' + pushed.stderr.slice(0, 1_000))
    const extracted = await this.exec(state.instance, { argv: ['sh', '-ceu', 'mkdir -p "$1" && tar -xf "$2" -C "$1" && rm -f "$2"', 'extract', target, remoteArchive], timeoutMs: 120_000 })
    if (extracted.exitCode !== 0) throw new Error('LXD archive extraction failed: ' + extracted.stderr.slice(0, 1_000))
  }

  async getArchive(state: LxdState, source: string, archivePath: string): Promise<void> {
    const sandboxSource = sandboxPath(source)
    const destination = await containedHostPath(state.input.workerDataDir, archivePath, false)
    await mkdir(resolve(destination, '..'), { recursive: true, mode: 0o700 })
    const remoteArchive = '/tmp/eval-transfer/output-' + Date.now().toString(36) + '.tar'
    const packed = await this.exec(state.instance, { argv: ['tar', '-cf', remoteArchive, '-C', sandboxSource, '.'], timeoutMs: 120_000 })
    if (packed.exitCode !== 0) throw new Error('LXD archive creation failed: ' + packed.stderr.slice(0, 1_000))
    const pulled = await commandOk(this.lxc, ['file', 'pull', state.instance + remoteArchive, destination], 120_000)
    if (pulled.exitCode !== 0) throw new Error('LXD archive download failed: ' + pulled.stderr.slice(0, 1_000))
    await this.exec(state.instance, { argv: ['rm', '-f', remoteArchive], timeoutMs: 10_000 })
  }

  async snapshot(state: LxdState): Promise<SandboxSnapshot> {
    const snapshots = join(resolve(state.input.workerDataDir), 'snapshots')
    return await withTemporaryDirectory(snapshots, state.instance + '-', async (directory) => {
      const pulled = await commandOk(this.lxc, ['file', 'pull', '--recursive', state.instance + '/workspace/.', join(directory, 'workspace')], 120_000)
      if (pulled.exitCode !== 0) throw new Error('LXD workspace snapshot failed: ' + pulled.stderr.slice(0, 1_000))
      return await snapshotDirectory(join(directory, 'workspace'))
    })
  }

  private get lxc(): string { return this.options.lxcBinary ?? 'lxc' }
  private state(target: SandboxExecutionTarget): LxdState { const state = this.states.get(target.sandboxId); if (!state) throw new Error('unknown LXD sandbox: ' + target.sandboxId); return state }
  private async version(): Promise<string> { const result = await commandOk(this.lxc, ['version'], 10_000); return result.stdout.trim().split('\n')[0] || 'unknown' }
  private async createAllowlistNetwork(input: SandboxCreateInput): Promise<LxdNetwork> {
    const suffix = createHash('sha256').update(input.workerId + '\0' + input.trialId).digest('hex').slice(0, 8)
    const network = 'ae-n-' + suffix
    const acl = 'ae-a-' + suffix
    const subnetValue = Number.parseInt(suffix.slice(0, 4), 16)
    const subnetBase = ((subnetValue & 0xff) & 0xf8)
    const gateway = '10.222.' + String(subnetValue >>> 8) + '.' + String(subnetBase + 1)
    const address = '10.222.' + String(subnetValue >>> 8) + '.' + String(subnetBase + 2) + '/29'
    const subnet = gateway + '/29'
    const destinations = parseAllowedDestinations(input.policy.network.allowedDestinations)
    const hosts = destinations.flatMap((destination) => destination.hostname ? [{ hostname: destination.hostname, address: destination.address.replace(/\/32$/u, '') }] : [])
    const createdAcl = await commandOk(this.lxc, ['network', 'acl', 'create', acl], 30_000)
    if (createdAcl.exitCode !== 0) throw new Error('LXD trial ACL creation failed: ' + createdAcl.stderr.slice(0, 1_000))
    try {
      await requireCommand(this.lxc, ['network', 'acl', 'set', acl, 'user.agent-eval.managed=true', 'user.agent-eval.worker=' + input.workerId, 'user.agent-eval.trial=' + input.trialId], 'LXD trial ACL labelling')
      await requireCommand(this.lxc, ['network', 'acl', 'rule', 'add', acl, 'ingress', 'action=allow', 'protocol=udp', 'source_port=67', 'destination_port=68', 'description=DHCP reply'], 'LXD trial DHCP ingress rule')
      await requireCommand(this.lxc, ['network', 'acl', 'rule', 'add', acl, 'egress', 'action=allow', 'protocol=udp', 'source_port=68', 'destination_port=67', 'description=DHCP request'], 'LXD trial DHCP egress rule')
      for (const destination of destinations) {
        const args = ['network', 'acl', 'rule', 'add', acl, 'egress', 'action=allow', 'destination=' + destination.address]
        if (destination.port !== undefined) args.push('protocol=tcp', 'destination_port=' + String(destination.port))
        args.push('description=declared evaluation destination')
        await requireCommand(this.lxc, args, 'LXD trial destination rule')
      }
      await requireCommand(this.lxc, ['network', 'create', network, 'ipv4.address=' + subnet, 'ipv4.nat=true', 'ipv6.address=none', 'security.acls=' + acl, 'security.acls.default.egress.action=reject', 'security.acls.default.ingress.action=reject', 'user.agent-eval.managed=true', 'user.agent-eval.worker=' + input.workerId, 'user.agent-eval.trial=' + input.trialId], 'LXD trial network creation')
      return { network, acl, address, gateway, hosts }
    } catch (error) {
      await commandOk(this.lxc, ['network', 'delete', network], 30_000).catch(() => undefined)
      await commandOk(this.lxc, ['network', 'acl', 'delete', acl], 30_000).catch(() => undefined)
      throw error
    }
  }
  private async destroyAllowlistNetwork(network: LxdNetwork): Promise<void> {
    const removedNetwork = await commandOk(this.lxc, ['network', 'delete', network.network], 120_000)
    if (removedNetwork.exitCode !== 0 && !/not found|doesn't exist/iu.test(removedNetwork.stderr)) throw new Error('LXD trial network deletion failed: ' + removedNetwork.stderr.slice(0, 1_000))
    const removedAcl = await commandOk(this.lxc, ['network', 'acl', 'delete', network.acl], 120_000)
    if (removedAcl.exitCode !== 0 && !/not found|doesn't exist/iu.test(removedAcl.stderr)) throw new Error('LXD trial ACL deletion failed: ' + removedAcl.stderr.slice(0, 1_000))
  }
  private async managedNetworkNames(workerId: string): Promise<string[]> {
    const listed = await commandOk(this.lxc, ['network', 'list', '--format', 'json'], 30_000)
    if (listed.exitCode !== 0) throw new Error('LXD managed network discovery failed: ' + listed.stderr.slice(0, 1_000))
    return managedNames(listed.stdout, workerId, 'network')
  }
  private async managedAclNames(workerId: string): Promise<string[]> {
    const listed = await commandOk(this.lxc, ['network', 'acl', 'list', '--format', 'json'], 30_000)
    if (listed.exitCode !== 0) throw new Error('LXD managed ACL discovery failed: ' + listed.stderr.slice(0, 1_000))
    return managedNames(listed.stdout, workerId, 'ACL')
  }
  private async exec(instance: string, request: SandboxExecRequest): Promise<SandboxExecResult> { return await runProcess({ command: this.lxc, args: ['exec', instance, '--force-noninteractive', ...(request.cwd ? ['--cwd', sandboxPath(request.cwd)] : []), '--', ...request.argv], stdin: request.stdin, timeoutMs: request.timeoutMs }) }
}

export function canonicalLxdImageDigest(resolved: string, requested: string): string {
  if (!resolved) return requested
  if (requested.startsWith('local:') && requested.slice('local:'.length) === resolved) return requested
  return resolved
}

function parseAllowedDestinations(values: readonly string[]): Array<{ address: string; port?: number; hostname?: string }> {
  if (values.length === 0) throw new Error('LXD allowlist mode requires at least one destination')
  return values.map((value) => {
    let address = value
    let port: number | undefined
    let hostname: string | undefined
    const lockedHostname = /^([a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?)=(\d{1,3}(?:\.\d{1,3}){3})(?::(\d{1,5}))?$/iu.exec(value)
    if (lockedHostname) {
      hostname = lockedHostname[1]!.toLowerCase()
      address = lockedHostname[2]!
      port = lockedHostname[3] ? Number(lockedHostname[3]) : undefined
    } else
    if (value.includes('://')) {
      const parsed = new URL(value)
      if (parsed.username || parsed.password || (parsed.pathname && parsed.pathname !== '/') || parsed.search || parsed.hash) throw new Error('LXD allowlist URL must identify only an origin: ' + value)
      address = parsed.hostname
      port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : parsed.protocol === 'http:' ? 80 : undefined
    } else {
      const match = /^(\d{1,3}(?:\.\d{1,3}){3})(?::(\d{1,5}))?$/u.exec(value)
      if (!match) throw new Error('LXD allowlist destination must be an IPv4 address with optional port: ' + value)
      address = match[1]!
      port = match[2] ? Number(match[2]) : undefined
    }
    if (isIP(address) !== 4) throw new Error('LXD allowlist destination must use an immutable IPv4 address: ' + value)
    if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new Error('LXD allowlist destination has an invalid port: ' + value)
    return { address: address + '/32', ...(port === undefined ? {} : { port }), ...(hostname === undefined ? {} : { hostname }) }
  })
}

function shellLiteral(value: string): string {
  if (value.includes('\0') || value.includes('\n') || value.includes('\r')) throw new Error('sandbox environment values cannot contain NUL or newlines')
  return "'" + value.replaceAll("'", "'\"'\"'") + "'"
}

function managedNames(body: string, workerId: string, kind: string): string[] {
  let entries: unknown
  try { entries = JSON.parse(body) } catch { throw new Error('LXD managed ' + kind + ' discovery returned invalid JSON') }
  if (!Array.isArray(entries)) throw new Error('LXD managed ' + kind + ' discovery returned invalid JSON')
  return entries.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return []
    const value = entry as Record<string, unknown>
    const config = value.config && typeof value.config === 'object' ? value.config as Record<string, unknown> : {}
    return config['user.agent-eval.managed'] === 'true' && config['user.agent-eval.worker'] === workerId && typeof value.name === 'string' ? [value.name] : []
  })
}

async function requireCommand(binary: string, args: readonly string[], label: string): Promise<void> {
  const result = await commandOk(binary, args, 30_000)
  if (result.exitCode !== 0) throw new Error(label + ' failed: ' + result.stderr.slice(0, 1_000))
}

class LxdExecutionTarget implements SandboxExecutionTarget {
  readonly sandboxId: string
  readonly descriptor
  readonly workspacePath = '/workspace'
  constructor(private readonly provider: LxdSandboxProvider, private readonly state: LxdState) { this.sandboxId = state.instance; this.descriptor = provider.descriptor }
  async execute(request: SandboxExecRequest, signal?: AbortSignal) { return await this.provider.execute(this.state, request, signal) }
  async putArchive(archivePath: string, destination: string) { await this.provider.putArchive(this.state, archivePath, destination) }
  async getArchive(source: string, archivePath: string) { await this.provider.getArchive(this.state, source, archivePath) }
  async snapshot() { return await this.provider.snapshot(this.state) }
}

export async function waitForExec(lxc: string, instance: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const probe = await commandOk(lxc, ['exec', instance, '--force-noninteractive', '--', 'true'], 10_000).catch(() => undefined)
    if (probe?.exitCode === 0) {
      const ready = await commandOk(lxc, ['exec', instance, '--force-noninteractive', '--', 'sh', '-ceu', 'if test -d /run/systemd/system && command -v systemctl >/dev/null 2>&1; then state=$(systemctl show --property=SystemState --value); test "$state" = running -o "$state" = degraded; fi'], 10_000).catch(() => undefined)
      if (ready?.exitCode === 0) return
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error('LXD guest did not become ready before deadline')
}

async function waitForLxdNetworkReady(lxc: string, instance: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const probe = await commandOk(lxc, ['exec', instance, '--force-noninteractive', '--', 'sh', '-ceu', 'test -e /sys/class/net/eth0; grep -qE "^[^ ]+\\s+00000000\\s+" /proc/net/route'], 10_000).catch(() => undefined)
    if (probe?.exitCode === 0) return
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('LXD allowlisted network did not become ready before deadline')
}

export async function configureLxdNetwork(lxc: string, instance: string, network: Pick<LxdNetwork, 'address' | 'gateway'>, timeoutMs: number): Promise<void> {
  const script = [
    'if command -v ip >/dev/null 2>&1; then ip_cmd=ip;',
    'elif test -x /usr/local/bin/busybox; then ip_cmd="/usr/local/bin/busybox ip";',
    'elif command -v busybox >/dev/null 2>&1; then ip_cmd="busybox ip";',
    'else echo "trial image has no ip command" >&2; exit 127; fi;',
    '$ip_cmd link set eth0 up;',
    '$ip_cmd address add "$1" dev eth0 2>/dev/null || $ip_cmd address show dev eth0 | grep -F "${1%/*}" >/dev/null;',
    '$ip_cmd route add default via "$2" dev eth0 2>/dev/null || $ip_cmd route show | grep -F "default via $2" >/dev/null',
  ].join(' ')
  const configured = await commandOk(lxc, ['exec', instance, '--force-noninteractive', '--', 'sh', '-ceu', script, 'configure-network', network.address, network.gateway], timeoutMs)
  if (configured.exitCode !== 0) throw new Error('LXD allowlisted network configuration failed: ' + configured.stderr.slice(0, 1_000))
}

export async function configureLxdHosts(lxc: string, instance: string, hosts: readonly { hostname: string; address: string }[], timeoutMs: number): Promise<void> {
  if (hosts.length === 0) return
  const body = hosts.map((host) => host.address + ' ' + host.hostname).join('\n') + '\n'
  const configured = await commandOk(lxc, ['exec', instance, '--force-noninteractive', '--', 'sh', '-ceu', 'printf %s "$1" >> /etc/hosts', 'configure-hosts', body], timeoutMs)
  if (configured.exitCode !== 0) throw new Error('LXD locked hostname configuration failed: ' + configured.stderr.slice(0, 1_000))
}

export async function configureLxdLoopback(lxc: string, instance: string, timeoutMs: number): Promise<void> {
  const script = [
    'if command -v ip >/dev/null 2>&1; then ip_cmd=ip;',
    'elif test -x /usr/local/bin/busybox; then ip_cmd="/usr/local/bin/busybox ip";',
    'elif command -v busybox >/dev/null 2>&1; then ip_cmd="busybox ip";',
    'else echo "trial image has no ip command" >&2; exit 127; fi;',
    '$ip_cmd link set lo up;',
    '$ip_cmd address show dev lo | grep -F "127.0.0.1/8" >/dev/null',
  ].join(' ')
  const configured = await commandOk(lxc, ['exec', instance, '--force-noninteractive', '--', 'sh', '-ceu', script], timeoutMs)
  if (configured.exitCode !== 0) throw new Error('LXD loopback configuration failed: ' + configured.stderr.slice(0, 1_000))
}
