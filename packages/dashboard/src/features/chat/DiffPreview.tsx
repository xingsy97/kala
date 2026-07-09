/**
 * DiffPreview renders a compact preview of file-mutating tool calls so users
 * can approve or reject them with full context.
 *
 *  - `edit { path, old_string, new_string }`: line-based diff (old vs new
 *    strings only; not full file context).
 *  - `write { path, content }`: head-of-file preview + byte count.
 *
 * Non-mutating tools return null; the parent falls back to the JSON view.
 */

import { ScrollArea } from '../../components/ui/scroll-area.js'

type EditInput = {
  path?: string
  old_string?: string
  new_string?: string
  replace_all?: boolean
}

type WriteInput = {
  path?: string
  content?: string
}

const WRITE_PREVIEW_LINES = 40
const EDIT_CONTEXT_LINES = 3

export function DiffPreview({
  toolName,
  input,
}: {
  toolName: string
  input: Record<string, unknown>
}): JSX.Element | null {
  if (toolName === 'edit') return <EditDiff input={input as EditInput} />
  if (toolName === 'write') return <WritePreview input={input as WriteInput} />
  return null
}

function EditDiff({ input }: { input: EditInput }): JSX.Element {
  const path = typeof input.path === 'string' ? input.path : '(no path)'
  const oldLines = (input.old_string ?? '').split('\n')
  const newLines = (input.new_string ?? '').split('\n')
  const rows = diffLines(oldLines, newLines, EDIT_CONTEXT_LINES)
  const replaceAll = input.replace_all === true
  return (
    <div
      className="mt-1.5 basis-full overflow-hidden rounded border border-amber-200 bg-white dark:border-amber-900/60 dark:bg-slate-950"
      data-testid="diff-preview"
    >
      <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-2 py-1 text-[10px] uppercase tracking-wide text-slate-500 dark:border-slate-800 dark:bg-slate-900/60 dark:text-slate-400">
        <span className="font-mono normal-case text-slate-700 dark:text-slate-200">{path}</span>
        <span>{replaceAll ? 'edit · replace_all' : 'edit'}</span>
      </div>
      <ScrollArea className="max-h-80">
        <pre className="whitespace-pre px-2 py-1 font-mono text-[11px] leading-snug">
          {rows.map((row, i) => (
            <DiffLineRow key={i} row={row} />
          ))}
        </pre>
      </ScrollArea>
    </div>
  )
}

function WritePreview({ input }: { input: WriteInput }): JSX.Element {
  const path = typeof input.path === 'string' ? input.path : '(no path)'
  const content = typeof input.content === 'string' ? input.content : ''
  const bytes = new TextEncoder().encode(content).byteLength
  const lines = content.split('\n')
  const truncated = lines.length > WRITE_PREVIEW_LINES
  const shown = truncated ? lines.slice(0, WRITE_PREVIEW_LINES) : lines
  return (
    <div
      className="mt-1.5 basis-full overflow-hidden rounded border border-emerald-200 bg-white dark:border-emerald-900/60 dark:bg-slate-950"
      data-testid="diff-preview"
    >
      <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-2 py-1 text-[10px] uppercase tracking-wide text-slate-500 dark:border-slate-800 dark:bg-slate-900/60 dark:text-slate-400">
        <span className="font-mono normal-case text-slate-700 dark:text-slate-200">{path}</span>
        <span>
          write · {formatBytes(bytes)}
          {truncated ? ` · showing ${WRITE_PREVIEW_LINES} of ${lines.length} lines` : ''}
        </span>
      </div>
      <ScrollArea className="max-h-80">
        <pre className="whitespace-pre px-2 py-1 font-mono text-[11px] leading-snug">
          {shown.map((line, i) => (
            <span key={i} className="flex">
              <span className="mr-2 w-8 flex-none select-none text-right text-slate-400">{i + 1}</span>
              <span className="text-emerald-700 dark:text-emerald-300">+ {line}</span>
            </span>
          ))}
          {truncated ? (
            <span className="mt-1 block text-slate-400 italic">…{lines.length - WRITE_PREVIEW_LINES} more lines</span>
          ) : null}
        </pre>
      </ScrollArea>
    </div>
  )
}

type DiffRow =
  | { kind: 'context'; text: string }
  | { kind: 'add'; text: string }
  | { kind: 'del'; text: string }
  | { kind: 'gap'; count: number }

function DiffLineRow({ row }: { row: DiffRow }): JSX.Element {
  if (row.kind === 'gap') {
    return (
      <span className="block px-1 text-slate-400 italic">
        … {row.count} unchanged line{row.count === 1 ? '' : 's'} skipped
      </span>
    )
  }
  const prefix = row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' '
  const tone =
    row.kind === 'add'
      ? 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200'
      : row.kind === 'del'
        ? 'bg-rose-50 text-rose-800 dark:bg-rose-950/40 dark:text-rose-200'
        : 'text-slate-700 dark:text-slate-300'
  return (
    <span className={`block px-1 ${tone}`}>
      <span className="mr-1 select-none">{prefix}</span>
      {row.text}
    </span>
  )
}

/**
 * Compute a diff between two arrays of lines using longest-common-subsequence
 * (LCS) walk-back, then collapse long stretches of unchanged lines into gap
 * markers so the preview stays readable when only a few lines actually
 * changed.
 */
export function diffLines(
  oldLines: readonly string[],
  newLines: readonly string[],
  context: number,
): DiffRow[] {
  const m = oldLines.length
  const n = newLines.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      const a = oldLines[i]!
      const b = newLines[j]!
      dp[i]![j] = a === b ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
    }
  }
  const raw: DiffRow[] = []
  let i = 0
  let j = 0
  while (i < m && j < n) {
    if (oldLines[i] === newLines[j]) {
      raw.push({ kind: 'context', text: oldLines[i]! })
      i++
      j++
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      raw.push({ kind: 'del', text: oldLines[i]! })
      i++
    } else {
      raw.push({ kind: 'add', text: newLines[j]! })
      j++
    }
  }
  while (i < m) {
    raw.push({ kind: 'del', text: oldLines[i]! })
    i++
  }
  while (j < n) {
    raw.push({ kind: 'add', text: newLines[j]! })
    j++
  }
  return collapseContext(raw, context)
}

function collapseContext(rows: readonly DiffRow[], context: number): DiffRow[] {
  const changeIdx = new Set<number>()
  for (let k = 0; k < rows.length; k++) {
    if (rows[k]!.kind !== 'context') changeIdx.add(k)
  }
  if (changeIdx.size === 0) return rows.slice(0, context)
  const keep = new Set<number>()
  for (const idx of changeIdx) {
    for (let d = -context; d <= context; d++) {
      const k = idx + d
      if (k >= 0 && k < rows.length) keep.add(k)
    }
  }
  const out: DiffRow[] = []
  let skipped = 0
  for (let k = 0; k < rows.length; k++) {
    if (keep.has(k)) {
      if (skipped > 0) {
        out.push({ kind: 'gap', count: skipped })
        skipped = 0
      }
      out.push(rows[k]!)
    } else {
      skipped++
    }
  }
  if (skipped > 0) out.push({ kind: 'gap', count: skipped })
  return out
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}
