import { describe, expect, it } from 'vitest'

import {
  createHookRunner,
  selectHooks,
  type HookConfig,
  type HookPayload,
} from './hooks.js'

// Hook commands run through the OS shell (`shell: true`). We can't rely on
// bash being present on Windows agents (cmd.exe is the default)  -  so the
// runner-level tests below invoke Node directly with a `-e` script, which
// works identically on every platform Node supports.
const NODE = process.execPath

function nodeInlineHook(script: string): HookConfig {
  // Quote for the surrounding shell. Double-quotes are safe on both bash
  // and cmd.exe; the script itself uses single quotes internally.
  return {
    event: 'pre_tool_use',
    command: `"${NODE}" -e "${script}"`,
  }
}

const basePayload: HookPayload = {
  event: 'pre_tool_use',
  sessionId: 'sess-1',
  toolName: 'read',
  toolInput: { path: '/etc/hosts' },
}

describe('createHookRunner', () => {
  it('runs a zero-exit command, ok=true, stdout captured', async () => {
    const runner = createHookRunner()
    const hook = nodeInlineHook("process.stdout.write('allowed')")
    const res = await runner.run(hook, basePayload)
    expect(res.ok).toBe(true)
    expect(res.exitCode).toBe(0)
    expect(res.stdout.trim()).toBe('allowed')
  })

  it('flags non-zero exit as ok=false and returns exit code + stderr', async () => {
    const runner = createHookRunner()
    const hook = nodeInlineHook(
      "process.stderr.write('bad'); process.exit(7)",
    )
    const res = await runner.run(hook, basePayload)
    expect(res.ok).toBe(false)
    expect(res.exitCode).toBe(7)
    expect(res.stderr.trim()).toBe('bad')
  })

  it('pipes the JSON payload on stdin', async () => {
    const runner = createHookRunner()
    // Read all of stdin, echo it back to stdout.
    const hook = nodeInlineHook(
      "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>process.stdout.write(d))",
    )
    const res = await runner.run(hook, basePayload)
    expect(res.ok).toBe(true)
    const parsed = JSON.parse(res.stdout) as HookPayload
    expect(parsed.toolName).toBe('read')
    expect(parsed.sessionId).toBe('sess-1')
  })

  it('kills a hook that exceeds the timeout', async () => {
    const runner = createHookRunner({ timeoutMs: 150 })
    // A 5s Node loop; the runner should SIGKILL it well before it exits.
    const hook = nodeInlineHook('setTimeout(()=>{},5000)')
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
