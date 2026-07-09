import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

import type { AgentConfig, AgentState } from '@agent-kernel/kernel'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { appendEventEntry, writeHeader } from '../store/log.js'
import { parseSweBenchCli } from './swebench-cli.js'
import { buildArtifactManifest } from '../artifact-manifest.js'
import {
  buildSweBenchGradeCommand,
  exportSessionForSweBench,
  inferSweBenchPatchRun,
  ingestSweBenchResults,
  runSweBenchAgentPatchRun,
  sweBenchRunLayout,
  writeSweBenchPredictionRun,
} from './swebench.js'

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

describe('SWE-bench eval runner', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ak-swebench-'))
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('writes prediction runs with official JSONL format and experiment metadata', async () => {
    const result = await writeSweBenchPredictionRun({
      rootDir: dir,
      runId: 'run1',
      dataset: 'princeton-nlp/SWE-bench_Lite',
      split: 'test',
      model: 'gpt-test',
      predictions: [
        {
          instance_id: 'sympy__sympy-20590',
          model_name_or_path: 'gpt-test',
          model_patch: 'diff --git a/x b/x\n',
        },
      ],
    })

    expect(result.layout).toEqual(sweBenchRunLayout(dir, 'run1'))
    expect(await readFile(result.layout.predictionsPath, 'utf8')).toBe(
      '{"instance_id":"sympy__sympy-20590","model_name_or_path":"gpt-test","model_patch":"diff --git a/x b/x\\n"}\n',
    )
    const experiment = JSON.parse(await readFile(result.layout.experimentPath, 'utf8'))
    expect(experiment.dataset).toBe('princeton-nlp/SWE-bench_Lite')
    expect(experiment.split).toBe('test')
  })

  it('exports an existing session log into a SWE-bench run with trace artifact', async () => {
    const sessionLog = join(dir, 'session.jsonl')
    await writeHeader({ path: sessionLog, sessionId: 's1', config, initialState })
    await appendEventEntry({
      path: sessionLog,
      seq: 1,
      event: { kind: 'user_message', text: 'fix it' },
      effects: [],
    })
    await appendEventEntry({
      path: sessionLog,
      seq: 2,
      event: { kind: 'llm_response', message: { role: 'assistant', content: [] } },
      effects: [],
      model: 'gpt-test',
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
    })

    const result = await exportSessionForSweBench({
      rootDir: dir,
      runId: 'run2',
      dataset: 'princeton-nlp/SWE-bench_Lite',
      split: 'test',
      model: 'gpt-test',
      instanceId: 'sympy__sympy-20590',
      sessionLogPath: sessionLog,
      modelPatch: 'diff --git a/x b/x\n',
    })

    expect(result.prediction.instance_id).toBe('sympy__sympy-20590')
    expect(result.traceArtifact.uri).toBe('traces/sympy__sympy-20590.openinference.json')
    expect(result.trial.sessionId).toBe('s1')
    expect(result.trial.artifacts.map((artifact) => artifact.uri)).toEqual([
      'traces/sympy__sympy-20590.openinference.json',
      'artifacts/sympy__sympy-20590/final.diff',
    ])
    const trace = JSON.parse(await readFile(join(result.layout.rootDir, result.traceArtifact.uri), 'utf8'))
    expect(trace.spans.map((span: { kind: string }) => span.kind)).toEqual(['AGENT', 'LLM'])
    const trial = JSON.parse(await readFile(join(result.layout.trialsDir, 'sympy__sympy-20590.json'), 'utf8'))
    expect(trial.sessionId).toBe('s1')
    expect(trial.metrics.patchBytes).toBe(Buffer.byteLength('diff --git a/x b/x\n', 'utf8'))
    const summary = JSON.parse(await readFile(result.layout.summaryPath, 'utf8'))
    expect(summary.trialCount).toBe(1)
    expect(summary.completed).toBe(1)
  })

  it('labels empty exported session patches while still linking trace artifacts', async () => {
    const sessionLog = join(dir, 'empty-session.jsonl')
    await writeHeader({ path: sessionLog, sessionId: 's-empty', config, initialState })
    await appendEventEntry({
      path: sessionLog,
      seq: 1,
      event: { kind: 'user_message', text: 'fix it' },
      effects: [],
    })

    const result = await exportSessionForSweBench({
      rootDir: dir,
      runId: 'run-empty-export',
      dataset: 'local',
      model: 'gpt-test',
      instanceId: 'local__empty-1',
      sessionLogPath: sessionLog,
      modelPatch: '',
    })

    expect(result.trial.status).toBe('failed')
    expect(result.trial.failureLabel).toBe('empty_patch')
    expect(result.trial.artifacts.map((artifact) => artifact.kind)).toEqual(['trace', 'diff'])
    const summary = JSON.parse(await readFile(result.layout.summaryPath, 'utf8'))
    expect(summary.failureCounts.empty_patch).toBe(1)
  })

  it('builds official harness command without executing by default', () => {
    expect(
      buildSweBenchGradeCommand({
        datasetName: 'princeton-nlp/SWE-bench_Lite',
        predictionsPath: 'runs/predictions.jsonl',
        runId: 'run3',
        maxWorkers: 4,
        instanceIds: ['a', 'b'],
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
      '4',
      '--run_id',
      'run3',
      '--instance_ids',
      'a',
      'b',
    ])
  })

  it('parses CLI grade and export-session commands', () => {
    expect(
      parseSweBenchCli([
        'eval',
        'swebench',
        'grade',
        '--dataset',
        'princeton-nlp/SWE-bench_Lite',
        '--predictions',
        'predictions.jsonl',
        '--run-id',
        'run4',
        '--max-workers',
        '2',
        '--instance-ids',
        'a,b',
      ]),
    ).toMatchObject({
      kind: 'grade',
      datasetName: 'princeton-nlp/SWE-bench_Lite',
      predictionsPath: 'predictions.jsonl',
      runId: 'run4',
      maxWorkers: 2,
      instanceIds: ['a', 'b'],
      execute: false,
    })

    expect(
      parseSweBenchCli([
        'eval',
        'swebench',
        'export-session',
        '--run-id',
        'run5',
        '--dataset',
        'princeton-nlp/SWE-bench_Lite',
        '--model',
        'gpt-test',
        '--instance-id',
        'i1',
        '--session-log',
        's.jsonl',
        '--model-patch',
        'patch.diff',
      ]),
    ).toMatchObject({
      kind: 'export-session',
      rootDir: 'runs/swebench',
      runId: 'run5',
      instanceId: 'i1',
    })
  })

  it('parses CLI infer and run commands', () => {
    expect(
      parseSweBenchCli([
        'eval',
        'swebench',
        'infer',
        '--run-id',
        'run7',
        '--dataset',
        'princeton-nlp/SWE-bench_Lite',
        '--model',
        'gpt-test',
        '--instances-jsonl',
        'instances.jsonl',
        '--patches-dir',
        'patches',
        '--limit',
        '1',
      ]),
    ).toMatchObject({
      kind: 'infer',
      runId: 'run7',
      instancesJsonl: 'instances.jsonl',
      patchesDir: 'patches',
      limit: 1,
    })

    expect(
      parseSweBenchCli([
        'eval',
        'swebench',
        'run',
        '--run-id',
        'run8',
        '--dataset',
        'princeton-nlp/SWE-bench_Lite',
        '--model',
        'gpt-test',
        '--instances-jsonl',
        'instances.jsonl',
        '--patches-dir',
        'patches',
        '--execute',
      ]),
    ).toMatchObject({ kind: 'run', execute: true })

    expect(
      parseSweBenchCli([
        'eval',
        'swebench',
        'agent-infer',
        '--run-id',
        'run-agent',
        '--dataset',
        'local',
        '--model',
        'agent-test',
        '--instances-jsonl',
        'instances.jsonl',
        '--agent-command',
        'agent --prompt "$AGENT_KERNEL_SWEBENCH_PROMPT_FILE"',
        '--repo-cache-dir',
        'repos',
        '--timeout-ms',
        '1000',
        '--max-workers',
        '2',
        '--skip-completed',
      ]),
    ).toMatchObject({
      kind: 'agent-infer',
      runId: 'run-agent',
      agentCommand: 'agent --prompt "$AGENT_KERNEL_SWEBENCH_PROMPT_FILE"',
      repoCacheDir: 'repos',
      timeoutMs: 1000,
      maxWorkers: 2,
      skipCompleted: true,
    })
  })

  it('creates an offline SWE-bench prediction run from local instance and patch fixtures', async () => {
    const instancesPath = join(dir, 'instances.jsonl')
    const patchesDir = join(dir, 'patches')
    mkdirSync(patchesDir)
    await writeFile(
      instancesPath,
      JSON.stringify({
        instance_id: 'sympy__sympy-20590',
        repo: 'sympy/sympy',
        problem_statement: 'fix bug',
      }) + '\n' + JSON.stringify({ instance_id: 'other__repo-1' }) + '\n',
      'utf8',
    )
    await writeFile(join(patchesDir, 'sympy__sympy-20590.diff'), 'diff --git a/x b/x\n', 'utf8')

    const result = await inferSweBenchPatchRun({
      rootDir: dir,
      runId: 'run7',
      dataset: 'princeton-nlp/SWE-bench_Lite',
      split: 'test',
      model: 'gpt-test',
      instancesJsonl: instancesPath,
      patchesDir,
      instanceIds: ['sympy__sympy-20590'],
    })

    expect(result.predictions).toHaveLength(1)
    expect(await readFile(result.layout.instancesPath, 'utf8')).toContain('sympy__sympy-20590')
    expect(await readFile(result.layout.predictionsPath, 'utf8')).toContain('diff --git')
    const summary = JSON.parse(await readFile(result.layout.summaryPath, 'utf8'))
    expect(summary.trialCount).toBe(1)
    expect(summary.emptyPatch).toBe(0)
    const trial = JSON.parse(await readFile(join(result.layout.trialsDir, 'sympy__sympy-20590.json'), 'utf8'))
    expect(trial.artifacts[0].uri).toBe('artifacts/sympy__sympy-20590/final.diff')
  })

  it('labels missing offline patches as empty_patch without failing the whole run', async () => {
    const instancesPath = join(dir, 'instances.jsonl')
    const patchesDir = join(dir, 'patches')
    mkdirSync(patchesDir)
    await writeFile(instancesPath, JSON.stringify({ instance_id: 'missing__repo-1' }) + '\n', 'utf8')

    const result = await inferSweBenchPatchRun({
      rootDir: dir,
      runId: 'run8',
      dataset: 'local',
      model: 'gpt-test',
      instancesJsonl: instancesPath,
      patchesDir,
    })

    expect(result.trials[0]?.failureLabel).toBe('empty_patch')
    const summary = JSON.parse(await readFile(result.layout.summaryPath, 'utf8'))
    expect(summary.failureCounts.empty_patch).toBe(1)
  })

  it('runs a local agent command against a materialized repo and captures the git diff prediction', async () => {
    const sourceRepo = join(dir, 'source-repo')
    mkdirSync(sourceRepo)
    await writeFile(join(sourceRepo, 'bug.txt'), 'before\n', 'utf8')
    runGit(sourceRepo, 'init')
    runGit(sourceRepo, 'config', 'user.email', 'test@example.com')
    runGit(sourceRepo, 'config', 'user.name', 'Test User')
    runGit(sourceRepo, 'add', 'bug.txt')
    runGit(sourceRepo, 'commit', '-m', 'init')
    const baseCommit = runGit(sourceRepo, 'rev-parse', 'HEAD').trim()
    const instancesPath = join(dir, 'instances.jsonl')
    await writeFile(instancesPath, JSON.stringify({
      instance_id: 'local__repo-1',
      repo_path: sourceRepo,
      repo: 'local/repo',
      base_commit: baseCommit,
      problem_statement: 'change bug.txt',
    }) + '\n', 'utf8')

    const result = await runSweBenchAgentPatchRun({
      rootDir: dir,
      runId: 'run-agent',
      dataset: 'local',
      model: 'agent-test',
      instancesJsonl: instancesPath,
      agentCommand: 'printf "after\\n" > bug.txt',
      timeoutMs: 5000,
    })

    expect(result.trials[0]?.failureLabel).toBeUndefined()
    expect(result.predictions[0]?.model_patch).toContain('diff --git a/bug.txt b/bug.txt')
    expect(result.predictions[0]?.model_patch).toContain('-before')
    expect(result.predictions[0]?.model_patch).toContain('+after')
    const summary = JSON.parse(await readFile(result.layout.summaryPath, 'utf8'))
    expect(summary.trialCount).toBe(1)
    expect(summary.failureCounts).toEqual({})
    const progress = JSON.parse(await readFile(result.layout.progressPath, 'utf8'))
    expect(progress).toMatchObject({
      schemaVersion: 1,
      runId: 'run-agent',
      status: 'completed',
      selectedCount: 1,
      queuedCount: 0,
      runningCount: 0,
      skippedCount: 0,
      completedCount: 1,
      failedCount: 0,
      timedOutCount: 0,
      maxWorkers: 1,
    })
    expect(progress.instances[0]).toMatchObject({
      instanceId: 'local__repo-1',
      status: 'completed',
    })
    expect(progress.instances[0].artifactRefs.map((artifact: { uri: string }) => artifact.uri)).toContain('artifacts/local__repo-1/final.diff')
    expect(typeof progress.instances[0].durationMs).toBe('number')
    const trial = JSON.parse(await readFile(join(result.layout.trialsDir, 'local__repo-1.json'), 'utf8'))
    expect(trial.artifacts.map((artifact: { uri: string }) => artifact.uri)).toContain('artifacts/local__repo-1/final.diff')
    expect(await readFile(result.layout.predictionsPath, 'utf8')).toContain('local__repo-1')

    const manifest = await buildArtifactManifest({ rootDir: result.layout.rootDir })
    expect(manifest.manifest.entries.find((entry) => entry.path === 'progress.json')?.kind).toBe('eval_progress')
  })

  it('resumes agent inference by skipping completed instances', async () => {
    const sourceRepo = join(dir, 'source-resume-repo')
    mkdirSync(sourceRepo)
    await writeFile(join(sourceRepo, 'bug.txt'), 'before\n', 'utf8')
    runGit(sourceRepo, 'init')
    runGit(sourceRepo, 'config', 'user.email', 'test@example.com')
    runGit(sourceRepo, 'config', 'user.name', 'Test User')
    runGit(sourceRepo, 'add', 'bug.txt')
    runGit(sourceRepo, 'commit', '-m', 'init')
    const baseCommit = runGit(sourceRepo, 'rev-parse', 'HEAD').trim()
    const instancesPath = join(dir, 'resume-instances.jsonl')
    await writeFile(instancesPath, JSON.stringify({
      instance_id: 'local__resume-1',
      repo_path: sourceRepo,
      base_commit: baseCommit,
      problem_statement: 'change bug.txt',
    }) + '\n', 'utf8')

    const first = await runSweBenchAgentPatchRun({
      rootDir: dir,
      runId: 'run-agent-resume',
      dataset: 'local',
      model: 'agent-test',
      instancesJsonl: instancesPath,
      agentCommand: 'printf "after\\n" > bug.txt',
      maxWorkers: 2,
    })
    const second = await runSweBenchAgentPatchRun({
      rootDir: dir,
      runId: 'run-agent-resume',
      dataset: 'local',
      model: 'agent-test',
      instancesJsonl: instancesPath,
      agentCommand: 'exit 7',
      skipCompleted: true,
      maxWorkers: 2,
    })

    expect(second.predictions).toEqual(first.predictions)
    expect(second.trials[0]?.failureLabel).toBeUndefined()
    const progress = JSON.parse(await readFile(second.layout.progressPath, 'utf8'))
    expect(progress).toMatchObject({
      selectedCount: 1,
      skippedCount: 1,
      completedCount: 0,
      failedCount: 0,
      timedOutCount: 0,
      status: 'completed',
    })
    expect(progress.instances[0]).toMatchObject({ instanceId: 'local__resume-1', status: 'skipped' })
    const predictionLines = (await readFile(second.layout.predictionsPath, 'utf8')).trim().split('\n')
    expect(predictionLines).toHaveLength(1)
  })

  it('records timeout failures in agent inference progress', async () => {
    const sourceRepo = join(dir, 'source-timeout-repo')
    mkdirSync(sourceRepo)
    await writeFile(join(sourceRepo, 'bug.txt'), 'before\n', 'utf8')
    runGit(sourceRepo, 'init')
    runGit(sourceRepo, 'config', 'user.email', 'test@example.com')
    runGit(sourceRepo, 'config', 'user.name', 'Test User')
    runGit(sourceRepo, 'add', 'bug.txt')
    runGit(sourceRepo, 'commit', '-m', 'init')
    const baseCommit = runGit(sourceRepo, 'rev-parse', 'HEAD').trim()
    const instancesPath = join(dir, 'timeout-instances.jsonl')
    await writeFile(instancesPath, JSON.stringify({
      instance_id: 'local__timeout-1',
      repo_path: sourceRepo,
      base_commit: baseCommit,
      problem_statement: 'change bug.txt slowly',
    }) + '\n', 'utf8')

    const result = await runSweBenchAgentPatchRun({
      rootDir: dir,
      runId: 'run-agent-timeout',
      dataset: 'local',
      model: 'agent-test',
      instancesJsonl: instancesPath,
      agentCommand: 'sleep 2',
      timeoutMs: 50,
    })

    expect(result.trials[0]?.status).toBe('timed_out')
    expect(result.trials[0]?.failureLabel).toBe('agent_timeout')
    const progress = JSON.parse(await readFile(result.layout.progressPath, 'utf8'))
    expect(progress).toMatchObject({
      status: 'failed',
      timedOutCount: 1,
      completedCount: 0,
      failedCount: 0,
    })
    expect(progress.instances[0]).toMatchObject({
      instanceId: 'local__timeout-1',
      status: 'timed_out',
      failureLabel: 'agent_timeout',
    })
  })

  it('ingests official-style SWE-bench instance results into trials and summary', async () => {
    const instancesPath = join(dir, 'instances.jsonl')
    const patchesDir = join(dir, 'patches')
    const resultsDir = join(dir, 'evaluation_results')
    mkdirSync(patchesDir)
    mkdirSync(resultsDir)
    await writeFile(
      instancesPath,
      JSON.stringify({ instance_id: 'a__repo-1' }) + '\n' + JSON.stringify({ instance_id: 'b__repo-2' }) + '\n',
      'utf8',
    )
    await writeFile(join(patchesDir, 'a__repo-1.diff'), 'diff --git a/x b/x\n', 'utf8')
    await writeFile(join(patchesDir, 'b__repo-2.diff'), 'diff --git a/y b/y\n', 'utf8')
    await inferSweBenchPatchRun({
      rootDir: dir,
      runId: 'run9',
      dataset: 'local',
      model: 'gpt-test',
      instancesJsonl: instancesPath,
      patchesDir,
    })
    await writeFile(
      join(resultsDir, 'instance_results.jsonl'),
      JSON.stringify({ instance_id: 'a__repo-1', resolved: true }) + '\n' +
        JSON.stringify({ instance_id: 'b__repo-2', resolved: false, error: 'tests failed' }) + '\n',
      'utf8',
    )
    mkdirSync(join(resultsDir, 'logs', 'b__repo-2'), { recursive: true })
    await writeFile(join(resultsDir, 'logs', 'b__repo-2', 'test_output.log'), 'pytest failed\n', 'utf8')

    const result = await ingestSweBenchResults({ rootDir: dir, runId: 'run9', resultsDir })

    expect(result.results.map((row) => [row.instanceId, row.resolved])).toEqual([
      ['a__repo-1', true],
      ['b__repo-2', false],
    ])
    const summary = JSON.parse(await readFile(result.summaryPath, 'utf8'))
    expect(summary.resolved).toBe(1)
    expect(summary.failureCounts.test_failed).toBe(1)
    const failedTrial = JSON.parse(await readFile(join(result.layout.trialsDir, 'b__repo-2.json'), 'utf8'))
    expect(failedTrial.failureLabel).toBe('test_failed')
    expect(failedTrial.artifacts.map((artifact: { uri: string }) => artifact.uri)).toEqual(expect.arrayContaining([
      'artifacts/b__repo-2/final.diff',
      'artifacts/b__repo-2/swebench-result.json',
      'artifacts/b__repo-2/harness/logs/b__repo-2/test_output.log',
    ]))
    expect(await readFile(join(result.layout.rootDir, 'artifacts/b__repo-2/swebench-result.json'), 'utf8')).toContain('tests failed')
    expect(await readFile(join(result.layout.rootDir, 'artifacts/b__repo-2/harness/logs/b__repo-2/test_output.log'), 'utf8')).toContain('pytest failed')
  })

  it('ingests results.json resolved id lists and parses the CLI command', async () => {
    const run = await writeSweBenchPredictionRun({
      rootDir: dir,
      runId: 'run10',
      dataset: 'local',
      model: 'gpt-test',
      predictions: [],
    })
    const resultsDir = join(dir, 'results-json')
    mkdirSync(resultsDir)
    await writeFile(join(resultsDir, 'results.json'), JSON.stringify({ resolved_ids: ['a__repo-1'] }), 'utf8')

    const parsed = parseSweBenchCli([
      'eval',
      'swebench',
      'ingest-results',
      '--root-dir',
      dir,
      '--run-id',
      'run10',
      '--results-dir',
      resultsDir,
    ])
    expect(parsed).toMatchObject({ kind: 'ingest-results', resultsDir })

    const result = await ingestSweBenchResults({ rootDir: dir, runId: run.layout.runId, resultsDir })
    expect(result.trials).toHaveLength(1)
    expect(result.trials[0]?.resolved).toBe(true)
  })

  it('can export a session using a patch file through the parsed command inputs', async () => {
    const sessionLog = join(dir, 'session.jsonl')
    const patchPath = join(dir, 'patch.diff')
    await writeHeader({ path: sessionLog, sessionId: 's1', config, initialState })
    await writeFile(patchPath, 'diff --git a/x b/x\n', 'utf8')
    const parsed = parseSweBenchCli([
      'eval',
      'swebench',
      'export-session',
      '--root-dir',
      dir,
      '--run-id',
      'run6',
      '--dataset',
      'princeton-nlp/SWE-bench_Lite',
      '--model',
      'gpt-test',
      '--instance-id',
      'i1',
      '--session-log',
      sessionLog,
      '--model-patch',
      patchPath,
    ])
    if (parsed.kind !== 'export-session') throw new Error('expected export-session')
    const modelPatch = await readFile(parsed.modelPatchPath, 'utf8')
    const result = await exportSessionForSweBench({ ...parsed, modelPatch })
    expect(await readFile(result.layout.predictionsPath, 'utf8')).toContain('diff --git')
  })
})

function runGit(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  }
  return result.stdout
}
