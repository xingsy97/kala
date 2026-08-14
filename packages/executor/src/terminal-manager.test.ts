import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => {
    const child = new EventEmitter() as EventEmitter & {
      stdin: { write: ReturnType<typeof vi.fn> }
      stdout: EventEmitter
      stderr: EventEmitter
      kill: ReturnType<typeof vi.fn>
    }
    child.stdin = { write: vi.fn() }
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = vi.fn()
    return child
  }),
}))

import { spawn } from 'node:child_process'
import { createTerminalManager } from './terminal-manager.js'

const base = { workspaceId: 'ws', sessionId: 'session' }

describe('TerminalManager', () => {
  it('keeps one terminal per Session, replays a 1 MiB ring, and closes only that Session', async () => {
    process.env.AGENT_KERNEL_TERMINAL_DISABLE_PTY = '1'
    const manager = createTerminalManager({
      sandbox: { roots: [], resolve: async (path) => path },
      emitOutput: vi.fn(),
      emitExit: vi.fn(),
    })

    const first = await manager.create({ ...base, requestId: 'r1', cwd: '/tmp' })
    expect(spawn).toHaveBeenCalledWith(
      process.platform === 'win32' ? expect.any(String) : 'script',
      process.platform === 'darwin'
        ? ['-q', '/dev/null', expect.any(String)]
        : process.platform === 'win32'
          ? []
          : ['-qfec', expect.any(String), '/dev/null'],
      expect.objectContaining({ cwd: '/tmp', stdio: 'pipe' }),
    )
    const child = vi.mocked(spawn).mock.results[0]!.value as { stdin: { write: ReturnType<typeof vi.fn> }; stdout: EventEmitter; kill: ReturnType<typeof vi.fn> }
    manager.input({ ...base, terminalId: first.terminalId!, data: 'echo works\r' })
    expect(child.stdin.write).toHaveBeenCalledWith('echo works\n')
    child.stdout.emit('data', Buffer.from('a'.repeat(1_048_576) + 'tail'))

    const reused = await manager.create({ ...base, requestId: 'r2', cwd: '/elsewhere' })
    expect(reused).toMatchObject({ requestId: 'r2', terminalId: first.terminalId, reused: true })
    expect(Buffer.byteLength(reused.replay ?? '')).toBe(1_048_576)
    expect(reused.replay?.endsWith('tail')).toBe(true)
    expect(spawn).toHaveBeenCalledTimes(1)

    const killed = manager.kill({ ...base, requestId: 'kill-1', terminalId: first.terminalId! })
    expect(killed.killed).toBe(true)
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')

    const restarted = await manager.create({ ...base, requestId: 'r3', cwd: '/tmp' })
    expect(restarted.terminalId).not.toBe(first.terminalId)
    expect(restarted.reused).not.toBe(true)
    expect(spawn).toHaveBeenCalledTimes(2)
    manager.input({ ...base, terminalId: restarted.terminalId!, data: 'after restart\r' })
    const restartedChild = vi.mocked(spawn).mock.results[1]!.value as { stdin: { write: ReturnType<typeof vi.fn> } }
    expect(restartedChild.stdin.write).toHaveBeenCalledWith('after restart\n')

    manager.closeSession(base)
  })
})
