#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

import { ReproductionTaskContractSchema, verifyReproductionBundleSignature } from '@agent-kernel/eval-protocol'
import { ArtifactEntrySchema, ControlPlaneDeadlineError, ControlPlaneHttpError, ControlPlaneClient, staticBearerToken } from '@agent-kernel/eval-sdk'
import { createBackup, restoreBackup, sweepRetention, verifyBackup } from '../src/maintenance.js'

class UsageError extends Error { readonly code = 'USAGE_ERROR' }
const parsedArguments = parseArguments(process.argv.slice(2))
const [command, action] = parsedArguments.positionals

try {
  const token = option('--token') ?? process.env.AGENT_EVAL_TOKEN
  const tokenFile = option('--token-file') ?? process.env.AGENT_EVAL_TOKEN_FILE
  if (token && tokenFile) throw new UsageError('use only one of --token or --token-file')
  const resolvedToken = token ?? (tokenFile ? (await readFile(resolve(tokenFile), 'utf8')).trim() : undefined)
  const client = new ControlPlaneClient({ baseUrl: option('--url') ?? process.env.AGENT_EVAL_URL ?? 'http://127.0.0.1:13100', deadlineMs: positiveInteger(option('--deadline-ms') ?? process.env.AGENT_EVAL_DEADLINE_MS ?? '30000', '--deadline-ms'), ...(resolvedToken ? { credentialProvider: staticBearerToken(resolvedToken) } : {}) })
  await dispatch(client)
} catch (error) {
  const result = normalizedError(error); process.stderr.write(JSON.stringify(result) + '\n'); process.exitCode = result.exitCode
}

async function dispatch(client: ControlPlaneClient): Promise<void> {
  const page = { limit: positiveInteger(option('--limit') ?? '50', '--limit'), ...(option('--cursor') ? { cursor: option('--cursor')! } : {}) }
  if (command === 'reproduce') return print(await reproduce(required('--bundle')))
  if (command === 'retention-sweep') return print(await sweepRetention(required('--data-dir'), required('--policy'), flag('--dry-run'), new Date(), option('--confirm')))
  if (command === 'backup') return print(await createBackup(required('--data-dir'), required('--output'), { rpoTargetSeconds: integerOption('--rpo-seconds'), rtoTargetSeconds: integerOption('--rto-seconds') }))
  if (command === 'backup-verify') return print(await verifyBackup(required('--backup')))
  if (command === 'restore-verify') { const output = required('--output'); return print(await restoreBackup(required('--backup'), output, option('--confirm'))) }
  if (command === 'capabilities') return print(await client.capabilities())
  if (command === 'command') return print(await client.command(await jsonFile('--file'), idempotencyOptions()))
  if (command === 'query') return print(await client.query(await jsonFile('--file')))
  if (command === 'run') {
    if (action === 'list') return print(await client.query({ resource: 'runs', page }))
    if (action === 'get') return print(await client.query({ resource: 'run', runId: required('--run-id') }))
    if (action === 'create') return print(await client.command({ type: 'run.create', spec: await jsonFile('--file') } as never, idempotencyOptions()))
    if (['start', 'grade', 'align', 'cluster'].includes(String(action))) return print(await client.command({ type: `run.${action}`, runId: required('--run-id') } as never, idempotencyOptions()))
    if (action === 'cancel') return print(await client.command({ type: 'run.cancel', runId: required('--run-id'), reason: required('--reason') }, idempotencyOptions()))
    if (action === 'watch') {
      const abort = new AbortController(); const stop = () => abort.abort(new DOMException('interrupted', 'AbortError'))
      process.once('SIGINT', stop); process.once('SIGTERM', stop)
      try { for await (const event of client.watchEvents(required('--run-id'), { signal: abort.signal, ...(option('--last-event-id') ? { lastEventId: option('--last-event-id')! } : {}), ...(option('--watch-deadline-ms') ? { deadlineMs: positiveInteger(option('--watch-deadline-ms')!, '--watch-deadline-ms') } : {}), ...(option('--reconnect-attempts') ? { reconnectAttempts: nonnegativeInteger(option('--reconnect-attempts')!, '--reconnect-attempts') } : {}), ...(option('--reconnect-delay-ms') ? { reconnectDelayMs: nonnegativeInteger(option('--reconnect-delay-ms')!, '--reconnect-delay-ms') } : {}) })) print(event) } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop) }
      return
    }
  }
  if (command === 'trial') {
    if (action === 'list') return print(await client.query({ resource: 'trials', runId: required('--run-id'), page }))
    if (action === 'get') return print(await client.query({ resource: 'trial', trialId: required('--trial-id') }))
    if (action === 'retry') return print(await client.command({ type: 'trial.retry', runId: required('--run-id'), trialIds: required('--trial-ids').split(',') }, idempotencyOptions()))
  }
  if (command === 'worker') {
    if (action === 'list') return print(await client.query({ resource: 'workers', page }))
    if (action === 'register') return print(await client.registerWorker(await jsonFile('--file')))
    if (action === 'heartbeat') { await client.heartbeatWorker(required('--worker-id')); return print({ committed: true }) }
  }
  if (command === 'report') {
    if (action === 'list') return print(await client.query({ resource: 'reports', page }))
    if (action === 'generate') return print(await client.command({ type: 'report.generate', reportId: required('--report-id'), runIds: required('--run-ids').split(','), methodologyVersion: required('--methodology-version') }, idempotencyOptions()))
  }
  if (command === 'leaderboard') {
    if (action === 'list') return print(await client.query({ resource: 'leaderboard', pivot: (option('--pivot') ?? 'model') as 'model', sliceManifestHash: required('--slice-manifest-hash'), page }))
    if (action === 'publish') return print(await client.command({ type: 'leaderboard.publish', runId: required('--run-id') }, idempotencyOptions()))
    if (action === 'invalidate') return print(await client.command({ type: 'leaderboard.invalidate', entryId: required('--entry-id'), reason: required('--reason') }, idempotencyOptions()))
  }
  if (command === 'artifact') {
    if (action === 'list') return print(await client.query({ resource: 'artifacts', runId: required('--run-id'), page }))
    if (action === 'download') { const entry = ArtifactEntrySchema.parse(await jsonFile('--entry')); const bytes = await client.downloadArtifact(entry, required('--trial-id')); await writeFile(resolve(required('--output')), bytes); return print({ artifactId: entry.artifactId, bytes: bytes.byteLength, sha256: entry.sha256, verified: true }) }
  }
  if (command === 'admin') {
    if (action === 'capabilities') return print(await client.capabilities())
    if (action === 'metrics') return print(await client.query({ resource: 'platform-metrics' }))
    if (action === 'audit') return print(await client.query({ resource: 'audit', page, ...(option('--actor-id') ? { actorId: option('--actor-id')! } : {}), ...(option('--operation') ? { operation: option('--operation')! } : {}), ...(option('--resource-type') ? { resourceType: option('--resource-type')! } : {}), ...(flag('--trusted-only') ? { trustedOnly: true } : {}) }))
    if (action === 'retention') return print(await client.query({ resource: 'retention', page }))
    if (action === 'status') return print(await client.administrationStatus())
    if (action === 'security-reload') return print(await client.reloadSecurity(required('--confirm') as 'reload-security-registry'))
    if (action === 'command') return print(await client.command(await jsonFile('--file'), idempotencyOptions()))
    if (action === 'query') return print(await client.query(await jsonFile('--file')))
  }
  throw new UsageError('usage: agent-eval <run|trial|worker|report|leaderboard|artifact|admin> <action> [options]')
}

async function jsonFile(name: string): Promise<any> { return JSON.parse(await readFile(resolve(required(name)), 'utf8')) }
function idempotencyOptions(): { idempotencyKey?: string } { return option('--idempotency-key') ? { idempotencyKey: option('--idempotency-key')! } : {} }
function positiveInteger(value: string, name: string): number { const parsed = Number(value); if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new UsageError(name + ' must be a positive integer'); return parsed }
function nonnegativeInteger(value: string, name: string): number { const parsed = Number(value); if (!Number.isSafeInteger(parsed) || parsed < 0) throw new UsageError(name + ' must be a nonnegative integer'); return parsed }
function normalizedError(error: unknown): { code: string; message: string; status?: number; exitCode: number } {
  if (error instanceof UsageError) return { code: error.code, message: error.message, exitCode: 2 }
  if (error instanceof ControlPlaneDeadlineError) return { code: error.code, message: error.message, exitCode: 6 }
  if (error instanceof ControlPlaneHttpError) return { code: error.code, message: error.message, status: error.status, exitCode: error.status === 401 || error.status === 403 ? 3 : error.status === 404 ? 4 : error.status === 409 ? 5 : 1 }
  const value = error as { code?: unknown; message?: unknown }
  return { code: typeof value?.code === 'string' ? value.code : 'CLI_ERROR', message: typeof value?.message === 'string' ? value.message : String(error), exitCode: 1 }
}

async function reproduce(bundleDirectory: string): Promise<unknown> {
  const root = await realpath(resolve(bundleDirectory))
  const bundle = await verifyReproductionBundleSignature(JSON.parse((await readContained(root, 'bundle.json')).toString('utf8')))
  const prefix = 'bundles/' + bundle.bundleId + '/'
  for (const file of bundle.files) {
    if (!file.path.startsWith(prefix)) throw new Error('bundle file escaped its signed prefix')
    const relative = file.path.slice(prefix.length)
    if (!safeRelative(relative)) throw new Error('bundle file path is not relative and contained')
    const content = await readContained(root, relative)
    if (content.byteLength !== file.bytes || sha256(content) !== file.sha256) throw new Error('bundle file integrity mismatch: ' + relative)
  }
  const checksums = (await readContained(root, 'SHA256SUMS')).toString('utf8')
  for (const line of checksums.trim().split('\n')) {
    const match = /^([a-f0-9]{64})  (.+)$/u.exec(line)
    if (!match || !safeRelative(match[2]!)) throw new Error('invalid SHA256SUMS entry')
    if (sha256(await readContained(root, match[2]!)) !== match[1]) throw new Error('SHA256SUMS mismatch: ' + match[2])
  }
  const environmentLock = JSON.parse((await readContained(root, 'environment.lock.json')).toString('utf8')) as { provider?: unknown; imageDigest?: unknown }
  const task = ReproductionTaskContractSchema.parse(JSON.parse((await readContained(root, 'task.json')).toString('utf8')))
  const contract = task.reproduction
  if (sha256(contract.failureFingerprintSource) !== bundle.failureFingerprint) throw new Error('reproduction contract fingerprint source does not match signed bundle')
  if (environmentLock.provider !== 'docker' || typeof environmentLock.imageDigest !== 'string' || !environmentLock.imageDigest.includes('@sha256:')) throw new Error('one-command reproduction currently requires a locked Docker image digest')
  const docker = option('--docker-binary') ?? process.env.AGENT_EVAL_DOCKER_BINARY ?? 'docker'
  const container = 'agent-eval-reproduce-' + randomUUID().slice(0, 12)
  let created = false
  let reproduction: { observedFailureFingerprint: string; exitCode: number | null } | undefined
  try {
    await requireProcess(docker, ['create', '--name', container, '--hostname', 'eval-reproduction', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '64', '--memory', '256m', '--memory-swap', '256m', '--tmpfs', '/tmp:rw,noexec,nosuid,size=32m', '--tmpfs', '/workspace:rw,exec,nosuid,size=64m', environmentLock.imageDigest, 'sh', '-ceu', 'trap : TERM INT; sleep infinity & wait'])
    created = true
    await requireProcess(docker, ['start', container])
    const archive = zstdDecompressSync(await readContained(root, 'minimal-workspace.tar.zst'))
    await requireProcess(docker, ['exec', '--interactive', container, 'tar', '-xf', '-', '-C', '/workspace'], archive)
    const observed = await runProcess(docker, ['exec', '--interactive', '--workdir', '/workspace', container, ...contract.argv])
    if (observed.exitCode !== contract.expectedExitCode || !observed.stderr.includes(contract.stderrIncludes)) throw new Error('fresh one-command reproduction did not observe the signed failure contract')
    const observedFailureFingerprint = sha256(contract.failureFingerprintSource)
    if (observedFailureFingerprint !== bundle.failureFingerprint) throw new Error('fresh one-command reproduction fingerprint mismatch')
    reproduction = { observedFailureFingerprint, exitCode: observed.exitCode }
  } finally {
    if (created) {
      const removed = await runProcess(docker, ['rm', '--force', '--volumes', container])
      if (removed.exitCode !== 0) throw new Error('fresh reproduction sandbox cleanup failed: ' + removed.stderr.slice(0, 1_000))
      const inspected = await runProcess(docker, ['inspect', container])
      if (inspected.exitCode === 0 || !/No such object|No such container/iu.test(inspected.stderr)) throw new Error('fresh reproduction sandbox cleanup could not be verified: ' + inspected.stderr.slice(0, 1_000))
    }
  }
  if (!reproduction) throw new Error('fresh reproduction did not produce an outcome')
  return { schemaVersion: 1, bundleId: bundle.bundleId, freshEnvironmentId: container, reproduced: true, observedFailureFingerprint: reproduction.observedFailureFingerprint, exitCode: reproduction.exitCode, cleanupVerified: true }
}

async function requireProcess(command: string, args: string[], stdin?: Uint8Array): Promise<void> {
  const result = await runProcess(command, args, stdin)
  if (result.exitCode !== 0) throw new Error(command + ' command failed: ' + result.stderr.slice(0, 1_000))
}

async function runProcess(command: string, args: string[], stdin?: Uint8Array): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] })
  const stdout: Buffer[] = []; const stderr: Buffer[] = []
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk)); child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
  if (stdin) child.stdin.end(stdin); else child.stdin.end()
  const exitCode = await new Promise<number | null>((resolvePromise, reject) => { child.once('error', reject); child.once('close', resolvePromise) })
  return { exitCode, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }
}

function safeRelative(value: string): boolean { return Boolean(value) && value !== '..' && !value.startsWith('/') && !value.startsWith('../') && !value.includes('/../') }
function sha256(value: string | Uint8Array): string { return createHash('sha256').update(value).digest('hex') }
async function readContained(root: string, path: string): Promise<Buffer> {
  if (!safeRelative(path)) throw new Error('bundle path is not relative and contained')
  const candidate = resolve(root, path)
  const metadata = await lstat(candidate)
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('bundle path must be a regular non-symlink file: ' + path)
  const canonical = await realpath(candidate)
  const rel = relative(root, canonical)
  if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new Error('bundle path escaped the bundle root: ' + path)
  return await readFile(canonical)
}

function print(value: unknown): void { process.stdout.write(JSON.stringify(value, null, 2) + '\n') }
function required(name: string): string { const value = option(name); if (!value) throw new Error(name + ' is required'); return value }
function flag(name: string): boolean { return parsedArguments.flags.has(name) }
function integerOption(name: string): number { const value = Number(required(name)); if (!Number.isSafeInteger(value) || value < 0) throw new Error(name + ' must be a non-negative integer'); return value }
function option(name: string): string | undefined {
  const value = parsedArguments.options.get(name)
  if (value === null) throw new UsageError(name + ' requires a value')
  return value
}

function parseArguments(args: string[]): { positionals: string[]; options: Map<string, string | null>; flags: Set<string> } {
  const positionals: string[] = []; const options = new Map<string, string | null>(); const flags = new Set<string>()
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!
    if (!value.startsWith('--')) { positionals.push(value); continue }
    const equals = value.indexOf('=')
    if (equals >= 0) { options.set(value.slice(0, equals), value.slice(equals + 1) || null); continue }
    if (value === '--dry-run' || value === '--trusted-only') { flags.add(value); continue }
    const next = args[index + 1]
    if (!next || next.startsWith('--')) options.set(value, null)
    else { options.set(value, next); index += 1 }
  }
  return { positionals, options, flags }
}
