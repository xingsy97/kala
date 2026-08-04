import {
  BenchmarkDescriptorSchema, BenchmarkNativeResultSchema, ResolvedTaskSchema,
  type BenchmarkDescriptor, type BenchmarkNativeResult, type NormalizedFailure, type ResolvedTask,
} from '@agent-kernel/eval-protocol'
import type { EvaluationBenchmarkAdapter, SandboxExecutionTarget, VerificationArtifacts, VerificationInput } from '@agent-kernel/eval-sdk'
import type { BenchmarkAdapterPlugin } from '@agent-kernel/eval-sdk'

export type VerificationStepResult = {
  stepId: string
  nativeMetric?: string
  passed: boolean
  exitCode: number | null
  timedOut: boolean
  stdout: string
  stderr: string
  emittedMetrics: Record<string, number | string | boolean>
}

export type DeclarativeBenchmarkPolicy = {
  descriptor: BenchmarkDescriptor
  taskPackId: ResolvedTask['taskPackId']
  failureCode: string
  failureSummary: string
  deriveMetrics(steps: readonly VerificationStepResult[], input: VerificationInput): Record<string, number | string | boolean>
}

export class DeclarativeBenchmarkAdapter implements EvaluationBenchmarkAdapter {
  readonly descriptor: BenchmarkDescriptor
  constructor(private readonly policy: DeclarativeBenchmarkPolicy) { this.descriptor = BenchmarkDescriptorSchema.parse(policy.descriptor) }

  async resolveTasks(input: unknown): Promise<readonly ResolvedTask[]> {
    if (!input || typeof input !== 'object' || Array.isArray(input) || !Array.isArray((input as { tasks?: unknown }).tasks)) throw new Error(this.descriptor.id + ' input requires a tasks array')
    return (input as { tasks: unknown[] }).tasks.map((task) => {
      const parsed = ResolvedTaskSchema.parse(task)
      if (parsed.taskPackId !== this.policy.taskPackId) throw new Error('task has wrong taskPackId for ' + this.descriptor.id + ': ' + parsed.taskPackId)
      return parsed
    })
  }

  async prepareTask(task: ResolvedTask, sandbox: SandboxExecutionTarget): Promise<void> {
    if (task.taskPackId !== this.policy.taskPackId) throw new Error('task is not owned by ' + this.descriptor.id)
    if (task.repository.kind !== 'artifact') throw new Error(this.descriptor.id + ' requires a content-addressed artifact repository')
    const empty = await sandbox.execute({ argv: ['sh', '-ceu', 'test -d "$1"; test -z "$(find "$1" -mindepth 1 -maxdepth 1 -print -quit)"', 'benchmark-preflight', sandbox.workspacePath], timeoutMs: 10_000 })
    if (empty.exitCode !== 0) throw new Error(this.descriptor.id + ' workspace is not an empty fresh sandbox')
    await sandbox.putArchive(task.repository.archiveRef, sandbox.workspacePath)
    const prepared = await sandbox.execute({
      argv: ['sh', '-ceu', 'test -d .git; test "$(git rev-parse HEAD)" = "$1"; test -z "$(git status --porcelain=v1 --untracked-files=all)"', 'verify-repository', task.repository.revision],
      cwd: sandbox.workspacePath, env: verifierGitEnvironment(sandbox.workspacePath), timeoutMs: 30_000,
    })
    if (prepared.exitCode !== 0) throw new Error(this.descriptor.id + ' repository revision or cleanliness check failed: ' + prepared.stderr.slice(0, 1_000))
  }

  async verify(input: VerificationInput): Promise<VerificationArtifacts> {
    const steps: VerificationStepResult[] = []
    for (const step of input.task.verification) {
      const result = await input.sandbox.execute({ argv: step.argv, cwd: step.cwd === '.' ? input.sandbox.workspacePath : input.sandbox.workspacePath + '/' + step.cwd, env: verifierGitEnvironment(input.sandbox.workspacePath), timeoutMs: step.timeoutMs }, input.signal)
      steps.push({ stepId: step.stepId, nativeMetric: step.nativeMetric, passed: !result.timedOut && result.exitCode === step.requiredExitCode, exitCode: result.exitCode, timedOut: result.timedOut, stdout: result.stdout, stderr: result.stderr, emittedMetrics: parseEmittedMetrics(result.stdout) })
    }
    const nativeMetrics = this.policy.deriveMetrics(steps, input)
    if (!(this.descriptor.nativePrimaryMetric in nativeMetrics)) throw new Error(this.descriptor.id + ' did not produce its declared primary metric')
    const raw = { schemaVersion: 1, benchmarkId: this.descriptor.id, verifierVersion: this.descriptor.verifierVersion, steps, nativeMetrics }
    const artifactPath = this.descriptor.id + '/' + safeId(input.trialId) + '/native-result.json'
    const written = await input.sandbox.execute({ argv: ['sh', '-ceu', 'mkdir -p /artifacts/"$(dirname "$1")"; cat > /artifacts/"$1"', 'write-result', artifactPath], stdin: JSON.stringify(raw, null, 2) + '\n', timeoutMs: 10_000 })
    if (written.exitCode !== 0) throw new Error(this.descriptor.id + ' verifier result artifact could not be written')
    return { result: BenchmarkNativeResultSchema.parse({ schemaVersion: 1, benchmarkId: this.descriptor.id, verifierId: this.descriptor.verifierId, verifierVersion: this.descriptor.verifierVersion, nativeMetrics, rawResultRef: artifactPath, officialEvidence: false }), stdout: steps.map((step) => step.stdout).join(''), stderr: steps.map((step) => step.stderr).join(''), artifactPaths: [artifactPath] }
  }

  explain(result: BenchmarkNativeResult): Readonly<Record<string, unknown>> { return { primaryMetric: this.descriptor.nativePrimaryMetric, value: result.nativeMetrics[this.descriptor.nativePrimaryMetric], officialEvidence: result.officialEvidence, verifierVersion: result.verifierVersion } }

  normalizeFailure(result: BenchmarkNativeResult): NormalizedFailure | null {
    if (metricPassed(result.nativeMetrics[this.descriptor.nativePrimaryMetric])) return null
    return { schemaVersion: 1, category: 'agent_failure', responsibility: 'agent', code: this.policy.failureCode, summary: this.policy.failureSummary, retryable: false, observedStateSufficientForRecovery: true, evidenceRefs: [result.rawResultRef] }
  }
}

export function allStepsMetrics(primaryMetric: string, steps: readonly VerificationStepResult[]): Record<string, number | string | boolean> {
  const metrics: Record<string, number | string | boolean> = {}
  for (const step of steps) { metrics[step.nativeMetric ?? step.stepId] = step.passed; Object.assign(metrics, step.emittedMetrics) }
  metrics[primaryMetric] ??= steps.every((step) => step.passed)
  metrics.passedSteps = steps.filter((step) => step.passed).length
  metrics.totalSteps = steps.length
  return metrics
}

function parseEmittedMetrics(stdout: string): Record<string, number | string | boolean> {
  for (const line of stdout.trim().split('\n').reverse()) {
    try {
      const parsed = JSON.parse(line) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
      const source = 'metrics' in parsed && typeof (parsed as { metrics?: unknown }).metrics === 'object' ? (parsed as { metrics: unknown }).metrics : parsed
      const metrics: Record<string, number | string | boolean> = {}
      for (const [name, value] of Object.entries(source as Record<string, unknown>)) if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') metrics[name] = value
      return metrics
    } catch {}
  }
  return {}
}

function metricPassed(value: unknown): boolean { return value === true || typeof value === 'number' && value > 0 }
function safeId(value: string): string { return value.replace(/[^A-Za-z0-9._:-]/gu, '-').slice(0, 120) }

function verifierGitEnvironment(workspacePath: string): Readonly<Record<string, string>> {
  return { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'safe.directory', GIT_CONFIG_VALUE_0: workspacePath }
}

export function createDeclarativeBenchmarkPlugin(policy: DeclarativeBenchmarkPolicy): BenchmarkAdapterPlugin {
  const create = () => new DeclarativeBenchmarkAdapter(policy)
  return { kind: 'benchmark-adapter', descriptor: create().descriptor, create }
}
