import { mkdtempSync, rmSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { AgentConfig, AgentState } from '@agent-kernel/kernel'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { appendEventEntry, writeHeader } from '../store/log.js'
import { parseEnhancementCli } from '../enhancement-cli.js'
import { profileSession, scoreSession } from './generic.js'

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

describe('generic eval and profile runners', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ak-generic-eval-'))
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('scores a session with deterministic patch and error checks', async () => {
    const logPath = join(dir, 'session.jsonl')
    const patchPath = join(dir, 'patch.diff')
    await writeHeader({ path: logPath, sessionId: 's1', config, initialState })
    await appendEventEntry({
      path: logPath,
      seq: 1,
      event: { kind: 'user_message', text: 'fix' },
      effects: [],
    })
    await appendEventEntry({
      path: logPath,
      seq: 2,
      event: { kind: 'llm_response', message: { role: 'assistant', content: [] } },
      effects: [],
    })
    await writeFile(patchPath, 'diff --git a/x b/x\n', 'utf8')

    const result = await scoreSession({
      rootDir: join(dir, 'score'),
      sessionLogPath: logPath,
      patchPath,
      instanceId: 'i1',
    })

    expect(result.summary.resolved).toBe(true)
    expect(result.summary.failureLabel).toBe('resolved')
    expect(await readFile(result.scoresPath, 'utf8')).toContain('patch.non_empty')
  })

  it('labels empty patches and failed tool results', async () => {
    const logPath = join(dir, 'session.jsonl')
    const patchPath = join(dir, 'patch.diff')
    await writeHeader({ path: logPath, sessionId: 's1', config, initialState })
    await appendEventEntry({
      path: logPath,
      seq: 1,
      event: { kind: 'tool_result', callId: 'c1', ok: false, content: 'failed' },
      effects: [],
    })
    await writeFile(patchPath, '', 'utf8')

    const result = await scoreSession({
      rootDir: join(dir, 'score'),
      sessionLogPath: logPath,
      patchPath,
    })

    expect(result.summary.resolved).toBe(false)
    expect(result.summary.failureLabel).toBe('empty_patch')
  })

  it('profiles tokens, calls, missing traces, and estimated cost', async () => {
    const logPath = join(dir, 'session.jsonl')
    const pricingPath = join(dir, 'pricing.json')
    await writeHeader({ path: logPath, sessionId: 's1', config, initialState })
    await appendEventEntry({
      path: logPath,
      seq: 1,
      event: { kind: 'llm_response', message: { role: 'assistant', content: [] } },
      effects: [{ kind: 'call_tool', callId: 'c1', name: 'read', input: {} }],
      model: 'gpt-test',
      usage: { inputTokens: 1000, outputTokens: 1000, cacheCreationTokens: 0, cacheReadTokens: 0 },
    })
    await writeFile(pricingPath, JSON.stringify({
      version: 'test',
      currency: 'USD',
      models: { 'gpt-test': { inputPerMillion: 1, outputPerMillion: 2 } },
    }), 'utf8')

    const result = await profileSession({
      rootDir: join(dir, 'profile'),
      sessionLogPath: logPath,
      pricingPath,
    })

    expect(result.profile.llmCalls).toBe(1)
    expect(result.profile.toolCalls).toBe(1)
    expect(result.profile.llmTraceMissingCalls).toBe(1)
    expect(result.profile.estimatedCostUsd).toBe(0.003)
  })

  it('parses generic eval and profile CLI commands', () => {
    expect(parseEnhancementCli([
      'enhancement',
      'eval',
      'score-session',
      '--session-log',
      's.jsonl',
      '--patch',
      'p.diff',
      '--require-done',
    ])).toMatchObject({ kind: 'eval-score-session', requireDone: true })

    expect(parseEnhancementCli([
      'enhancement',
      'profile',
      'session',
      '--session-log',
      's.jsonl',
      '--pricing',
      'pricing.json',
    ])).toMatchObject({ kind: 'profile-session', pricingPath: 'pricing.json' })
  })
})
