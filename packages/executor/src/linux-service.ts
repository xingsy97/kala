import { dirname, join } from 'node:path'

import type { InstallerSession } from './installer-session.js'
import type { ServiceAction, ServiceMode } from './cli-args.js'

export type Command = {
  file: string
  args: readonly string[]
  stdin?: string
  allowFailure?: boolean
}

export type CommandResult = { code: number; stdout: string; stderr: string }
export type CommandRunner = { run(command: Command): Promise<CommandResult> }

export type LinuxServicePaths = {
  unit: string
  config: string
  credential: string
  serviceName: string
}

export type LinuxServicePlan = {
  action: ServiceAction
  mode: ServiceMode
  paths: LinuxServicePaths
  commands: readonly Command[]
  rollback: readonly Command[]
}

const SERVICE_NAME = 'runlab-executor.service'

function systemctl(mode: ServiceMode, ...args: string[]): Command {
  return { file: 'systemctl', args: [...(mode === 'user' ? ['--user'] : []), ...args] }
}

function journalctl(mode: ServiceMode): Command {
  return { file: 'journalctl', args: [...(mode === 'user' ? ['--user'] : []), '--unit', SERVICE_NAME, '--follow'] }
}

export function linuxServicePaths(mode: ServiceMode, home: string): LinuxServicePaths {
  return mode === 'system'
    ? {
        serviceName: SERVICE_NAME,
        unit: `/etc/systemd/system/${SERVICE_NAME}`,
        config: '/etc/runlab-executor/executor.json',
        credential: '/etc/runlab-executor/credential',
      }
    : {
        serviceName: SERVICE_NAME,
        unit: join(home, '.config', 'systemd', 'user', SERVICE_NAME),
        config: join(home, '.config', 'runlab-executor', 'executor.json'),
        credential: join(home, '.config', 'runlab-executor', 'credential'),
      }
}

export function renderLinuxServiceFiles(session: InstallerSession, home: string): {
  paths: LinuxServicePaths
  unit: string
  config: string
  credential: string
} {
  const paths = linuxServicePaths(session.mode, home)
  const config = `${JSON.stringify({
    version: 1,
    host: session.host,
    ...(session.profile ? { profile: session.profile } : {}),
    ...(session.name ? { name: session.name } : {}),
    sandboxRoots: session.sandboxRoots,
    credentialFile: paths.credential,
    ...(session.installationId ? { installationId: session.installationId } : {}),
    installationSource: 'dashboard-native',
  }, null, 2)}\n`
  const credential = session.credential.token
    ? `${session.credential.token}\n`
    : `${session.credential.invite!}\n`
  const unit = `[Unit]
Description=Agent RunLab Executor
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${systemdQuote(session.executable)} --config ${systemdQuote(paths.config)}
Restart=always
RestartSec=5s
TimeoutStopSec=90s
KillMode=control-group
UMask=0077

[Install]
WantedBy=${session.mode === 'system' ? 'multi-user.target' : 'default.target'}
`
  return { paths, unit, config, credential }
}

function systemdQuote(value: string): string {
  if (value.includes('\0') || value.includes('\n') || value.includes('\r')) throw new Error('Invalid service argument')
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

function privateWrite(path: string, contents: string): Command {
  // Content is sent over stdin and never appears in argv or diagnostics.
  return { file: 'install', args: ['-D', '-m', '0600', '/dev/stdin', path], stdin: contents }
}

export function createLinuxServicePlan(
  action: ServiceAction,
  mode: ServiceMode,
  home: string,
  session?: InstallerSession,
): LinuxServicePlan {
  const paths = linuxServicePaths(mode, home)
  if (action === 'status') return { action, mode, paths, commands: [systemctl(mode, 'status', SERVICE_NAME)], rollback: [] }
  if (action === 'logs') return { action, mode, paths, commands: [journalctl(mode)], rollback: [] }
  if (action === 'restart') return { action, mode, paths, commands: [systemctl(mode, 'restart', SERVICE_NAME)], rollback: [] }
  if (action === 'uninstall') {
    return {
      action, mode, paths,
      commands: [
        { ...systemctl(mode, 'disable', '--now', SERVICE_NAME), allowFailure: true },
        { file: 'rm', args: ['-f', paths.unit, paths.config, paths.credential] },
        systemctl(mode, 'daemon-reload'),
      ],
      rollback: [],
    }
  }
  if (!session || session.mode !== mode) throw new Error('Install requires a matching installer session')
  const rendered = renderLinuxServiceFiles(session, home)
  return {
    action, mode, paths,
    commands: [
      // Fail closed when the name belongs to a unit outside the managed path.
      { ...systemctl(mode, 'show', SERVICE_NAME, '--property=LoadState,FragmentPath,MainPID'), allowFailure: true },
      privateWrite(paths.config, rendered.config),
      privateWrite(paths.credential, rendered.credential),
      privateWrite(paths.unit, rendered.unit),
      systemctl(mode, 'daemon-reload'),
      systemctl(mode, 'enable', '--now', SERVICE_NAME),
    ],
    rollback: [
      { ...systemctl(mode, 'disable', '--now', SERVICE_NAME), allowFailure: true },
      { file: 'rm', args: ['-f', paths.unit, paths.config, paths.credential] },
      systemctl(mode, 'daemon-reload'),
    ],
  }
}

function assertManagedUnit(result: CommandResult, expectedPath: string): void {
  if (result.code !== 0) return
  const fields = Object.fromEntries(result.stdout.split('\n').map((line) => line.split('=', 2) as [string, string]))
  if (fields.LoadState === 'not-found') return
  if (fields.LoadState !== 'loaded' || fields.FragmentPath !== expectedPath) {
    throw new Error(`Refusing to replace unknown service at ${fields.FragmentPath || '<unknown>'}`)
  }
  const pid = Number.parseInt(fields.MainPID ?? '0', 10)
  if (!Number.isSafeInteger(pid) || pid < 0) throw new Error('Refusing service with an unknown process state')
}

/** Executes only through the injected runner and rolls a partial install back. */
export async function executeLinuxServicePlan(plan: LinuxServicePlan, runner: CommandRunner): Promise<readonly CommandResult[]> {
  const results: CommandResult[] = []
  try {
    for (let index = 0; index < plan.commands.length; index++) {
      const command = plan.commands[index]!
      const result = await runner.run(command)
      results.push(result)
      if (plan.action === 'install' && index === 0) assertManagedUnit(result, plan.paths.unit)
      if (result.code !== 0 && !command.allowFailure) throw new Error(`${command.file} failed: ${result.stderr.trim()}`)
    }
    return results
  } catch (error) {
    if (plan.action === 'install' && results.length > 1) {
      for (const command of plan.rollback) await runner.run(command).catch(() => undefined)
    }
    throw error
  }
}
