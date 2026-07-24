import { describe, expect, it } from 'vitest'

import { parseEvalBenchCli } from './eval-bench-cli.js'

describe('parseEvalBenchCli', () => {
  it('returns none for non-eval argv and unknown benchmarks', () => {
    expect(parseEvalBenchCli(['serve']).kind).toBe('none')
    expect(parseEvalBenchCli(['eval', 'unknown-bench', 'run']).kind).toBe('none')
  })

  it('parses program-bench run with all options', () => {
    const cmd = parseEvalBenchCli([
      'eval', 'program-bench', 'run',
      '--run-id', 'r1', '--tasks-jsonl', '/t.jsonl',
      '--agent-command', 'do-it', '--limit', '5', '--max-workers', '2',
      '--timeout-ms', '1000', '--root-dir', '/out', '--dataset', 'd', '--model', 'm',
    ])
    expect(cmd).toEqual({
      kind: 'program-bench-run', runId: 'r1', rootDir: '/out', tasksJsonl: '/t.jsonl',
      agentCommand: 'do-it', limit: 5, maxWorkers: 2, timeoutMs: 1000, dataset: 'd', model: 'm',
    })
  })

  it('parses program-bench import with default root', () => {
    expect(parseEvalBenchCli(['eval', 'program-bench', 'import', '--run-id', 'r2']))
      .toEqual({ kind: 'program-bench-import', runId: 'r2', rootDir: 'runs/program-bench' })
  })

  it('parses swe-marathon run with task ids', () => {
    const cmd = parseEvalBenchCli(['eval', 'swe-marathon', 'run', '--run-id', 'r3', '--tasks-dir', '/tasks', '--task-ids', 'a,b'])
    expect(cmd).toMatchObject({ kind: 'swe-marathon-run', runId: 'r3', tasksDir: '/tasks', taskIds: ['a', 'b'] })
  })

  it('parses terminal-bench-2_1 run and defaults agent to solution', () => {
    const cmd = parseEvalBenchCli(['eval', 'terminal-bench-2_1', 'run', '--run-id', 'r4', '--tasks-dir', '/ds'])
    expect(cmd).toMatchObject({ kind: 'terminal-bench-2_1-run', agent: 'solution', tasksDir: '/ds' })
    const none = parseEvalBenchCli(['eval', 'terminal-bench-2_1', 'run', '--run-id', 'r5', '--tasks-dir', '/ds', '--agent', 'none'])
    expect(none).toMatchObject({ agent: 'none' })
  })

  it('throws on missing required flags and unknown subcommands', () => {
    expect(() => parseEvalBenchCli(['eval', 'program-bench', 'run'])).toThrow(/missing required --run-id/)
    expect(() => parseEvalBenchCli(['eval', 'swe-marathon', 'bogus'])).toThrow(/unknown swe-marathon subcommand/)
  })
})
