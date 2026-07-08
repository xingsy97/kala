import { mkdtempSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { AgentConfig, AgentState } from '@agent-kernel/kernel'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { appendEventEntry, writeHeader } from './store/log.js'
import { exportRolloutSidecar, exportSessionTraceArtifacts } from './enhancement-export.js'
import { parseEnhancementCli } from './enhancement-cli.js'

const config: AgentConfig = { tools: [] }
const initialState: AgentState = {
  sessionId: 's1',
  messages: [],
  pendingCalls: [],
  status: 'idle',
  usage: {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  },
  cursor: 0,
  contextPressureLevel: 'none',
  approvalMode: 'auto',
}

describe('enhancement artifact export', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ak-export-'))
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('exports redacted trace and LLM request/response artifacts from a session log', async () => {
    const logPath = join(dir, 'session.jsonl')
    await writeHeader({ path: logPath, sessionId: 's1', config, initialState })
    await appendEventEntry({
      path: logPath,
      seq: 1,
      event: { kind: 'llm_response', message: { role: 'assistant', content: [] } },
      effects: [],
      model: 'gpt-test',
      llmTrace: {
        provider: 'openai',
        model: 'gpt-test',
        request: {
          url: 'https://gateway.example.test/v1/chat/completions',
          headers: { authorization: 'Bearer test-redacted-api-key' },
          body: { model: 'gpt-test', messages: [{ role: 'user', content: 'hello' }] },
        },
        response: { status: 200, body: { id: 'cmpl_1' } },
      },
    })

    const result = await exportSessionTraceArtifacts({ rootDir: dir, sessionLogPath: logPath })
    expect(result.traceArtifact.uri).toBe('traces/s1.openinference.json')
    expect(result.llmArtifacts.map((artifact) => artifact.kind)).toEqual(['llm_request', 'llm_response'])
    const request = await readFile(join(dir, 'llm/s1/1.request.json'), 'utf8')
    expect(request).not.toContain('gateway.example.test')
    expect(request).not.toContain('test-redacted-api-key')
  })

  it('exports RL rollout sidecars as metadata indexes', async () => {
    const logPath = join(dir, 'session.jsonl')
    await writeHeader({ path: logPath, sessionId: 's1', config, initialState })

    const result = await exportRolloutSidecar({
      rootDir: dir,
      sessionLogPath: logPath,
      taskId: 'swebench:sympy__sympy-20590',
      frameworkTarget: 'slime',
      model: 'policy-a',
      rewardPath: 'rewards/s1.json',
    })

    const sidecar = JSON.parse(await readFile(result.sidecarPath, 'utf8'))
    expect(sidecar.task_id).toBe('swebench:sympy__sympy-20590')
    expect(sidecar.framework_target).toBe('slime')
    expect(sidecar.trace_ref).toBe('traces/s1.openinference.json')
    expect(sidecar.reward_ref).toBe('rewards/s1.json')
  })

  it('parses enhancement trace and rollout export commands', () => {
    expect(parseEnhancementCli([
      'enhancement',
      'trace',
      'export-session',
      '--session-log',
      's.jsonl',
      '--root-dir',
      'runs/x',
    ])).toMatchObject({ kind: 'trace-export-session', rootDir: 'runs/x' })

    expect(parseEnhancementCli([
      'enhancement',
      'rollout',
      'export-session',
      '--session-log',
      's.jsonl',
      '--task-id',
      'task1',
      '--framework',
      'verl',
    ])).toMatchObject({ kind: 'rollout-export-session', frameworkTarget: 'verl' })
  })
})
