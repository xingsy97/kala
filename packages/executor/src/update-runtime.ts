import { createPublicKey, verify } from 'node:crypto'
import { access, mkdir, open, readFile, readlink, rename, rm, symlink } from 'node:fs/promises'
import { constants } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'

import type { RuntimeLogger } from './logger.js'
import { requestUpdateControl } from './update-control.js'
import { GenerationUpdater, type RestartPlan, type SignedUpdateManifest, type UpdateChannel, type UpdateLifecycle, type Verifier } from './update.js'

export type ManagedUpdateOptions = {
  root: string
  manifestUrl: string
  publicKeyPath: string
  currentVersion?: string
  channel: UpdateChannel
  protocol: number
  serviceMode: 'system' | 'user'
  workspaceId: string
  socketPath: string
  drainTimeoutMs?: number
  reconnectTimeoutMs?: number
  logger: RuntimeLogger
}

export function ed25519Verifier(publicKeyPem: string): Verifier {
  const key = createPublicKey(publicKeyPem)
  return { verify: (signed, signature) => verify(null, Buffer.from(signed), key, Buffer.from(signature, 'base64')) }
}

export async function applyManagedUpdate(options: ManagedUpdateOptions): Promise<Awaited<ReturnType<GenerationUpdater['run']>>> {
  return await withUpdateLock(options.root, async () => {
    const publicKey = await readFile(options.publicKeyPath, 'utf8')
    const lifecycle = linuxServiceUpdateLifecycle(options)
    const updater = new GenerationUpdater({
      installationSource: 'dashboard-native', manifestUrl: options.manifestUrl,
      ...(options.currentVersion ? { currentVersion: options.currentVersion } : {}),
      channel: options.channel, protocol: options.protocol, root: options.root,
      verifier: ed25519Verifier(publicKey), lifecycle,
    })
    return await updater.run()
  })
}

export async function rollbackManagedUpdate(options: Pick<ManagedUpdateOptions, 'root' | 'serviceMode' | 'workspaceId' | 'socketPath' | 'reconnectTimeoutMs' | 'logger'>): Promise<void> {
  const current = await pointer(options.root, 'current')
  const previous = await pointer(options.root, 'previous')
  if (!current || !previous) throw new Error('no previous Executor generation is available')
  await publishPointer(join(options.root, 'current'), previous)
  await publishPointer(join(options.root, 'previous'), current)
  await restartService(options.serviceMode)
  await waitForHealthy(options.socketPath, options.workspaceId, basename(previous), options.reconnectTimeoutMs ?? 60_000)
}

function linuxServiceUpdateLifecycle(options: ManagedUpdateOptions): UpdateLifecycle {
  return {
    async selfTest(generationPath, manifest) {
      const executable = join(generationPath, manifest.artifact.file ?? 'runlab-executor')
      await access(executable, constants.X_OK)
      const result = await run(executable, ['--version'], 20_000)
      if (result.code !== 0 || !result.stdout.includes(manifest.release)) throw new Error(`Executor self-test failed: ${result.stderr || result.stdout}`)
    },
    async drain() {
      const deadline = Date.now() + (options.drainTimeoutMs ?? 90_000)
      let status = await requestUpdateControl(options.socketPath, 'drain')
      while (status.activeTools > 0 || status.activeTerminals > 0) {
        if (Date.now() >= deadline) {
          await requestUpdateControl(options.socketPath, 'resume').catch(() => undefined)
          throw new Error(`update postponed: Executor still has ${status.activeTools} Tool call(s) and ${status.activeTerminals} terminal(s)`)
        }
        await delay(500)
        status = await requestUpdateControl(options.socketPath, 'status')
      }
    },
    async restart(_plan: RestartPlan) { await restartService(options.serviceMode) },
    async health(manifest: SignedUpdateManifest) { await waitForHealthy(options.socketPath, options.workspaceId, manifest.release, options.reconnectTimeoutMs ?? 60_000) },
    async reconnect(manifest: SignedUpdateManifest) { await waitForHealthy(options.socketPath, options.workspaceId, manifest.release, options.reconnectTimeoutMs ?? 60_000) },
    async rollbackHealth(previousGeneration: string) { await waitForHealthy(options.socketPath, options.workspaceId, basename(previousGeneration), options.reconnectTimeoutMs ?? 60_000) },
  }
}

async function restartService(mode: 'system' | 'user'): Promise<void> {
  const args = [...(mode === 'user' ? ['--user'] : []), 'restart', 'runlab-executor.service']
  const result = await run('systemctl', args, 90_000)
  if (result.code !== 0) throw new Error(`failed to restart Executor service: ${result.stderr || result.stdout}`)
}

async function waitForHealthy(socketPath: string, workspaceId: string, release: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const status = await requestUpdateControl(socketPath, 'status', 2_000)
      if (status.workspaceId === workspaceId && status.connected && status.version === release) return
    } catch (error) { lastError = error }
    await delay(500)
  }
  throw new Error(`Executor ${release} did not reconnect healthy within ${timeoutMs}ms`, { cause: lastError })
}

async function pointer(root: string, name: string): Promise<string | undefined> {
  try { return resolve(root, await readlink(join(root, name))) } catch { return undefined }
}
async function publishPointer(path: string, target: string): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}`
  await rm(temporary, { force: true })
  await symlink(target, temporary, process.platform === 'win32' ? 'junction' : 'dir')
  await rename(temporary, path)
}
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)) }
async function withUpdateLock<T>(root: string, action: () => Promise<T>): Promise<T> {
  await mkdir(root, { recursive: true, mode: 0o700 })
  const lock = join(root, 'update.lock')
  let handle
  try { handle = await open(lock, 'wx', 0o600) } catch { throw new Error('another Executor update is already in progress') }
  try { return await action() } finally { await handle.close(); await rm(lock, { force: true }) }
}
function run(file: string, args: readonly string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(file, [...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout: Buffer[] = [], stderr: Buffer[] = []
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${file} timed out after ${timeoutMs}ms`)) }, timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk)); child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('close', (code) => { clearTimeout(timer); resolveRun({ code: code ?? -1, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() }) })
  })
}
