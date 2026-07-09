import { describe, expect, it } from 'vitest'

import {
  createHookRunner,
  selectHooks,
  type HookConfig,
  type HookPayload,
} from './hooks.js'

const basePayload: HookPayload = {
  event: 'pre_tool_use',
  sessionId: 'sess-1',
  toolName: 'read',
  toolInput: { path: '/etc/hosts' },
}

describe('createHookRunner', () => {
  it('runs a zero-exit command, ok=true, stdout captured', async () => {
    const runner = createHookRunner()
    const hook: HookConfig = {
      event: 'pre_tool_use',
      command: 'cat > /dev/null; echo allowed',
    }
    const res = await runner.run(hook, basePayload)
    expect(res.ok).toBe(true)
    expect(res.exitCode).toBe(0)
    expect(res.stdout.trim()).toBe('allowed')
  })

  it('flags non-zero exit as ok=false and returns exit code + stderr', async () => {
    const runner = createHookRunner()
    const hook: HookConfig = {
      event: 'pre_tool_use',
      command: 'cat > /dev/null; echo bad >&2; exit 7',
    }
    const res = await runner.run(hook, basePayload)
    expect(res.ok).toBe(false)
    expect(res.exitCode).toBe(7)
    expect(res.stderr.trim()).toBe('bad')
  })

  it('pipes the JSON payload on stdin', async () => {
    const runner = createHookRunner()
    const hook: HookConfig = {
      event: 'pre_tool_use',
      command: 'cat',
    }
    const res = await runner.run(hook, basePayload)
    expect(res.ok).toBe(true)
    const parsed = JSON.parse(res.stdout) as HookPayload
    expect(parsed.toolName).toBe('read')
    expect(parsed.sessionId).toBe('sess-1')
  })

  it('kills a hook that exceeds the timeout', async () => {
    const runner = createHookRunner({ timeoutMs: 150 })
    const hook: HookConfig = {
      event: 'pre_tool_use',
      command: 'sleep 5',
    }
    const start = Date.now()
    const res = await runner.run(hook, basePayload)
    const elapsed = Date.now() - start
    expect(res.ok).toBe(false)
    expect(elapsed).toBeLessThan(1500)
    expect(res.stderr).toContain('timeout')
  })
})

describe('selectHooks', () => {
  const hooks: readonly HookConfig[] = [
    { event: 'pre_tool_use', command: 'a' },
    { event: 'pre_tool_use', command: 'b', match: 'bash' },
    { event: 'post_tool_use', command: 'c' },
    { event: 'session_start', command: 'd' },
  ]

  it('picks all pre_tool_use hooks when no match specified and no tool given', () => {
    const picked = selectHooks(hooks, 'pre_tool_use')
    expect(picked.map((h) => h.command)).toEqual(['a'])
  })

  it('picks match-scoped hook when tool name matches', () => {
    const picked = selectHooks(hooks, 'pre_tool_use', 'bash')
    expect(picked.map((h) => h.command)).toEqual(['a', 'b'])
  })

  it('drops match-scoped hook when tool name differs', () => {
    const picked = selectHooks(hooks, 'pre_tool_use', 'read')
    expect(picked.map((h) => h.command)).toEqual(['a'])
  })

  it('filters by event', () => {
    const picked = selectHooks(hooks, 'session_start')
    expect(picked.map((h) => h.command)).toEqual(['d'])
  })
})
