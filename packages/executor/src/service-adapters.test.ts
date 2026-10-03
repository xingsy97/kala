import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { createLinuxServicePlan, executeLinuxServicePlan, renderLinuxServiceFiles } from './linux-service.js'
import { createMacosLaunchdService, executeLaunchdPlan } from './macos-launchd.js'
import { assertManagedWindowsInstallation, createWindowsServicePlan, executeWindowsServicePlan } from './windows-service.js'
import type { InstallerSession } from './installer-session.js'

const session: InstallerSession = {
  version: 1,
  mode: 'system',
  privilegeMode: 'privileged',
  executable: '/opt/kala/executor/current/kala-executor',
  host: 'https://agent.example.test',
  name: 'Build Box',
  sandboxRoots: ['/srv/work space'],
  credential: { token: 'secret-value' },
}

describe('Linux service adapter', () => {
  it('writes private files through a real Node stdin pipe without exposing contents in argv', async () => {
    const root = mkdtempSync(join(tmpdir(), 'runlab-linux-service-write-'))
    try {
      const privateSession: InstallerSession = {
        ...session,
        mode: 'user',
        executable: join(root, 'kala-executor'),
        credential: { token: 'real-pipe-secret' },
      }
      const plan = createLinuxServicePlan('install', 'user', root, privateSession)
      const writes = plan.commands.filter((command) => command.stdin !== undefined)
      expect(writes).toHaveLength(3)
      for (const command of writes) {
        expect(command.args.join(' ')).not.toContain('real-pipe-secret')
        const result = await spawnCommand(command)
        expect(result.code, result.stderr).toBe(0)
      }
      expect(readFileSync(plan.paths.credential, 'utf8')).toBe('real-pipe-secret\n')
      expect(statSync(plan.paths.credential).mode & 0o777).toBe(0o600)
      expect(readFileSync(plan.paths.unit, 'utf8')).toContain('kala-executor')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps credentials out of the unit and rolls partial installation back', async () => {
    const rendered = renderLinuxServiceFiles(session, '/home/example')
    expect(rendered.unit).not.toContain('secret-value')
    expect(rendered.unit).toContain('Restart=always')
    expect(rendered.unit).toContain(`Environment="PATH=${dirname(process.execPath)}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"`)
    expect(rendered.unit).toContain('CPUQuota=400%')
    expect(rendered.unit).toContain('MemoryMax=8G')
    expect(rendered.unit).toContain('TasksMax=512')
    expect(rendered.unit).toContain('NoNewPrivileges=no')
    expect(JSON.parse(rendered.config).privilegeMode).toBe('privileged')
    expect(rendered.credential).toContain('secret-value')

    const plan = createLinuxServicePlan('install', 'system', '/home/example', session)
    const seen: string[] = []
    const runner = {
      run: vi.fn(async (command: { file: string; args: readonly string[]; allowFailure?: boolean }) => {
        seen.push(`${command.file} ${command.args.join(' ')}`)
        if (command.file === 'systemctl' && command.args.includes('show')) return { code: 0, stdout: 'LoadState=not-found\nFragmentPath=\nMainPID=0\n', stderr: '' }
        if (command.file === 'systemctl' && command.args.includes('enable')) return { code: 1, stdout: '', stderr: 'boom' }
        return { code: 0, stdout: '', stderr: '' }
      }),
    }
    await expect(executeLinuxServicePlan(plan, runner)).rejects.toThrow('boom')
    expect(seen.some((value) => value.includes('disable --now'))).toBe(true)
  })

  it('enables no-new-privileges only in Restricted Mode', () => {
    const rendered = renderLinuxServiceFiles({ ...session, privilegeMode: 'restricted' }, '/home/example')
    expect(rendered.unit).toContain('NoNewPrivileges=yes')
    expect(JSON.parse(rendered.config).privilegeMode).toBe('restricted')
  })

  it('exposes status, logs, start, stop, restart, and uninstall service controls', () => {
    expect(createLinuxServicePlan('status', 'user', '/home/example').commands[0]).toMatchObject({ file: 'systemctl', args: ['--user', 'status', 'kala-executor.service'] })
    expect(createLinuxServicePlan('logs', 'user', '/home/example').commands[0]).toMatchObject({ file: 'journalctl', args: ['--user', '--unit', 'kala-executor.service', '--follow'] })
    expect(createLinuxServicePlan('start', 'system', '/home/example').commands[0]).toMatchObject({ file: 'systemctl', args: ['start', 'kala-executor.service'] })
    expect(createLinuxServicePlan('stop', 'system', '/home/example').commands[0]).toMatchObject({ file: 'systemctl', args: ['stop', 'kala-executor.service'] })
    expect(createLinuxServicePlan('restart', 'system', '/home/example').commands[0]).toMatchObject({ file: 'systemctl', args: ['restart', 'kala-executor.service'] })
    expect(createLinuxServicePlan('uninstall', 'system', '/home/example').commands.some((command) => command.args.includes('disable'))).toBe(true)
  })

  it('installs a separate persistent updater timer for managed generations', () => {
    const managed: InstallerSession = {
      ...session,
      managedRoot: '/var/lib/kala/executor',
      update: {
        manifestUrl: 'https://agent.example.test/install/assets/executor-update-manifest.json',
        publicKeyFile: '/var/lib/kala/executor/update-public-key.pem',
        channel: 'stable',
        intervalMinutes: 60,
      },
    }
    const rendered = renderLinuxServiceFiles(managed, '/home/example')
    expect(rendered.unit).toContain('/current/kala-executor')
    expect(rendered.updateUnit).toContain('update apply --config')
    expect(rendered.updateTimer).toContain('Persistent=true')
    const plan = createLinuxServicePlan('install', 'system', '/home/example', managed)
    expect(plan.commands.some((command) => command.args.includes('kala-executor-update.timer'))).toBe(true)
  })

  it('restarts an existing managed service so a repeated install activates the new generation', () => {
    const plan = createLinuxServicePlan('install', 'system', '/home/example', session)
    const serviceCommands = plan.commands
      .filter((command) => command.file === 'systemctl')
      .map((command) => command.args.join(' '))
    expect(serviceCommands).toContain('enable kala-executor.service')
    expect(serviceCommands).toContain('restart kala-executor.service')
    expect(serviceCommands).not.toContain('enable --now kala-executor.service')
    expect(serviceCommands.indexOf('enable kala-executor.service')).toBeLessThan(serviceCommands.indexOf('restart kala-executor.service'))
  })
})

function spawnCommand(command: { file: string; args: readonly string[]; stdin?: string }): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command.file, [...command.args], { stdio: ['pipe', 'pipe', 'pipe'] })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.once('error', reject)
    child.once('close', (code) => resolve({ code: code ?? -1, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() }))
    child.stdin.end(command.stdin)
  })
}

describe('macOS service adapter', () => {
  it('renders safe system and user launchd definitions and rolls back writes', async () => {
    const system = createMacosLaunchdService({ scope: 'system', architecture: 'arm64', configPath: '/Library/Application Support/Kala/配置.json', executablePath: '/opt/homebrew/bin/kala-executor' })
    expect(system.plist).toContain('/opt/homebrew/bin/kala-executor')
    expect(system.plist).toContain('配置.json')
    expect(system.plist).not.toContain('token')

    const user = createMacosLaunchdService({ scope: 'user', architecture: 'x64', uid: 501, homeDirectory: '/Users/Test User', configPath: '/Users/Test User/Library/Application Support/Kala/config.json' })
    expect(user.domain).toBe('gui/501')
    const operations: string[] = []
    await expect(executeLaunchdPlan(user.plans.install, async (operation) => {
      operations.push(operation.kind === 'command' ? operation.args[0] ?? operation.executable : operation.kind)
      if (operation.kind === 'command' && operation.args[0] === 'bootstrap') throw new Error('bootstrap failed')
      return undefined
    })).rejects.toThrow('bootstrap failed')
    expect(operations).toContain('remove-file')
  })
})

describe('Windows service adapter', () => {
  it('quotes paths, excludes credentials, and executes only through the injected boundary', async () => {
    const plan = createWindowsServicePlan({ serviceName: 'KalaExecutor', programFiles: 'C:\\Program Files', programData: 'C:\\Program Data', executableName: 'kala-executor.exe' })
    const create = plan.commands.find((command) => command.action === 'create')!
    expect(create.args.join(' ')).toContain('C:\\Program Files')
    expect(create.args.join(' ')).toContain('--config')
    expect(create.args.join(' ')).not.toMatch(/token|credential/i)
    const runner = vi.fn(async () => ({ exitCode: 0, stdout: 'ok', stderr: '' }))
    await executeWindowsServicePlan(plan, ['create', 'recovery', 'start'], { platform: 'win32', runner })
    expect(runner).toHaveBeenCalledTimes(3)
  })

  it('binds uninstall to a recognized installation identity', () => {
    expect(assertManagedWindowsInstallation({ installationSource: 'dashboard-native', installationId: 'install-1' }).installationId).toBe('install-1')
    expect(() => assertManagedWindowsInstallation({ installationSource: 'manual', installationId: 'install-1' })).toThrow('Refusing')
    expect(() => assertManagedWindowsInstallation({ installationSource: 'dashboard-native', installationId: '' })).toThrow('Refusing')
  })
})
