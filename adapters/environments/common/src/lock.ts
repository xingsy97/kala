import { canonicalJson, sha256Hex, type EnvironmentLock, type ResolvedTask, type SandboxPolicy } from '@agent-kernel/eval-protocol'

export async function environmentLock(input: { policy: SandboxPolicy; task: ResolvedTask; resolvedImageDigest: string; toolchainVersions: Readonly<Record<string, string>> }): Promise<EnvironmentLock> {
  return {
    schemaVersion: 1, provider: input.policy.provider, imageDigest: input.resolvedImageDigest, repositoryRevision: input.task.repository.revision,
    dependencyLockHashes: {}, redactedEnvironment: {},
    resourcePolicyHash: await sha256Hex(canonicalJson(input.policy.resources)),
    networkPolicyHash: await sha256Hex(canonicalJson(input.policy.network)),
    toolchainVersions: { ...input.toolchainVersions },
    fixtureVersions: { [input.task.taskPackId]: input.task.taskPackVersion },
    faultInjectorVersions: Object.fromEntries(input.task.faultScenarioIds.map((id) => [id, 'declared-by-task-pack'])),
  }
}
