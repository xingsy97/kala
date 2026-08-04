#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { promisify } from 'node:util'

const runFile = promisify(execFile)
const root = resolve(new URL('../..', import.meta.url).pathname)
const evidencePaths = {
  terminalBench: 'docs/evidence/evaluation/fresh-terminal-bench-codex-20260803.json',
  programBench: 'docs/evidence/evaluation/fresh-program-bench-codex-20260803.json',
  externalTaskPack: 'docs/evidence/evaluation/external-contributor-acceptance-20260803.json',
}
const evidence = Object.fromEntries(await Promise.all(Object.entries(evidencePaths).map(async ([name, path]) => [name, JSON.parse(await readFile(resolve(root, path), 'utf8'))])))

const terminalBench = validateFreshAgentRun(evidence.terminalBench, {
  taskPackId: 'terminal-bench', taskId: 'release-ledger-reconciliation',
  metrics: { reward: 1, resolved: true, verifier_protocol_valid: true },
})
const programBench = validateFreshAgentRun(evidence.programBench, {
  taskPackId: 'program-bench', taskId: 'greeting-cli',
  metrics: { submission_contract: true, compile_passed: true, tests_passed: true, verifier_protocol_valid: true },
})
if (terminalBench.runId === programBench.runId || terminalBench.resultHash === programBench.resultHash) throw new Error('benchmark Agent runs must be distinct fresh Sessions with distinct canonical results')

const contributor = evidence.externalTaskPack
const taskPackWorkspace = contributor.cleanWorkspaces?.find((entry) => entry.template === 'task-pack')
if (taskPackWorkspace?.plugin?.kind !== 'benchmark-adapter' || taskPackWorkspace.plugin.id !== 'sample-task-pack') throw new Error('external task-pack clean-workspace plugin evidence is incomplete')
if (contributor.fixtureValidation?.tasks?.length !== 1 || contributor.privateImportScan?.length !== 0 || contributor.orchestratorInternalsUnchanged !== true) throw new Error('external task-pack SDK/no-internals evidence is incomplete')

const runtimeResidue = await managedRuntimeResidue()
if (Object.values(runtimeResidue).some((items) => items.length > 0)) throw new Error('managed runtime residue remains after fresh benchmark runs: ' + JSON.stringify(runtimeResidue))

const sourcePaths = [
  'adapters/benchmarks/terminal-bench/src/index.ts',
  'adapters/benchmarks/program-bench/src/index.ts',
  'scripts/evaluation/run-real-task-pack.mjs',
  'scripts/evaluation/verify-benchmark-agent-lifecycles.mjs',
  'task-packs/terminal-bench-v1/release-ledger/TASK.md',
  'task-packs/terminal-bench-v1/release-ledger/package.json',
  'task-packs/terminal-bench-v1/release-ledger/fixture/release-ledger.tsv',
  'task-packs/terminal-bench-v1/release-ledger/scripts/verify-row.mjs',
  'task-packs/terminal-bench-v1/release-ledger/tests/fixture.test.mjs',
  'task-packs/program-bench-v1/greeting-cli/TASK.md',
  'task-packs/program-bench-v1/greeting-cli/package.json',
  'task-packs/program-bench-v1/greeting-cli/program.mjs',
  'task-packs/program-bench-v1/greeting-cli/compile.sh',
  'task-packs/program-bench-v1/greeting-cli/fixture/contract.json',
  'task-packs/program-bench-v1/greeting-cli/tests/program.test.mjs',
]
const sourceFiles = Object.fromEntries(await Promise.all(sourcePaths.map(async (path) => [path, sha256(await readFile(resolve(root, path)))])))
const evidenceFiles = Object.fromEntries(await Promise.all(Object.values(evidencePaths).map(async (path) => [path, sha256(await readFile(resolve(root, path)))])))
const sourceRevision = (await runFile('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' })).stdout.trim()
const report = {
  schemaVersion: 1, generatedAt: new Date().toISOString(),
  scope: 'fresh real-Agent unified lifecycle acceptance for Terminal-Bench and ProgramBench plus clean-workspace public task-pack SDK acceptance; no historical Session input',
  sourceRevision, sourceFiles, evidenceFiles,
  terminalBench, programBench,
  customTaskPack: { package: taskPackWorkspace.package, plugin: taskPackWorkspace.plugin, taskIds: contributor.fixtureValidation.tasks, privateImports: contributor.privateImportScan.length, orchestratorInternalsUnchanged: true },
  runtimeResidue,
}
const output = resolve(option('--output') ?? 'docs/evidence/evaluation/benchmark-agent-lifecycles-acceptance-20260803.json')
await mkdir(dirname(output), { recursive: true, mode: 0o700 })
await writeFile(output, JSON.stringify(report, null, 2) + String.fromCharCode(10), { encoding: 'utf8', mode: 0o600 })
process.stdout.write(JSON.stringify({ ok: true, freshAgentRuns: 2, customTaskPackCleanWorkspaces: 1, managedRuntimeResidue: 0, output }) + String.fromCharCode(10))

function validateFreshAgentRun(run, expected) {
  const trial = run.trials?.[0]
  if (!run.runId?.startsWith('fresh-') || run.taskPackId !== expected.taskPackId || run.runState !== 'completed') throw new Error(expected.taskPackId + ' fresh run identity/state is incomplete')
  if (run.agentIds?.length !== 1 || run.agentIds[0] !== 'codex' || run.freshSandboxes !== 1 || run.cleanupVerified !== true || run.environmentLockEqualAcrossAgents !== true || run.workerErrors?.length !== 0) throw new Error(expected.taskPackId + ' Agent/sandbox lifecycle evidence is incomplete')
  if (!run.gradingJobId || !run.gradingOutputHash || !run.analysisJobId || !run.analysisOutputHash) throw new Error(expected.taskPackId + ' grading/analyzer evidence is incomplete')
  if (trial?.taskId !== expected.taskId || trial.agentVariantId !== 'codex' || trial.evidenceLevel !== 'native' || trial.normalizedEventCount < 1 || !isHash(trial.resultHash) || !isHash(trial.artifactManifestHash)) throw new Error(expected.taskPackId + ' canonical trial evidence is incomplete')
  for (const [name, value] of Object.entries(expected.metrics)) if (trial.nativeMetrics?.[name] !== value) throw new Error(expected.taskPackId + ' native metric mismatch: ' + name)
  return {
    runId: run.runId, taskPackId: run.taskPackId, taskId: trial.taskId, agentVariantId: trial.agentVariantId,
    freshSandboxes: run.freshSandboxes, cleanupVerified: run.cleanupVerified, durationMs: run.durationMs,
    resultHash: trial.resultHash, artifactManifestHash: trial.artifactManifestHash, normalizedEventCount: trial.normalizedEventCount,
    nativeMetrics: trial.nativeMetrics, gradingJobId: run.gradingJobId, analysisJobId: run.analysisJobId,
  }
}

async function managedRuntimeResidue() {
  const [instances, networks, acls] = await Promise.all([
    lxc(['list', '--format', 'json'], (entry) => /^(?:eval-|ae-)/u.test(String(entry.name))),
    lxc(['network', 'list', '--format', 'json'], (entry) => /^ae-n-/u.test(String(entry.name))),
    lxc(['network', 'acl', 'list', '--format', 'json'], (entry) => /^ae-a-/u.test(String(entry.name))),
  ])
  return { instances, networks, acls }
}
async function lxc(args, matches) {
  const result = await runFile('lxc', args, { cwd: root, encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024 })
  return JSON.parse(result.stdout).filter(matches).map((entry) => entry.name).sort()
}
function sha256(value) { return createHash('sha256').update(value).digest('hex') }
function isHash(value) { return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value) }
function option(name) { for (let index = 2; index < process.argv.length; index += 1) if (process.argv[index] === name) return process.argv[index + 1]; else if (process.argv[index]?.startsWith(name + '=')) return process.argv[index].slice(name.length + 1) }
