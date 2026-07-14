import { mkdtempSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { LLMAdapter } from '../llm/adapter.js'
import type { ToolDispatcher } from '../loop-types.js'
import { runRlRollout } from './rollout-runner.js'
import { writeTokenCaptureArtifact } from './token-capture.js'
import type { AgentRlTask } from '@agent-kernel/shared/enhancement'

const READ_TOOL = {
  name: 'read',
  description: 'Read a file',
  inputSchema: { type: 'object', additionalProperties: true },
  requiresApproval: false,
} as const

const WRITE_TOOL = {
  name: 'write',
  description: 'Write a file',
  inputSchema: { type: 'object', additionalProperties: true },
  requiresApproval: false,
} as const

const BASH_TOOL = {
  name: 'bash',
  description: 'Run bash',
  inputSchema: { type: 'object', additionalProperties: true },
  requiresApproval: false,
} as const

function baseTask(taskId: string): AgentRlTask {
  return {
    schemaVersion: 'agent.rl.task.v1',
    taskId,
    source: { kind: 'local-fixture' },
    prompt: 'Fix the code and run tests.',
    workspace: { kind: 'empty-tempdir' },
    verifier: { kind: 'command', command: ['bash', '-lc', 'true'], timeoutMs: 5000 },
    governance: { trainingAllowed: true, redactionStatus: 'not_required', retentionClass: 'training_allowed' },
  }
}

function captureWritingAdapter(rootDir: string, rolloutId: string, sessionId: string, script: Array<
  | { kind: 'tool_call'; name: string; input: Record<string, unknown> }
  | { kind: 'text'; text: string }
>): LLMAdapter {
  let call = 0
  return {
    name: 'multi-turn-mock',
    async call() {
      const idx = call++
      const step = script[idx]
      if (!step) {
        return { message: { role: 'assistant', content: [{ type: 'text', text: 'stop' }] } }
      }
      // Every LLM call writes a token capture (simulating what policy-gateway does)
      await writeTokenCaptureArtifact({
        rootDir,
        requireLogprobs: false,
        capture: {
          rolloutId,
          sessionId,
          callId: `call-${idx}`,
          provider: 'policy-gateway',
          backend: 'sglang',
          model: 'mock',
          tokenizer: { nameOrPath: 'mock', chatTemplate: 'mock' },
          promptIds: [1, 2, 3],
          outputIds: [10 + idx, 20 + idx, 30 + idx],
          responseMask: [1, 1, 1] as const,
          usage: { promptTokens: 3, completionTokens: 3 },
          weightVersion: String(1 + Math.floor(idx / 2)),
        },
      })
      if (step.kind === 'tool_call') {
        return {
          message: {
            role: 'assistant',
            content: [{ type: 'tool_call', callId: `call-${idx}`, name: step.name, input: step.input }],
          },
        }
      }
      return { message: { role: 'assistant', content: [{ type: 'text', text: step.text }] } }
    },
  }
}

function scriptedTools(returns: Record<string, string>): ToolDispatcher {
  return {
    async callTool(_sid, eff) {
      const out = returns[eff.name]
      if (out === undefined) return { ok: false, content: `unknown tool ${eff.name}` }
      return { ok: true, content: out }
    },
    cancelPending() {},
  }
}

describe('rollout-runner multi-turn', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ak-mturn-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('runs multiple LLM↔tool turns and produces one capture per LLM call', async () => {
    const script: Array<
      | { kind: 'tool_call'; name: string; input: Record<string, unknown> }
      | { kind: 'text'; text: string }
    > = [
      { kind: 'tool_call', name: 'read', input: { path: 'a.txt' } },
      { kind: 'tool_call', name: 'bash', input: { command: 'true' } },
      { kind: 'text', text: 'all done' },
    ]
    const result = await runRlRollout({
      rootDir: dir,
      task: baseTask('mt-1'),
      rolloutId: 'ro-1',
      sessionId: 'se-1',
      llm: captureWritingAdapter(dir, 'ro-1', 'se-1', script),
      tools: scriptedTools({ read: 'content of a.txt', bash: '' }),
      config: { tools: [READ_TOOL, WRITE_TOOL, BASH_TOOL] },
      maxTurns: 15,
    })

    expect(result.result.status).toBe('completed')
    expect(result.result.tokenCaptureRefs.length).toBeGreaterThanOrEqual(3)
    // Trajectory should have >= 3 turns
    expect(result.result.trajectoryRef).toBeTruthy()
    const traj = JSON.parse(await readFile(join(dir, result.result.trajectoryRef!.uri), 'utf8'))
    expect(traj.turns.length).toBeGreaterThanOrEqual(3)
  })

  it('marks status=blocked when maxTurns is exceeded', async () => {
    const infiniteScript: Array<{ kind: 'tool_call'; name: string; input: Record<string, unknown> }> = Array.from(
      { length: 50 },
      (_, i) => ({ kind: 'tool_call', name: 'bash', input: { command: `echo ${i}` } }),
    )
    const result = await runRlRollout({
      rootDir: dir,
      task: baseTask('mt-cap'),
      rolloutId: 'ro-cap',
      sessionId: 'se-cap',
      llm: captureWritingAdapter(dir, 'ro-cap', 'se-cap', infiniteScript),
      tools: scriptedTools({ bash: '' }),
      config: { tools: [BASH_TOOL] },
      maxTurns: 3,
    })
    expect(result.result.status).toBe('blocked')
    expect(result.result.blockedReason).toMatch(/maxTurns/)
  })

  it('emits at least one capture per turn (evidence for criterion 4)', async () => {
    const script = [
      { kind: 'tool_call' as const, name: 'read', input: { path: 'x' } },
      { kind: 'tool_call' as const, name: 'write', input: { path: 'y', content: 'z' } },
      { kind: 'tool_call' as const, name: 'bash', input: { command: 'ls' } },
      { kind: 'text' as const, text: 'done' },
    ]
    const result = await runRlRollout({
      rootDir: dir,
      task: baseTask('mt-cap-per-turn'),
      rolloutId: 'ro-per-turn',
      sessionId: 'se-per-turn',
      llm: captureWritingAdapter(dir, 'ro-per-turn', 'se-per-turn', script),
      tools: scriptedTools({ read: 'ok', write: 'ok', bash: 'ok' }),
      config: { tools: [READ_TOOL, WRITE_TOOL, BASH_TOOL] },
      maxTurns: 15,
    })
    expect(result.result.tokenCaptureRefs.length).toBe(4)
  })
})
