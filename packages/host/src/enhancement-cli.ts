import {
  exportRolloutSidecar,
  exportSessionTraceArtifacts,
  type ExportRolloutSidecarInput,
  type ExportSessionTraceInput,
} from './enhancement-export.js'
import { profileSession, scoreSession, type ProfileSessionInput, type ScoreSessionInput } from './eval/generic.js'
import { auditSessionReliability, type AuditSessionReliabilityInput } from './reliability.js'

export type EnhancementCliCommand =
  | { kind: 'none' }
  | ({ kind: 'eval-score-session' } & ScoreSessionInput)
  | ({ kind: 'profile-session' } & ProfileSessionInput)
  | ({ kind: 'reliability-audit-session' } & AuditSessionReliabilityInput)
  | ({ kind: 'trace-export-session' } & ExportSessionTraceInput)
  | ({ kind: 'rollout-export-session' } & ExportRolloutSidecarInput)

export function parseEnhancementCli(argv: readonly string[]): EnhancementCliCommand {
  if (argv[0] !== 'enhancement') return { kind: 'none' }
  if (argv[1] === 'trace' && argv[2] === 'export-session') {
    const rest = argv.slice(3)
    return {
      kind: 'trace-export-session',
      rootDir: value(rest, '--root-dir') ?? 'runs/enhancement',
      sessionLogPath: required(rest, '--session-log'),
      runId: value(rest, '--run-id'),
      evalInstanceId: value(rest, '--eval-instance-id'),
      workspaceRoot: value(rest, '--workspace-root'),
    }
  }
  if (argv[1] === 'eval' && argv[2] === 'score-session') {
    const rest = argv.slice(3)
    return {
      kind: 'eval-score-session',
      rootDir: value(rest, '--root-dir') ?? 'runs/eval/session-score',
      sessionLogPath: required(rest, '--session-log'),
      instanceId: value(rest, '--instance-id'),
      patchPath: value(rest, '--patch'),
      requireDone: flag(rest, '--require-done'),
      workspaceRoot: value(rest, '--workspace-root'),
    }
  }
  if (argv[1] === 'profile' && argv[2] === 'session') {
    const rest = argv.slice(3)
    return {
      kind: 'profile-session',
      rootDir: value(rest, '--root-dir') ?? 'runs/profile/session',
      sessionLogPath: required(rest, '--session-log'),
      pricingPath: value(rest, '--pricing'),
    }
  }
  if (argv[1] === 'reliability' && argv[2] === 'audit-session') {
    const rest = argv.slice(3)
    return {
      kind: 'reliability-audit-session',
      rootDir: value(rest, '--root-dir') ?? 'runs/reliability/session',
      sessionLogPath: required(rest, '--session-log'),
    }
  }
  if (argv[1] === 'rollout' && argv[2] === 'export-session') {
    const rest = argv.slice(3)
    return {
      kind: 'rollout-export-session',
      rootDir: value(rest, '--root-dir') ?? 'runs/rollouts',
      sessionLogPath: required(rest, '--session-log'),
      taskId: required(rest, '--task-id'),
      frameworkTarget: frameworkTarget(required(rest, '--framework')),
      runId: value(rest, '--run-id'),
      evalInstanceId: value(rest, '--eval-instance-id'),
      workspaceRoot: value(rest, '--workspace-root'),
      model: value(rest, '--model'),
      weightVersion: value(rest, '--weight-version'),
      rewardPath: value(rest, '--reward'),
      tokenSegmentsPath: value(rest, '--token-segments'),
    }
  }
  throw new Error(`unknown enhancement command: ${argv.slice(1).join(' ') || '<missing>'}`)
}

export async function runEnhancementCli(command: EnhancementCliCommand): Promise<boolean> {
  if (command.kind === 'none') return false
  if (command.kind === 'trace-export-session') {
    const result = await exportSessionTraceArtifacts(command)
    console.log(JSON.stringify(result, null, 2))
    return true
  }
  if (command.kind === 'eval-score-session') {
    const result = await scoreSession(command)
    console.log(JSON.stringify({ scoresPath: result.scoresPath, summary: result.summary }, null, 2))
    return true
  }
  if (command.kind === 'profile-session') {
    const result = await profileSession(command)
    console.log(JSON.stringify({ profilePath: result.profilePath, profile: result.profile }, null, 2))
    return true
  }
  if (command.kind === 'reliability-audit-session') {
    const result = await auditSessionReliability(command)
    console.log(JSON.stringify({ auditPath: result.auditPath, audit: result.audit }, null, 2))
    return true
  }
  const result = await exportRolloutSidecar(command)
  console.log(JSON.stringify({
    rolloutId: result.sidecar.rollout_id,
    sidecarPath: result.sidecarPath,
    traceArtifact: result.traceArtifact,
  }, null, 2))
  return true
}

function value(argv: readonly string[], name: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === name) return argv[i + 1]
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1)
  }
  return undefined
}

function required(argv: readonly string[], name: string): string {
  const found = value(argv, name)
  if (!found) throw new Error(`missing required ${name}`)
  return found
}

function flag(argv: readonly string[], name: string): boolean {
  return argv.includes(name)
}

function frameworkTarget(value: string): ExportRolloutSidecarInput['frameworkTarget'] {
  if (value === 'slime' || value === 'verl' || value === 'trl' || value === 'openrlhf') return value
  return 'unknown'
}
