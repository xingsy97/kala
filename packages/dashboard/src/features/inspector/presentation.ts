import type { AgentState, Message } from '@agent-kernel/kernel'

import type { RunHealthItem, StateDiffSummaryItem } from './debugger-model.js'
import type { StatusTopologyNode, TraceCategory } from './trace-types.js'

/** Pure inspector presentation helpers (labels, tones, truncation). */

export function shortTopologyValue(node: StatusTopologyNode): string {
  if (node.id === 'host') return node.value.replace(/^socket /u, '')
  if (node.id === 'executor') return compactPath(node.value)
  if (node.id === 'llm') return compactModelLabel(node.value)
  return node.value
}

export function compactPath(value: string): string {
  if (!value.startsWith('/')) return value
  const parts = value.split('/').filter(Boolean)
  if (parts.length <= 3) return value
  return `/${parts.slice(-3).join('/')}`
}

export function compactModelLabel(value: string): string {
  return value
    .replace('anthropic / ', '')
    .replace('kernel / ', '')
    .replace(/-internal$/u, '')
}

export function topologyTone(status: StatusTopologyNode['status']): string {
  if (status === 'ok') return 'bg-emerald-500 dark:bg-emerald-400'
  if (status === 'warn') return 'bg-amber-500 dark:bg-amber-400'
  if (status === 'error') return 'bg-rose-500 dark:bg-rose-400'
  return 'bg-muted-foreground/50'
}

export function shortHealthLabel(label: string): string {
  if (label === 'Missing HTTP traces') return 'Missing traces'
  if (label === 'Pending approvals') return 'Approvals'
  if (label === 'Failed tools') return 'Tool failures'
  return label
}

export function diffSummaryTone(tone: StateDiffSummaryItem['tone']): string {
  if (tone === 'added') return 'text-emerald-700 dark:text-emerald-300'
  if (tone === 'removed') return 'text-rose-700 dark:text-rose-300'
  if (tone === 'changed') return 'text-amber-700 dark:text-amber-300'
  return 'text-muted-foreground'
}

export function summarizeTextForCard(text: string): string {
  const compact = text.replace(/\s+/g, ' ').trim()
  if (!compact) return 'empty text'
  return compact.length > 48 ? `text ${compact.length} chars` : compactCardSummary(compact)
}

export function compactNameCounts(names: readonly string[], limit: number): string {
  const counts = new Map<string, number>()
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1)
  const entries = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  const shown = entries.slice(0, limit).map(([name, count]) => count > 1 ? `${name} x${count}` : name)
  const remaining = entries.length - shown.length
  return remaining > 0 ? `${shown.join(', ')} +${remaining}` : shown.join(', ')
}

export function compactCardSummary(value: string): string {
  const compact = value.replace(/\s+/g, ' ').trim()
  return compact.length > 72 ? `${compact.slice(0, 69)}...` : compact
}

export function messageRoleTone(role: Message['role']): string {
  if (role === 'user') return 'text-sky-600 dark:text-sky-300'
  if (role === 'assistant') return 'text-violet-600 dark:text-violet-300'
  if (role === 'tool') return 'text-emerald-600 dark:text-emerald-300'
  return 'text-amber-600 dark:text-amber-300'
}

export function adapterTransformSummary(provider: string): string {
  if (provider === 'anthropic') {
    return 'systemPrompt -> body.system; messages -> body.messages; tool_call -> tool_use; tool_result -> tool_result; ToolSchema[] -> body.tools'
  }
  if (provider === 'openai') {
    return 'systemPrompt -> system message; messages -> body.messages; tool_call/tool_result -> OpenAI-compatible tool messages; ToolSchema[] -> tools'
  }
  return 'HTTP trace captured; exact adapter output is shown in API Request'
}

export function apiAdapterLabel(provider: string): string {
  if (provider === 'anthropic') return 'Anthropic Messages API'
  if (provider === 'openai') return 'OpenAI-compatible Chat API'
  if (provider === 'kernel') return 'not captured'
  return provider
}

export function formatTraceDuration(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 'not captured'
  if (value < 1000) return `${Math.round(value)}ms`
  if (value < 60_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}s`
  const minutes = Math.floor(value / 60_000)
  const seconds = Math.round((value % 60_000) / 1000)
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`
}

export function shortStatus(status: AgentState['status'] | undefined): string {
  if (!status) return 'none'
  if (status === 'executing_tools') return 'executing'
  if (status === 'awaiting_approval') return 'approval'
  return status
}

export function statusTone(status: AgentState['status'] | undefined): string | undefined {
  if (status === 'error') return 'text-rose-600 dark:text-rose-300'
  if (status === 'awaiting_approval') return 'text-amber-600 dark:text-amber-300'
  if (status === 'executing_tools') return 'text-emerald-600 dark:text-emerald-300'
  if (status === 'thinking') return 'text-violet-600 dark:text-violet-300'
  return undefined
}

export function healthTone(tone: RunHealthItem['tone']): string {
  if (tone === 'ok') return 'text-emerald-600 dark:text-emerald-300'
  if (tone === 'warn') return 'text-amber-600 dark:text-amber-300'
  if (tone === 'error') return 'text-rose-600 dark:text-rose-300'
  return 'text-muted-foreground'
}

export function minimapTone(cat: TraceCategory): string {
  if (cat === 'user') return 'bg-sky-500/70 hover:bg-sky-500'
  if (cat === 'llm') return 'bg-violet-500/70 hover:bg-violet-500'
  if (cat === 'tool') return 'bg-emerald-500/70 hover:bg-emerald-500'
  if (cat === 'approval') return 'bg-amber-500/70 hover:bg-amber-500'
  return 'bg-muted-foreground/50 hover:bg-muted-foreground'
}
