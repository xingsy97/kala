#!/usr/bin/env tsx
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { runProgramBenchCompileProbe } from '../src/eval/programbench/programbench-compile.js'
import { inspectProgramBenchSubmissionContract } from '../src/eval/programbench/programbench-contract.js'
import { buildProgramBenchCompileRepairPrompt, classifyProgramBenchCompileRepair } from '../src/eval/programbench/programbench-compile-repair.js'

type Args = {
  portfolioDir: string
  runId?: string
  timeoutMs: number
}

type ProgramBenchCase = {
  instance_id: string
  image_name?: string
}

const REPO_ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)))

async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printHelp()
    return
  }
  const args = parseArgs(process.argv.slice(2))
  const programRoot = join(args.portfolioDir, 'artifacts', 'program-bench')
  const latest = args.runId
    ? { run_id: args.runId, run_root: `artifacts/program-bench/${args.runId}` }
    : JSON.parse(await readFile(join(programRoot, 'latest-run-summary.json'), 'utf8')) as { run_id: string; run_root: string }
  const runRoot = join(args.portfolioDir, latest.run_root)
  const agents = ['agent-runlab', 'claude-code']
  const written = []
  for (const agent of agents) {
    const agentRoot = join(runRoot, agent)
    if (!existsSync(agentRoot)) continue
    for (const instanceId of await readdir(agentRoot)) {
      const caseRoot = join(agentRoot, instanceId)
      const workspaceRoot = join(caseRoot, 'workspace')
      const caseJsonPath = join(caseRoot, 'programbench-case.json')
      if (!existsSync(workspaceRoot) || !existsSync(caseJsonPath)) continue
      const item = JSON.parse(await readFile(caseJsonPath, 'utf8')) as ProgramBenchCase
      const dockerImage = item.image_name ? `${item.image_name}:task_cleanroom_v6` : null
      const probe = await runProgramBenchCompileProbe({
        workspaceRoot,
        dockerImage,
        timeoutMs: args.timeoutMs,
      })
      const out = join(caseRoot, 'compile-probe.json')
      await mkdir(caseRoot, { recursive: true })
      await writeFile(out, `${JSON.stringify({
        ...probe,
        workspace_root: relativeToPortfolio(args.portfolioDir, workspaceRoot),
      }, null, 2)}\n`, 'utf8')
      const contract = await inspectProgramBenchSubmissionContract(workspaceRoot)
      const compileRepairControl = classifyProgramBenchCompileRepair({ contract, compileProbe: probe })
      const promptPath = join(caseRoot, 'compile-repair-prompt.txt')
      if (compileRepairControl.action === 'continue_compile_repair') {
        await writeFile(promptPath, buildProgramBenchCompileRepairPrompt({
          item,
          workspaceRoot,
          contract,
          compileProbe: probe,
        }), 'utf8')
      }
      await writeFile(join(caseRoot, 'compile-repair-gate.json'), `${JSON.stringify({
        schema_version: 1,
        gate: 'programbench_compile_repair',
        compile_repair_control: compileRepairControl,
        compile_probe: {
          ok: probe.ok,
          status: probe.status,
          reason_codes: probe.reason_codes,
          exit_code: probe.exit_code,
        },
        prompt: compileRepairControl.action === 'continue_compile_repair'
          ? relativeToPortfolio(args.portfolioDir, promptPath)
          : null,
        next_action: compileRepairControl.action === 'continue_compile_repair'
          ? 'bounded compile repair should run before any broader ProgramBench expansion'
          : compileRepairControl.action,
      }, null, 2)}\n`, 'utf8')
      written.push(relativeToPortfolio(args.portfolioDir, out))
    }
  }
  const summary = {
    schema_version: 1,
    benchmark: 'program-bench',
    run_id: latest.run_id,
    status: 'compile_probes_backfilled',
    timeout_ms: args.timeoutMs,
    written,
  }
  await writeFile(join(runRoot, 'compile-probe-backfill-summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  console.log(JSON.stringify(summary, null, 2))
}

function printHelp(): void {
  process.stdout.write(`Usage: pnpm --filter @agent-kernel/host exec tsx bin/backfill-programbench-compile-probes.ts [options]

Options:
  --portfolio-dir <path>   Portfolio root (default: experiments/evals/2026-07-agent-benchmark-comparison)
  --run-id <id>            ProgramBench run id (default: latest-run-summary.json)
  --timeout-ms <n>         Per-probe timeout (default: 300000)
  -h, --help               Print this help and exit
`)
}

function parseArgs(argv: readonly string[]): Args {
  return {
    portfolioDir: resolve(REPO_ROOT, value(argv, '--portfolio-dir') ?? 'experiments/evals/2026-07-agent-benchmark-comparison'),
    runId: value(argv, '--run-id'),
    timeoutMs: numberValue(argv, '--timeout-ms') ?? 300_000,
  }
}

function value(argv: readonly string[], name: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === name) return argv[i + 1]
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1)
  }
  return undefined
}

function numberValue(argv: readonly string[], name: string): number | undefined {
  const raw = value(argv, name)
  if (raw === undefined) return undefined
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 1) throw new Error(`${name} must be a positive number`)
  return parsed
}

function relativeToPortfolio(portfolioDir: string, target: string): string {
  return resolve(target).startsWith(resolve(portfolioDir))
    ? resolve(target).slice(resolve(portfolioDir).length).replace(/^\/+/, '').replaceAll('\\', '/')
    : target.replaceAll('\\', '/')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
