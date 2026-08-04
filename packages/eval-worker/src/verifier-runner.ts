import type { AgentVariantSpec, ResolvedTask } from '@agent-kernel/eval-protocol'
import type { AgentRunArtifacts, EvaluationBenchmarkAdapter, SandboxExecutionTarget, VerificationArtifacts } from '@agent-kernel/eval-sdk'

export async function runVerifier(input: {
  adapter: EvaluationBenchmarkAdapter
  runId: string
  trialId: string
  task: ResolvedTask
  sandbox: SandboxExecutionTarget
  agentArtifacts: AgentRunArtifacts
  agentVariant: AgentVariantSpec
  signal: AbortSignal
}): Promise<VerificationArtifacts> {
  return await input.adapter.verify(input)
}
