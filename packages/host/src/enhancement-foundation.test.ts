import { mkdtempSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { EventEntry, HeaderEntry, LLMTrace } from '@agent-kernel/shared'
import {
  buildSweBenchEvaluationCommand,
  createArtifactStore,
  createRolloutSidecar,
  createSweBenchPrediction,
  exportSessionSpans,
  redactForPersistence,
  serializeJsonl,
} from '@agent-kernel/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const header: HeaderEntry = {
  kind: 'header',
  seq: 0,
  ts: '2026-07-09T00:00:00.000Z',
  sessionId: 's1',
  workspaceId: 'w1',
  formatVersion: 1,
  kernelVersion: '@agent-kernel/kernel@0.0.0',
  config: { tools: [] },
  initialState: {
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
  },
}

describe('enhancement foundation', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ak-enhancement-'))
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('redacts provider base URLs and secrets before persistence', () => {
    const result = redactForPersistence(
      {
        url: 'https://gateway.example.com/v1/chat/completions?api_key=abc',
        headers: {
          authorization: 'Bearer test-redacted-api-key',
          'x-api-key': 'anthropic-secret',
        },
        body: 'OPENAI_API_KEY=redacted-test-api-key in <workspace-root>',
      },
      { workspaceRoot: '<workspace-root>' },
    )

    expect(JSON.stringify(result.value)).not.toContain('gateway.example.com')
    expect(JSON.stringify(result.value)).not.toContain('verysecretkey')
    expect(JSON.stringify(result.value)).not.toContain('<workspace-root>')
    expect(result.summary.rules).toContain('url.base')
    expect(result.summary.rules).toContain('secret.key')
    expect(result.summary.rules).toContain('path.workspace_root')
  })

  it('writes redacted artifacts with hashes and relative refs', async () => {
    const store = createArtifactStore(dir)
    const ref = await store.writeJson('llm_request', 'llm/request-1.json', {
      url: 'https://api.openai.com/v1/chat/completions',
      headers: { authorization: 'Bearer test-redacted-api-key' },
      body: { model: 'gpt-test' },
    })

    expect(ref.uri).toBe('llm/request-1.json')
    expect(ref.sha256).toHaveLength(64)
    expect(ref.bytes).toBeGreaterThan(0)
    expect(ref.redaction.redacted).toBe(true)
    const persisted = await readFile(join(dir, ref.uri), 'utf8')
    expect(persisted).not.toContain('api.openai.com')
    expect(persisted).not.toContain('test-redacted-api-key')
  })

  it('exports OpenInference-shaped spans from session log entries', () => {
    const llmTrace: LLMTrace = {
      provider: 'openai',
      model: 'gpt-test',
      request: { url: '<redacted>/chat/completions', headers: {}, body: {} },
      response: { status: 200, body: { id: 'x' } },
    }
    const events: EventEntry[] = [
      {
        kind: 'event',
        seq: 1,
        ts: '2026-07-09T00:00:01.000Z',
        event: { kind: 'llm_response', message: { role: 'assistant', content: [] } },
        effects: [
          { kind: 'call_tool', callId: 'c1', name: 'read', input: { path: 'README.md' } },
        ],
        usage: {
          inputTokens: 10,
          outputTokens: 2,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
        },
        llmTrace,
        model: 'gpt-test',
      },
      {
        kind: 'event',
        seq: 2,
        ts: '2026-07-09T00:00:02.000Z',
        event: { kind: 'tool_result', callId: 'c1', ok: true, content: 'ok' },
        effects: [],
      },
    ]

    const spans = exportSessionSpans({ header, events, runId: 'run1', evalInstanceId: 'i1' })
    expect(spans.map((span) => span.kind)).toEqual(['AGENT', 'LLM', 'TOOL'])
    expect(spans[1]!.attributes['gen_ai.provider.name']).toBe('openai')
    expect(spans[1]!.attributes['gen_ai.usage.input_tokens']).toBe(10)
    expect(spans[2]!.attributes['gen_ai.tool.name']).toBe('read')
    expect(spans.every((span) => span.traceId === spans[0]!.traceId)).toBe(true)
  })

  it('creates official SWE-bench prediction rows and harness command args', () => {
    const row = createSweBenchPrediction({
      instanceId: 'sympy__sympy-20590',
      modelNameOrPath: 'agent-kernel/gpt-test',
      modelPatch: 'diff --git a/x b/x\n',
    })
    expect(serializeJsonl([row])).toBe(
      '{"instance_id":"sympy__sympy-20590","model_name_or_path":"agent-kernel/gpt-test","model_patch":"diff --git a/x b/x\\n"}\n',
    )
    expect(
      buildSweBenchEvaluationCommand({
        datasetName: 'princeton-nlp/SWE-bench_Lite',
        predictionsPath: 'runs/predictions.jsonl',
        runId: 'run1',
        maxWorkers: 2,
        instanceIds: ['sympy__sympy-20590'],
      }),
    ).toEqual([
      'python',
      '-m',
      'swebench.harness.run_evaluation',
      '--dataset_name',
      'princeton-nlp/SWE-bench_Lite',
      '--predictions_path',
      'runs/predictions.jsonl',
      '--max_workers',
      '2',
      '--run_id',
      'run1',
      '--instance_ids',
      'sympy__sympy-20590',
    ])
  })

  it('creates RL rollout sidecars as indexes, not trajectory schemas', () => {
    const sidecar = createRolloutSidecar({
      rolloutId: 'rollout_1',
      sessionId: 's1',
      taskId: 'swebench:sympy__sympy-20590',
      frameworkTarget: 'slime',
      eventLogRef: 'sessions/s1.jsonl',
      traceRef: 'traces/s1.otlp.jsonl',
      rewardRef: 'rewards/s1.json',
      model: 'local-policy',
    })

    expect(sidecar).toEqual({
      rollout_id: 'rollout_1',
      session_id: 's1',
      task_id: 'swebench:sympy__sympy-20590',
      framework_target: 'slime',
      event_log_ref: 'sessions/s1.jsonl',
      trace_ref: 'traces/s1.otlp.jsonl',
      reward_ref: 'rewards/s1.json',
      model: 'local-policy',
      metadata: {},
    })
  })
})
