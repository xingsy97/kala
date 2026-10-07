import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, win32 } from 'node:path'

export type WindowsServiceAction = 'create' | 'start' | 'query' | 'stop' | 'delete' | 'recovery'

export interface WindowsServiceLayout {
  installDir: string
  dataDir: string
  executablePath: string
  serviceHostPath: string
  serviceConfigPath: string
  configPath: string
}

export interface WindowsServiceCommand {
  action: WindowsServiceAction
  command: 'sc.exe'
  args: readonly string[]
}

export interface WindowsServicePlan {
  layout: WindowsServiceLayout
  commands: readonly WindowsServiceCommand[]
}

export interface WindowsServicePlanOptions {
  serviceName: string
  displayName?: string
  executableName?: string
  vendor?: string
  product?: string
  programFiles?: string
  programData?: string
  recovery?: {
    resetSeconds?: number
    restartDelaysMs?: readonly number[]
  }
}

export interface WindowsCommandResult {
  exitCode: number
  stdout: string
  stderr: string
}

export type WindowsCommandRunner = (
  command: string,
  args: readonly string[],
  options?: { input?: string },
) => Promise<WindowsCommandResult>

export interface WindowsServiceExecutorOptions {
  runner?: WindowsCommandRunner
  platform?: NodeJS.Platform
}

export interface ManagedWindowsInstallation {
  installationSource: 'dashboard-native'
  installationId: string
}

const DEFAULT_VENDOR = 'Kala'
const DEFAULT_PRODUCT = 'Executor'
export const WINDOWS_SERVICE_HOST_ASSET = 'kala-executor-service-host-win32-x64.exe'
const WINDOWS_SERVICE_HOST_SHA256 = '05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da'
const WINDOWS_SERVICE_HOST_BYTES = 18_243_033

/** Re-verify the pinned release asset at the privileged installation boundary. */
export function copyWindowsServiceHost(sourceRoot: string, destinationRoot: string): void {
  const source = join(sourceRoot, WINDOWS_SERVICE_HOST_ASSET)
  if (!existsSync(source) || !lstatSync(source).isFile() || lstatSync(source).size !== WINDOWS_SERVICE_HOST_BYTES) {
    throw new Error('Windows service host is missing or has the wrong size')
  }
  const bytes = readFileSync(source)
  if (createHash('sha256').update(bytes).digest('hex') !== WINDOWS_SERVICE_HOST_SHA256) {
    throw new Error('Windows service host SHA-256 mismatch')
  }
  copyFileSync(source, join(destinationRoot, 'kala-executor-service.exe'))
}

function xml(value: string): string {
  return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;').replace(/'/gu, '&apos;')
}

export function renderWindowsServiceConfig(layout: WindowsServiceLayout, serviceName: string, displayName: string): string {
  return `<service>\n  <id>${xml(safeValue(serviceName, 'name'))}</id>\n  <name>${xml(safeValue(displayName, 'display name'))}</name>\n  <description>Kala native Executor</description>\n  <executable>%BASE%\\${xml(win32.basename(layout.executablePath))}</executable>\n  <arguments>--config ${xml(quoteWindowsArgument(layout.configPath))}</arguments>\n  <log mode="roll-by-size">\n    <sizeThreshold>10240</sizeThreshold>\n    <keepFiles>5</keepFiles>\n  </log>\n  <stoptimeout>15sec</stoptimeout>\n  <stopparentprocessfirst>true</stopparentprocessfirst>\n</service>\n`
}

export async function secureWindowsServiceDataDir(
  dataDir: string,
  options: WindowsServiceExecutorOptions = {},
): Promise<void> {
  if ((options.platform ?? process.platform) !== 'win32') throw new Error('Windows ACL hardening is unavailable on this platform')
  // SID form is locale-independent: LocalSystem and built-in Administrators.
  // Apply before writing any credential; strip inherited Users access.
  const result = await (options.runner ?? spawnWindowsCommand)('icacls.exe', [
    dataDir, '/inheritance:r', '/grant:r', '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F',
  ])
  if (result.exitCode !== 0) throw new Error(`Unable to secure Windows Executor credentials directory: ${result.stderr.trim() || result.stdout.trim()}`)
}

export const WINDOWS_NODE_PTY_RUNTIME_FILES = Object.freeze([
  'prebuilds/win32-x64/conpty.node',
  'prebuilds/win32-x64/conpty_console_list.node',
  'prebuilds/win32-x64/pty.node',
  'prebuilds/win32-x64/winpty-agent.exe',
  'prebuilds/win32-x64/winpty.dll',
  'worker/conoutSocketWorker.js',
  'shared/conout.js',
])

/** Copy only the verified node-pty runtime closure needed beside a Windows SEA. */
export function copyWindowsNodePtyRuntime(sourceRoot: string, destinationRoot: string): void {
  const files = WINDOWS_NODE_PTY_RUNTIME_FILES.map((relative) => ({
    relative,
    source: join(sourceRoot, ...relative.split('/')),
    destination: join(destinationRoot, ...relative.split('/')),
  }))
  for (const file of files) {
    if (!existsSync(file.source) || !lstatSync(file.source).isFile() || lstatSync(file.source).size === 0) {
      throw new Error(`Windows node-pty runtime is missing ${file.relative}`)
    }
  }
  for (const file of files) {
    mkdirSync(dirname(file.destination), { recursive: true, mode: 0o700 })
    copyFileSync(file.source, file.destination)
  }
}

function safeValue(value: string, label: string): string {
  if (!value || /[\0\r\n]/u.test(value)) throw new Error(`Invalid Windows service ${label}`)
  return value
}

/** Quote one argument using the Windows CommandLineToArgvW escaping rules. */
export function quoteWindowsArgument(value: string): string {
  safeValue(value, 'argument')
  return `"${value.replace(/(\\*)"/gu, '$1$1\\"').replace(/(\\+)$/u, '$1$1')}"`
}

export function windowsServiceLayout(options: WindowsServicePlanOptions): WindowsServiceLayout {
  const vendor = safeValue(options.vendor ?? DEFAULT_VENDOR, 'vendor')
  const product = safeValue(options.product ?? DEFAULT_PRODUCT, 'product')
  const programFiles = safeValue(options.programFiles ?? 'C:\\Program Files', 'Program Files path')
  const programData = safeValue(options.programData ?? 'C:\\ProgramData', 'ProgramData path')
  const executableName = safeValue(options.executableName ?? 'kala-executor.exe', 'executable name')
  const installDir = win32.join(programFiles, vendor, product)
  const dataDir = win32.join(programData, vendor, product)
  return {
    installDir,
    dataDir,
    executablePath: win32.join(installDir, executableName),
    serviceHostPath: win32.join(installDir, 'kala-executor-service.exe'),
    serviceConfigPath: win32.join(installDir, 'kala-executor-service.xml'),
    configPath: win32.join(dataDir, 'config.json'),
  }
}

export function assertManagedWindowsInstallation(value: unknown): ManagedWindowsInstallation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Refusing to uninstall an unrecognized Windows Executor installation')
  const input = value as Record<string, unknown>
  if (input.installationSource !== 'dashboard-native' || typeof input.installationId !== 'string' || !input.installationId || input.installationId.includes('\0')) throw new Error('Refusing to uninstall an unrecognized Windows Executor installation')
  return { installationSource: 'dashboard-native', installationId: input.installationId }
}

/**
 * Generate an SCM plan without touching the host. The service command line has
 * exactly one application option (`--config`); credentials never enter SCM.
 */
export function createWindowsServicePlan(options: WindowsServicePlanOptions): WindowsServicePlan {
  const serviceName = safeValue(options.serviceName, 'name')
  const displayName = safeValue(options.displayName ?? serviceName, 'display name')
  const layout = windowsServiceLayout(options)
  // The Node SEA is a console program and cannot report SERVICE_RUNNING to SCM.
  const binaryPath = quoteWindowsArgument(layout.serviceHostPath)
  const resetSeconds = options.recovery?.resetSeconds ?? 86_400
  const restartDelaysMs = options.recovery?.restartDelaysMs ?? [5_000, 30_000]
  if (!Number.isSafeInteger(resetSeconds) || resetSeconds < 0) throw new Error('Invalid recovery reset seconds')
  if (restartDelaysMs.some((delay) => !Number.isSafeInteger(delay) || delay < 0)) {
    throw new Error('Invalid recovery restart delay')
  }
  const actions = [...restartDelaysMs.map((delay) => `restart/${delay}`), 'none/0'].join('/')
  const command = (action: WindowsServiceAction, args: readonly string[]): WindowsServiceCommand => ({
    action,
    command: 'sc.exe',
    args,
  })
  return {
    layout,
    commands: [
      command('create', ['create', serviceName, 'binPath=', binaryPath, 'start=', 'auto', 'DisplayName=', displayName]),
      command('recovery', ['failure', serviceName, 'reset=', String(resetSeconds), 'actions=', actions]),
      command('start', ['start', serviceName]),
      command('query', ['query', serviceName]),
      command('stop', ['stop', serviceName]),
      command('delete', ['delete', serviceName]),
    ],
  }
}

export async function executeWindowsServiceCommand(
  command: WindowsServiceCommand,
  options: WindowsServiceExecutorOptions = {},
): Promise<WindowsCommandResult> {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') throw new Error('Windows SCM is unavailable on this platform')
  const result = await (options.runner ?? spawnWindowsCommand)(command.command, command.args)
  if (result.exitCode !== 0) {
    throw new Error(`SCM ${command.action} failed (${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`)
  }
  return result
}

export async function executeWindowsServicePlan(
  plan: WindowsServicePlan,
  actions: readonly WindowsServiceAction[],
  options: WindowsServiceExecutorOptions = {},
): Promise<readonly WindowsCommandResult[]> {
  const results: WindowsCommandResult[] = []
  for (const action of actions) {
    const command = plan.commands.find((candidate) => candidate.action === action)
    if (!command) throw new Error(`Windows service plan does not contain ${action}`)
    results.push(await executeWindowsServiceCommand(command, options))
  }
  return results
}

export async function waitForWindowsServiceStopped(
  plan: WindowsServicePlan,
  options: WindowsServiceExecutorOptions & { timeoutMs?: number; pollMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + (options.timeoutMs ?? 30_000)
  const query = plan.commands.find((command) => command.action === 'query')
  if (!query) throw new Error('Windows service plan does not contain query')
  while (true) {
    try {
      const result = await executeWindowsServiceCommand(query, options)
      const match = result.stdout.match(/\bSTATE\s*:\s*(\d+)\b/iu)
      if (!match) throw new Error('Windows SCM query returned an unrecognized state')
      if (Number(match[1]) === 1) return // STOPPED; pending stop is state 3.
    } catch (error) {
      // 1060 means the service was not registered (e.g. install failed before
      // sc create). Do not interpret any other SCM error as a stopped process.
      if (!(error instanceof Error) || !/SCM query failed \(1060\)|\[SC\] OpenService FAILED 1060/u.test(error.message)) throw error
      return
    }
    if (Date.now() >= deadline) throw new Error('Timed out waiting for Windows Executor service to stop')
    await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 250))
  }
}

export const spawnWindowsCommand: WindowsCommandRunner = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { windowsHide: true, shell: false, stdio: 'pipe' })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.once('error', reject)
    child.once('close', (code) => resolve({
      exitCode: code ?? -1,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }))
    child.stdin.end(options.input)
  })
