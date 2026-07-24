// Unified CLI for the container-backed benchmarks added alongside SWE-bench:
// program-bench, swe-marathon, and terminal-bench 2.1.
//
//   agent-kernel-host eval program-bench run   --run-id <id> --tasks-jsonl <path> [--agent-command <cmd>] [--limit N] [--max-workers N] [--timeout-ms N] [--root-dir <dir>] [--dataset <name>] [--model <ref>]
//   agent-kernel-host eval program-bench import --run-id <id> [--root-dir <dir>]
//   agent-kernel-host eval swe-marathon run     --run-id <id> --tasks-dir <dir> [--task-ids a,b] [--limit N] [--timeout-ms N] [--root-dir <dir>] [--dataset <name>] [--model <ref>]
//   agent-kernel-host eval swe-marathon import  --run-id <id> [--root-dir <dir>]
//   agent-kernel-host eval terminal-bench-2_1 run --run-id <id> --tasks-dir <dir> [--agent solution|none] [--task-ids a,b] [--limit N] [--timeout-ms N] [--root-dir <dir>] [--dataset <name>] [--model <ref>]
//
// Mirrors swebench-cli.ts conventions. Emits JSON summaries to stdout.

import {
  importProgramBenchResults,
  runProgramBenchRun,
} from '../programbench/programbench.js'
import {
  importSweMarathonResults,
  runSweMarathonRun,
} from '../swe-marathon/swe-marathon.js'
import { runTerminalBench21Run } from '../terminal-bench/terminal-bench-2_1.js'

export type EvalBenchKind = 'program-bench' | 'swe-marathon' | 'terminal-bench-2_1'

export type EvalBenchCliCommand =
  | { kind: 'none' }
  | { kind: 'program-bench-run'; runId: string; rootDir: string; tasksJsonl?: string; agentCommand?: string; limit?: number; maxWorkers?: number; timeoutMs?: number; dataset?: string; model?: string; allowHostExecution?: boolean }
  | { kind: 'program-bench-import'; runId: string; rootDir: string }
  | { kind: 'swe-marathon-run'; runId: string; rootDir: string; tasksDir: string; taskIds?: readonly string[]; limit?: number; timeoutMs?: number; dataset?: string; model?: string }
  | { kind: 'swe-marathon-import'; runId: string; rootDir: string }
  | { kind: 'terminal-bench-2_1-run'; runId: string; rootDir: string; tasksDir: string; agent: 'solution' | 'none'; taskIds?: readonly string[]; limit?: number; timeoutMs?: number; dataset?: string; model?: string }

const DEFAULT_PB_ROOT = 'runs/program-bench'
const DEFAULT_SM_ROOT = 'runs/swe-marathon'
const DEFAULT_TB21_ROOT = 'runs/terminal-bench'

export function parseEvalBenchCli(argv: readonly string[]): EvalBenchCliCommand {
  if (argv[0] !== 'eval') return { kind: 'none' }
  const bench = argv[1]
  const sub = argv[2]
  const rest = argv.slice(3)

  if (bench === 'program-bench') {
    if (sub === 'run') {
      return {
        kind: 'program-bench-run',
        runId: required(rest, '--run-id'),
        rootDir: value(rest, '--root-dir') ?? DEFAULT_PB_ROOT,
        ...(value(rest, '--tasks-jsonl') ? { tasksJsonl: value(rest, '--tasks-jsonl') } : {}),
        ...(value(rest, '--agent-command') ? { agentCommand: value(rest, '--agent-command') } : {}),
        ...(flag(rest, '--allow-host-execution') ? { allowHostExecution: true } : {}),
        ...(numberArg(rest, '--limit') !== undefined ? { limit: numberArg(rest, '--limit') } : {}),
        ...(numberArg(rest, '--max-workers') !== undefined ? { maxWorkers: numberArg(rest, '--max-workers') } : {}),
        ...(numberArg(rest, '--timeout-ms') !== undefined ? { timeoutMs: numberArg(rest, '--timeout-ms') } : {}),
        ...(value(rest, '--dataset') ? { dataset: value(rest, '--dataset') } : {}),
        ...(value(rest, '--model') ? { model: value(rest, '--model') } : {}),
      }
    }
    if (sub === 'import') {
      return { kind: 'program-bench-import', runId: required(rest, '--run-id'), rootDir: value(rest, '--root-dir') ?? DEFAULT_PB_ROOT }
    }
    throw new Error(`unknown program-bench subcommand: ${sub ?? '<missing>'}`)
  }

  if (bench === 'swe-marathon') {
    if (sub === 'run') {
      return {
        kind: 'swe-marathon-run',
        runId: required(rest, '--run-id'),
        rootDir: value(rest, '--root-dir') ?? DEFAULT_SM_ROOT,
        tasksDir: required(rest, '--tasks-dir'),
        ...(listArg(rest, '--task-ids') ? { taskIds: listArg(rest, '--task-ids') } : {}),
        ...(numberArg(rest, '--limit') !== undefined ? { limit: numberArg(rest, '--limit') } : {}),
        ...(numberArg(rest, '--timeout-ms') !== undefined ? { timeoutMs: numberArg(rest, '--timeout-ms') } : {}),
        ...(value(rest, '--dataset') ? { dataset: value(rest, '--dataset') } : {}),
        ...(value(rest, '--model') ? { model: value(rest, '--model') } : {}),
      }
    }
    if (sub === 'import') {
      return { kind: 'swe-marathon-import', runId: required(rest, '--run-id'), rootDir: value(rest, '--root-dir') ?? DEFAULT_SM_ROOT }
    }
    throw new Error(`unknown swe-marathon subcommand: ${sub ?? '<missing>'}`)
  }

  if (bench === 'terminal-bench-2_1') {
    if (sub === 'run') {
      const agent = value(rest, '--agent') === 'none' ? 'none' : 'solution'
      return {
        kind: 'terminal-bench-2_1-run',
        runId: required(rest, '--run-id'),
        rootDir: value(rest, '--root-dir') ?? DEFAULT_TB21_ROOT,
        tasksDir: required(rest, '--tasks-dir'),
        agent,
        ...(listArg(rest, '--task-ids') ? { taskIds: listArg(rest, '--task-ids') } : {}),
        ...(numberArg(rest, '--limit') !== undefined ? { limit: numberArg(rest, '--limit') } : {}),
        ...(numberArg(rest, '--timeout-ms') !== undefined ? { timeoutMs: numberArg(rest, '--timeout-ms') } : {}),
        ...(value(rest, '--dataset') ? { dataset: value(rest, '--dataset') } : {}),
        ...(value(rest, '--model') ? { model: value(rest, '--model') } : {}),
      }
    }
    throw new Error(`unknown terminal-bench-2_1 subcommand: ${sub ?? '<missing>'}`)
  }

  return { kind: 'none' }
}

export async function runEvalBenchCli(command: EvalBenchCliCommand): Promise<boolean> {
  if (command.kind === 'none') return false

  if (command.kind === 'program-bench-run') {
    const { summary } = await runProgramBenchRun({
      rootDir: command.rootDir,
      runId: command.runId,
      ...(command.tasksJsonl ? { tasksJsonl: command.tasksJsonl } : {}),
      ...(command.agentCommand ? { agentCommand: command.agentCommand } : {}),
      ...(command.allowHostExecution ? { allowHostExecution: true } : {}),
      ...(command.limit !== undefined ? { limit: command.limit } : {}),
      ...(command.maxWorkers !== undefined ? { maxWorkers: command.maxWorkers } : {}),
      ...(command.timeoutMs !== undefined ? { timeoutMs: command.timeoutMs } : {}),
      ...(command.dataset ? { dataset: command.dataset } : {}),
      ...(command.model ? { model: command.model } : {}),
    })
    console.log(JSON.stringify({ benchmark: 'program-bench', ...summary }, null, 2))
    return true
  }
  if (command.kind === 'program-bench-import') {
    const summary = await importProgramBenchResults({ rootDir: command.rootDir, runId: command.runId })
    console.log(JSON.stringify({ benchmark: 'program-bench', ...summary }, null, 2))
    return true
  }

  if (command.kind === 'swe-marathon-run') {
    const { summary } = await runSweMarathonRun({
      rootDir: command.rootDir,
      runId: command.runId,
      tasksDir: command.tasksDir,
      ...(command.taskIds ? { taskIds: command.taskIds } : {}),
      ...(command.limit !== undefined ? { limit: command.limit } : {}),
      ...(command.timeoutMs !== undefined ? { timeoutMs: command.timeoutMs } : {}),
      ...(command.dataset ? { dataset: command.dataset } : {}),
      ...(command.model ? { model: command.model } : {}),
    })
    console.log(JSON.stringify({ benchmark: 'swe-marathon', requiresDocker: true, ...summary }, null, 2))
    return true
  }
  if (command.kind === 'swe-marathon-import') {
    const summary = await importSweMarathonResults({ rootDir: command.rootDir, runId: command.runId })
    console.log(JSON.stringify({ benchmark: 'swe-marathon', ...summary }, null, 2))
    return true
  }

  if (command.kind === 'terminal-bench-2_1-run') {
    const { summary } = await runTerminalBench21Run({
      rootDir: command.rootDir,
      runId: command.runId,
      datasetDir: command.tasksDir,
      agent: command.agent,
      ...(command.taskIds ? { taskIds: command.taskIds } : {}),
      ...(command.limit !== undefined ? { limit: command.limit } : {}),
      ...(command.timeoutMs !== undefined ? { timeoutMs: command.timeoutMs } : {}),
      ...(command.dataset ? { dataset: command.dataset } : {}),
      ...(command.model ? { model: command.model } : {}),
    })
    console.log(JSON.stringify({ benchmark: 'terminal-bench-2_1', requiresDocker: true, ...summary }, null, 2))
    return true
  }

  return false
}

// --- arg helpers (mirror swebench-cli.ts) ---------------------------------

function value(argv: readonly string[], name: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === name) return argv[i + 1]
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1)
  }
  return undefined
}

function required(argv: readonly string[], name: string): string {
  const found = value(argv, name)
  if (!found) throw new Error(`missing required ${name}`)
  return found
}

function numberArg(argv: readonly string[], name: string): number | undefined {
  const found = value(argv, name)
  if (found === undefined) return undefined
  const parsed = Number(found)
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`invalid ${name}: ${found}`)
  return parsed
}

function listArg(argv: readonly string[], name: string): readonly string[] | undefined {
  const found = value(argv, name)
  if (!found) return undefined
  return found.split(',').map((item) => item.trim()).filter(Boolean)
}

function flag(argv: readonly string[], name: string): boolean {
  return argv.includes(name)
}
