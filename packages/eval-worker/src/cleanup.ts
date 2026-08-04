import type { EvaluationSandboxProvider, SandboxExecutionTarget } from '@agent-kernel/eval-sdk'

export async function destroyAndVerify(provider: EvaluationSandboxProvider, target: SandboxExecutionTarget): Promise<void> {
  await provider.destroy(target)
  if (!await provider.verifyDestroyed(target)) throw new Error('sandbox destruction verification failed: ' + target.sandboxId)
}
