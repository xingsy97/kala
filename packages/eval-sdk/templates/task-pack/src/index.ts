import {
  BenchmarkDescriptorSchema,
  BenchmarkNativeResultSchema,
  ResolvedTaskSchema,
  defineBenchmarkAdapterPlugin,
  type BenchmarkNativeResult,
  type EvaluationBenchmarkAdapter,
  type NormalizedFailure,
  type ResolvedTask,
  type SandboxExecutionTarget,
  type VerificationArtifacts,
  type VerificationInput,
} from '@agent-kernel/eval-sdk'

const descriptor = BenchmarkDescriptorSchema.parse({
  schemaVersion: 1, protocolVersions: [1], id: 'example:sample-task-pack', label: 'Sample Task Pack', version: '1.0.0',
  official: false, nativePrimaryMetric: 'passed', verifierId: 'example:sample-task-verifier', verifierVersion: '1.0.0',
  capabilities: ['resolve-tasks', 'prepare-task', 'verify', 'explain', 'normalize-failure'],
})

class SampleTaskPackAdapter implements EvaluationBenchmarkAdapter {
  readonly descriptor = descriptor

  async resolveTasks(input: unknown): Promise<readonly ResolvedTask[]> {
    if (!input || typeof input !== 'object' || !Array.isArray((input as { tasks?: unknown }).tasks)) throw new Error('sample task pack requires a tasks array')
    return (input as { tasks: unknown[] }).tasks.map((task) => {
      const parsed = ResolvedTaskSchema.parse(task)
      if (parsed.taskPackId !== descriptor.id) throw new Error('taskPackId must be ' + descriptor.id)
      return parsed
    })
  }

  async prepareTask(_task: ResolvedTask, sandbox: SandboxExecutionTarget): Promise<void> {
    const ready = await sandbox.execute({ argv: ['test', '-d', sandbox.workspacePath], cwd: sandbox.workspacePath, timeoutMs: 10_000 })
    if (ready.exitCode !== 0) throw new Error('sample task workspace is unavailable')
  }

  async verify(input: VerificationInput): Promise<VerificationArtifacts> {
    const steps = []
    for (const step of input.task.verification) {
      const cwd = step.cwd === '.' ? input.sandbox.workspacePath : input.sandbox.workspacePath + '/' + step.cwd
      const executed = await input.sandbox.execute({ argv: step.argv, cwd, timeoutMs: step.timeoutMs }, input.signal)
      steps.push({ stepId: step.stepId, passed: !executed.timedOut && executed.exitCode === step.requiredExitCode, exitCode: executed.exitCode, timedOut: executed.timedOut })
    }
    const passed = steps.every((step) => step.passed)
    const rawResultRef = 'example:sample-task-pack/' + input.trialId + '/native-result.json'
    return {
      result: BenchmarkNativeResultSchema.parse({ schemaVersion: 1, benchmarkId: descriptor.id, verifierId: descriptor.verifierId, verifierVersion: descriptor.verifierVersion, nativeMetrics: { passed, passedSteps: steps.filter((step) => step.passed).length, totalSteps: steps.length }, rawResultRef, officialEvidence: false }),
      stdout: JSON.stringify({ steps }) + '\n', stderr: '', artifactPaths: [rawResultRef],
    }
  }

  explain(result: BenchmarkNativeResult): Readonly<Record<string, unknown>> { return { passed: result.nativeMetrics.passed === true, verifierVersion: result.verifierVersion } }

  normalizeFailure(result: BenchmarkNativeResult): NormalizedFailure | null {
    return result.nativeMetrics.passed === true ? null : { schemaVersion: 1, category: 'agent_failure', responsibility: 'agent', code: 'SAMPLE_TASK_FAILED', summary: 'A declared sample task verification step failed', retryable: false, observedStateSufficientForRecovery: true, evidenceRefs: [result.rawResultRef] }
  }
}

export const evaluationPlugins = [defineBenchmarkAdapterPlugin({
  kind: 'benchmark-adapter', descriptor, create: () => new SampleTaskPackAdapter(),
})]
