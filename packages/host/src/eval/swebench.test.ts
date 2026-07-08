import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { AgentConfig, AgentState } from '@agent-kernel/kernel'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { appendEventEntry, writeHeader } from '../store/log.js'
import { parseSweBenchCli } from './swebench-cli.js'
import {
  buildSweBenchGradeCommand,
  exportSessionForSweBench,
  inferSweBenchPatchRun,
  ingestSweBenchResults,
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
    const trace = JSON.parse(await readFile(join(result.layout.rootDir, result.traceArtifact.uri), 'utf8'))
    expect(trace.spans.map((span: { kind: string }) => span.kind)).toEqual(['AGENT', 'LLM'])
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
