import { existsSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'

export type ShellFamily = 'powershell' | 'cmd' | 'bash' | 'zsh' | 'sh'
export type ShellSpec = { family: ShellFamily; executable: string }
export type ShellResourceLimits = {
  cpuSeconds?: number
  memoryMb?: number
  fileBytes?: number
  maxProcesses?: number
}

function findExecutable(names: readonly string[], env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const name of names) {
    if (isAbsolute(name) && existsSync(name)) return name
    for (const dir of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
      const candidate = join(dir, name)
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

export function discoverShells(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): ShellSpec[] {
  const found: ShellSpec[] = []
  const add = (family: ShellFamily, names: readonly string[]) => { const executable = findExecutable(names, env); if (executable && !found.some((item) => item.family === family)) found.push({ family, executable }) }
  const configured = env.AGENT_KERNEL_SHELL?.trim()
  if (configured) {
    const executable = findExecutable([configured], env)
    if (executable) found.push({ family: inferShellFamily(executable), executable })
  }
  if (platform === 'win32') {
    add('powershell', ['pwsh.exe', 'pwsh', 'powershell.exe', 'powershell'])
    add('bash', [env.AGENT_KERNEL_GIT_BASH ?? '', 'bash.exe', 'bash'].filter(Boolean))
    add('cmd', [env.COMSPEC ?? '', 'cmd.exe', 'cmd'].filter(Boolean))
  } else {
    const configuredShell = env.SHELL?.trim()
    if (configuredShell) add(inferShellFamily(configuredShell), [configuredShell])
    if (platform === 'darwin') add('zsh', ['/bin/zsh', 'zsh'])
    add('bash', ['/bin/bash', 'bash'])
    add('sh', ['/bin/sh', 'sh'])
  }
  return found
}

export function inferShellFamily(executable: string): ShellFamily {
  const name = executable.replaceAll('\\', '/').split('/').at(-1)?.toLowerCase().replace(/\.exe$/u, '') ?? ''
  if (name === 'pwsh' || name === 'powershell') return 'powershell'
  if (name === 'cmd') return 'cmd'
  if (name === 'zsh') return 'zsh'
  if (name === 'sh') return 'sh'
  return 'bash'
}

export function selectShell(requested: string | undefined, shells = discoverShells()): ShellSpec {
  const family = !requested || requested === 'auto' ? undefined : requested as ShellFamily
  const selected = family ? shells.find((item) => item.family === family) : shells[0]
  if (!selected) throw new Error(family ? `requested shell is unavailable: ${family}` : 'no supported shell found; install PowerShell, cmd, bash, zsh, or sh')
  return selected
}

export function shellArgv(shell: ShellSpec, command: string, limits: ShellResourceLimits = {}): string[] {
  const limitedCommand = applyPosixResourceLimits(shell, command, limits)
  if (shell.family === 'powershell') return ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}; ${command}`]
  if (shell.family === 'cmd') return ['/d', '/s', '/c', command]
  if (shell.family === 'sh') return ['-c', limitedCommand]
  return ['-lc', limitedCommand]
}

export function shellResourceLimitsFromEnv(env: NodeJS.ProcessEnv = process.env): ShellResourceLimits {
  return {
    ...positiveIntEnv(env, 'AGENT_RUNLAB_SHELL_CPU_SECONDS', 'cpuSeconds'),
    ...positiveIntEnv(env, 'AGENT_RUNLAB_SHELL_MEMORY_MB', 'memoryMb'),
    ...positiveIntEnv(env, 'AGENT_RUNLAB_SHELL_FILE_BYTES', 'fileBytes'),
    ...positiveIntEnv(env, 'AGENT_RUNLAB_SHELL_MAX_PROCESSES', 'maxProcesses'),
  }
}

function positiveIntEnv<K extends keyof ShellResourceLimits>(env: NodeJS.ProcessEnv, key: string, field: K): Pick<ShellResourceLimits, K> {
  const raw = env[key]?.trim()
  if (!raw) return {} as Pick<ShellResourceLimits, K>
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${key} must be a positive integer`)
  return { [field]: value } as Pick<ShellResourceLimits, K>
}

function applyPosixResourceLimits(shell: ShellSpec, command: string, limits: ShellResourceLimits): string {
  if (shell.family === 'powershell' || shell.family === 'cmd') return command
  const statements: string[] = []
  if (limits.cpuSeconds !== undefined) statements.push(`ulimit -t ${limits.cpuSeconds}`)
  if (limits.memoryMb !== undefined) statements.push(`ulimit -v ${limits.memoryMb * 1024}`)
  if (limits.fileBytes !== undefined) statements.push(`ulimit -f ${Math.ceil(limits.fileBytes / 512)}`)
  if (limits.maxProcesses !== undefined) statements.push(`ulimit -u ${limits.maxProcesses}`)
  return statements.length === 0 ? command : `set -e; ${statements.join('; ')}; set +e; ${command}`
}
