import {
  BenchmarkDescriptorSchema, BenchmarkNativeResultSchema, ResolvedTaskSchema,
  type BenchmarkNativeResult, type NormalizedFailure, type ResolvedTask,
} from '@agent-kernel/eval-protocol'
import type { BenchmarkAdapterPlugin, EvaluationBenchmarkAdapter, SandboxExecutionTarget, VerificationArtifacts, VerificationInput } from '@agent-kernel/eval-sdk'

export type CustomTaskPackInput = { tasks: readonly ResolvedTask[] }

export class CustomTaskPackAdapter implements EvaluationBenchmarkAdapter {
  readonly descriptor = BenchmarkDescriptorSchema.parse({
    schemaVersion: 1, id: 'custom-task-pack', label: 'Custom Task Pack', version: '1.0.0', official: false,
    nativePrimaryMetric: 'passed', verifierId: 'custom-task-verifier', verifierVersion: '1.0.0',
  })

  async resolveTasks(input: unknown): Promise<readonly ResolvedTask[]> {
    if (!input || typeof input !== 'object' || Array.isArray(input) || !Array.isArray((input as CustomTaskPackInput).tasks)) {
      throw new Error('custom task pack input requires a tasks array')
    }
    return (input as CustomTaskPackInput).tasks.map((task) => {
      const parsed = ResolvedTaskSchema.parse(task)
      if (parsed.taskPackId !== this.descriptor.id) throw new Error('custom task has the wrong taskPackId: ' + parsed.taskPackId)
      return parsed
    })
  }

  async prepareTask(task: ResolvedTask, sandbox: SandboxExecutionTarget): Promise<void> {
    if (task.taskPackId !== this.descriptor.id) throw new Error('task is not a custom task-pack task')
    const initialized = await sandbox.execute({
      argv: ['sh', '-ceu', 'test -d /workspace; test -z "$(find /workspace -mindepth 1 -maxdepth 1 -print -quit)"; git init -q; git config user.name agent-evaluation; git config user.email evaluation@localhost; printf "# Deterministic evaluation fixture\n" > README.md; git add README.md; git commit -qm fixture'],
      cwd: sandbox.workspacePath, timeoutMs: 30_000,
    })
    if (initialized.exitCode !== 0) throw new Error('custom task fixture initialization failed: ' + initialized.stderr.slice(0, 1_000))
  }

  async verify(input: VerificationInput): Promise<VerificationArtifacts> {
    const steps: Array<{ stepId: string; passed: boolean; exitCode: number | null; timedOut: boolean; stdout: string; stderr: string }> = []
    for (const step of input.task.verification) {
      const result = await input.sandbox.execute({ argv: step.argv, cwd: step.cwd === '.' ? input.sandbox.workspacePath : input.sandbox.workspacePath + '/' + step.cwd, timeoutMs: step.timeoutMs }, input.signal)
      steps.push({ stepId: step.stepId, passed: !result.timedOut && result.exitCode === step.requiredExitCode, exitCode: result.exitCode, timedOut: result.timedOut, stdout: result.stdout, stderr: result.stderr })
    }
    const passed = steps.every((step) => step.passed)
    const raw = { schemaVersion: 1, verifierVersion: this.descriptor.verifierVersion, passed, steps }
    const artifactPath = 'custom-task-pack/' + safeId(input.trialId) + '/native-result.json'
    const written = await input.sandbox.execute({
      argv: ['sh', '-ceu', 'mkdir -p /artifacts/"$(dirname "$1")"; cat > /artifacts/"$1"', 'write-result', artifactPath],
      stdin: JSON.stringify(raw, null, 2) + '\n', timeoutMs: 10_000,
    })
    if (written.exitCode !== 0) throw new Error('custom verifier result artifact could not be written')
    return {
      result: BenchmarkNativeResultSchema.parse({ schemaVersion: 1, benchmarkId: this.descriptor.id, verifierId: this.descriptor.verifierId, verifierVersion: this.descriptor.verifierVersion, nativeMetrics: { passed, passedSteps: steps.filter((step) => step.passed).length, totalSteps: steps.length }, rawResultRef: artifactPath, officialEvidence: false }),
      stdout: steps.map((step) => step.stdout).join(''), stderr: steps.map((step) => step.stderr).join(''), artifactPaths: [artifactPath],
    }
  }

  explain(result: BenchmarkNativeResult): Readonly<Record<string, unknown>> {
    return { primaryMetric: 'passed', passed: result.nativeMetrics.passed === true, officialEvidence: false, verifierVersion: result.verifierVersion }
  }

  normalizeFailure(result: BenchmarkNativeResult): NormalizedFailure | null {
    if (result.nativeMetrics.passed === true) return null
    return { schemaVersion: 1, category: 'agent_failure', responsibility: 'agent', code: 'CUSTOM_TASK_FAILED', summary: 'One or more declared custom task verification steps failed', retryable: false, observedStateSufficientForRecovery: true, evidenceRefs: [result.rawResultRef] }
  }
}

function safeId(value: string): string { return value.replace(/[^A-Za-z0-9._:-]/gu, '-').slice(0, 120) }
export function createCustomTaskPackAdapter(): CustomTaskPackAdapter { return new CustomTaskPackAdapter() }
export const evaluationPlugins: readonly BenchmarkAdapterPlugin[] = [{ kind: 'benchmark-adapter', descriptor: createCustomTaskPackAdapter().descriptor, create: createCustomTaskPackAdapter }]
