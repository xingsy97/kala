import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ResolvedTask, SandboxPolicy } from '@agent-kernel/eval-protocol'
import type { EvaluationSandboxProvider, SandboxExecutionTarget } from '@agent-kernel/eval-sdk'

const HASH = 'a'.repeat(64)

export type SandboxConformanceResult = {
  provider: string
  checks: Readonly<Record<'hostPathInaccessible' | 'trialIsolation' | 'networkDenied' | 'resourceBounded' | 'cancellationKillsDescendants' | 'cleanupComplete' | 'environmentLockReproducible', boolean>>
  evidence: Readonly<Record<string, unknown>>
}

export async function runSandboxConformance(provider: EvaluationSandboxProvider, policy: SandboxPolicy): Promise<SandboxConformanceResult> {
  const workerDataDir = await mkdtemp(join(tmpdir(), 'eval-sandbox-conformance-'))
  const marker = 'host-secret-' + randomUUID()
  await writeFile(join(workerDataDir, 'host-marker'), marker, { mode: 0o600 })
  const task = fixtureTask()
  const targets: SandboxExecutionTarget[] = []
  let first: SandboxExecutionTarget | undefined
  let second: SandboxExecutionTarget | undefined
  const checks = { hostPathInaccessible: false, trialIsolation: false, networkDenied: false, resourceBounded: false, cancellationKillsDescendants: false, cleanupComplete: false, environmentLockReproducible: false }
  const evidence: Record<string, unknown> = {}
  try {
    first = await provider.create({ workerId: 'conformance-worker', trialId: 'conformance-a-' + randomUUID(), task, policy, workerDataDir }); targets.push(first)
    second = await provider.create({ workerId: 'conformance-worker', trialId: 'conformance-b-' + randomUUID(), task, policy, workerDataDir }); targets.push(second)
    const markerPath = join(workerDataDir, 'host-marker')
    const hostCandidates = [markerPath, '/host' + markerPath, '/mnt/host' + markerPath, '/run/host' + markerPath, '/var/lib/snapd/hostfs' + markerPath]
    const host = await first.execute({ argv: ['sh', '-ceu', 'for p do test ! -r "$p" || exit 41; done', 'host-check', ...hostCandidates], timeoutMs: 10_000 })
    checks.hostPathInaccessible = host.exitCode === 0
    const isolatedWrite = await first.execute({ argv: ['sh', '-ceu', 'printf isolated > /workspace/only-a'], timeoutMs: 10_000 })
    const isolated = await second.execute({ argv: ['test', '!', '-e', '/workspace/only-a'], timeoutMs: 10_000 })
    checks.trialIsolation = isolatedWrite.exitCode === 0 && isolated.exitCode === 0
    const network = await first.execute({ argv: ['sh', '-ceu', 'test ! -e /sys/class/net/eth0; ! awk \'$2=="00000000" && $3=="00000000" { found=1 } END { exit found ? 0 : 1 }\' /proc/net/route'], timeoutMs: 10_000 })
    checks.networkDenied = network.exitCode === 0 && !network.timedOut
    const cgroupLimit = policy.provider === 'lxd-vm'
      ? 'limit=$(systemctl show "${AGENT_EVAL_SYSTEMD_UNIT:?}" --property="$1" --value); printf \'%s\' "$limit"; test "$limit" != infinity && test "$limit" -le "$2"'
      : 'cg=$(awk -F: \'$1=="0" { print $3 }\' /proc/self/cgroup); if test -f "/sys/fs/cgroup/$1"; then file="/sys/fs/cgroup/$1"; else file="/sys/fs/cgroup${cg}/$1"; fi; limit=$(cat "$file"); printf \'%s\' "$limit"; test "$limit" != max && test "$limit" -le "$2"'
    const pidsKey = policy.provider === 'lxd-vm' ? 'TasksMax' : 'pids.max'
    const memoryKey = policy.provider === 'lxd-vm' ? 'MemoryMax' : 'memory.max'
    const pids = await first.execute({ argv: ['sh', '-ceu', cgroupLimit, 'limit', pidsKey, String(policy.resources.pids)], timeoutMs: 10_000 })
    const memory = await first.execute({ argv: ['sh', '-ceu', cgroupLimit, 'limit', memoryKey, String(policy.resources.memoryMb * 1024 * 1024)], timeoutMs: 10_000 })
    checks.resourceBounded = pids.exitCode === 0 && memory.exitCode === 0
    const controller = new AbortController()
    const execution = first.execute({ argv: ['sh', '-ceu', 'sleep 300 & wait'], timeoutMs: 60_000 }, controller.signal)
    setTimeout(() => controller.abort(new Error('conformance cancel')), 100).unref()
    const cancelled = await execution
    const afterCancel = await first.execute({ argv: ['true'], timeoutMs: 5_000 })
    checks.cancellationKillsDescendants = cancelled.signal !== undefined && afterCancel.exitCode !== 0
    evidence.probes = { host, isolatedWrite, isolated, network, pids, memory, cancellation: cancelled, afterCancel }
    await provider.destroy(first); targets.splice(targets.indexOf(first), 1); const firstGone = await provider.verifyDestroyed(first)
    first = await provider.create({ workerId: 'conformance-worker', trialId: 'conformance-replay-' + randomUUID(), task, policy, workerDataDir }); targets.push(first)
    const firstCollected = await provider.collect(first); const secondCollected = await provider.collect(second)
    checks.environmentLockReproducible = canonicalLock(firstCollected.environmentLock) === canonicalLock(secondCollected.environmentLock)
    await provider.destroy(first); targets.splice(targets.indexOf(first), 1)
    await provider.destroy(second); targets.splice(targets.indexOf(second), 1)
    checks.cleanupComplete = firstGone && await provider.verifyDestroyed(first) && await provider.verifyDestroyed(second)
    evidence.environmentLock = firstCollected.environmentLock
    return { provider: provider.descriptor.providerId, checks, evidence }
  } finally {
    for (const target of targets) await provider.destroy(target).catch(() => undefined)
    await rm(workerDataDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

function fixtureTask(): ResolvedTask {
  return { schemaVersion: 1, taskId: 'sandbox-conformance', taskPackId: 'custom-task-pack', taskPackVersion: '1', title: 'Sandbox conformance', prompt: 'Run deterministic sandbox checks.', repository: { kind: 'artifact', archiveRef: 'fixtures/empty.tar', archiveSha256: HASH, revision: 'conformance-revision' }, fixtureManifestHash: HASH, faultScenarioIds: [], verification: [{ stepId: 'true', argv: ['true'], cwd: '.', timeoutMs: 1_000, requiredExitCode: 0 }], analysis: { constraints: [], protectedPaths: [], hiddenVerifierPaths: [] }, lxdInitMode: 'keepalive', policy: { license: { status: 'granted', basis: 'MIT' }, permissions: { evaluation: { status: 'granted', basis: 'local conformance testing' }, training: { status: 'denied', basis: 'not required' } }, sourceProvenance: { status: 'granted', sourceRefs: ['builtin:sandbox-conformance'] }, publication: { artifact: { status: 'denied', basis: 'internal conformance only' }, report: { status: 'denied', basis: 'internal conformance only' }, leaderboard: { status: 'denied', basis: 'internal conformance only' }, redistribution: { status: 'denied', basis: 'internal conformance only' } } } }
}

function canonicalLock(lock: import('@agent-kernel/eval-protocol').EnvironmentLock): string {
  return JSON.stringify({ ...lock, provider: undefined })
}
