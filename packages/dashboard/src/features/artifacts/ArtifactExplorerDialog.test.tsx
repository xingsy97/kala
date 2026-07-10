import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ArtifactExplorerDialog, type ArtifactManifest } from './ArtifactExplorerDialog.js'

const manifest: ArtifactManifest = {
  schemaVersion: 1,
  generatedAt: '2026-07-09T00:00:00.000Z',
  rootDir: '/tmp/artifacts',
  entries: [
    {
      path: 'llm/s1/1.request.json',
      kind: 'llm_request',
      mediaType: 'application/json',
      bytes: 128,
      mtime: '2026-07-09T00:00:00.000Z',
      sha256: 'abcdef1234567890',
    },
    {
      path: 'large.log',
      kind: 'log',
      mediaType: 'text/plain',
      bytes: 4096,
      mtime: '2026-07-09T00:00:00.000Z',
      hashSkippedReason: 'file exceeds maxHashBytes',
    },
    {
      path: 'runs/swebench/run1/summary.json',
      kind: 'eval_summary',
      mediaType: 'application/json',
      bytes: 256,
      mtime: '2026-07-09T00:00:00.000Z',
      sha256: '123456abcdef',
    },
    {
      path: 'runs/swebench/run1/progress.json',
      kind: 'eval_progress',
      mediaType: 'application/json',
      bytes: 260,
      mtime: '2026-07-09T00:00:00.000Z',
      sha256: 'progressabcdef',
    },
    {
      path: 'runs/swebench/run1/worker-plan.json',
      kind: 'eval_worker_plan',
      mediaType: 'application/json',
      bytes: 310,
      mtime: '2026-07-09T00:00:00.000Z',
      sha256: 'workerplanabcdef',
    },
    {
      path: 'runs/swebench/run1/trials/local__repo-1.json',
      kind: 'eval_trial',
      mediaType: 'application/json',
      bytes: 512,
      mtime: '2026-07-09T00:00:00.000Z',
      sha256: 'trialabcdef',
    },
    {
      path: 'runs/eval/compare/eval-comparison.json',
      kind: 'eval_comparison',
      mediaType: 'application/json',
      bytes: 300,
      mtime: '2026-07-09T00:00:00.000Z',
      sha256: 'fedcba654321',
    },
    { path: 'runs/eval/session-score/scores.json', kind: 'eval_score', mediaType: 'application/json', bytes: 220, mtime: '2026-07-09T00:00:00.000Z', sha256: 'scoreabcdef' },
    { path: 'runs/eval/judge-score/judge/model_judge.score.judge-trace.json', kind: 'eval_judge', mediaType: 'application/json', bytes: 260, mtime: '2026-07-09T00:00:00.000Z', sha256: 'judgeabcdef' },
    {
      path: 'runs/profile/session/profile.json',
      kind: 'profile',
      mediaType: 'application/json',
      bytes: 420,
      mtime: '2026-07-09T00:00:00.000Z',
      sha256: 'profileabcdef',
    },
    {
      path: 'runs/memory/memory-index.json',
      kind: 'memory_index',
      mediaType: 'application/json',
      bytes: 520,
      mtime: '2026-07-09T00:00:00.000Z',
      sha256: 'memoryabcdef',
    },
    { path: 'runs/reliability/session/reliability-audit.json', kind: 'reliability_audit', mediaType: 'application/json', bytes: 360, mtime: '2026-07-09T00:00:00.000Z', sha256: 'relauditabcdef' },
    { path: 'runs/reliability/chaos/reliability-chaos.json', kind: 'reliability_chaos', mediaType: 'application/json', bytes: 300, mtime: '2026-07-09T00:00:00.000Z', sha256: 'relchaosabcdef' },
    { path: 'runs/rollouts/rollouts/rollout_1.json', kind: 'rl_rollout_sidecar', mediaType: 'application/json', bytes: 340, mtime: '2026-07-09T00:00:00.000Z', sha256: 'rolloutabcdef' },
    { path: 'runs/rollouts/rl-token-segments/s1.json', kind: 'rl_token_segments', mediaType: 'application/json', bytes: 480, mtime: '2026-07-09T00:00:00.000Z', sha256: 'segmentsabcdef' },
    { path: 'runs/rollouts/rl-adapters/verl/rollout_1.json', kind: 'rl_adapter', mediaType: 'application/json', bytes: 300, mtime: '2026-07-09T00:00:00.000Z', sha256: 'adapterabcdef' },
    { path: 'runs/subagents/subagent-graph.json', kind: 'subagent_graph', mediaType: 'application/json', bytes: 280, mtime: '2026-07-09T00:00:00.000Z', sha256: 'subgraphabcdef' },
    { path: 'traces/s1.openinference.json', kind: 'trace', mediaType: 'application/json', bytes: 520, mtime: '2026-07-09T00:00:00.000Z', sha256: 'traceabcdef' },
    { path: 'message-assembly/s1/1.json', kind: 'message_assembly', mediaType: 'application/json', bytes: 420, mtime: '2026-07-09T00:00:00.000Z', sha256: 'assemblyabcdef' },
    { path: 'router-decisions/s1/1.json', kind: 'router_decision', mediaType: 'application/json', bytes: 260, mtime: '2026-07-09T00:00:00.000Z', sha256: 'routerabcdef' },
    { path: 'tool-catalog/s1/1.json', kind: 'tool_catalog', mediaType: 'application/json', bytes: 260, mtime: '2026-07-09T00:00:00.000Z', sha256: 'toolcatalogabcdef' },
  ],
  summary: {
    entryCount: 21,
    totalBytes: 10802,
    hashedCount: 20,
    hashSkippedCount: 1,
    kinds: { llm_request: 1, log: 1, eval_summary: 1, eval_progress: 1, eval_worker_plan: 1, eval_trial: 1, eval_comparison: 1, eval_score: 1, eval_judge: 1, profile: 1, memory_index: 1, reliability_audit: 1, reliability_chaos: 1, rl_rollout_sidecar: 1, rl_token_segments: 1, rl_adapter: 1, subagent_graph: 1, trace: 1, message_assembly: 1, router_decision: 1, tool_catalog: 1 },
  },
}

describe('ArtifactExplorerDialog', () => {
  const fetchMock = vi.fn<typeof fetch>()

  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('loads and renders the artifact manifest summary and entries', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(manifest), { status: 200 }))

    render(<ArtifactExplorerDialog open onOpenChange={() => {}} />)

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/artifacts/manifest', { cache: 'no-store' })
    })
    await screen.findByText('llm/s1/1.request.json')
    expect(screen.getByText('large.log')).toBeTruthy()
    expect(screen.getByText('20/21')).toBeTruthy()
    expect(screen.getByText('hash skipped')).toBeTruthy()
  })

  it('loads eval summaries from artifact content when the Eval Runs tab is selected', async () => {
    const onOpenSession = vi.fn()
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify(manifest), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        path: 'runs/swebench/run1/summary.json',
        mediaType: 'application/json',
        body: {
          experimentId: 'run1',
          dataset: 'local',
          model: 'agent-test',
          trialCount: 2,
          resolved: 1,
          failed: 1,
          timedOut: 0,
          failureCounts: { empty_patch: 1, test_failed: 2 },
          metrics: { passRate: 0.5 },
        },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        path: 'runs/eval/compare/eval-comparison.json',
        mediaType: 'application/json',
        body: {
          baseline: { experimentId: 'base', resolved: 1, failed: 1, timedOut: 0 },
          candidate: { experimentId: 'candidate', resolved: 2, failed: 0, timedOut: 0 },
          deltas: { resolved: 1, failed: -1, timedOut: 0, passRate: 0.5 },
          failureDeltas: { empty_patch: -1 },
          subagentUsageDelta: {
            baseline: null,
            candidate: {
              totalCount: 3,
              trialsWithSubagents: 2,
              maxDepth: 2,
              perTrialMean: 1.5,
              resolvedWithSubagents: 2,
              unresolvedWithSubagents: 0,
            },
            totalCount: 3,
            trialsWithSubagents: 2,
            maxDepth: 2,
            perTrialMean: 1.5,
            resolvedWithSubagents: 2,
            unresolvedWithSubagents: 0,
          },
        },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        path: 'runs/swebench/run1/progress.json',
        mediaType: 'application/json',
        body: {
          schemaVersion: 1,
          runId: 'run1',
          dataset: 'local',
          model: 'agent-test',
          status: 'completed',
          selectedCount: 2,
          queuedCount: 0,
          runningCount: 0,
          skippedCount: 1,
          completedCount: 1,
          failedCount: 0,
          timedOutCount: 0,
          maxWorkers: 4,
          instances: [{ instanceId: 'local__repo-1', status: 'completed' }],
        },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        path: 'runs/swebench/run1/worker-plan.json',
        mediaType: 'application/json',
        body: {
          runId: 'run1',
          dataset: 'local',
          model: 'agent-test',
          selectedCount: 2,
          maxWorkers: 4,
          shards: [
            { workerId: 1, instanceCount: 1, instanceIds: ['local__repo-1'] },
            { workerId: 2, instanceCount: 1, instanceIds: ['local__repo-2'] },
          ],
          resourceHints: { dockerRequired: true, workspaceIsolation: 'per-instance-git-clone', maxConcurrentWorkspaces: 2, timeoutMs: 600000 },
          warnings: ['maxWorkers exceeds selected instance count'],
        },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        path: 'runs/eval/session-score/scores.json',
        mediaType: 'application/json',
        body: { instanceId: 'local__repo-1', resolved: true, failureLabel: 'resolved', score: 1, results: [{ scorer: 'patch.non_empty', passed: true, score: 1 }] },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        path: 'runs/eval/judge-score/judge/model_judge.score.judge-trace.json',
        mediaType: 'application/json',
        body: { scorer: 'model_judge.score', judgeModel: 'judge-test', inputRef: 'local__repo-1', parsed: { score: 0.8, passed: true, explanation: 'Looks correct' } },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        path: 'runs/swebench/run1/trials/local__repo-1.json',
        mediaType: 'application/json',
        body: {
          trialId: 'run1:local__repo-1',
          experimentId: 'run1',
          instanceId: 'local__repo-1',
          sessionId: 'session-linked-1',
          status: 'completed',
          resolved: true,
          artifacts: [
            { kind: 'diff', uri: 'artifacts/local__repo-1/final.diff', bytes: 42, mediaType: 'text/x-diff' },
            { kind: 'trace', uri: 'traces/local__repo-1.openinference.json', bytes: 1024, mediaType: 'application/json' },
            { kind: 'metadata', uri: 'artifacts/local__repo-1/swebench-result.json', bytes: 256, mediaType: 'application/json' },
            { kind: 'log', uri: 'artifacts/local__repo-1/harness/test.log', bytes: 2048, mediaType: 'text/plain' },
            { kind: 'log', uri: 'artifacts/local__repo-1/agent.stdout.log', bytes: 128, mediaType: 'text/plain' },
            { kind: 'metadata', uri: 'artifacts/local__repo-1/prompt.txt', bytes: 64, mediaType: 'text/plain' },
            { kind: 'metadata', uri: 'artifacts/local__repo-1/workspace-metadata.json', bytes: 96, mediaType: 'application/json' },
          ],
          metrics: { durationMs: 1250, patchBytes: 42 },
        },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        path: 'runs/swebench/run1/artifacts/local__repo-1/final.diff',
        mediaType: 'text/x-diff',
        body: 'diff --git a/file b/file\n',
      }), { status: 200 }))

    render(<ArtifactExplorerDialog open onOpenChange={() => {}} onOpenSession={onOpenSession} />)
    await screen.findByText('llm/s1/1.request.json')

    fireEvent.click(screen.getByRole('button', { name: /^eval$/i }))

    await waitFor(() => expect(screen.getAllByText('run1').length).toBeGreaterThanOrEqual(1))
    expect(screen.getByText('Runs')).toBeTruthy()
    expect(screen.getByText('Selected pass')).toBeTruthy()
    expect(screen.getByText('local')).toBeTruthy()
    expect(screen.getByText('agent-test')).toBeTruthy()
    expect(screen.getAllByText('50%').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('Progress')).toBeTruthy()
    expect(screen.getByText('Failure Breakdown')).toBeTruthy()
    expect(screen.getByText('empty_patch')).toBeTruthy()
    expect(screen.getByText('test_failed')).toBeTruthy()
    expect(screen.getByText('3 labeled')).toBeTruthy()
    expect(screen.getAllByText('completed').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('Workers')).toBeTruthy()
    expect(await screen.findByText('base')).toBeTruthy()
    expect(screen.getByText('candidate')).toBeTruthy()
    expect(screen.getAllByText('+50%').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByLabelText('comparison delta chart')).toBeTruthy()
    expect(screen.getByText('empty_patch -1')).toBeTruthy()
    const usageDelta = screen.getByTestId('eval-subagent-usage-delta')
    expect(usageDelta.textContent).toContain('Sub-agent Usage  - ')
    expect(usageDelta.textContent).toContain('0  -  3')
    expect(usageDelta.textContent).toContain('+3')
    expect(usageDelta.textContent).toContain('spawned  - ')
    expect(usageDelta.textContent).toContain('trials w/ sub  - ')
    expect(usageDelta.textContent).toContain('resolved w/ sub  - ')
    expect(screen.getByText('Worker Plans')).toBeTruthy()
    expect(screen.getByText('2 tasks')).toBeTruthy()
    expect(screen.getByText('4 workers / 2 shards')).toBeTruthy()
    expect(screen.getByText('per-instance-git-clone / max 2')).toBeTruthy()
    expect(screen.getByText('maxWorkers exceeds selected instance count')).toBeTruthy()
    expect(screen.getByText('Score Artifacts')).toBeTruthy()
    expect(screen.getByText('model_judge.score')).toBeTruthy()
    expect(screen.getByText('judge-test')).toBeTruthy()
    expect(screen.getByText('80%')).toBeTruthy()
    await waitFor(() => expect(screen.getAllByText('local__repo-1').length).toBeGreaterThanOrEqual(1))
    expect(screen.getAllByText('resolved').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('Linked Session')).toBeTruthy()
    fireEvent.click(screen.getByText('session-linked-1'))
    expect(onOpenSession).toHaveBeenCalledWith('session-linked-1')
    expect(screen.getAllByText('Final Patch').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('Trace').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('Harness Evidence').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('Agent Logs')).toBeTruthy()
    expect(screen.getByText('Prompt')).toBeTruthy()
    expect(screen.getByText('Metadata')).toBeTruthy()
    expect(screen.getAllByText('artifacts/local__repo-1/final.diff').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('traces/local__repo-1.openinference.json').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('artifacts/local__repo-1/swebench-result.json').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('artifacts/local__repo-1/harness/test.log').length).toBeGreaterThanOrEqual(1)
    expect(fetchMock).toHaveBeenCalledWith(
      '/artifacts/content?path=runs%2Fswebench%2Frun1%2Fsummary.json',
      { cache: 'no-store' },
    )
    expect(fetchMock).toHaveBeenCalledWith(
      '/artifacts/content?path=runs%2Feval%2Fcompare%2Feval-comparison.json',
      { cache: 'no-store' },
    )
    expect(fetchMock).toHaveBeenCalledWith(
      '/artifacts/content?path=runs%2Fswebench%2Frun1%2Fprogress.json',
      { cache: 'no-store' },
    )
    expect(fetchMock).toHaveBeenCalledWith(
      '/artifacts/content?path=runs%2Fswebench%2Frun1%2Fworker-plan.json',
      { cache: 'no-store' },
    )
    expect(fetchMock).toHaveBeenCalledWith(
      '/artifacts/content?path=runs%2Fswebench%2Frun1%2Ftrials%2Flocal__repo-1.json',
      { cache: 'no-store' },
    )

    fireEvent.click(screen.getAllByText('artifacts/local__repo-1/final.diff')[0]!)

    await screen.findByText('diff --git a/file b/file')
    expect(fetchMock).toHaveBeenCalledWith(
      '/artifacts/content?path=runs%2Fswebench%2Frun1%2Fartifacts%2Flocal__repo-1%2Ffinal.diff',
      { cache: 'no-store' },
    )
  })

  it('can open directly in eval mode', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify(manifest), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        path: 'runs/swebench/run1/summary.json',
        mediaType: 'application/json',
        body: { experimentId: 'run1', dataset: 'local', model: 'agent-test', trialCount: 1, resolved: 1, failed: 0, metrics: { passRate: 1 } },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        path: 'runs/eval/compare/eval-comparison.json',
        mediaType: 'application/json',
        body: {},
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        path: 'runs/swebench/run1/progress.json',
        mediaType: 'application/json',
        body: { runId: 'run1', dataset: 'local', model: 'agent-test', status: 'completed', selectedCount: 1 },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        path: 'runs/swebench/run1/worker-plan.json',
        mediaType: 'application/json',
        body: { runId: 'run1', dataset: 'local', model: 'agent-test', selectedCount: 1, maxWorkers: 1, shards: [{ workerId: 1, instanceCount: 1, instanceIds: ['local__repo-1'] }], resourceHints: { dockerRequired: true, workspaceIsolation: 'per-instance-git-clone', maxConcurrentWorkspaces: 1 } },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        path: 'runs/eval/session-score/scores.json',
        mediaType: 'application/json',
        body: { instanceId: 'local__repo-1', resolved: true, failureLabel: 'resolved', score: 1, results: [] },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        path: 'runs/eval/judge-score/judge/model_judge.score.judge-trace.json',
        mediaType: 'application/json',
        body: { scorer: 'model_judge.score', judgeModel: 'judge-test', parsed: { score: 1, passed: true } },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        path: 'runs/swebench/run1/trials/local__repo-1.json',
        mediaType: 'application/json',
        body: { trialId: 'run1:local__repo-1', instanceId: 'local__repo-1', status: 'completed', resolved: true, artifacts: [] },
      }), { status: 200 }))

    render(<ArtifactExplorerDialog open initialMode="eval" onOpenChange={() => {}} />)

    await screen.findByRole('heading', { name: 'Eval' })
    await waitFor(() => expect(screen.getAllByText('run1').length).toBeGreaterThanOrEqual(1))
    expect(screen.queryByText('llm/s1/1.request.json')).toBeNull()
  })

  it('creates SWE-bench worker plans from the Eval dashboard', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify(manifest), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        path: 'runs/swebench/run1/summary.json',
        mediaType: 'application/json',
        body: { experimentId: 'run1', dataset: 'local', model: 'agent-test', trialCount: 1, resolved: 1, failed: 0, metrics: { passRate: 1 } },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ path: 'runs/eval/compare/eval-comparison.json', mediaType: 'application/json', body: {} }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ path: 'runs/swebench/run1/progress.json', mediaType: 'application/json', body: { runId: 'run1', dataset: 'local', model: 'agent-test', status: 'completed', selectedCount: 1 } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ path: 'runs/swebench/run1/worker-plan.json', mediaType: 'application/json', body: { runId: 'run1', dataset: 'local', model: 'agent-test', selectedCount: 1, maxWorkers: 1, shards: [{ workerId: 1, instanceCount: 1, instanceIds: ['local__repo-1'] }], resourceHints: { dockerRequired: true, workspaceIsolation: 'per-instance-git-clone', maxConcurrentWorkspaces: 1 } } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ path: 'runs/eval/session-score/scores.json', mediaType: 'application/json', body: { instanceId: 'local__repo-1', resolved: true, failureLabel: 'resolved', score: 1, results: [] } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ path: 'runs/eval/judge-score/judge/model_judge.score.judge-trace.json', mediaType: 'application/json', body: { scorer: 'model_judge.score', judgeModel: 'judge-test', parsed: { score: 1, passed: true } } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ path: 'runs/swebench/run1/trials/local__repo-1.json', mediaType: 'application/json', body: { trialId: 'run1:local__repo-1', instanceId: 'local__repo-1', status: 'completed', resolved: true, artifacts: [] } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ instancesJsonlPath: '/tmp/instances.jsonl', rowCount: 2, bytes: 72, source: { kind: 'inline' } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ planPath: '/tmp/artifacts/dash-plan/worker-plan.json', runId: 'dash-plan', selectedCount: 2, maxWorkers: 2, shardCount: 2, warnings: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(manifest), { status: 200 }))

    render(<ArtifactExplorerDialog open initialMode="eval" onOpenChange={() => {}} />)

    await screen.findByRole('heading', { name: 'Eval' })
    fireEvent.click(await screen.findByTestId('run-benchmark-wizard-toggle'))
    fireEvent.change(screen.getByTestId('run-benchmark-wizard-run-id'), { target: { value: 'dash-plan' } })
    fireEvent.change(screen.getByTestId('run-benchmark-wizard-model'), { target: { value: 'agent-test' } })
    fireEvent.change(screen.getByTestId('run-benchmark-wizard-max-workers'), { target: { value: '2' } })
    fireEvent.click(screen.getByTestId('instances-source-tab-paste'))
    fireEvent.change(screen.getByTestId('instances-paste-textarea'), { target: { value: '{"instance_id":"repo__one-1"}\n{"instance_id":"repo__two-2"}\n' } })

    fireEvent.click(screen.getByTestId('instances-resolve-button'))
    await screen.findByTestId('instances-resolve-summary')

    fireEvent.click(screen.getByRole('button', { name: 'Create Plan' }))

    expect(fetchMock).toHaveBeenCalledWith('/eval/swebench/plan', expect.objectContaining({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    }))
    await waitFor(() => {
      expect(screen.getByTestId('run-benchmark-wizard-step-plan').getAttribute('data-status')).toBe('done')
    })
    const planCall = fetchMock.mock.calls.find((call) => call[0] === '/eval/swebench/plan')
    const body = JSON.parse(String((planCall?.[1] as RequestInit | undefined)?.body)) as Record<string, unknown>
    expect(body).toMatchObject({ runId: 'dash-plan', model: 'agent-test', instancesJsonl: '/tmp/instances.jsonl', maxWorkers: 2 })
    expect(fetchMock.mock.calls.filter((call) => call[0] === '/artifacts/manifest').length).toBe(2)
  })

  it('shows progress-only eval runs before summaries are written', async () => {
    const progressOnlyManifest: ArtifactManifest = {
      ...manifest,
      entries: manifest.entries.filter((entry) => entry.path !== 'runs/swebench/run1/summary.json' && entry.path !== 'runs/swebench/run1/trials/local__repo-1.json'),
    }
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify(progressOnlyManifest), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        path: 'runs/eval/compare/eval-comparison.json',
        mediaType: 'application/json',
        body: {},
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        path: 'runs/swebench/run1/progress.json',
        mediaType: 'application/json',
        body: {
          runId: 'run1',
          dataset: 'local',
          model: 'agent-test',
          status: 'running',
          selectedCount: 3,
          queuedCount: 1,
          runningCount: 1,
          skippedCount: 0,
          completedCount: 1,
          failedCount: 0,
          timedOutCount: 0,
          maxWorkers: 2,
        },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        path: 'runs/swebench/run1/worker-plan.json',
        mediaType: 'application/json',
        body: { runId: 'run1', dataset: 'local', model: 'agent-test', selectedCount: 3, maxWorkers: 2, shards: [{ workerId: 1, instanceCount: 2, instanceIds: ['a', 'c'] }, { workerId: 2, instanceCount: 1, instanceIds: ['b'] }], resourceHints: { dockerRequired: true, workspaceIsolation: 'per-instance-git-clone', maxConcurrentWorkspaces: 2 } },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        path: 'runs/eval/session-score/scores.json',
        mediaType: 'application/json',
        body: { instanceId: 'local__repo-1', resolved: true, failureLabel: 'resolved', score: 1, results: [] },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        path: 'runs/eval/judge-score/judge/model_judge.score.judge-trace.json',
        mediaType: 'application/json',
        body: { scorer: 'model_judge.score', judgeModel: 'judge-test', parsed: { score: 1, passed: true } },
      }), { status: 200 }))

    render(<ArtifactExplorerDialog open onOpenChange={() => {}} />)
    await screen.findByText('llm/s1/1.request.json')

    fireEvent.click(screen.getByRole('button', { name: /^eval$/i }))

    await waitFor(() => expect(screen.getAllByText('run1').length).toBeGreaterThanOrEqual(1))
    expect(screen.getByText('running')).toBeTruthy()
    expect(screen.getByText('Workers')).toBeTruthy()
    expect(screen.getByText('No trial artifacts found for this run.')).toBeTruthy()
  })

  it('loads session profile artifacts in the Profiles tab', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify(manifest), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        path: 'runs/profile/session/profile.json',
        mediaType: 'application/json',
        body: {
          sessionId: 's1',
          llmCalls: 2,
          toolCalls: 3,
          llmTraceMissingCalls: 1,
          totalInputTokens: 1234,
          totalOutputTokens: 567,
          models: ['gpt-test'],
          llmLatencyCalls: 2,
          averageLlmDurationMs: 2400,
          p95LlmDurationMs: 3100,
          averageTimeToFirstChunkMs: 320,
          p95TimeToFirstChunkMs: 480,
        },
      }), { status: 200 }))

    render(<ArtifactExplorerDialog open onOpenChange={() => {}} />)
    await screen.findByText('llm/s1/1.request.json')

    fireEvent.click(screen.getByRole('button', { name: /profiles/i }))

    await screen.findByText('s1')
    expect(screen.getAllByText('2').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('1,234').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('567').length).toBeGreaterThanOrEqual(1)
    expect(document.body.textContent ?? '').not.toContain('$0.0123')
    expect(document.body.textContent ?? '').toContain('gpt-test')
    expect(screen.getByText('Latency calls')).toBeTruthy()
    expect(screen.getByText('Avg TTFT')).toBeTruthy()
    expect(screen.getByText('320ms')).toBeTruthy()
    expect(screen.getByText('480ms')).toBeTruthy()
    expect(fetchMock).toHaveBeenCalledWith(
      '/artifacts/content?path=runs%2Fprofile%2Fsession%2Fprofile.json',
      { cache: 'no-store' },
    )
  })

  it('runs lightweight enhancement artifact actions from dashboard tabs', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify(manifest), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        path: 'runs/profile/session/profile.json',
        mediaType: 'application/json',
        body: { sessionId: 's1', llmCalls: 1, toolCalls: 0, costStatus: 'unknown' },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ action: 'profile-session', profilePath: '/tmp/artifacts/profile.json', profile: { sessionId: 's2' } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(manifest), { status: 200 }))

    render(<ArtifactExplorerDialog open onOpenChange={() => {}} />)
    await screen.findByText('llm/s1/1.request.json')

    fireEvent.click(screen.getByRole('button', { name: /profiles/i }))
    await screen.findByText('s1')
    fireEvent.click(screen.getByText('Profile Artifact Actions'))
    fireEvent.change(screen.getByLabelText('Session ID'), { target: { value: 's2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Run Action' }))

    await screen.findByTestId('enhancement-action-profile-artifact-actions-result')
    expect(fetchMock).toHaveBeenCalledWith('/enhancement/action', expect.objectContaining({ method: 'POST' }))
    const actionCall = fetchMock.mock.calls.find((call) => call[0] === '/enhancement/action')
    const body = JSON.parse(String((actionCall?.[1] as RequestInit | undefined)?.body)) as Record<string, unknown>
    expect(body).toEqual({ action: 'profile-session', sessionId: 's2' })
    expect(fetchMock.mock.calls.filter((call) => call[0] === '/artifacts/manifest').length).toBe(2)
  })

  it('builds SWE-bench predictions from uploaded patches through the guided wizard', async () => {
    const emptyManifest: ArtifactManifest = {
      schemaVersion: 1,
      generatedAt: '2026-07-09T00:00:00.000Z',
      rootDir: '/tmp/artifacts',
      entries: [],
      summary: { entryCount: 0, totalBytes: 0, hashedCount: 0, hashSkippedCount: 0, kinds: {} },
    }
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify(emptyManifest), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ instancesJsonlPath: '/tmp/artifacts/dash-infer/instances.jsonl', rowCount: 2, bytes: 86, source: { kind: 'inline' } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ action: 'swebench-upload-patches', patchesDir: '/tmp/artifacts/dash-infer/patches', instanceCount: 2 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ action: 'swebench-infer-patches', predictionsPath: '/tmp/artifacts/dash-infer/predictions.jsonl', trialCount: 2, gradingStatus: 'not_graded' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(emptyManifest), { status: 200 }))

    render(<ArtifactExplorerDialog open initialMode="eval" onOpenChange={() => {}} />)
    await screen.findByText('No eval summaries found.')

    fireEvent.click(await screen.findByTestId('run-benchmark-wizard-toggle'))
    expect(screen.getByTestId('run-benchmark-wizard-harness-boundary').textContent).toContain('Agent completion does not imply resolved')
    fireEvent.change(screen.getByTestId('run-benchmark-wizard-run-id'), { target: { value: 'dash-infer' } })
    fireEvent.change(screen.getByTestId('run-benchmark-wizard-model'), { target: { value: 'agent-test' } })
    fireEvent.change(screen.getByTestId('run-benchmark-wizard-dataset'), { target: { value: 'SWE-bench/local' } })
    fireEvent.click(screen.getByTestId('instances-source-tab-paste'))
    fireEvent.change(screen.getByTestId('instances-paste-textarea'), { target: { value: '{"instance_id":"a__b-1"}\n{"instance_id":"c__d-2"}\n' } })
    fireEvent.click(screen.getByTestId('instances-resolve-button'))
    await screen.findByTestId('instances-resolve-summary')

    fireEvent.click(screen.getByTestId('run-benchmark-wizard-step-infer'))
    fireEvent.click(screen.getByText('I already ran the agent externally'))
    fireEvent.change(screen.getByTestId('patches-paste-textarea'), { target: { value: '{"a__b-1":"diff --git a/a b/a\\n+one\\n","c__d-2":"diff --git a/c b/c\\n+two\\n"}' } })
    fireEvent.click(screen.getByTestId('patches-resolve-button'))
    await screen.findByTestId('patches-resolve-summary')
    fireEvent.click(screen.getByTestId('run-benchmark-wizard-infer-upload-submit'))

    await waitFor(() => {
      expect(screen.getByTestId('run-benchmark-wizard-step-infer').getAttribute('data-status')).toBe('done')
    })
    const inferCall = fetchMock.mock.calls.find((call) => {
      if (call[0] !== '/enhancement/action') return false
      const body = JSON.parse(String((call[1] as RequestInit | undefined)?.body)) as Record<string, unknown>
      return body.action === 'swebench-infer-patches'
    })
    const body = JSON.parse(String((inferCall?.[1] as RequestInit | undefined)?.body)) as Record<string, unknown>
    expect(body).toMatchObject({
      action: 'swebench-infer-patches',
      runId: 'dash-infer',
      dataset: 'SWE-bench/local',
      model: 'agent-test',
      instancesJsonl: '/tmp/artifacts/dash-infer/instances.jsonl',
      patchesDir: '/tmp/artifacts/dash-infer/patches',
    })
    expect(body).not.toHaveProperty('resolved')
  })

  it('posts pasted upload content as *Content payload without a *Path field', async () => {
    const emptyManifest: ArtifactManifest = {
      schemaVersion: 1,
      generatedAt: '2026-07-09T00:00:00.000Z',
      rootDir: '/tmp/artifacts',
      entries: [],
      summary: { entryCount: 0, totalBytes: 0, hashedCount: 0, hashSkippedCount: 0, kinds: {} },
    }
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify(emptyManifest), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ action: 'eval-judge-score', scoresPath: '/tmp/artifacts/eval/judge/score.json' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(emptyManifest), { status: 200 }))

    render(<ArtifactExplorerDialog open initialMode="eval" onOpenChange={() => {}} />)
    await screen.findByText('No eval summaries found.')

    fireEvent.click(screen.getByText('Eval Artifact Actions'))
    fireEvent.change(screen.getByLabelText('Action'), { target: { value: 'eval-judge-score' } })
    fireEvent.change(screen.getByLabelText('Judge Model'), { target: { value: 'gpt-judge' } })

    const promptTextarea = document.querySelector('[data-testid="enhancement-action-eval-artifact-actions-upload-promptPath-textarea"]') as HTMLTextAreaElement | null
    expect(promptTextarea).not.toBeNull()
    if (promptTextarea) fireEvent.change(promptTextarea, { target: { value: 'grade this response' } })

    const responseTextarea = document.querySelector('[data-testid="enhancement-action-eval-artifact-actions-upload-responsePath-textarea"]') as HTMLTextAreaElement | null
    expect(responseTextarea).not.toBeNull()
    if (responseTextarea) fireEvent.change(responseTextarea, { target: { value: 'Score: 0.9' } })

    fireEvent.click(screen.getByRole('button', { name: 'Run Action' }))
    await screen.findByTestId('enhancement-action-eval-artifact-actions-result')

    const actionCall = fetchMock.mock.calls.find((call) => call[0] === '/enhancement/action')
    const body = JSON.parse(String((actionCall?.[1] as RequestInit | undefined)?.body)) as Record<string, unknown>
    expect(body).toMatchObject({
      action: 'eval-judge-score',
      judgeModel: 'gpt-judge',
      promptContent: 'grade this response',
      responseContent: 'Score: 0.9',
    })
    expect(body.promptPath).toBeUndefined()
    expect(body.responsePath).toBeUndefined()
    expect(body.rootDir).toBeUndefined()
  })

  it('loads memory index artifacts in the Memory tab', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify(manifest), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        path: 'runs/memory/memory-index.json',
        mediaType: 'application/json',
        body: {
          generatedAt: '2026-07-09T00:00:00.000Z',
          entries: [
            {
              scope: 'workspace',
              key: 'user-style',
              path: '/repo/.agent-kernel/memory/user-style.md',
              bytes: 120,
              status: 'active',
              description: 'User prefers concise answers',
              type: 'user',
              source: 'consolidator',
              confidence: 0.9,
              sessionId: 's1',
            },
            {
              scope: 'workspace',
              key: 'old-rule',
              path: '/repo/.agent-kernel/memory/.tombstones/old-rule.json',
              bytes: 80,
              status: 'tombstoned',
              deletedAt: '2026-07-09T00:00:00.000Z',
              archivedPath: '/repo/.agent-kernel/memory/.tombstones/old-rule.md',
            },
          ],
          warnings: ['ignored malformed tombstone'],
        },
      }), { status: 200 }))

    render(<ArtifactExplorerDialog open onOpenChange={() => {}} />)
    await screen.findByText('llm/s1/1.request.json')

    fireEvent.click(screen.getByRole('button', { name: /memory/i }))

    await screen.findByText('user-style')
    expect(screen.getByText('old-rule')).toBeTruthy()
    expect(screen.getByText('Tombstoned')).toBeTruthy()
    expect(screen.getByText('90%')).toBeTruthy()
    expect(screen.getByText('User prefers concise answers')).toBeTruthy()
    expect(screen.getByText('2026-07-09T00:00:00.000Z')).toBeTruthy()
    expect(fetchMock).toHaveBeenCalledWith(
      '/artifacts/content?path=runs%2Fmemory%2Fmemory-index.json',
      { cache: 'no-store' },
    )
  })

  it('loads ops artifacts for reliability, rollout, trace, router, and subagent views', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify(manifest), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        path: 'runs/reliability/session/reliability-audit.json',
        mediaType: 'application/json',
        body: {
          sessionId: 's1',
          status: 'done',
          dangling: false,
          recoveryEventDetails: [{ seq: 3, kind: 'tool_result_recovered', callId: 'c1' }],
          integrity: { duplicateToolCallIds: ['dup'], duplicateToolResultIds: [], toolResultsWithoutCall: ['late'], toolCallsWithoutResult: [] },
        },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        path: 'runs/reliability/chaos/reliability-chaos.json',
        mediaType: 'application/json',
        body: { sessionCount: 2, danglingCount: 1, recoveryEventCount: 1 },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        path: 'runs/rollouts/rollouts/rollout_1.json',
        mediaType: 'application/json',
        body: { rollout_id: 'rollout_1', task_id: 'swebench:local__repo-1', framework_target: 'verl' },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        path: 'runs/rollouts/rl-token-segments/s1.json',
        mediaType: 'application/json',
        body: { sessionId: 's1', tokenIdsCaptured: false, segments: [{ segmentId: 'seg_1' }], topology: { compactionCount: 1, subAgentCallCount: 2 } },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        path: 'runs/rollouts/rl-adapters/verl/rollout_1.json',
        mediaType: 'application/json',
        body: { frameworkTarget: 'verl', status: 'blocked', reason: 'requires token ids' },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        path: 'runs/subagents/subagent-graph.json',
        mediaType: 'application/json',
        body: { nodes: [{ sessionId: 'parent' }, { sessionId: 'child' }], edges: [{ parentSessionId: 'parent', childSessionId: 'child' }], warnings: [] },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        path: 'traces/s1.openinference.json',
        mediaType: 'application/json',
        body: { spans: [{ name: 'llm' }] },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        path: 'message-assembly/s1/1.json',
        mediaType: 'application/json',
        body: { sessionId: 's1', messageCount: 2, toolCount: 13, estimatedTokens: 900 },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        path: 'router-decisions/s1/1.json',
        mediaType: 'application/json',
        body: { selectedProvider: 'openai', selectedModel: 'gpt-test', reasonCodes: ['tool_calling_enabled'], toolPolicy: { toolCount: 13, skillBackedCount: 1 } },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        path: 'tool-catalog/s1/1.json',
        mediaType: 'application/json',
        body: { toolCount: 13, tools: [{ name: 'skill', skillBacked: true }, { name: 'read', skillBacked: false }] },
      }), { status: 200 }))

    render(<ArtifactExplorerDialog open initialMode="ops" onOpenChange={() => {}} />)

    await screen.findByRole('heading', { name: 'Ops' })
    await screen.findByText('Reliability')
    expect(screen.getByText('Agentic RL')).toBeTruthy()
    expect(screen.getByText('Subagents')).toBeTruthy()
    expect(screen.getByText('Trace and Context')).toBeTruthy()
    expect(screen.getByText('Router and Tools')).toBeTruthy()
    expect(screen.getByText('Reliability issues')).toBeTruthy()
    expect(screen.getByText('rollout_1')).toBeTruthy()
    expect(screen.getByText('blocked')).toBeTruthy()
    expect(screen.getByText('2 nodes / 1 edges')).toBeTruthy()
    expect(screen.getByText('900 est tokens')).toBeTruthy()
    expect(screen.getByText('13 tools / 1 skill-backed')).toBeTruthy()
    expect(fetchMock).toHaveBeenCalledWith(
      '/artifacts/content?path=runs%2Freliability%2Fsession%2Freliability-audit.json',
      { cache: 'no-store' },
    )
  })

  it('surfaces endpoint errors', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'artifact capture is not configured' }), { status: 404 }))

    render(<ArtifactExplorerDialog open onOpenChange={() => {}} />)

    await screen.findByText(/artifact capture is not configured/i)
  })

  it('advances the Run Benchmark wizard from plan to predictions after /eval/swebench/plan succeeds', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ...manifest, entries: [] }), { status: 200 }))

    render(<ArtifactExplorerDialog open initialMode="eval" onOpenChange={() => {}} />)

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/artifacts/manifest', { cache: 'no-store' })
    })
    fireEvent.click(await screen.findByTestId('run-benchmark-wizard-toggle'))
    fireEvent.change(screen.getByTestId('run-benchmark-wizard-run-id'), { target: { value: 'run-1' } })
    fireEvent.change(screen.getByTestId('run-benchmark-wizard-model'), { target: { value: 'gpt-test' } })
    fireEvent.click(screen.getByTestId('instances-source-tab-paste'))
    fireEvent.change(screen.getByTestId('instances-paste-textarea'), { target: { value: '{"instance_id":"repo-1"}\n{"instance_id":"repo-2"}\n' } })

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      instancesJsonlPath: '/tmp/instances.jsonl',
      rowCount: 2,
      bytes: 64,
      source: { kind: 'inline' },
    }), { status: 200 }))

    fireEvent.click(screen.getByTestId('instances-resolve-button'))
    await screen.findByTestId('instances-resolve-summary')

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      planPath: '/tmp/plan.json',
      runId: 'run-1',
      selectedCount: 2,
      shardCount: 1,
    }), { status: 200 }))
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(manifest), { status: 200 }))

    fireEvent.click(screen.getByTestId('run-benchmark-wizard-plan-submit'))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/eval/swebench/plan', expect.objectContaining({ method: 'POST' }))
    })
    await screen.findByTestId('run-benchmark-wizard-infer')
    const planStep = screen.getByTestId('run-benchmark-wizard-step-plan')
    expect(planStep.getAttribute('data-status')).toBe('done')
    const inferStep = screen.getByTestId('run-benchmark-wizard-step-infer')
    expect(inferStep.getAttribute('data-status')).toBe('active')
  })

  it('surfaces the SWE-bench grade command in the wizard handoff panel', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ...manifest, entries: [] }), { status: 200 }))

    render(<ArtifactExplorerDialog open initialMode="eval" onOpenChange={() => {}} />)

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/artifacts/manifest', { cache: 'no-store' })
    })
    fireEvent.click(await screen.findByTestId('run-benchmark-wizard-toggle'))
    fireEvent.change(screen.getByTestId('run-benchmark-wizard-run-id'), { target: { value: 'run-1' } })
    fireEvent.click(screen.getByTestId('run-benchmark-wizard-step-grade'))

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      action: 'swebench-grade-command',
      gradingAuthority: 'official-swebench-harness',
      gradingMode: 'dry-run',
      requiresDocker: true,
      shellCommand: 'python -m swebench.harness.run_evaluation --predictions_path artifacts/eval/run-1/predictions.jsonl --dataset_name princeton-nlp/SWE-bench_Lite --run_id run-1',
      resultsDir: 'evaluation_results/run-1',
    }), { status: 200 }))
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(manifest), { status: 200 }))

    fireEvent.click(screen.getByTestId('run-benchmark-wizard-grade-submit'))

    const commandPanel = await screen.findByTestId('run-benchmark-wizard-grade-command')
    expect(commandPanel.textContent).toContain('python -m swebench.harness.run_evaluation')
    expect(commandPanel.textContent).toContain('Official harness command')
    expect(commandPanel.textContent).toContain('evaluation_results/<run_id>')
    expect(screen.getByTestId('run-benchmark-wizard-harness-boundary').textContent).toContain('SWE-bench official Docker scoring harness')
    const gradeStep = screen.getByTestId('run-benchmark-wizard-step-grade')
    expect(gradeStep.getAttribute('data-status')).toBe('done')
  })

  it('uploads patches inline from the wizard Infer step', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ...manifest, entries: [] }), { status: 200 }))
    render(<ArtifactExplorerDialog open initialMode="eval" onOpenChange={() => {}} />)
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/artifacts/manifest', { cache: 'no-store' })
    })
    fireEvent.click(await screen.findByTestId('run-benchmark-wizard-toggle'))
    fireEvent.change(screen.getByTestId('run-benchmark-wizard-run-id'), { target: { value: 'run-1' } })
    fireEvent.click(screen.getByTestId('run-benchmark-wizard-step-infer'))

    fireEvent.change(screen.getByTestId('patches-paste-textarea'), {
      target: { value: '{"astropy__astropy-12907":"diff --git a/x b/x\\n+one\\n"}' },
    })

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      patchesDir: '/tmp/artifacts/run-1/patches',
      instanceCount: 1,
      bytes: 42,
    }), { status: 200 }))

    fireEvent.click(screen.getByTestId('patches-resolve-button'))
    await screen.findByTestId('patches-resolve-summary')

    const uploadCall = fetchMock.mock.calls.find((call) => {
      if (call[0] !== '/enhancement/action') return false
      const body = JSON.parse(String((call[1] as RequestInit | undefined)?.body ?? '{}')) as { action?: string }
      return body.action === 'swebench-upload-patches'
    })
    expect(uploadCall).toBeTruthy()
    const uploadBody = JSON.parse(String((uploadCall?.[1] as RequestInit | undefined)?.body)) as Record<string, unknown>
    expect(uploadBody).toMatchObject({
      action: 'swebench-upload-patches',
      runId: 'run-1',
      patches: { 'astropy__astropy-12907': 'diff --git a/x b/x\n+one\n' },
    })
    const summary = screen.getByTestId('patches-resolve-summary')
    expect(summary.textContent).toContain('1')
  })

  it('uploads grade results inline from the wizard Ingest step', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ...manifest, entries: [] }), { status: 200 }))
    render(<ArtifactExplorerDialog open initialMode="eval" onOpenChange={() => {}} />)
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/artifacts/manifest', { cache: 'no-store' })
    })
    fireEvent.click(await screen.findByTestId('run-benchmark-wizard-toggle'))
    fireEvent.change(screen.getByTestId('run-benchmark-wizard-run-id'), { target: { value: 'run-1' } })
    fireEvent.click(screen.getByTestId('run-benchmark-wizard-step-ingest'))

    fireEvent.change(screen.getByTestId('results-paste-textarea'), {
      target: { value: '{"instance_results.jsonl":"{\\"instance_id\\":\\"a\\",\\"resolved\\":true}\\n","summary.json":"{\\"total\\":1}"}' },
    })

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      resultsDir: '/tmp/artifacts/run-1/grade-results',
      fileCount: 2,
      bytes: 84,
    }), { status: 200 }))

    fireEvent.click(screen.getByTestId('results-resolve-button'))
    await screen.findByTestId('results-resolve-summary')

    const uploadCall = fetchMock.mock.calls.find((call) => {
      if (call[0] !== '/enhancement/action') return false
      const body = JSON.parse(String((call[1] as RequestInit | undefined)?.body ?? '{}')) as { action?: string }
      return body.action === 'swebench-upload-results'
    })
    expect(uploadCall).toBeTruthy()
    const uploadBody = JSON.parse(String((uploadCall?.[1] as RequestInit | undefined)?.body)) as Record<string, unknown>
    expect(uploadBody).toMatchObject({
      action: 'swebench-upload-results',
      runId: 'run-1',
      resultsFiles: {
        'instance_results.jsonl': '{"instance_id":"a","resolved":true}\n',
        'summary.json': '{"total":1}',
      },
    })
    const summary = screen.getByTestId('results-resolve-summary')
    expect(summary.textContent).toContain('2')
  })

  it('advances to the review step after planning without leaking server paths', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ...manifest, entries: [] }), { status: 200 }))

    render(<ArtifactExplorerDialog open initialMode="eval" onOpenChange={() => {}} />)

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/artifacts/manifest', { cache: 'no-store' })
    })
    fireEvent.click(await screen.findByTestId('run-benchmark-wizard-toggle'))
    fireEvent.change(screen.getByTestId('run-benchmark-wizard-run-id'), { target: { value: 'run-1' } })
    fireEvent.change(screen.getByTestId('run-benchmark-wizard-model'), { target: { value: 'gpt-test' } })
    fireEvent.click(screen.getByTestId('instances-source-tab-paste'))
    fireEvent.change(screen.getByTestId('instances-paste-textarea'), { target: { value: '{"instance_id":"repo-1"}\n{"instance_id":"repo-2"}\n' } })

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      instancesJsonlPath: '/tmp/instances.jsonl',
      rowCount: 2,
      bytes: 64,
      source: { kind: 'inline' },
    }), { status: 200 }))

    fireEvent.click(screen.getByTestId('instances-resolve-button'))
    await screen.findByTestId('instances-resolve-summary')

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      planPath: '/tmp/plan.json',
      registryPath: '/tmp/registry/run-index.json',
      runId: 'run-1',
      selectedCount: 2,
      shardCount: 1,
    }), { status: 200 }))
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(manifest), { status: 200 }))

    fireEvent.click(screen.getByTestId('run-benchmark-wizard-plan-submit'))

    await screen.findByTestId('run-benchmark-wizard-infer')
    fireEvent.click(screen.getByTestId('run-benchmark-wizard-step-review'))
    const review = await screen.findByTestId('run-benchmark-wizard-review')
    expect(review.textContent).toContain('run-1')
    expect(review.textContent).not.toContain('/tmp/')
    expect(review.textContent).not.toContain('/home/')
  })

  it('renders the SubAgentUsagePanel when the eval summary carries subagentUsage', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify(manifest), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        path: 'runs/swebench/run1/summary.json',
        mediaType: 'application/json',
        body: {
          experimentId: 'run1',
          dataset: 'local',
          model: 'agent-test',
          trialCount: 2,
          resolved: 1,
          failed: 1,
          timedOut: 0,
          metrics: { passRate: 0.5 },
          subagentUsage: {
            totalCount: 3,
            trialsWithSubagents: 2,
            maxDepth: 2,
            perTrialMean: 1.5,
            resolvedWithSubagents: 1,
            unresolvedWithSubagents: 1,
          },
        },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        path: 'runs/eval/compare/eval-comparison.json',
        mediaType: 'application/json',
        body: {},
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        path: 'runs/swebench/run1/progress.json',
        mediaType: 'application/json',
        body: { runId: 'run1', dataset: 'local', model: 'agent-test', status: 'completed', selectedCount: 2 },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        path: 'runs/swebench/run1/worker-plan.json',
        mediaType: 'application/json',
        body: { runId: 'run1', dataset: 'local', model: 'agent-test', selectedCount: 2, maxWorkers: 2, shards: [], resourceHints: { dockerRequired: true, workspaceIsolation: 'per-instance-git-clone', maxConcurrentWorkspaces: 2 } },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        path: 'runs/eval/session-score/scores.json',
        mediaType: 'application/json',
        body: { instanceId: 'local__repo-1', resolved: true, failureLabel: 'resolved', score: 1, results: [] },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        path: 'runs/eval/judge-score/judge/model_judge.score.judge-trace.json',
        mediaType: 'application/json',
        body: { scorer: 'model_judge.score', judgeModel: 'judge-test', parsed: { score: 1, passed: true } },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        path: 'runs/swebench/run1/trials/local__repo-1.json',
        mediaType: 'application/json',
        body: { trialId: 'run1:local__repo-1', instanceId: 'local__repo-1', status: 'completed', resolved: true, artifacts: [] },
      }), { status: 200 }))

    render(<ArtifactExplorerDialog open initialMode="eval" onOpenChange={() => {}} />)

    await screen.findByRole('heading', { name: 'Eval' })
    const panel = await screen.findByTestId('eval-subagent-usage')
    expect(panel.textContent).toContain('Sub-agent Usage')
    expect(panel.textContent).toContain('3 spawned')
    expect(panel.textContent).toContain('trials w/ sub')
    expect(panel.textContent).toContain('max depth')
    expect(panel.textContent).toContain('mean / trial')
    expect(panel.textContent).toContain('1.50')
    expect(panel.textContent).toContain('resolved w/ sub')
    expect(panel.textContent).toContain('1 (50%)')
  })
})
