#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { promisify } from 'node:util'

const runFile = promisify(execFile)
const root = resolve(new URL('../..', import.meta.url).pathname)
const runPath = resolve(root, option('--run') ?? 'docs/evidence/evaluation/fresh-code-understanding-codex-20260803.json')
const run = JSON.parse(await readFile(runPath, 'utf8'))
const trial = run.trials?.[0]
const metricNames = ['file_recall_at_k', 'symbol_recall_at_k', 'first_relevant_read_rank', 'irrelevant_read_ratio', 'dependency_edge_precision', 'dependency_edge_recall']

if (!run.runId?.startsWith('fresh-code-understanding-') || run.taskPackId !== 'code-understanding' || run.runState !== 'completed') throw new Error('fresh code-understanding run identity/state is incomplete')
if (run.agentIds?.length !== 1 || run.agentIds[0] !== 'codex' || run.freshSandboxes !== 1 || run.cleanupVerified !== true || run.workerErrors?.length !== 0) throw new Error('Agent/sandbox lifecycle evidence is incomplete')
if (!run.gradingJobId || !isHash(run.gradingOutputHash) || !run.analysisJobId || !isHash(run.analysisOutputHash)) throw new Error('grader/analyzer evidence is incomplete')
if (trial?.taskId !== 'configuration-runtime-trace' || trial.agentVariantId !== 'codex' || trial.evidenceLevel !== 'native' || trial.normalizedEventCount < 1 || !isHash(trial.resultHash) || !isHash(trial.artifactManifestHash)) throw new Error('canonical trial evidence is incomplete')
if (trial.nativeMetrics?.verifier_protocol_valid !== true || trial.nativeMetrics.passedSteps !== 1 || trial.nativeMetrics.totalSteps !== 1) throw new Error('native verifier protocol did not pass')
for (const name of metricNames) if (typeof trial.nativeMetrics[name] !== 'number' || !Number.isFinite(trial.nativeMetrics[name])) throw new Error('missing finite metric: ' + name)
for (const name of ['file_recall_at_k', 'symbol_recall_at_k', 'irrelevant_read_ratio', 'dependency_edge_precision', 'dependency_edge_recall']) if (trial.nativeMetrics[name] < 0 || trial.nativeMetrics[name] > 1) throw new Error('bounded metric outside [0,1]: ' + name)
if (trial.nativeMetrics.first_relevant_read_rank < 0 || !Number.isInteger(trial.nativeMetrics.first_relevant_read_rank)) throw new Error('read rank must be a non-negative integer')
if (metricNames.every((name) => trial.nativeMetrics[name] === 1)) throw new Error('measured run unexpectedly collapsed all distinct code-understanding metrics to one value')

const runtimeResidue = await managedRuntimeResidue()
if (Object.values(runtimeResidue).some((entries) => entries.length > 0)) throw new Error('managed runtime residue remains: ' + JSON.stringify(runtimeResidue))
const sourcePaths = [
  'adapters/benchmarks/common/src/index.ts',
  'adapters/benchmarks/code-understanding/src/index.ts',
  'adapters/benchmarks/code-understanding/src/index.test.ts',
  'scripts/evaluation/run-real-task-pack.mjs',
  'scripts/evaluation/verify-code-understanding-lifecycle.mjs',
  'task-packs/code-understanding-v1/configuration-runtime-trace/TASK.md',
  'task-packs/code-understanding-v1/configuration-runtime-trace/localization.json',
  'task-packs/code-understanding-v1/configuration-runtime-trace/config/defaults.json',
  'task-packs/code-understanding-v1/configuration-runtime-trace/src/cli.mjs',
  'task-packs/code-understanding-v1/configuration-runtime-trace/src/config.mjs',
  'task-packs/code-understanding-v1/configuration-runtime-trace/src/formatter.mjs',
  'task-packs/code-understanding-v1/configuration-runtime-trace/src/runtime.mjs',
  'task-packs/code-understanding-v1/configuration-runtime-trace/scripts/validate-submission.mjs',
  'task-packs/code-understanding-v1/configuration-runtime-trace/tests/runtime.test.mjs',
]
const sourceFiles = Object.fromEntries(await Promise.all(sourcePaths.map(async (path) => [path, sha256(await readFile(resolve(root, path)))])))
const report = {
  schemaVersion: 1, generatedAt: new Date().toISOString(),
  scope: 'code-understanding v1 fixture/property tests plus fresh Codex unified lifecycle; no historical Session input',
  sourceRevision: (await runFile('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' })).stdout.trim(),
  sourceFiles, runEvidence: { path: runPath.slice(root.length + 1), sha256: sha256(await readFile(runPath)) },
  runId: run.runId, taskId: trial.taskId, agentVariantId: trial.agentVariantId, normalizedEventCount: trial.normalizedEventCount,
  resultHash: trial.resultHash, artifactManifestHash: trial.artifactManifestHash, nativeMetrics: trial.nativeMetrics,
  gradingJobId: run.gradingJobId, analysisJobId: run.analysisJobId, cleanupVerified: true, runtimeResidue,
}
const output = resolve(root, option('--output') ?? 'docs/evidence/evaluation/code-understanding-acceptance-20260803.json')
await mkdir(dirname(output), { recursive: true, mode: 0o700 })
await writeFile(output, JSON.stringify(report, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
process.stdout.write(JSON.stringify({ ok: true, runId: run.runId, metrics: trial.nativeMetrics, managedRuntimeResidue: 0, output }) + '\n')

async function managedRuntimeResidue() {
  const [instances, networks, acls] = await Promise.all([
    lxc(['list', '--format', 'json'], (entry) => /^(?:eval-|ae-)/u.test(String(entry.name))),
    lxc(['network', 'list', '--format', 'json'], (entry) => /^ae-n-/u.test(String(entry.name))),
    lxc(['network', 'acl', 'list', '--format', 'json'], (entry) => /^ae-a-/u.test(String(entry.name))),
  ])
  return { instances, networks, acls }
}
async function lxc(args, matches) { const result = await runFile('lxc', args, { cwd: root, encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }); return JSON.parse(result.stdout).filter(matches).map((entry) => entry.name).sort() }
function sha256(value) { return createHash('sha256').update(value).digest('hex') }
function isHash(value) { return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value) }
function option(name) { for (let index = 2; index < process.argv.length; index += 1) if (process.argv[index] === name) return process.argv[index + 1]; else if (process.argv[index]?.startsWith(name + '=')) return process.argv[index].slice(name.length + 1) }
