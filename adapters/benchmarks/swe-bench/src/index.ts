import {
  BenchmarkDescriptorSchema, BenchmarkNativeResultSchema, ResolvedTaskSchema, SweBenchTaskInputSchema, canonicalJson, sha256Hex,
  type BenchmarkNativeResult, type NormalizedFailure, type ResolvedTask, type SweBenchTaskInput,
} from '@agent-kernel/eval-protocol'
import type { BenchmarkAdapterPlugin, EvaluationBenchmarkAdapter, SandboxExecutionTarget, VerificationArtifacts, VerificationInput } from '@agent-kernel/eval-sdk'

export type SweBenchTaskPackInput = {
  schemaVersion: 1
  datasetId: string
  datasetVersion: string
  split: string
  harnessRevision: string
  officialInstanceImageDigest: string
  trialSandboxImageDigest: string
  repositoryManifestHash: string
  officialRecord: SweBenchTaskInput['officialRecord']
  license: string
  evaluationPermission: string
  testTimeoutSeconds?: number
  namespace?: string | null
  instanceImageTag?: string
  envImageTag?: string
}

export class SweBenchBenchmarkAdapter implements EvaluationBenchmarkAdapter {
  readonly descriptor = BenchmarkDescriptorSchema.parse({
    schemaVersion: 1, id: 'swe-bench', label: 'SWE-Bench · pinned official harness · local run', version: '1.0.0', official: true, nativePrimaryMetric: 'resolved',
    verifierId: 'swe-bench-official', verifierVersion: 'f7bbbb2ccdf479001d6467c9e34af59e44a840f9',
  })

  async resolveTasks(input: unknown): Promise<readonly ResolvedTask[]> {
    const source = parseTaskPackInput(input)
    const benchmarkInput = SweBenchTaskInputSchema.parse({
      schemaVersion: 1, benchmarkId: 'swe-bench', datasetId: source.datasetId, datasetVersion: source.datasetVersion, split: source.split,
      harnessRevision: source.harnessRevision, officialInstanceImageDigest: source.officialInstanceImageDigest, trialSandboxImageDigest: source.trialSandboxImageDigest,
      officialRecord: source.officialRecord, testTimeoutSeconds: source.testTimeoutSeconds ?? 1_800,
      namespace: source.namespace === undefined ? 'swebench' : source.namespace, instanceImageTag: source.instanceImageTag ?? 'latest', envImageTag: source.envImageTag ?? 'latest',
    })
    return [ResolvedTaskSchema.parse({
      schemaVersion: 1, taskId: benchmarkInput.officialRecord.instance_id, taskPackId: 'swe-bench', taskPackVersion: source.datasetVersion,
      title: benchmarkInput.officialRecord.repo + ' / ' + benchmarkInput.officialRecord.instance_id, prompt: benchmarkInput.officialRecord.problem_statement,
      repository: { kind: 'git', url: 'https://github.com/' + benchmarkInput.officialRecord.repo + '.git', revision: benchmarkInput.officialRecord.base_commit, repositoryManifestHash: source.repositoryManifestHash },
      requiredSandboxImageDigest: source.trialSandboxImageDigest,
      fixtureManifestHash: source.repositoryManifestHash, faultScenarioIds: [],
      lxdInitMode: 'keepalive',
      verification: [{ stepId: 'swe-bench-official', argv: ['agent-eval-swe-bench-grade'], cwd: '.', timeoutMs: benchmarkInput.testTimeoutSeconds * 1_000, requiredExitCode: 0, nativeMetric: 'resolved' }],
      analysis: { constraints: [{ id: 'swe-bench-resolved', kind: 'evidence', sourceRef: 'benchmark#resolved', verifierId: this.descriptor.verifierId, verifierVersion: this.descriptor.verifierVersion, verifierMetric: 'resolved' }], protectedPaths: [], hiddenVerifierPaths: [] },
      benchmarkInput,
      policy: {
        license: { status: 'granted', basis: source.license },
        permissions: { evaluation: { status: 'granted', basis: source.evaluationPermission }, training: { status: 'unknown' } },
        sourceProvenance: { status: 'granted', sourceRefs: ['https://github.com/' + benchmarkInput.officialRecord.repo, 'dataset:' + source.datasetId + '@' + source.datasetVersion] },
        publication: { artifact: { status: 'granted', basis: source.evaluationPermission }, report: { status: 'granted', basis: source.evaluationPermission }, leaderboard: { status: 'granted', basis: source.evaluationPermission }, redistribution: { status: 'unknown' } },
      },
    })]
  }

  async prepareTask(task: ResolvedTask, sandbox: SandboxExecutionTarget): Promise<void> {
    const input = requiredInput(task)
    const lineageResult = await sandbox.execute({ argv: ['cat', '/etc/agent-eval/swe-bench-image.json'], timeoutMs: 10_000 })
    if (lineageResult.exitCode !== 0) throw new Error('SWE-Bench trial image is missing immutable source lineage')
    let lineage: unknown
    try { lineage = JSON.parse(lineageResult.stdout) } catch { throw new Error('SWE-Bench trial image has invalid source lineage') }
    if (!lineage || typeof lineage !== 'object' || Array.isArray(lineage)
      || (lineage as Record<string, unknown>).officialInstanceImageDigest !== input.officialInstanceImageDigest
      || (lineage as Record<string, unknown>).harnessRevision !== input.harnessRevision) {
      throw new Error('SWE-Bench trial image lineage does not match the task')
    }
    const prepared = await sandbox.execute({
      argv: ['sh', '-ceu', 'test -d /testbed/.git; test -d /workspace; rmdir /workspace; mv /testbed /workspace; ln -s /workspace /testbed'], timeoutMs: 120_000,
    })
    if (prepared.exitCode !== 0) throw new Error('SWE-Bench instance image does not contain a prepared /testbed repository')
    const gitEnvironment = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'safe.directory', GIT_CONFIG_VALUE_0: sandbox.workspacePath }
    const current = await sandbox.execute({ argv: ['git', 'rev-parse', 'HEAD'], cwd: sandbox.workspacePath, env: gitEnvironment, timeoutMs: 10_000 })
    if (current.exitCode !== 0 || current.stdout.trim() !== input.officialRecord.base_commit) throw new Error('SWE-Bench workspace base revision mismatch')
    const clean = await sandbox.execute({ argv: ['git', 'status', '--porcelain=v1', '--untracked-files=all'], cwd: sandbox.workspacePath, env: gitEnvironment, timeoutMs: 10_000 })
    if (clean.exitCode !== 0 || clean.stdout.trim() !== '') throw new Error('SWE-Bench workspace must be clean before Agent execution')
  }

  async verify(input: VerificationInput): Promise<VerificationArtifacts> {
    const taskInput = requiredInput(input.task)
    if (taskInput.harnessRevision !== this.descriptor.verifierVersion) throw new Error('SWE-Bench harness revision does not match adapter verifier version')
    const request = {
      schemaVersion: 1, runId: safeId(input.runId), trialId: safeId(input.trialId), officialInstanceImageDigest: taskInput.officialInstanceImageDigest,
      instance: taskInput.officialRecord, modelNameOrPath: input.agentVariant.backendId + '/' + input.agentVariant.model.modelId, modelPatch: input.agentArtifacts.finalDiff,
      testTimeoutSeconds: taskInput.testTimeoutSeconds, harnessRevision: taskInput.harnessRevision,
    }
    const result = await input.sandbox.execute({
      argv: ['agent-eval-swe-bench-grade'], cwd: input.sandbox.workspacePath, stdin: canonicalJson(request),
      timeoutMs: taskInput.testTimeoutSeconds * 1_000 + 120_000, env: { AGENT_EVAL_SWEBENCH_HARNESS_REVISION: taskInput.harnessRevision },
    }, input.signal)
    if (result.timedOut) throw new Error('official SWE-Bench verifier timed out')
    if (result.exitCode !== 0) throw new Error('official SWE-Bench verifier failed: ' + result.stderr.slice(0, 1_000))
    let native: unknown
    try { native = JSON.parse(result.stdout) } catch { throw new Error('official SWE-Bench verifier returned invalid JSON') }
    const parsed = parseGradeOutput(native, taskInput.officialRecord.instance_id)
    const artifactPath = 'swe-bench/' + safeId(input.trialId) + '/official-result.json'
    await input.sandbox.execute({ argv: ['sh', '-ceu', 'mkdir -p /artifacts/"$(dirname "$1")"; cat > /artifacts/"$1"', 'write-result', artifactPath], stdin: JSON.stringify(parsed.rawReport, null, 2) + '\n', timeoutMs: 10_000 })
    const benchmarkResult = BenchmarkNativeResultSchema.parse({
      schemaVersion: 1, benchmarkId: 'swe-bench', verifierId: this.descriptor.verifierId, verifierVersion: this.descriptor.verifierVersion,
      nativeMetrics: { resolved: parsed.resolved, completed: parsed.completed, patchApplied: parsed.patchApplied }, rawResultRef: artifactPath, officialEvidence: true,
    })
    return { result: benchmarkResult, stdout: result.stdout, stderr: result.stderr, artifactPaths: [artifactPath] }
  }

  explain(result: BenchmarkNativeResult): Readonly<Record<string, unknown>> {
    return { primaryMetric: 'resolved', resolved: result.nativeMetrics.resolved === true, officialEvidence: result.officialEvidence, verifierVersion: result.verifierVersion }
  }

  normalizeFailure(result: BenchmarkNativeResult): NormalizedFailure | null {
    if (result.nativeMetrics.resolved === true) return null
    return { schemaVersion: 1, category: 'agent_failure', responsibility: 'agent', code: 'SWE_BENCH_UNRESOLVED', summary: 'Official SWE-Bench harness did not resolve the instance', retryable: false, observedStateSufficientForRecovery: true, evidenceRefs: [result.rawResultRef] }
  }
}

function requiredInput(task: ResolvedTask): SweBenchTaskInput {
  if (task.taskPackId !== 'swe-bench') throw new Error('task is not a SWE-Bench task')
  return SweBenchTaskInputSchema.parse(task.benchmarkInput)
}

function parseTaskPackInput(input: unknown): SweBenchTaskPackInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('SWE-Bench task input must be an object')
  const value = input as Record<string, unknown>
  const required = ['datasetId', 'datasetVersion', 'split', 'harnessRevision', 'officialInstanceImageDigest', 'trialSandboxImageDigest', 'repositoryManifestHash', 'license', 'evaluationPermission'] as const
  for (const key of required) if (typeof value[key] !== 'string' || String(value[key]).length === 0) throw new Error('SWE-Bench task input requires ' + key)
  if (!value.officialRecord || typeof value.officialRecord !== 'object') throw new Error('SWE-Bench task input requires officialRecord')
  return value as unknown as SweBenchTaskPackInput
}

function parseGradeOutput(value: unknown, instanceId: string): { resolved: boolean; completed: boolean; patchApplied: boolean; rawReport: unknown } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('official SWE-Bench result must be an object')
  const body = value as Record<string, unknown>; const report = body.report
  if (!report || typeof report !== 'object' || Array.isArray(report)) throw new Error('official SWE-Bench result is missing report')
  const instance = (report as Record<string, unknown>)[instanceId]
  if (!instance || typeof instance !== 'object' || Array.isArray(instance)) throw new Error('official SWE-Bench report is missing instance result')
  const resolved = (instance as Record<string, unknown>).resolved
  if (typeof resolved !== 'boolean') throw new Error('official SWE-Bench report has invalid resolved value')
  return { resolved, completed: body.completed === true, patchApplied: body.patchApplied === true, rawReport: value }
}

function safeId(value: string): string { return value.replace(/[^A-Za-z0-9._:-]/gu, '-').slice(0, 120) }

export async function sweBenchTaskInputHash(input: SweBenchTaskPackInput): Promise<string> { return await sha256Hex(canonicalJson(input)) }
export function createSweBenchBenchmarkAdapter(): SweBenchBenchmarkAdapter { return new SweBenchBenchmarkAdapter() }
export const evaluationPlugins: readonly BenchmarkAdapterPlugin[] = [{ kind: 'benchmark-adapter', descriptor: createSweBenchBenchmarkAdapter().descriptor, create: createSweBenchBenchmarkAdapter }]
