import { mkdtempSync, rmSync } from 'node:fs'
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
