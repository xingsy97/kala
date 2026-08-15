import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { createLinuxServicePlan, executeLinuxServicePlan, renderLinuxServiceFiles } from './linux-service.js'
import { createMacosLaunchdService, executeLaunchdPlan } from './macos-launchd.js'
import { createWindowsServicePlan, executeWindowsServicePlan } from './windows-service.js'
import type { InstallerSession } from './installer-session.js'

const session: InstallerSession = {
  version: 1,
  mode: 'system',
  executable: '/opt/agent-runlab/executor/current/runlab-executor',
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
        executable: join(root, 'runlab-executor'),
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
      expect(readFileSync(plan.paths.unit, 'utf8')).toContain('runlab-executor')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps credentials out of the unit and rolls partial installation back', async () => {
    const rendered = renderLinuxServiceFiles(session, '/home/example')
    expect(rendered.unit).not.toContain('secret-value')
    expect(rendered.unit).toContain('Restart=always')
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

  it('exposes status, logs, start, stop, restart, and uninstall service controls', () => {
    expect(createLinuxServicePlan('status', 'user', '/home/example').commands[0]).toMatchObject({ file: 'systemctl', args: ['--user', 'status', 'runlab-executor.service'] })
    expect(createLinuxServicePlan('logs', 'user', '/home/example').commands[0]).toMatchObject({ file: 'journalctl', args: ['--user', '--unit', 'runlab-executor.service', '--follow'] })
    expect(createLinuxServicePlan('start', 'system', '/home/example').commands[0]).toMatchObject({ file: 'systemctl', args: ['start', 'runlab-executor.service'] })
    expect(createLinuxServicePlan('stop', 'system', '/home/example').commands[0]).toMatchObject({ file: 'systemctl', args: ['stop', 'runlab-executor.service'] })
    expect(createLinuxServicePlan('restart', 'system', '/home/example').commands[0]).toMatchObject({ file: 'systemctl', args: ['restart', 'runlab-executor.service'] })
    expect(createLinuxServicePlan('uninstall', 'system', '/home/example').commands.some((command) => command.args.includes('disable'))).toBe(true)
  })

  it('installs a separate persistent updater timer for managed generations', () => {
    const managed: InstallerSession = {
      ...session,
      managedRoot: '/var/lib/runlab-executor',
      update: {
        manifestUrl: 'https://agent.example.test/install/assets/executor-update-manifest.json',
        publicKeyFile: '/var/lib/runlab-executor/update-public-key.pem',
        channel: 'stable',
        intervalMinutes: 60,
      },
    }
    const rendered = renderLinuxServiceFiles(managed, '/home/example')
    expect(rendered.unit).toContain('/current/runlab-executor')
    expect(rendered.updateUnit).toContain('update apply --config')
    expect(rendered.updateTimer).toContain('Persistent=true')
    const plan = createLinuxServicePlan('install', 'system', '/home/example', managed)
    expect(plan.commands.some((command) => command.args.includes('runlab-executor-update.timer'))).toBe(true)
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
    const system = createMacosLaunchdService({ scope: 'system', architecture: 'arm64', configPath: '/Library/Application Support/Agent RunLab/配置.json', executablePath: '/opt/homebrew/bin/runlab-executor' })
    expect(system.plist).toContain('/opt/homebrew/bin/runlab-executor')
    expect(system.plist).toContain('配置.json')
    expect(system.plist).not.toContain('token')

    const user = createMacosLaunchdService({ scope: 'user', architecture: 'x64', uid: 501, homeDirectory: '/Users/Test User', configPath: '/Users/Test User/Library/Application Support/Agent RunLab/config.json' })
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
    const plan = createWindowsServicePlan({ serviceName: 'RunLabExecutor', programFiles: 'C:\\Program Files', programData: 'C:\\Program Data', executableName: 'runlab-executor.exe' })
    const create = plan.commands.find((command) => command.action === 'create')!
    expect(create.args.join(' ')).toContain('C:\\Program Files')
    expect(create.args.join(' ')).toContain('--config')
    expect(create.args.join(' ')).not.toMatch(/token|credential/i)
    const runner = vi.fn(async () => ({ exitCode: 0, stdout: 'ok', stderr: '' }))
    await executeWindowsServicePlan(plan, ['create', 'recovery', 'start'], { platform: 'win32', runner })
    expect(runner).toHaveBeenCalledTimes(3)
  })
})
