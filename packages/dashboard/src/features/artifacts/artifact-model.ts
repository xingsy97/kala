/**
 * Pure artifact model helpers (no React/DOM). Extracted from the artifacts UI so
 * they can be unit-tested and reused. Types are imported type-only from the
 * artifacts internals module (erased at runtime, no cycle).
 */
import type {
  EvalProgressContentRow,
  EvalRunRow,
  EvalSummaryContentRow,
  EvalTrialArtifactRef,
  EvalTrialRow,
  OpsArtifactKind,
  TrialArtifactCategory,
  TrialArtifactGroup,
  TrialArtifactItem,
} from './shared/internals.js'

const trialArtifactCategoryOrder: readonly TrialArtifactCategory[] = ['patch', 'trace', 'harness', 'log', 'prompt', 'metadata', 'other']

export function isOpsArtifactKind(kind: string): kind is OpsArtifactKind {
  return kind === 'reliability_audit' || kind === 'reliability_chaos' || kind === 'rl_rollout_sidecar' || kind === 'rl_token_segments' || kind === 'rl_adapter' || kind === 'subagent_graph' || kind === 'trace' || kind === 'message_assembly' || kind === 'router_decision' || kind === 'tool_catalog'
}

export function opsKindOrder(kind: OpsArtifactKind): number {
  return ['reliability_audit', 'reliability_chaos', 'rl_rollout_sidecar', 'rl_token_segments', 'rl_adapter', 'subagent_graph', 'trace', 'message_assembly', 'router_decision', 'tool_catalog'].indexOf(kind)
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export function evalRunRoot(summaryPath: string): string {
  if (summaryPath.endsWith('/summary.json')) return summaryPath.slice(0, -'/summary.json'.length)
  if (summaryPath.endsWith('/progress.json')) return summaryPath.slice(0, -'/progress.json'.length)
  return summaryPath.replace(/\/[^/]+$/, '')
}

export function resolveTrialArtifactPath(runRoot: string, uri: string): string {
  if (uri.startsWith('/') || uri.includes('://')) return uri
  if (uri === runRoot || uri.startsWith(`${runRoot}/`)) return uri
  return `${runRoot}/${uri}`
}

export function groupTrialArtifacts(runRoot: string, artifacts: readonly EvalTrialArtifactRef[]): TrialArtifactGroup[] {
  const byCategory = new Map<TrialArtifactCategory, TrialArtifactItem[]>()
  for (const artifact of artifacts) {
    const uri = artifact.uri
    const path = uri ? resolveTrialArtifactPath(runRoot, uri) : null
    const category = classifyTrialArtifact(artifact)
    const title = uri ?? '(inline artifact)'
    const meta = [artifact.kind ?? 'artifact', artifact.mediaType].filter(Boolean).join(' / ')
    const items = byCategory.get(category) ?? []
    items.push({ artifact, category, path, title, meta })
    byCategory.set(category, items)
  }
  return trialArtifactCategoryOrder
    .map((category) => {
      const items = byCategory.get(category) ?? []
      return { category, items }
    })
    .filter((group) => group.items.length > 0)
}

export function classifyTrialArtifact(artifact: EvalTrialArtifactRef): TrialArtifactCategory {
  const kind = (artifact.kind ?? '').toLowerCase()
  const uri = (artifact.uri ?? '').toLowerCase()
  const mediaType = (artifact.mediaType ?? '').toLowerCase()
  if (kind === 'diff' || uri.endsWith('.diff') || uri.endsWith('.patch') || mediaType.includes('diff')) return 'patch'
  if (kind === 'trace' || uri.includes('trace') || uri.includes('openinference')) return 'trace'
  if (uri.includes('/harness/') || uri.includes('swebench-result')) return 'harness'
  if (uri.endsWith('prompt.txt') || uri.includes('/prompt.')) return 'prompt'
  if (kind === 'log' || uri.endsWith('.log') || uri.includes('stdout') || uri.includes('stderr') || mediaType.startsWith('text/plain')) return 'log'
  if (kind === 'metadata' || mediaType.includes('json')) return 'metadata'
  return 'other'
}

export function trialArtifactCategoryLabelKey(category: TrialArtifactCategory): string {
  switch (category) {
    case 'patch': return 'artifacts.eval.artifactCategories.patch'
    case 'trace': return 'artifacts.eval.artifactCategories.trace'
    case 'harness': return 'artifacts.eval.artifactCategories.harness'
    case 'log': return 'artifacts.eval.artifactCategories.log'
    case 'prompt': return 'artifacts.eval.artifactCategories.prompt'
    case 'metadata': return 'artifacts.eval.artifactCategories.metadata'
    case 'other': return 'artifacts.eval.artifactCategories.other'
    default: return 'artifacts.eval.artifactCategories.other'
  }
}

export function mergeEvalRuns(
  summaries: readonly EvalSummaryContentRow[],
  progresses: readonly EvalProgressContentRow[],
): EvalRunRow[] {
  const byRoot = new Map<string, EvalRunRow>()
  for (const row of summaries) {
    const root = evalRunRoot(row.path)
    byRoot.set(root, { ...(byRoot.get(root) ?? { key: root, root }), summaryPath: row.path, summary: row.summary })
  }
  for (const row of progresses) {
    const root = evalRunRoot(row.path)
    byRoot.set(root, { ...(byRoot.get(root) ?? { key: root, root }), progressPath: row.path, progress: row.progress })
  }
  return [...byRoot.values()].sort((a, b) => {
    const aTime = a.progress?.updatedAt ?? a.progress?.startedAt ?? a.summaryPath ?? a.key
    const bTime = b.progress?.updatedAt ?? b.progress?.startedAt ?? b.summaryPath ?? b.key
    return bTime.localeCompare(aTime)
  })
}

export function trialStableId(row: EvalTrialRow): string {
  return row.trial.trialId ?? row.trial.instanceId ?? row.path
}

export function trialInstanceId(row: EvalTrialRow): string {
  return row.trial.instanceId ?? row.trial.trialId ?? row.path.split('/').pop()?.replace(/\.json$/, '') ?? row.path
}


// ── Pure field accessors + formatters (moved from artifacts internals) ──

export function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' ? value : undefined
}


export function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}


export function booleanField(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key]
  return typeof value === 'boolean' ? value : undefined
}


export function arrayField(record: Record<string, unknown>, key: string): readonly unknown[] | undefined {
  const value = record[key]
  return Array.isArray(value) ? value : undefined
}


export function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0
}


export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}


export function formatPercent(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${Math.round(value * 100)}%` : 'n/a'
}


export function formatDuration(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'n/a'
  if (value < 1000) return `${Math.round(value)}ms`
  if (value < 60_000) return `${(value / 1000).toFixed(1)}s`
  return `${Math.round(value / 60_000)}m`
}


export function formatBytesMetric(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? formatBytes(value) : 'n/a'
}


export function formatInteger(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value).toLocaleString('en-US') : '0'
}


export function formatDurationMetric(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${Math.round(value)}ms` : 'n/a'
}


export function formatDeltaValue(value: number, percent: boolean): string {
  const prefix = value > 0 ? '+' : ''
  return percent ? `${prefix}${Math.round(value * 100)}%` : `${prefix}${value}`
}


export function formatConfidence(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${Math.round(value * 100)}%` : 'n/a'
}
