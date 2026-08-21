import { spawn } from 'node:child_process'
import { win32 } from 'node:path'

export type WindowsServiceAction = 'create' | 'start' | 'query' | 'stop' | 'delete' | 'recovery'

export interface WindowsServiceLayout {
  installDir: string
  dataDir: string
  executablePath: string
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

const DEFAULT_VENDOR = 'Agent RunLab'
const DEFAULT_PRODUCT = 'Executor'

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
  const executableName = safeValue(options.executableName ?? 'runlab-executor.exe', 'executable name')
  const installDir = win32.join(programFiles, vendor, product)
  const dataDir = win32.join(programData, vendor, product)
  return {
    installDir,
    dataDir,
    executablePath: win32.join(installDir, executableName),
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
  const binaryPath = [layout.executablePath, '--config', layout.configPath]
    .map(quoteWindowsArgument)
    .join(' ')
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
