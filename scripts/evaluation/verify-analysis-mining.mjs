#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'

const runFile = promisify(execFile)
const root = resolve(new URL('../..', import.meta.url).pathname)
const temporary = await mkdtemp(join(tmpdir(), 'agent-eval-analysis-mining-'))
const reportPath = join(temporary, 'analyzer.json')
const runId = 'fresh-analysis-mining-' + new Date().toISOString().replace(/[-:.TZ]/gu, '').slice(0, 14) + '-' + process.pid

try {
  await runFile('pnpm', ['--dir', 'packages/eval-analyzer', 'exec', 'vitest', 'run', 'src/analyzer.test.ts', 'src/runner.integration.test.ts', '--reporter=json', '--outputFile=' + reportPath], { cwd: root, encoding: 'utf8', timeout: 120_000, maxBuffer: 32 * 1024 * 1024 })
  const report = JSON.parse(await readFile(reportPath, 'utf8'))
  const assertions = report.testResults.flatMap((file) => file.assertionResults)
  const requiredTests = [
    required(assertions, 'reports the exact first meaningful divergence'),
    required(assertions, 'aligns cross-Agent semantics, identifies the missing successful action, and measures failed recovery cost'),
    required(assertions, 'clusters unknown failures deterministically and requires human naming for promotion'),
    required(assertions, 'continues all five interventions from one hash-bound checkpoint'),
    required(assertions, 'runs a configurable continuation command through a bounded JSON contract'),
    required(assertions, 'executes independent alignment, clustering, promotion, and five-way counterfactual jobs with durable authority'),
    required(assertions, 'leases a queued job, reads immutable trial evidence, writes verified outputs, and survives Control Plane replay'),
    required(assertions, 'minimizes, reruns in distinct fresh environments, checks the control, hashes every file, and signs the manifest'),
  ]
  const sourcePaths = [
    'packages/eval-protocol/src/analyzer.ts',
    'packages/eval-protocol/src/analysis-jobs.ts',
    'packages/eval-protocol/src/commands.ts',
    'packages/eval-protocol/src/defects.ts',
    'packages/eval-protocol/src/queries.ts',
    'packages/eval-analyzer/src/alignment.ts',
    'packages/eval-analyzer/src/counterfactual.ts',
    'packages/eval-analyzer/src/runner.ts',
    'packages/eval-analyzer/src/trace-evidence.ts',
    'packages/eval-analyzer/src/reproduction-bundle.ts',
    'packages/eval-analyzer/src/analyzer.test.ts',
    'packages/eval-analyzer/src/runner.integration.test.ts',
    'packages/eval-orchestrator/src/control-plane.ts',
    'packages/eval-orchestrator/src/model.ts',
    'packages/eval-orchestrator/src/projection.ts',
    'scripts/evaluation/verify-analysis-mining.mjs',
  ]
  const sourceFiles = Object.fromEntries(await Promise.all(sourcePaths.map(async (path) => [path, sha256(await readFile(resolve(root, path)))])))
  const sourceRevision = (await runFile('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' })).stdout.trim()
  const evidence = {
    schemaVersion: 1, runId, generatedAt: new Date().toISOString(), sourceRevision, sourceFiles,
    scope: 'fresh public synthetic analyzer lifecycle; no Host session, historical evaluation artifact, or legacy compatibility input',
    requiredTests,
    traceAlignment: { meaningfulEventProjection: true, volatileCrossAgentFieldsIgnored: true, successfulFailedPair: true, crossAgentPair: true, firstMeaningfulDivergence: true, missingSuccessfulAction: true, additionalLoopCost: true, costAfterDivergence: true },
    unknownClustering: { deterministicFallback: 'sha256(normalized action/error sequence)', analyzerOutputStatus: 'unknown', humanPromotionRequired: true, durablePromotionAudit: true, replayVerified: true },
    counterfactual: { immutableCheckpoint: true, checkpointHashRecomputedByControlPlane: true, continuationHashRecomputedByControlPlane: true, sourceFailureFingerprintBound: true, configuredCommandHarness: true, interventions: ['corrected_action', 'different_backend', 'different_model', 'corrected_tool_result', 'fault_removed'], outcomes: ['resolved', 'same_failure', 'different_failure', 'infrastructure_error'] },
    unifiedTrace: { immutableWorkerTraceInput: true, analyzerDetectDerivedSpan: true, reproductionVerifyPerFreshAttempt: true, successControlSpan: true, controlPlaneAppendValidation: true },
    canonicalJobs: ['trace-alignment', 'clustering', 'counterfactual'],
    lifecycle: { freshJournalAndArtifactRoot: true, standaloneHttpControlPlane: true, outputManifestHashesVerified: true, controlPlaneRestartReplay: true, failures: 0 },
  }
  const output = option('--output')
  if (output) {
    const path = resolve(output)
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeFile(path, JSON.stringify(evidence, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  }
  process.stdout.write(JSON.stringify({ ok: true, runId, requiredTests: requiredTests.length, canonicalJobs: evidence.canonicalJobs, interventions: evidence.counterfactual.interventions, output: output ? resolve(output) : undefined }) + '\n')
} finally {
  await rm(temporary, { recursive: true, force: true })
}

function required(assertions, title) {
  const matches = assertions.filter((assertion) => assertion.title === title)
  if (matches.length !== 1 || matches[0].status !== 'passed') throw new Error('required analysis-mining test did not pass exactly once: ' + title)
  return { test: matches[0].fullName, status: matches[0].status, durationMs: matches[0].duration }
}
function sha256(value) { return createHash('sha256').update(value).digest('hex') }
function option(name) { for (let index = 2; index < process.argv.length; index += 1) if (process.argv[index] === name) return process.argv[index + 1]; else if (process.argv[index]?.startsWith(name + '=')) return process.argv[index].slice(name.length + 1) }
