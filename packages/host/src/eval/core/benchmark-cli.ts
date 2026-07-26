import { readFile } from 'node:fs/promises'

import { BenchmarkRunSpecSchema } from '@agent-kernel/shared'

import { listAgentBackends } from './agent-backend.js'
import { importLegacySweBench } from './legacy-swebench-import.js'
import { BenchmarkRunService } from './benchmark-run-service.js'

export type BenchmarkCliCommand =
  | { kind: 'none' }
  | { kind: 'backends' }
  | { kind: 'run'; configPath: string; rootDir: string }
  | { kind: 'grade'; runId: string; rootDir: string; dryRun: boolean }
  | { kind: 'status'; runId: string; rootDir: string }
  | { kind: 'cancel'; runId: string; rootDir: string }
  | { kind: 'import-legacy-swebench'; sourceDir: string; rootDir: string; importId?: string }

export function parseBenchmarkCli(argv: readonly string[]): BenchmarkCliCommand {
  if (argv[0] !== 'benchmark') return { kind: 'none' }
  if (argv[1] === 'backends') return { kind: 'backends' }
  if (argv[1] === 'run') return {
    kind: 'run',
    configPath: required(argv, '--config'),
    rootDir: value(argv, '--root-dir') ?? 'runs/benchmark-runs',
  }
  if (argv[1] === 'grade') return { kind: 'grade', runId: required(argv, '--run-id'), rootDir: value(argv, '--root-dir') ?? 'runs/benchmark-runs', dryRun: argv.includes('--dry-run') }
  if (argv[1] === 'status') return { kind: 'status', runId: required(argv, '--run-id'), rootDir: value(argv, '--root-dir') ?? 'runs/benchmark-runs' }
  if (argv[1] === 'cancel') return { kind: 'cancel', runId: required(argv, '--run-id'), rootDir: value(argv, '--root-dir') ?? 'runs/benchmark-runs' }
  if (argv[1] === 'import-legacy-swebench') return {
    kind: 'import-legacy-swebench',
    sourceDir: required(argv, '--source-dir'),
    rootDir: value(argv, '--root-dir') ?? 'runs/benchmark-runs',
    ...(value(argv, '--import-id') ? { importId: value(argv, '--import-id') } : {}),
  }
  throw new Error(`unknown benchmark subcommand: ${argv[1] ?? '<missing>'}`)
}

export async function runBenchmarkCli(command: BenchmarkCliCommand): Promise<boolean> {
  if (command.kind === 'none') return false
  if (command.kind === 'backends') {
    console.log(JSON.stringify({ backends: listAgentBackends() }, null, 2))
    return true
  }
  if (command.kind === 'grade') {
    console.log(JSON.stringify(await new BenchmarkRunService(command.rootDir).grade(command.runId, !command.dryRun), null, 2))
    return true
  }
  if (command.kind === 'status') {
    console.log(JSON.stringify(await new BenchmarkRunService(command.rootDir).get(command.runId), null, 2))
    return true
  }
  if (command.kind === 'cancel') {
    console.log(JSON.stringify(await new BenchmarkRunService(command.rootDir).cancel(command.runId), null, 2))
    return true
  }
  if (command.kind === 'import-legacy-swebench') {
    const result = await importLegacySweBench({
      sourceDir: command.sourceDir,
      outputRoot: command.rootDir,
      ...(command.importId ? { importId: command.importId } : {}),
    })
    console.log(JSON.stringify({ path: result.path, imported: result.imported }, null, 2))
    return true
  }

  const spec = BenchmarkRunSpecSchema.parse(JSON.parse(await readFile(command.configPath, 'utf8')))
  const service = new BenchmarkRunService(command.rootDir)
  await service.create(spec)
  const result = await service.run(spec.runId)
  console.log(JSON.stringify(result, null, 2))
  return true
}

function value(argv: readonly string[], name: string): string | undefined {
  for (let index = 0; index < argv.length; index++) {
    const item = argv[index]!
    if (item === name) return argv[index + 1]
    if (item.startsWith(`${name}=`)) return item.slice(name.length + 1)
  }
  return undefined
}

function required(argv: readonly string[], name: string): string {
  const found = value(argv, name)
  if (!found) throw new Error(`missing required ${name}`)
  return found
}
