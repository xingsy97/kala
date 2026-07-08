import {
  exportRolloutFrameworkAdapter,
  exportRolloutSidecar,
  exportRolloutSegments,
  exportSessionTraceArtifacts,
  type ExportRolloutAdapterInput,
  type ExportRolloutSidecarInput,
  type ExportSessionTraceInput,
} from './enhancement-export.js'
import { buildArtifactManifest, type BuildArtifactManifestInput } from './artifact-manifest.js'
import {
  compareEvalRuns,
  judgeScore,
  profileSession,
  scoreSession,
  type CompareEvalRunsInput,
  type JudgeScoreInput,
  type ProfileSessionInput,
  type ScoreSessionInput,
} from './eval/generic.js'
import { auditSessionReliability, replayReliabilityChaos, type AuditSessionReliabilityInput, type ReliabilityChaosReplayInput } from './reliability.js'
import { buildMemoryIndex, type BuildMemoryIndexInput } from './memory-index.js'
import { exportSubAgentGraph, type ExportSubAgentGraphInput } from './subagent-graph.js'

export type EnhancementCliCommand =
  | { kind: 'none' }
  | ({ kind: 'eval-score-session' } & ScoreSessionInput)
  | ({ kind: 'eval-judge-score' } & JudgeScoreInput)
  | ({ kind: 'eval-compare-runs' } & CompareEvalRunsInput)
  | ({ kind: 'profile-session' } & ProfileSessionInput)
  | ({ kind: 'reliability-audit-session' } & AuditSessionReliabilityInput)
  | ({ kind: 'reliability-chaos-replay' } & ReliabilityChaosReplayInput)
  | ({ kind: 'memory-index' } & BuildMemoryIndexInput)
  | ({ kind: 'subagents-graph' } & ExportSubAgentGraphInput)
  | ({ kind: 'artifacts-manifest' } & BuildArtifactManifestInput)
  | ({ kind: 'trace-export-session' } & ExportSessionTraceInput)
  | ({ kind: 'rollout-export-session' } & ExportRolloutSidecarInput)
  | ({ kind: 'rollout-export-segments' } & ExportSessionTraceInput)
  | ({ kind: 'rollout-export-adapter' } & ExportRolloutAdapterInput)

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
  if (argv[1] === 'eval' && argv[2] === 'compare-runs') {
    const rest = argv.slice(3)
    return {
      kind: 'eval-compare-runs',
      rootDir: value(rest, '--root-dir') ?? 'runs/eval/compare',
      baselineSummaryPath: required(rest, '--baseline-summary'),
      candidateSummaryPath: required(rest, '--candidate-summary'),
    }
  }
  if (argv[1] === 'eval' && argv[2] === 'judge-score') {
    const rest = argv.slice(3)
    return {
      kind: 'eval-judge-score',
      rootDir: value(rest, '--root-dir') ?? 'runs/eval/judge-score',
      promptPath: required(rest, '--prompt'),
      responsePath: required(rest, '--response'),
      judgeModel: required(rest, '--judge-model'),
      scorer: value(rest, '--scorer'),
      instanceId: value(rest, '--instance-id'),
      threshold: numberValue(rest, '--threshold'),
      inputRef: value(rest, '--input-ref'),
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
  if (argv[1] === 'reliability' && argv[2] === 'chaos-replay') {
    const rest = argv.slice(3)
    return {
      kind: 'reliability-chaos-replay',
      rootDir: value(rest, '--root-dir') ?? 'runs/reliability/chaos',
      sessionLogPaths: listValue(rest, '--session-logs'),
    }
  }
  if (argv[1] === 'memory' && argv[2] === 'index') {
    const rest = argv.slice(3)
    return {
      kind: 'memory-index',
      rootDir: value(rest, '--root-dir') ?? 'runs/memory',
      workspaceRoot: value(rest, '--workspace-root'),
      includeGlobal: flag(rest, '--include-global'),
    }
  }
  if (argv[1] === 'subagents' && argv[2] === 'graph') {
    const rest = argv.slice(3)
    return {
      kind: 'subagents-graph',
      rootDir: value(rest, '--root-dir') ?? 'runs/subagents',
      sessionsDir: required(rest, '--sessions-dir'),
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
  if (argv[1] === 'rollout' && argv[2] === 'export-segments') {
    const rest = argv.slice(3)
    return {
      kind: 'rollout-export-segments',
      rootDir: value(rest, '--root-dir') ?? 'runs/rollouts',
      sessionLogPath: required(rest, '--session-log'),
      runId: value(rest, '--run-id'),
      evalInstanceId: value(rest, '--eval-instance-id'),
      workspaceRoot: value(rest, '--workspace-root'),
    }
  }
  if (argv[1] === 'rollout' && argv[2] === 'export-adapter') {
    const rest = argv.slice(3)
    const framework = value(rest, '--framework')
    return {
      kind: 'rollout-export-adapter',
      rootDir: value(rest, '--root-dir') ?? 'runs/rollouts',
      sidecarPath: required(rest, '--sidecar'),
      ...(framework ? { frameworkTarget: frameworkTarget(framework) } : {}),
    }
  }
  if (argv[1] === 'artifacts' && argv[2] === 'manifest') {
    const rest = argv.slice(3)
    const maxHashBytes = numberValue(rest, '--max-hash-bytes')
    return {
      kind: 'artifacts-manifest',
      rootDir: value(rest, '--root-dir') ?? 'runs/enhancement',
      outputPath: value(rest, '--output'),
      ...(maxHashBytes === undefined ? {} : { maxHashBytes }),
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
  if (command.kind === 'eval-compare-runs') {
    const result = await compareEvalRuns(command)
    console.log(JSON.stringify({ comparisonPath: result.comparisonPath, comparison: result.comparison }, null, 2))
    return true
  }
  if (command.kind === 'eval-judge-score') {
    const result = await judgeScore(command)
    console.log(JSON.stringify({ scoresPath: result.scoresPath, judgeTrace: result.judgeTrace, summary: result.summary }, null, 2))
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
  if (command.kind === 'reliability-chaos-replay') {
    const result = await replayReliabilityChaos(command)
    console.log(JSON.stringify({ reportPath: result.reportPath, report: result.report }, null, 2))
    return true
  }
  if (command.kind === 'memory-index') {
    const result = await buildMemoryIndex(command)
    console.log(JSON.stringify({ indexPath: result.indexPath, entries: result.index.entries.length, warnings: result.index.warnings }, null, 2))
    return true
  }
  if (command.kind === 'subagents-graph') {
    const result = await exportSubAgentGraph(command)
    console.log(JSON.stringify({ graphPath: result.graphPath, nodes: result.graph.nodes.length, edges: result.graph.edges.length, warnings: result.graph.warnings }, null, 2))
    return true
  }
  if (command.kind === 'artifacts-manifest') {
    const result = await buildArtifactManifest(command)
    console.log(JSON.stringify({ manifestPath: result.manifestPath, summary: result.manifest.summary }, null, 2))
    return true
  }
  if (command.kind === 'rollout-export-segments') {
    const result = await exportRolloutSegments(command)
    console.log(JSON.stringify({ artifact: result.artifact, segmentCount: result.segments.segments.length }, null, 2))
    return true
  }
  if (command.kind === 'rollout-export-adapter') {
    const result = await exportRolloutFrameworkAdapter(command)
    console.log(JSON.stringify({ adapterPath: result.adapterPath, status: result.adapter.status, frameworkTarget: result.adapter.frameworkTarget }, null, 2))
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

function numberValue(argv: readonly string[], name: string): number | undefined {
  const found = value(argv, name)
  if (found === undefined) return undefined
  const parsed = Number(found)
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`invalid numeric ${name}: ${found}`)
  return parsed
}

function listValue(argv: readonly string[], name: string): readonly string[] {
  const found = value(argv, name)
  if (!found) throw new Error(`missing required ${name}`)
  return found.split(',').map((item) => item.trim()).filter(Boolean)
}

function frameworkTarget(value: string): ExportRolloutSidecarInput['frameworkTarget'] {
  if (value === 'slime' || value === 'verl' || value === 'trl' || value === 'openrlhf') return value
  return 'unknown'
}
