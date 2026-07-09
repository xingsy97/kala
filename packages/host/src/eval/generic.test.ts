import { mkdtempSync, rmSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { AgentConfig, AgentState } from '@agent-kernel/kernel'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { appendEventEntry, writeHeader } from '../store/log.js'
import { parseEnhancementCli } from '../enhancement-cli.js'
import { compareEvalRuns, judgeScore, profileSession, scoreSession } from './generic.js'

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

  it('compares eval run summaries without mutating either run', async () => {
    const baselinePath = join(dir, 'baseline-summary.json')
    const candidatePath = join(dir, 'candidate-summary.json')
    await writeFile(baselinePath, JSON.stringify({
      experimentId: 'base',
      dataset: 'local',
      model: 'm1',
      trialCount: 2,
      completed: 2,
      failed: 1,
      timedOut: 0,
      resolved: 1,
      unresolved: 1,
      emptyPatch: 1,
      failureCounts: { empty_patch: 1 },
      metrics: { passRate: 0.5 },
    }), 'utf8')
    await writeFile(candidatePath, JSON.stringify({
      experimentId: 'candidate',
      dataset: 'local',
      model: 'm2',
      trialCount: 2,
      completed: 2,
      failed: 0,
      timedOut: 0,
      resolved: 2,
      unresolved: 0,
      emptyPatch: 0,
      failureCounts: {},
      metrics: { passRate: 1 },
    }), 'utf8')

    const result = await compareEvalRuns({
      rootDir: join(dir, 'compare'),
      baselineSummaryPath: baselinePath,
      candidateSummaryPath: candidatePath,
    })

    expect(result.comparison.deltas.resolved).toBe(1)
    expect(result.comparison.deltas.passRate).toBe(0.5)
    expect(result.comparison.failureDeltas.empty_patch).toBe(-1)
    expect(await readFile(result.comparisonPath, 'utf8')).toContain('candidate')
  })

  it('writes model judge traces and score summaries', async () => {
    const promptPath = join(dir, 'judge-prompt.txt')
    const responsePath = join(dir, 'judge-response.json')
    await writeFile(promptPath, 'Judge this answer. OPENAI_API_KEY=test-redacted-api-key', 'utf8')
    await writeFile(responsePath, JSON.stringify({ score: 0.75, label: 'resolved', explanation: 'Grounded answer.' }), 'utf8')

    const result = await judgeScore({
      rootDir: join(dir, 'judge'),
      promptPath,
      responsePath,
      judgeModel: 'judge-model-v1',
      scorer: 'answer.groundedness',
      instanceId: 'i1',
      threshold: 0.7,
    })

    expect(result.summary.resolved).toBe(true)
    expect(result.summary.score).toBe(1)
    expect(result.summary.results[0]?.score).toBe(0.75)
    expect(result.judgeTrace.kind).toBe('eval_judge')
    const persisted = await readFile(join(dir, 'judge', result.judgeTrace.uri), 'utf8')
    expect(persisted).toContain('judge-model-v1')
    expect(persisted).not.toContain('test-redacted-api-key')
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

    expect(parseEnhancementCli([
      'enhancement',
      'eval',
      'judge-score',
      '--prompt',
      'prompt.txt',
      '--response',
      'response.json',
      '--judge-model',
      'judge-v1',
      '--threshold',
      '0.8',
    ])).toMatchObject({ kind: 'eval-judge-score', promptPath: 'prompt.txt', responsePath: 'response.json', judgeModel: 'judge-v1', threshold: 0.8 })

    expect(parseEnhancementCli([
      'enhancement',
      'eval',
      'compare-runs',
      '--baseline-summary',
      'base.json',
      '--candidate-summary',
      'cand.json',
    ])).toMatchObject({ kind: 'eval-compare-runs', baselineSummaryPath: 'base.json', candidateSummaryPath: 'cand.json' })
  })
})
