#!/usr/bin/env node
/**
 * `agent-kernel-executor` CLI.
 *
 * Env / flags:
 *   HOST_URL / --host           required (e.g. http://localhost:3000)
 *   WORKSPACE_NAME / --name     optional display label; defaults to os.hostname().
 *                               Free to rename — routing uses the workspaceId
 *                               (persisted at ~/.agent-kernel/workspace-id).
 *   SANDBOX_ROOTS / --sandbox-root
 *     optional workspace root(s). Absolute path(s). `SANDBOX_ROOTS` is a
 *     `:`-separated list; `--sandbox-root <path>` is repeatable. Session cwd
 *     may be the root itself or any child directory. Empty = no jail
 *     (executor trusts the whole machine).
 *   EXECUTOR_TOKEN / --token    optional long-term executor token
 *   EXECUTOR_INVITE / --invite  optional invite token from Dashboard
 *   EXECUTOR_ID / --id          optional; defaults to a ULID
 *   AGENT_KERNEL_EXECUTOR_PROFILE / --profile
 *     optional local profile. Non-default profiles use isolated lock,
 *     workspace-id, and executor-token files under ~/.agent-kernel/profiles/<profile>/.
 *   AGENT_KERNEL_AUTO_UPDATE / --auto-update
 *     optional; update the release asset from the latest GitHub Release before connecting.
 *   AGENT_KERNEL_NO_UPDATE_CHECK / --no-update-check
 *     optional; disable the default latest-release reminder.
 *
 * The executor is a daemon: it does NOT bind to a sessionId at startup.
 * The host routes `tool:call` messages to it for any session whose
 * `workspaceId` matches this executor's stored workspace id.
 */

import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, resolve, join, sep } from 'node:path'
import process from 'node:process'

import lockfile from 'proper-lockfile'

import { PROTOCOL_VERSION } from '@agent-kernel/shared'
import { startExecutor } from '../src/client.js'
import { createRuntimeLogger } from '../src/logger.js'
import { checkExecutorUpdate } from '../src/update.js'
import { applyManagedUpdate, rollbackManagedUpdate } from '../src/update-runtime.js'
import { startUpdateControlServer } from '../src/update-control.js'
import { executorReleaseVersion } from '../src/build-info.js'
import { loadExecutorToken, saveExecutorToken } from '../src/executor-token.js'
import { readPairingJson } from '../src/pairing-response.js'
import { readExecutorCredential, readExecutorRuntimeConfig } from '../src/executor-config.js'
import { parseSandboxRootsEnv } from '../src/sandbox-roots-env.js'
import { executorProfileDir, loadOrCreateWorkspaceId, normalizeExecutorProfile } from '../src/workspace-id.js'
import { bootstrapEnvironment, defaultManagedRoot, redeemInstallation, reportInstallation, waitForApproval, writeInstallerSession } from '../src/installer-flow.js'
import { createLinuxServicePlan, executeLinuxServicePlan, linuxServicePaths, type Command } from '../src/linux-service.js'
import { assertManagedWindowsInstallation, createWindowsServicePlan, executeWindowsServicePlan, type WindowsServiceAction } from '../src/windows-service.js'
import type { ServiceAction, ServiceMode } from '../src/cli-args.js'
import type { InstallerSession } from '../src/installer-session.js'
import { spawn } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'

const logger = createRuntimeLogger('agent-kernel-executor')

type Args = {
  help?: boolean
  version?: boolean
  host?: string
  name?: string
  sandboxRoots: string[]
  token?: string
  invite?: string
  id?: string
  profile?: string
  autoUpdate?: boolean
  noUpdateCheck?: boolean
  updateRepo?: string
  config?: string
  command?: 'run' | 'update' | 'service'
  updateAction?: 'apply' | 'rollback'
  serviceAction?: Exclude<ServiceAction, 'install'>
  serviceMode?: ServiceMode
}

function parseArgs(argv: readonly string[]): Args {
  const out: Args = { sandboxRoots: [], command: argv[0] === 'update' ? 'update' : argv[0] === 'service' ? 'service' : 'run' }
  let start = 0
  if (out.command === 'update') {
    if (argv[1] !== 'apply' && argv[1] !== 'rollback') throw new Error('Usage: runlab-executor update apply|rollback --config <path>')
    out.updateAction = argv[1]
    start = 2
  } else if (out.command === 'service') {
    const action = argv[1]
    if (!['status', 'logs', 'start', 'stop', 'restart', 'uninstall'].includes(action ?? '')) throw new Error('Usage: runlab-executor service status|logs|start|stop|restart|uninstall [--system|--user]')
    out.serviceAction = action as Args['serviceAction']
    start = 2
  }
  for (let i = start; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--') continue
    const eq = a.indexOf('=')
    const [key, inline] =
      eq === -1 ? [a, undefined] : [a.slice(0, eq), a.slice(eq + 1)]
    switch (key) {
      case '--auto-update':
        out.autoUpdate = true
        break
      case '--system':
        out.serviceMode = 'system'
        break
      case '--user':
        out.serviceMode = 'user'
        break
      case '-h':
      case '--help':
        out.help = true
        break
      case '-v':
      case '--version':
        out.version = true
        break
      case '--no-update-check':
        out.noUpdateCheck = true
        break
      case '--host':
      case '--name':
      case '--sandbox-root':
      case '--token':
      case '--invite':
      case '--id':
      case '--profile':
      case '--update-repo':
      case '--config': {
        const value = inline ?? argv[++i]
        if (value === undefined) break
        if (key === '--host') out.host = value
        else if (key === '--name') out.name = value
        else if (key === '--sandbox-root') out.sandboxRoots.push(value)
        else if (key === '--token') out.token = value
        else if (key === '--invite') out.invite = value
        else if (key === '--id') out.id = value
        else if (key === '--profile') out.profile = value
        else if (key === '--config') out.config = value
        else out.updateRepo = value
        break
      }
      default:
        break
    }
  }
  return out
}

function printHelp(): void {
  process.stdout.write(`Agent RunLab Executor

Usage:
  runlab-executor --host <url> [options]
  runlab-executor service status|logs|start|stop|restart|uninstall [--system|--user]
  runlab-executor update apply|rollback --config <path>

Options:
  -h, --help                 Show this help and exit.
  -v, --version              Print version and exit.
  --host <url>               Host URL to connect to. Defaults to HOST_URL.
  --name <workspace>         Workspace display name. Defaults to WORKSPACE_NAME or hostname.
  --sandbox-root <path>      Allowed filesystem root. Repeatable. Defaults to SANDBOX_ROOTS.
  --token <token>            Long-term executor token. Defaults to EXECUTOR_TOKEN.
  --invite <token>           One-time invite token. Defaults to EXECUTOR_INVITE.
  --id <id>                  Executor id. Defaults to EXECUTOR_ID or generated id.
  --profile <name>           Local profile for lock, workspace id, and token files.
  --auto-update              Update release asset before connecting.
  --no-update-check          Disable release update check.
  --update-repo <owner/repo> GitHub release repo. Defaults to AGENT_KERNEL_UPDATE_REPO.
  --config <path>             Managed service JSON config; credentials are loaded from its protected file.
  --system                    Manage the system service.
  --user                      Manage the current user's service.

Common environment:
  HOST_URL                   Host URL used when --host is omitted.
  WORKSPACE_NAME             Workspace display name.
  SANDBOX_ROOTS              Colon-separated sandbox roots.
  EXECUTOR_TOKEN             Long-term executor token.
  EXECUTOR_INVITE            One-time invite token.
  AGENT_KERNEL_EXECUTOR_PROFILE
                             Local profile. Example: dev.
  LOG_LEVEL                  trace, debug, info, warn, error. Default: info.
  LOG_FORMAT                 pretty/human or json. Default: pretty.

Examples:
  runlab-executor --host http://localhost:3000 --sandbox-root /workspace
  runlab-executor --host http://localhost:3000 --profile dev
  runlab-executor service status
  runlab-executor service logs
  runlab-executor service restart
  runlab-executor service stop
  runlab-executor service uninstall
`)
}

function printVersion(): void {
  process.stdout.write(`Agent RunLab Executor ${executorReleaseVersion()}\n`)
}

function printServiceCommands(mode: ServiceMode, executable = process.execPath): void {
  const user = mode === 'user' ? ' --user' : ''
  const modeFlag = mode === 'user' ? '--user' : '--system'
  process.stdout.write(`\n============================================================\n`)
  process.stdout.write(`  SERVICE INSTALLED AND RUNNING\n`)
  process.stdout.write(`============================================================\n`)
  process.stdout.write(`\nManage the Agent RunLab Executor service:\n\n`)
  process.stdout.write(`  Status    systemctl${user} status runlab-executor.service\n`)
  process.stdout.write(`  Logs      journalctl${user} -u runlab-executor.service -f\n`)
  process.stdout.write(`  Restart   systemctl${user} restart runlab-executor.service\n`)
  process.stdout.write(`  Stop      systemctl${user} stop runlab-executor.service\n`)
  process.stdout.write(`  Start     systemctl${user} start runlab-executor.service\n`)
  process.stdout.write(`  Uninstall ${JSON.stringify(executable)} service uninstall ${modeFlag}\n`)
  process.stdout.write(`\nThese commands are also available through the installed Executor CLI.\n`)
}

function printForegroundCommands(): void {
  process.stdout.write(`\n============================================================\n`)
  process.stdout.write(`  EXECUTOR CONNECTED - FOREGROUND MODE\n`)
  process.stdout.write(`============================================================\n`)
  process.stdout.write(`\n  Stop    Press Ctrl+C\n`)
  process.stdout.write(`  Status  Look for \"welcome from host\" and \"awaiting tool calls\" above\n`)
  process.stdout.write(`  Logs    This terminal is the live log stream (LOG_LEVEL=debug for details)\n`)
  process.stdout.write(`\nKeep this terminal open while using this Workspace.\n`)
}

/**
 * Acquire a single-instance lock at `~/.agent-kernel/executor.lock`. Fails
 * fast (no retry) if another executor process on the same user account is
 * already running. The lock is released automatically on process exit;
 * `proper-lockfile` also uses mtime-based stale detection so a crashed
 * executor's lock becomes reclaimable after 30 seconds.
 */
async function acquireLocalLock(
  logger: ReturnType<typeof createRuntimeLogger>,
  profile?: string,
): Promise<string> {
  const dir = executorProfileDir(profile)
  mkdirSync(dir, { recursive: true })
  const lockPath = join(dir, 'executor.lock')
  // proper-lockfile locks a target file - write an empty sentinel first
  // so its existence check succeeds.
  if (!existsSync(lockPath)) {
    writeFileSync(lockPath, '', { flag: 'a', mode: 0o600 })
  }
  try {
    await lockfile.lock(lockPath, {
      stale: 30_000,
      retries: 0,
      realpath: false,
    })
    // Overwrite the sentinel with our PID + timestamp so a user can trace
    // stray locks. (proper-lockfile itself keeps a sibling `.lock`
    // directory; the payload of `lockPath` is just informational.)
    writeFileSync(lockPath, `${process.pid}\n${new Date().toISOString()}\n`)
    return lockPath
  } catch (err) {
    // Contention: read whoever's already holding the lock.
    let existingPid = '?'
    try {
      existingPid = readFileSync(lockPath, 'utf8').split('\n')[0]?.trim() ?? '?'
    } catch {
      // ignore
    }
    logger.error(
      {
        existingPid,
        lockPath,
        err: err instanceof Error ? err.message : String(err),
      },
      `another executor is already running on this machine (pid ${existingPid}). ` +
        `Stop it first, or if you're sure no executor is running, delete ${lockPath}.`,
    )
    process.exit(1)
  }
}

async function runInternalInstaller(): Promise<void> {
  const env = bootstrapEnvironment(process.env)
  await reportInstallation(env, 'asset_verified')
  await reportInstallation(env, 'pairing_pending')
  await waitForApproval(env)
  const workspaceId = loadOrCreateWorkspaceId()
  const redeemed = await redeemInstallation(env, workspaceId)
  const workspaceRoot = env.EXECUTOR_INSTALL_ROOT === '__RUNLAB_CURRENT_DIRECTORY__' ? resolve(process.cwd()) : resolve(env.EXECUTOR_INSTALL_ROOT)
  process.stdout.write(`Agent RunLab workspace root: ${workspaceRoot}\n`)
  const service = env.EXECUTOR_INSTALL_MODE === 'service'
  if (service && process.platform === 'win32') return await installWindowsService(env, workspaceRoot, redeemed.token)
  const managedRoot = defaultManagedRoot(homedir(), service && process.getuid?.() === 0)
  const executable = service ? join(managedRoot, 'current', 'runlab-executor') : process.execPath
  const installerSession: InstallerSession = {
    version: 1, mode: service && process.getuid?.() === 0 ? 'system' : 'user', executable,
    host: env.HOST_URL, ...(env.EXECUTOR_INSTALL_LABEL ? { name: env.EXECUTOR_INSTALL_LABEL } : {}),
    sandboxRoots: [workspaceRoot], credential: { token: redeemed.token }, installationId: env.EXECUTOR_INSTALL_ID,
    ...(service ? {
      managedRoot,
      update: {
        manifestUrl: `${env.HOST_URL.replace(/\/$/u, '')}/install/assets/executor-update-manifest.json`,
        publicKeyFile: join(managedRoot, 'update-public-key.pem'),
        channel: 'stable' as const,
        intervalMinutes: 60,
      },
    } : {}),
  }
  if (!service) {
    await reportInstallation(env, 'starting')
    process.env.EXECUTOR_TOKEN = redeemed.token
    process.env.HOST_URL = env.HOST_URL
    process.env.SANDBOX_ROOTS = workspaceRoot
    return await main(['--host', env.HOST_URL, '--sandbox-root', workspaceRoot, '--config', writeTemporaryConfig(installerSession)])
  }
  const release = executorReleaseVersion()
  const generation = join(managedRoot, 'generations', release)
  mkdirSync(generation, { recursive: true, mode: 0o700 })
  const generationExecutable = join(generation, 'runlab-executor')
  copyFileSync(process.execPath, generationExecutable)
  chmodSync(generationExecutable, 0o755)
  rmSync(join(managedRoot, 'current'), { recursive: true, force: true })
  symlinkSync(generation, join(managedRoot, 'current'), process.platform === 'win32' ? 'junction' : 'dir')
  const keyResponse = await fetch(`${env.HOST_URL.replace(/\/$/u, '')}/install/assets/executor-update-public-key.pem`)
  if (!keyResponse.ok) throw new Error(`failed to download Executor update verification key: ${keyResponse.status}`)
  writeFileSync(join(managedRoot, 'update-public-key.pem'), await keyResponse.text(), { mode: 0o600 })
  const sessionFile = join(managedRoot, 'installer-session.json')
  writeInstallerSession(sessionFile, installerSession)
  const plan = createLinuxServicePlan('install', installerSession.mode, homedir(), installerSession)
  await reportInstallation(env, 'service_installing')
  // Enter `starting` before `systemctl enable --now`: a fast service can announce
  // during that command, and Host only accepts online completion from starting.
  await reportInstallation(env, 'starting')
  await executeLinuxServicePlan(plan, { run: runServiceCommand })
  rmSync(sessionFile, { force: true })
  process.stdout.write(`[4/4] Service started and connected.\n`)
  printServiceCommands(installerSession.mode, executable)
}

async function installWindowsService(env: ReturnType<typeof bootstrapEnvironment>, workspaceRoot: string, token: string): Promise<void> {
  const serviceName = 'RunLabExecutor'
  const plan = createWindowsServicePlan({
    serviceName, displayName: 'Agent RunLab Executor',
    programFiles: process.env.ProgramFiles, programData: process.env.ProgramData,
  })
  if (basename(process.execPath).toLowerCase() === 'node.exe') throw new Error('Windows service mode requires the native runlab-executor asset')
  mkdirSync(plan.layout.installDir, { recursive: true, mode: 0o700 })
  mkdirSync(plan.layout.dataDir, { recursive: true, mode: 0o700 })
  const credentialPath = join(plan.layout.dataDir, 'credential')
  const config = {
    version: 1, host: env.HOST_URL, ...(env.EXECUTOR_INSTALL_LABEL ? { name: env.EXECUTOR_INSTALL_LABEL } : {}),
    sandboxRoots: [workspaceRoot], credentialFile: credentialPath, installationId: env.EXECUTOR_INSTALL_ID,
    installationSource: 'dashboard-native', managedRoot: plan.layout.dataDir, serviceMode: 'system',
  }
  try {
    copyFileSync(process.execPath, plan.layout.executablePath)
    const prebuilds = join(dirname(process.execPath), 'prebuilds')
    if (existsSync(prebuilds)) cpSync(prebuilds, join(plan.layout.installDir, 'prebuilds'), { recursive: true, force: true })
    writePrivateAtomic(credentialPath, `${token}\n`)
    writePrivateAtomic(plan.layout.configPath, `${JSON.stringify(config, null, 2)}\n`)
    await reportInstallation(env, 'service_installing')
    await reportInstallation(env, 'starting')
    await executeWindowsServicePlan(plan, ['create', 'recovery', 'start'])
    process.stdout.write('[4/4] Windows service started and connected.\n')
    process.stdout.write(`  Status ${JSON.stringify(plan.layout.executablePath)} service status\n`)
    process.stdout.write(`  Uninstall ${JSON.stringify(plan.layout.executablePath)} service uninstall\n`)
  } catch (error) {
    await executeWindowsServicePlan(plan, ['stop']).catch(() => undefined)
    await executeWindowsServicePlan(plan, ['delete']).catch(() => undefined)
    rmSync(plan.layout.installDir, { recursive: true, force: true }); rmSync(plan.layout.dataDir, { recursive: true, force: true })
    throw error
  }
}

function writePrivateAtomic(path: string, contents: string): void {
  const temporary = `${path}.tmp-${process.pid}`
  try { writeFileSync(temporary, contents, { mode: 0o600, flag: 'wx' }); renameSync(temporary, path) }
  finally { rmSync(temporary, { force: true }) }
}

function writeTemporaryConfig(session: InstallerSession): string {
  const root = defaultManagedRoot(homedir(), false)
  const credential = join(root, 'temporary-credential')
  mkdirSync(root, { recursive: true, mode: 0o700 })
  writeFileSync(credential, `${session.credential.token}\n`, { mode: 0o600 })
  const config = join(root, 'temporary-config.json')
  writeFileSync(config, `${JSON.stringify({ version: 1, host: session.host, sandboxRoots: session.sandboxRoots, credentialFile: credential, installationId: session.installationId })}\n`, { mode: 0o600 })
  return config
}

async function runServiceCommand(command: Command): Promise<{ code: number; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command.file, [...command.args], { stdio: ['pipe', 'pipe', 'pipe'] })
    const stdout: Buffer[] = [], stderr: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk)); child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.once('error', reject); child.once('close', (code) => resolve({ code: code ?? -1, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() }))
    child.stdin.end(command.stdin)
  })
}

async function main(argv = process.argv.slice(2)): Promise<void> {
  const internalIndex = argv.findIndex((arg) => arg === '--internal-installer')
  if (internalIndex >= 0) {
    await runInternalInstaller()
    return
  }
  const args = parseArgs(argv)
  if (args.help) {
    printHelp()
    return
  }
  if (args.version) {
    printVersion()
    return
  }

  if (args.command === 'service') {
    if (process.platform === 'win32') { await manageWindowsService(args.serviceAction!); return }
    if (process.platform !== 'linux') throw new Error('Executor service management is currently available on Linux and Windows only')
    const systemPaths = linuxServicePaths('system', homedir())
    const userPaths = linuxServicePaths('user', homedir())
    const mode = args.serviceMode ?? (existsSync(systemPaths.config) ? 'system' : existsSync(userPaths.config) ? 'user' : undefined)
    if (!mode) throw new Error('No managed Executor service was found. Install service mode from Add Workspace, or pass --system/--user explicitly.')
    const plan = createLinuxServicePlan(args.serviceAction!, mode, homedir())
    const results = await executeLinuxServicePlan(plan, { run: runServiceCommand })
    for (const result of results) {
      if (result.stdout) process.stdout.write(result.stdout)
      if (result.stderr) process.stderr.write(result.stderr)
    }
    if (args.serviceAction === 'uninstall') process.stdout.write('\nAgent RunLab Executor service was removed.\n')
    else if (args.serviceAction !== 'logs' && args.serviceAction !== 'status') printServiceCommands(mode)
    return
  }

  const managed = args.config ? readExecutorRuntimeConfig(args.config) : undefined
  if (args.command === 'update') {
    if (!managed?.update?.enabled || !managed.managedRoot || !managed.serviceMode) throw new Error('managed updates are not configured for this Executor service')
    const workspaceId = loadOrCreateWorkspaceId(undefined, normalizeExecutorProfile(managed.profile))
    const common = { root: managed.managedRoot, serviceMode: managed.serviceMode, workspaceId, socketPath: join(managed.managedRoot, 'update-control.sock'), reconnectTimeoutMs: 60_000, logger }
    if (args.updateAction === 'rollback') await rollbackManagedUpdate(common)
    else {
      const result = await applyManagedUpdate({ ...common, manifestUrl: managed.update.manifestUrl, publicKeyPath: managed.update.publicKeyFile, currentVersion: executorReleaseVersion(), channel: managed.update.channel, protocol: Number(PROTOCOL_VERSION.split('.')[0]) })
      logger.info({ result }, 'managed Executor update finished')
    }
    return
  }
  const host = args.host ?? managed?.host ?? process.env.HOST_URL
  const name = args.name ?? managed?.name ?? process.env.WORKSPACE_NAME
  const envRoots = parseSandboxRootsEnv(process.env.SANDBOX_ROOTS)
  const sandboxRoots = args.sandboxRoots.length > 0 ? args.sandboxRoots : managed?.sandboxRoots ?? envRoots
  const managedCredential = managed ? readExecutorCredential(managed.credentialFile) : undefined
  const invite = args.invite ?? (managedCredential?.startsWith('ak_invite_') ? managedCredential : undefined) ?? process.env.EXECUTOR_INVITE
  const profile = normalizeExecutorProfile(args.profile ?? managed?.profile ?? process.env.AGENT_KERNEL_EXECUTOR_PROFILE)
  const token = args.token ?? (managedCredential?.startsWith('ak_exec_') ? managedCredential : undefined) ?? process.env.EXECUTOR_TOKEN ?? (invite ? undefined : loadExecutorToken(undefined, profile))
  const executorId = args.id ?? process.env.EXECUTOR_ID
  const autoUpdate = args.autoUpdate === true || process.env.AGENT_KERNEL_AUTO_UPDATE === '1'
  const noUpdateCheck = args.noUpdateCheck === true || process.env.AGENT_KERNEL_NO_UPDATE_CHECK === '1'
  const updateRepo = args.updateRepo ?? process.env.AGENT_KERNEL_UPDATE_REPO

  if (!host) {
    logger.error(
      {
        flag: '--host',
        env: 'HOST_URL',
        example: 'HOST_URL=http://localhost:3000 EXECUTOR_INVITE=ak_invite_... node agent-kernel-executor.cjs',
      },
      'missing host url',
    )
    process.exit(1)
  }

  let pairingToken = token
  if (!invite && !pairingToken) {
    const workspaceId = loadOrCreateWorkspaceId(undefined, profile)
    const pairingUrl = `${host.replace(/\/$/u, '')}/auth/executor-pairings`
    const response = await fetch(pairingUrl, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ workspaceId, label: name }) })
    const pairing = await readPairingJson<{ id: string; claimSecret: string; code: string; expiresAt: string }>(response, 'start pairing', pairingUrl)
    logger.info({ code: pairing.code, expiresAt: pairing.expiresAt }, 'approve this executor in Agent RunLab')
    while (Date.now() < Date.parse(pairing.expiresAt)) {
      await new Promise((resolve) => setTimeout(resolve, 2000))
      const claimUrl = `${host.replace(/\/$/u, '')}/auth/executor-pairings/${encodeURIComponent(pairing.id)}/claim`
      const claim = await fetch(claimUrl, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ claimSecret: pairing.claimSecret }) })
      if (claim.status === 404) continue
      const result = await readPairingJson<{ status: string; token?: string }>(claim, 'check pairing approval', claimUrl)
      if (result.token) { pairingToken = result.token; saveExecutorToken(result.token, undefined, profile); break }
      if (result.status === 'rejected' || result.status === 'expired') throw new Error(`pairing ${result.status}`)
    }
    if (!pairingToken) throw new Error('pairing expired')
  }
  const authKind = invite ? 'invite' : pairingToken ? 'token' : 'none'
  const rootsLabel = sandboxRoots.length > 0 ? sandboxRoots.join(':') : '<no jail>'
  const profileLabel = profile ?? 'default'
  logger.info(
    { host, auth: authKind, profile: profileLabel, workspace: name ?? '<hostname>', sandbox: rootsLabel },
    'connecting to host',
  )

  // Local single-instance lock for this profile. Different profiles get
  // distinct workspace ids and token files, so a dev machine can run one
  // release executor and one isolated test executor at the same time.
  const lockPath = await acquireLocalLock(logger, profile)
  process.on('exit', () => {
    // Best-effort release. proper-lockfile also survives crashes via mtime
    // staleness so we don't panic if this doesn't run.
    void lockfile.unlock(lockPath, { realpath: false }).catch(() => undefined)
  })

  if (updateRepo && !noUpdateCheck && process.env.AGENT_KERNEL_SKIP_UPDATE_ONCE !== '1') {
    try {
      await checkExecutorUpdate({
        repo: updateRepo,
        currentTag: process.env.AGENT_KERNEL_RELEASE_TAG,
        autoUpdate,
        argv: process.argv.slice(2),
        logger,
      })
    } catch (err) {
      logger.warn({ err }, 'executor update check failed')
    }
  }

  const handle = startExecutor({
    host,
    workspaceId: loadOrCreateWorkspaceId(undefined, profile),
    ...(name !== undefined ? { workspaceName: name } : {}),
    ...(sandboxRoots.length > 0 ? { sandboxRoots } : {}),
    ...(pairingToken !== undefined ? { token: pairingToken } : {}),
    ...(invite !== undefined ? { invite } : {}),
    ...(executorId !== undefined ? { executorId } : {}),
    ...(managed?.installationId ? { installId: managed.installationId } : {}),
    logger,
    onToken(nextToken) {
      saveExecutorToken(nextToken, undefined, profile)
      logger.info('executor identity saved for future reconnects')
    },
  })

  handle.socket.on('connect', () => {
    logger.debug(
      {
        executorId: handle.executorId,
        workspaceId: handle.workspaceId,
        workspaceName: handle.workspaceName,
        host,
      },
      'executor connection details',
    )
  })

  await handle.ready
  logger.info({ workspaceId: handle.workspaceId, workspaceName: handle.workspaceName, host, sandboxRoots }, 'executor announced; awaiting tool calls')
  if (!managed?.serviceMode) printForegroundCommands()
  const updateControl = managed?.managedRoot && process.platform !== 'win32'
    ? await startUpdateControlServer({
        socketPath: join(managed.managedRoot, 'update-control.sock'),
        status: () => ({
          version: executorReleaseVersion(), workspaceId: handle.workspaceId,
          connected: handle.socket.connected, draining: handle.draining(),
          activeTools: handle.activeToolCount(), activeTerminals: handle.activeTerminalCount(),
        }),
        beginDrain: () => handle.beginDrain(),
        resume: () => handle.resume(),
      })
    : null

  const shutdown = (): void => {
    logger.info('shutting down')
    handle.close()
    void updateControl?.close().finally(() => process.exit(0))
    if (!updateControl) process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  // Wait for a permanent error signal from the wire layer. This resolves
  // only when the host explicitly rejects this executor's identity, auth, or
  // protocol version. Transport failures are daemon-normal: socket.io keeps
  // reconnecting with exponential backoff until the process is stopped.
  const failure = await handle.permanentError
  const exitCodeByReason: Record<string, number> = {
    workspace_id_conflict: 2,
    workspace_identity_mismatch: 2,
    version_incompatible: 3,
    auth_failed: 4,
  }
  const code = exitCodeByReason[failure.code] ?? 1
  logger.error(
    { failure },
    `executor stopping — this is a permanent failure that will not self-heal. ` +
      `See message above for instructions.`,
  )
  process.exit(code)
}

async function manageWindowsService(action: Exclude<ServiceAction, 'install'>): Promise<void> {
  if (action === 'logs') throw new Error('Windows service logs are available through Windows Event Viewer and are not streamed by this command')
  const plan = createWindowsServicePlan({ serviceName: 'RunLabExecutor', displayName: 'Agent RunLab Executor', programFiles: process.env.ProgramFiles, programData: process.env.ProgramData })
  const actions: readonly WindowsServiceAction[] = action === 'status' ? ['query'] : action === 'start' ? ['start'] : action === 'stop' ? ['stop'] : action === 'restart' ? ['stop', 'start'] : ['stop', 'delete']
  if (action === 'uninstall') {
    if (!existsSync(plan.layout.configPath)) throw new Error('No managed Windows Executor service configuration was found')
    assertManagedWindowsInstallation(JSON.parse(readFileSync(plan.layout.configPath, 'utf8')))
  }
  let results
  if (action === 'uninstall' || action === 'restart') {
    await executeWindowsServicePlan(plan, ['stop']).catch(() => undefined)
    results = await executeWindowsServicePlan(plan, actions.slice(1))
  } else results = await executeWindowsServicePlan(plan, actions)
  for (const result of results) { if (result.stdout) process.stdout.write(result.stdout); if (result.stderr) process.stderr.write(result.stderr) }
  if (action === 'uninstall') {
    rmSync(plan.layout.dataDir, { recursive: true, force: true })
    if (resolve(process.execPath).startsWith(`${resolve(plan.layout.installDir)}${sep}`)) scheduleWindowsSelfRemoval(plan.layout.installDir)
    else rmSync(plan.layout.installDir, { recursive: true, force: true })
    process.stdout.write('\nAgent RunLab Executor Windows service and credentials were removed.\n')
  }
}

function scheduleWindowsSelfRemoval(installDir: string): void {
  const script = join(tmpdir(), `runlab-executor-uninstall-${process.pid}.ps1`)
  writeFileSync(script, `param([string]$Target,[int]$OwnerPid,[string]$Script)\n+$ErrorActionPreference='SilentlyContinue'\n+Wait-Process -Id $OwnerPid -Timeout 60\n+Remove-Item -LiteralPath $Target -Recurse -Force\n+Remove-Item -LiteralPath $Script -Force\n+`, { mode: 0o600 })
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, installDir, String(process.pid), script], { detached: true, windowsHide: true, stdio: 'ignore' })
  child.unref()
}

main().catch((err) => {
  logger.error({ err }, 'fatal error')
  process.exit(1)
})
