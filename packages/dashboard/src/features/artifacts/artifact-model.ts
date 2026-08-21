/**
 * Pure product artifact model helpers (no React/DOM).
 */
import type {
  OpsArtifactKind,
} from './product-artifact-views.js'

export const OPS_ARTIFACT_KINDS: readonly OpsArtifactKind[] = ['reliability_audit', 'reliability_chaos', 'rl_rollout_sidecar', 'rl_token_segments', 'rl_adapter', 'subagent_graph', 'trace', 'message_assembly', 'router_decision', 'tool_catalog']

export function isOpsArtifactKind(kind: string): kind is OpsArtifactKind {
  return kind === 'reliability_audit' || kind === 'reliability_chaos' || kind === 'rl_rollout_sidecar' || kind === 'rl_token_segments' || kind === 'rl_adapter' || kind === 'subagent_graph' || kind === 'trace' || kind === 'message_assembly' || kind === 'router_decision' || kind === 'tool_catalog'
}

export function opsKindOrder(kind: OpsArtifactKind): number {
  return OPS_ARTIFACT_KINDS.indexOf(kind)
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
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


export function formatBytesMetric(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? formatBytes(value) : 'n/a'
}


export function formatInteger(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value).toLocaleString('en-US') : '0'
}


export function formatDurationMetric(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${Math.round(value)}ms` : 'n/a'
}


export function formatConfidence(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${Math.round(value * 100)}%` : 'n/a'
}
