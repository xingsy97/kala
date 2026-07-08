import type { ToolCallContent, ToolResultContent } from '@agent-kernel/kernel'
import type { LucideIcon } from 'lucide-react'
import { CheckCircle2, Wrench, XCircle } from 'lucide-react'

import { cn } from '../../../lib/utils.js'

export type SummaryRow = {
  callId: string
  primary: string
  secondary?: string
  ok: boolean
}

export type GroupedToolRenderer = (args: {
  calls: readonly ToolCallContent[]
  results: ReadonlyMap<string, ToolResultContent>
}) => SummaryRow[]

export const genericRenderer: GroupedToolRenderer = ({ calls, results }) => {
  return calls.map((c) => {
    const r = results.get(c.callId)
    const preview = Object.entries(c.input)
      .slice(0, 2)
      .map(([k, v]) => `${k}=${truncate(previewValue(v), 40)}`)
      .join('  -  ')
    return {
      callId: c.callId,
      primary: preview || c.callId,
      ok: r ? r.ok : true,
    }
  })
}

export function previewValue(v: unknown): string {
  if (v == null) return String(v)
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) return `[${v.length} item${v.length === 1 ? '' : 's'}]`
  if (typeof v === 'object') {
    const keys = Object.keys(v as object)
    return `{${keys.length} field${keys.length === 1 ? '' : 's'}}`
  }
  return String(v)
}

export function truncate(s: string, n: number): string {
  if (s.length <= n) return s
  return `${s.slice(0, n - 1)} - `
}

export function firstLine(s: string): string {
  const idx = s.indexOf('\n')
  return idx === -1 ? s : s.slice(0, idx)
}

export function countLines(s: string): number {
  if (s.length === 0) return 0
  let n = 1
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++
  return n
}

export type ToolIconRenderer = {
  Icon: LucideIcon
  toneClass: string
}

export function toolStatusIcon(ok: boolean): ToolIconRenderer {
  return ok
    ? {
        Icon: CheckCircle2,
        toneClass: 'text-emerald-600 dark:text-emerald-400',
      }
    : {
        Icon: XCircle,
        toneClass: 'text-rose-600 dark:text-rose-400',
      }
}

export function GroupSummaryRow({
  row,
  onClick,
}: {
  row: SummaryRow
  onClick: () => void
}): JSX.Element {
  const { Icon, toneClass } = toolStatusIcon(row.ok)
  return (
    <button
      type="button"
      onClick={onClick}
      className="group/summary flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-xs transition-colors hover:bg-muted"
      data-testid={`grouped-tool-row-${row.callId}`}
    >
      <Icon className={cn('h-3 w-3 flex-none', toneClass)} aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground [overflow-wrap:anywhere]">
        {row.primary}
      </span>
      {row.secondary ? (
        <span className="flex-none truncate text-[11px] text-muted-foreground">
          {row.secondary}
        </span>
      ) : null}
    </button>
  )
}

export function GroupHeaderIcon(): JSX.Element {
  return <Wrench className="h-3.5 w-3.5 flex-none text-muted-foreground" aria-hidden="true" />
}
