import { readFile } from 'node:fs/promises'

import {
  exportSessionForSweBench,
  runSweBenchGrade,
  type ExportSessionForSweBenchInput,
  type SweBenchGradeInput,
} from './swebench.js'

export type SweBenchCliCommand =
  | { kind: 'none' }
  | ({ kind: 'grade' } & SweBenchGradeInput)
  | ({ kind: 'export-session' } & Omit<ExportSessionForSweBenchInput, 'modelPatch'> & {
      modelPatchPath: string
    })

export function parseSweBenchCli(argv: readonly string[]): SweBenchCliCommand {
  if (argv[0] !== 'eval' || argv[1] !== 'swebench') return { kind: 'none' }
  const subcommand = argv[2]
  const rest = argv.slice(3)
  if (subcommand === 'grade') {
    return {
      kind: 'grade',
      datasetName: required(rest, '--dataset'),
      predictionsPath: required(rest, '--predictions'),
      runId: required(rest, '--run-id'),
      maxWorkers: numberArg(rest, '--max-workers'),
      instanceIds: listArg(rest, '--instance-ids'),
      modal: flag(rest, '--modal'),
      execute: flag(rest, '--execute'),
      cwd: value(rest, '--cwd'),
    }
  }
  if (subcommand === 'export-session') {
    return {
      kind: 'export-session',
      rootDir: value(rest, '--root-dir') ?? 'runs/swebench',
      runId: required(rest, '--run-id'),
      dataset: required(rest, '--dataset'),
      split: value(rest, '--split'),
      model: required(rest, '--model'),
      instanceId: required(rest, '--instance-id'),
      sessionLogPath: required(rest, '--session-log'),
      modelPatchPath: required(rest, '--model-patch'),
      workspaceRoot: value(rest, '--workspace-root'),
    }
  }
  throw new Error(`unknown swebench subcommand: ${subcommand ?? '<missing>'}`)
}

export async function runSweBenchCli(command: SweBenchCliCommand): Promise<boolean> {
  if (command.kind === 'none') return false
  if (command.kind === 'grade') {
    const result = await runSweBenchGrade(command)
    console.log(result.command.map(shellQuote).join(' '))
    if (result.exitCode !== undefined) process.exitCode = result.exitCode
    return true
  }
  const modelPatch = await readFile(command.modelPatchPath, 'utf8')
  const result = await exportSessionForSweBench({ ...command, modelPatch })
  console.log(JSON.stringify({
    runId: result.layout.runId,
    predictionsPath: result.layout.predictionsPath,
    experimentPath: result.layout.experimentPath,
    traceArtifact: result.traceArtifact,
  }, null, 2))
  return true
}

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

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=+-]+$/.test(value)) return value
  return `'${value.replace(/'/g, `'\\''`)}'`
}

