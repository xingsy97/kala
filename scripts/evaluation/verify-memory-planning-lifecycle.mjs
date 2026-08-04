#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { promisify } from 'node:util'

const runFile = promisify(execFile)
const root = resolve(new URL('../..', import.meta.url).pathname)
const runPath = resolve(root, option('--run') ?? 'docs/evidence/evaluation/fresh-memory-planning-codex-20260803.json')
const run = JSON.parse(await readFile(runPath, 'utf8'))
const trial = run.trials?.[0]
const exactMetrics = {
  memory_recall: 1, memory_precision: 1, stale_memory_use_rate: 0, correction_compliance: 1, deletion_compliance: 1, cross_workspace_isolation: 1, compaction_retention: 1, long_term_recall: 1,
  prerequisite_edge_precision: 1, prerequisite_edge_recall: 1, parallel_branch_recall: 1, blocked_task_violation_rate: 0, replan_compliance: 1, plan_execution_alignment: 1, verified_completion_rate: 1, plan_bloat_ratio: 0,
  plan_converged: true, verifier_protocol_valid: true, passedSteps: 1, totalSteps: 1,
}

if (!run.runId?.startsWith('fresh-memory-planning-') || run.taskPackId !== 'memory-planning' || run.runState !== 'completed') throw new Error('fresh memory/planning run identity/state is incomplete')
if (run.agentIds?.length !== 1 || run.agentIds[0] !== 'codex' || run.freshSandboxes !== 1 || run.cleanupVerified !== true || run.workerErrors?.length !== 0) throw new Error('Agent/sandbox lifecycle evidence is incomplete')
if (!run.gradingJobId || !isHash(run.gradingOutputHash) || !run.analysisJobId || !isHash(run.analysisOutputHash)) throw new Error('grader/analyzer evidence is incomplete')
if (trial?.taskId !== 'release-handoff' || trial.agentVariantId !== 'codex' || trial.evidenceLevel !== 'native' || trial.normalizedEventCount < 1 || !isHash(trial.resultHash) || !isHash(trial.artifactManifestHash)) throw new Error('canonical trial evidence is incomplete')
for (const [name, expected] of Object.entries(exactMetrics)) if (trial.nativeMetrics?.[name] !== expected) throw new Error('memory/planning metric mismatch: ' + name)

const runtimeResidue = await managedRuntimeResidue()
if (Object.values(runtimeResidue).some((entries) => entries.length > 0)) throw new Error('managed runtime residue remains: ' + JSON.stringify(runtimeResidue))
const sourcePaths = [
  'adapters/benchmarks/common/src/index.ts',
  'adapters/benchmarks/memory-planning/src/index.ts',
  'adapters/benchmarks/memory-planning/src/index.test.ts',
  'scripts/evaluation/run-real-task-pack.mjs',
  'scripts/evaluation/verify-memory-planning-lifecycle.mjs',
  'task-packs/memory-planning-v1/release-handoff/TASK.md',
  'task-packs/memory-planning-v1/release-handoff/response.json',
  'task-packs/memory-planning-v1/release-handoff/memory/workspace-release/01-intake.md',
  'task-packs/memory-planning-v1/release-handoff/memory/workspace-release/02-compaction-summary.md',
  'task-packs/memory-planning-v1/release-handoff/memory/workspace-release/03-correction-and-forgetting.md',
  'task-packs/memory-planning-v1/release-handoff/memory/foreign-workspace/snapshot.md',
  'task-packs/memory-planning-v1/release-handoff/incident/path-drift.json',
  'task-packs/memory-planning-v1/release-handoff/scripts/run-step.mjs',
  'task-packs/memory-planning-v1/release-handoff/scripts/validate-submission.mjs',
  'task-packs/memory-planning-v1/release-handoff/tests/contracts.test.mjs',
]
const sourceFiles = Object.fromEntries(await Promise.all(sourcePaths.map(async (path) => [path, sha256(await readFile(resolve(root, path)))])))
const report = {
  schemaVersion: 1, generatedAt: new Date().toISOString(),
  scope: 'memory/planning v1 retention, isolation, correction, deletion, compaction, plan-graph property tests and fresh Codex unified lifecycle; no historical Session input',
  sourceRevision: (await runFile('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' })).stdout.trim(),
  sourceFiles, runEvidence: { path: runPath.slice(root.length + 1), sha256: sha256(await readFile(runPath)) },
  runId: run.runId, taskId: trial.taskId, agentVariantId: trial.agentVariantId, normalizedEventCount: trial.normalizedEventCount,
  resultHash: trial.resultHash, artifactManifestHash: trial.artifactManifestHash, nativeMetrics: trial.nativeMetrics,
  gradingJobId: run.gradingJobId, analysisJobId: run.analysisJobId, cleanupVerified: true, runtimeResidue,
}
const output = resolve(root, option('--output') ?? 'docs/evidence/evaluation/memory-planning-acceptance-20260803.json')
await mkdir(dirname(output), { recursive: true, mode: 0o700 })
await writeFile(output, JSON.stringify(report, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
process.stdout.write(JSON.stringify({ ok: true, runId: run.runId, metrics: trial.nativeMetrics, managedRuntimeResidue: 0, output }) + '\n')

async function managedRuntimeResidue() { const [instances, networks, acls] = await Promise.all([lxc(['list', '--format', 'json'], (entry) => /^(?:eval-|ae-)/u.test(String(entry.name))), lxc(['network', 'list', '--format', 'json'], (entry) => /^ae-n-/u.test(String(entry.name))), lxc(['network', 'acl', 'list', '--format', 'json'], (entry) => /^ae-a-/u.test(String(entry.name)))]); return { instances, networks, acls } }
async function lxc(args, matches) { const result = await runFile('lxc', args, { cwd: root, encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }); return JSON.parse(result.stdout).filter(matches).map((entry) => entry.name).sort() }
function sha256(value) { return createHash('sha256').update(value).digest('hex') }
function isHash(value) { return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value) }
function option(name) { for (let index = 2; index < process.argv.length; index += 1) if (process.argv[index] === name) return process.argv[index + 1]; else if (process.argv[index]?.startsWith(name + '=')) return process.argv[index].slice(name.length + 1) }
