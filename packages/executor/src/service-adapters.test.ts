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
})

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
