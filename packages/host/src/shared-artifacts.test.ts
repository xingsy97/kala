import { mkdtempSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { EventEntry, HeaderEntry, LLMTrace } from '@agent-kernel/shared'
import {
  buildSweBenchEvaluationCommand,
  createArtifactStore,
  createEvalExperiment,
  createMessageAssemblyArtifact,
  createRolloutSidecar,
  createRouterDecisionArtifact,
  createSessionProfile,
  createSweBenchPrediction,
  createToolCatalogArtifact,
  deriveEvalMemoryPolicy,
  exportSessionSpans,
  redactForPersistence,
  serializeJsonl,
  summarizeEvalRun,
  summarizeEvalScores,
} from '@agent-kernel/shared/enhancement'
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
      gatewayRequestId: 'req_abc123',
      weightVersion: 'policy-preview-1@2026-07-09',
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
    expect(spans[1]!.attributes['gen_ai.response.id']).toBe('req_abc123')
    expect(spans[1]!.attributes['agent_kernel.model.weight_version']).toBe('policy-preview-1@2026-07-09')
    expect(spans[2]!.attributes['gen_ai.tool.name']).toBe('read')
    expect(spans.every((span) => span.traceId === spans[0]!.traceId)).toBe(true)
  })

  it('emits MEMORY-kind spans for memory tool calls and propagates parent-session attrs', () => {
    const events: EventEntry[] = [
      {
        kind: 'event',
        seq: 1,
        ts: '2026-07-09T00:00:01.000Z',
        event: { kind: 'llm_response', message: { role: 'assistant', content: [] } },
        effects: [
          { kind: 'call_tool', callId: 'm1', name: 'memory', input: { operation: 'read' } },
        ],
      },
      {
        kind: 'event',
        seq: 2,
        ts: '2026-07-09T00:00:02.000Z',
        event: { kind: 'tool_result', callId: 'm1', ok: true, content: 'ok' },
        effects: [],
      },
    ]
    const forked: HeaderEntry = {
      ...header,
      parentSessionId: 'parent-1',
      parentCursor: 7,
    }
    const spans = exportSessionSpans({ header: forked, events })
    const root = spans.find((s) => s.kind === 'AGENT')!
    expect(root.attributes['agent_kernel.parent_session_id']).toBe('parent-1')
    expect(root.attributes['agent_kernel.parent_cursor']).toBe(7)
    const mem = spans.find((s) => s.kind === 'MEMORY')!
    expect(mem).toBeDefined()
    expect(mem.name).toBe('memory memory')
    expect(mem.attributes['gen_ai.operation.name']).toBe('memory_operation')
    expect(mem.attributes['gen_ai.tool.name']).toBe('memory')
  })

  it('emits CHAIN spans for each compaction outcome with matching status', () => {
    const events: EventEntry[] = [
      {
        kind: 'event',
        seq: 1,
        ts: '2026-07-09T00:00:01.000Z',
        event: {
          kind: 'compact_replaced',
          trigger: 'auto',
          attemptId: 'a1',
          preserveFrom: 3,
          summary: 's',
          replacedCount: 4,
          tokensBefore: 10_000,
          tokensAfter: 2_000,
        },
        effects: [],
      },
      {
        kind: 'event',
        seq: 2,
        ts: '2026-07-09T00:00:02.000Z',
        event: {
          kind: 'compact_skipped',
          trigger: 'auto',
          attemptId: 'a2',
          reason: 'circuit_breaker_open',
        },
        effects: [],
      },
      {
        kind: 'event',
        seq: 3,
        ts: '2026-07-09T00:00:03.000Z',
        event: {
          kind: 'compact_rejected',
          attemptId: 'a3',
          reason: 'pending_call_orphaned',
        },
        effects: [],
      },
    ]
    const spans = exportSessionSpans({ header, events })
    const chains = spans.filter((s) => s.kind === 'CHAIN')
    expect(chains).toHaveLength(3)
    const replaced = chains.find((s) => s.attributes['agent_kernel.compact.attempt_id'] === 'a1')!
    expect(replaced.status).toBe('OK')
    expect(replaced.attributes['agent_kernel.compact.outcome']).toBe('replaced')
    expect(replaced.attributes['agent_kernel.compact.tokens_before']).toBe(10_000)
    expect(replaced.attributes['agent_kernel.compact.tokens_after']).toBe(2_000)
    expect(replaced.attributes['agent_kernel.compact.replaced_count']).toBe(4)
    const skipped = chains.find((s) => s.attributes['agent_kernel.compact.attempt_id'] === 'a2')!
    expect(skipped.status).toBe('ERROR')
    expect(skipped.attributes['agent_kernel.compact.outcome']).toBe('skipped')
    expect(skipped.attributes['agent_kernel.compact.reason']).toBe('circuit_breaker_open')
    const rejected = chains.find((s) => s.attributes['agent_kernel.compact.attempt_id'] === 'a3')!
    expect(rejected.status).toBe('ERROR')
    expect(rejected.attributes['agent_kernel.compact.outcome']).toBe('rejected')
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

  it('summarizes eval trials with low-cardinality failure labels', () => {
    const experiment = createEvalExperiment({
      experimentId: 'run1',
      dataset: 'local',
      model: 'gpt-test',
      createdAt: '2026-07-09T00:00:00.000Z',
    })
    const summary = summarizeEvalRun(experiment, [
      {
        trialId: 't1',
        experimentId: 'run1',
        instanceId: 'i1',
        status: 'completed',
        resolved: true,
        failureLabel: 'resolved',
        artifacts: [],
        metrics: {},
      },
      {
        trialId: 't2',
        experimentId: 'run1',
        instanceId: 'i2',
        status: 'completed',
        resolved: false,
        failureLabel: 'empty_patch',
        artifacts: [],
        metrics: {},
      },
    ])

    expect(summary.trialCount).toBe(2)
    expect(summary.resolved).toBe(1)
    expect(summary.emptyPatch).toBe(1)
    expect(summary.metrics.passRate).toBe(0.5)
  })

  it('builds message assembly artifacts from messages and tool schemas', () => {
    const artifact = createMessageAssemblyArtifact({
      sessionId: 's1',
      model: 'gpt-test',
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'sys' }] },
        { role: 'user', content: [{ type: 'text', text: 'hello' }] },
        { role: 'assistant', content: [{ type: 'tool_call', callId: 'm1', name: 'memory', input: { operation: 'read', scope: 'workspace', key: 'style' } }] },
        { role: 'tool', content: [{ type: 'tool_result', callId: 'm1', ok: true, content: 'prefer concise output' }] },
      ],
      tools: [
        { name: 'read', description: 'read files', inputSchema: { type: 'object' }, requiresApproval: false },
        { name: 'memory', description: 'memory', inputSchema: { type: 'object' }, requiresApproval: false },
      ],
    })

    expect(artifact.messageCount).toBe(4)
    expect(artifact.toolCount).toBe(2)
    expect(artifact.parts.map((part) => part.name)).toContain('system')
    expect(artifact.parts.map((part) => part.name)).toContain('tools')
    expect(artifact.parts.map((part) => part.name)).toContain('memory')
    expect(artifact.estimatedTokens).toBeGreaterThan(0)
  })

  it('includes budget partitions with reason codes when contextLimit is provided', () => {
    const artifact = createMessageAssemblyArtifact({
      sessionId: 's1',
      model: 'gpt-test',
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'sys' }] },
        { role: 'user', content: [{ type: 'text', text: 'previous question' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'previous answer' }] },
        { role: 'user', content: [{ type: 'text', text: 'current question' }] },
      ],
      tools: [{ name: 'read', description: 'reads files', inputSchema: { type: 'object' }, requiresApproval: false }],
      budget: { contextLimit: 128_000 },
    })

    expect(artifact.budget).toBeDefined()
    expect(artifact.budget!.contextLimit).toBe(128_000)
    expect(artifact.budget!.partitions.map((p) => p.name)).toEqual([
      'fixed_instructions',
      'tool_schemas',
      'active_turn',
      'recent_tail',
      'retrieved_memory',
      'output_reserve',
      'compaction_reserve',
    ])
    const activeTurn = artifact.budget!.partitions.find((p) => p.name === 'active_turn')
    expect(activeTurn?.reasonCodes).toContain('active_turn_present')
    const recentTail = artifact.budget!.partitions.find((p) => p.name === 'recent_tail')
    expect(recentTail?.reasonCodes).toContain('recent_tail_present')
    expect(artifact.budget!.overBudget).toBe(false)
  })

  it('flags over_budget in the budget reason codes when input exceeds the available window', () => {
    const bigText = 'x'.repeat(600_000)
    const artifact = createMessageAssemblyArtifact({
      sessionId: 's1',
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'sys' }] },
        { role: 'user', content: [{ type: 'text', text: bigText }] },
      ],
      tools: [],
      budget: { contextLimit: 8_000 },
    })
    expect(artifact.budget!.overBudget).toBe(true)
    expect(artifact.budget!.reasonCodes).toContain('over_budget')
  })

  it('reports active_turn_missing when the most recent turn is not from the user', () => {
    const artifact = createMessageAssemblyArtifact({
      sessionId: 's1',
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'sys' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'orphan' }] },
      ],
      tools: [],
      budget: { contextLimit: 128_000 },
    })
    const activeTurn = artifact.budget!.partitions.find((p) => p.name === 'active_turn')
    expect(activeTurn?.reasonCodes).toContain('active_turn_missing')
    expect(artifact.budget!.reasonCodes).toContain('active_turn_missing')
  })

  it('summarizes eval scores and session profiles without kernel state changes', () => {
    const score = summarizeEvalScores([
      {
        scorer: 'patch.non_empty',
        passed: false,
        label: 'empty_patch',
        score: 0,
        metrics: {},
        artifactRefs: [],
      },
    ], 'i1')
    expect(score.failureLabel).toBe('empty_patch')
    expect(score.resolved).toBe(false)

    const profile = createSessionProfile({
      header,
      events: [
        {
          kind: 'event',
          seq: 1,
          ts: '2026-07-09T00:00:01.000Z',
          event: { kind: 'llm_response', message: { role: 'assistant', content: [] } },
          effects: [],
          model: 'gpt-test',
          llmTrace: {
            provider: 'openai',
            model: 'gpt-test',
            request: { url: 'https://api.openai.com/v1/chat/completions', headers: {}, body: {} },
            response: { status: 200, metrics: { durationMs: 1800, timeToFirstChunkMs: 250 } },
          },
          usage: {
            inputTokens: 1000,
            outputTokens: 500,
            cacheCreationTokens: 0,
            cacheReadTokens: 100,
          },
        },
      ],
      pricing: {
        version: 'test',
        currency: 'USD',
        models: { 'gpt-test': { inputPerMillion: 1, outputPerMillion: 2, cacheReadPerMillion: 0.1 } },
      },
    })
    expect(profile.llmCalls).toBe(1)
    expect(profile.totalInputTokens).toBe(1000)
    expect(profile.llmLatencyCalls).toBe(1)
    expect(profile.averageLlmDurationMs).toBe(1800)
    expect(profile.averageTimeToFirstChunkMs).toBe(250)
    expect(profile.costStatus).toBe('estimated')
    expect(profile.estimatedCostUsd).toBe(0.00201)
  })

  it('creates router decision and tool catalog artifacts for observability', () => {
    const decision = createRouterDecisionArtifact({
      requestedModel: 'gpt-test',
      adapterName: 'router(openai:gpt-test)',
      maxInputTokens: 128000,
      tools: [
        { name: 'skill', description: 'Load skill', requiresApproval: false, inputSchema: { type: 'object' } },
        { name: 'agent', description: 'Sub agent', requiresApproval: false, inputSchema: { type: 'object' } },
        { name: 'edit', description: 'Edit file', requiresApproval: true, inputSchema: { type: 'object' } },
      ],
    })
    expect(decision.selectedProvider).toBe('openai')
    expect(decision.selectedModel).toBe('gpt-test')
    expect(decision.budget?.maxInputTokens).toBe(128000)
    expect(decision.reasonCodes).toContain('tool_calling_enabled')
    expect(decision.reasonCodes).toContain('skill_backed_tools_visible')
    expect(decision.reasonCodes).toContain('sub_agent_tool_visible')
    expect(decision.reasonCodes).toContain('approval_required_tools_visible')
    expect(decision.toolPolicy).toMatchObject({
      toolCount: 3,
      requiresApprovalCount: 1,
      skillBackedCount: 1,
      subAgentToolAvailable: true,
      memoryToolAvailable: false,
    })

    const catalog = createToolCatalogArtifact([
      { name: 'skill', description: 'Load skill', requiresApproval: false, inputSchema: { type: 'object' } },
      { name: 'agent', description: 'Sub agent', requiresApproval: false, inputSchema: { type: 'object' } },
      { name: 'edit', description: 'Edit file', requiresApproval: true, inputSchema: { type: 'object' } },
    ])
    expect(catalog.toolCount).toBe(3)
    expect(catalog.tools[0]).toMatchObject({ name: 'skill', kind: 'skill_loader', skillBacked: true })
    expect(catalog.tools[1]).toMatchObject({ name: 'agent', kind: 'sub_agent' })
    expect(catalog.tools[2]).toMatchObject({ name: 'edit', kind: 'executor', requiresApproval: true })
  })

  it('records capability requirements when tools, images, or reasoning are needed', () => {
    const decision = createRouterDecisionArtifact({
      requestedModel: 'claude-vision',
      tools: [
        { name: 'edit', description: 'Edit file', requiresApproval: true, inputSchema: { type: 'object' } },
      ],
      hasImageInput: true,
      reasoningBudgetRequested: true,
      requiredTools: ['edit'],
      minContextTokens: 200_000,
    })
    expect(decision.capabilityRequirements).toEqual({
      toolCalling: true,
      imageInput: true,
      reasoningBudget: true,
      minContextTokens: 200_000,
      requiredTools: ['edit'],
    })
    expect(decision.reasonCodes).toContain('image_input_required')
    expect(decision.reasonCodes).toContain('reasoning_budget_required')
    expect(decision.reasonCodes).toContain('specific_tools_required')
    expect(decision.reasonCodes).toContain('context_size_required')
  })

  it('omits capabilityRequirements when nothing exotic is required', () => {
    const decision = createRouterDecisionArtifact({
      requestedModel: 'gpt-basic',
    })
    expect(decision.capabilityRequirements).toBeUndefined()
  })

  it('derives eval memory policy defaults from workspace/global flags', () => {
    const workspaceOnly = deriveEvalMemoryPolicy({ workspaceRoot: '/repo' })
    expect(workspaceOnly.mode).toBe('workspace_only')
    expect(workspaceOnly.includeGlobal).toBe(false)
    expect(workspaceOnly.reasonCodes).toContain('memory_mode:workspace_only')

    const workspaceAndGlobal = deriveEvalMemoryPolicy({ workspaceRoot: '/repo', includeGlobal: true })
    expect(workspaceAndGlobal.mode).toBe('workspace_and_global')
    expect(workspaceAndGlobal.reasonCodes).toContain('global_included')
  })

  it('flags benchmark isolation as disabled memory unless explicit', () => {
    const isolated = deriveEvalMemoryPolicy({ benchmarkIsolation: true })
    expect(isolated.mode).toBe('disabled')
    expect(isolated.reasonCodes).toContain('benchmark_isolation')
    expect(isolated.reasonCodes).toContain('memory_disabled')

    const isolatedButPinned = deriveEvalMemoryPolicy({ benchmarkIsolation: true, mode: 'snapshot_pinned', snapshotRef: 'snap.json' })
    expect(isolatedButPinned.mode).toBe('snapshot_pinned')
    expect(isolatedButPinned.reasonCodes).toContain('benchmark_isolation')
    expect(isolatedButPinned.reasonCodes).toContain('snapshot_pinned')
  })

  it('counts active and tombstoned entries from memory index', () => {
    const policy = deriveEvalMemoryPolicy({
      workspaceRoot: '/repo',
      memoryIndex: {
        generatedAt: '2026-07-09T00:00:00.000Z',
        entries: [
          { status: 'active' },
          { status: 'active' },
          { status: 'tombstoned' },
        ],
      },
    })
    expect(policy.entryCount).toBe(2)
    expect(policy.tombstoneCount).toBe(1)
    expect(policy.generatedAt).toBe('2026-07-09T00:00:00.000Z')
  })

  it('records memory policy on eval experiments for reproducibility', () => {
    const policy = deriveEvalMemoryPolicy({ workspaceRoot: '/repo' })
    const experiment = createEvalExperiment({
      dataset: 'SWE-bench_Verified',
      model: 'gpt-test',
      memoryPolicy: policy,
    })
    expect(experiment.memoryPolicy).toEqual(policy)
  })
})
