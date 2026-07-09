import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('restart-every', () => {
  it('is opt-in and not the default backend dev command', async () => {
    const hostPkg = JSON.parse(await import('node:fs/promises').then((fs) => fs.readFile('packages/host/package.json', 'utf8')))
    const executorPkg = JSON.parse(await import('node:fs/promises').then((fs) => fs.readFile('packages/executor/package.json', 'utf8')))

    expect(hostPkg.scripts.dev).toContain('tsx watch')
    expect(hostPkg.scripts.dev).toContain('--exclude "../dashboard/**"')
    expect(hostPkg.scripts.dev).not.toContain('restart-every.mjs')
    expect(executorPkg.scripts.dev).toBe('tsx watch bin/agent-kernel-executor.ts')
    expect(executorPkg.scripts.dev).not.toContain('restart-every.mjs')
    expect(hostPkg.scripts['dev:restart']).toContain('restart-every.mjs')
    expect(executorPkg.scripts['dev:restart']).toContain('restart-every.mjs')
  })

  it('strips pnpm argument separators before spawning the child command', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ak-restart-every-'))
    const script = join(dir, 'argv.mjs')
    writeFileSync(
      script,
      "console.log(JSON.stringify(process.argv.slice(2))); setInterval(() => {}, 10000)\n",
      'utf8',
    )
    const child = spawn(
      process.execPath,
      [
        'scripts/dev/restart-every.mjs',
        '--interval-ms',
        '5000',
        '--',
        process.execPath,
        script,
        '--',
        '--host',
        'http://localhost:3000',
      ],
      { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let stdout = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })

    while (!stdout.includes('\n')) {
      await once(child.stdout, 'data')
    }
    child.kill('SIGTERM')
    await once(child, 'exit')
    rmSync(dir, { recursive: true, force: true })

    expect(JSON.parse(stdout.trim())).toEqual(['--host', 'http://localhost:3000'])
  })
})
