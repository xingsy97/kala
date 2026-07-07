/**
 * DiffPreview renders a compact preview of file-mutating tool calls so users
 * can approve or reject them with full context.
 *
 *  - `edit { path, old_string, new_string }`: line-based diff (old vs new
 *    strings only; not full file context). Adjacent del+add pairs collapse
 *    into `replace` rows so intra-line word diff can highlight only the
 *    changed substring.
 *  - `write { path, content }`: head-of-file preview + byte count.
 *
 * Non-mutating tools return null; the parent falls back to the JSON view.
 *
 * Syntax highlighting via shiki is a planned follow-up; the design in
 * docs/dashboard-advanced-debugger-features.md calls for build-time preload
 * with dual-theme CSS variables, which is enough moving parts to warrant
 * its own task. For now we render plaintext with add/del/replace tone.
 */

import { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'

import { ScrollArea } from '../../components/ui/scroll-area.js'
import { cn } from '../../lib/utils.js'
import {
  countAddDel,
  diffLines,
  diffWords,
  type LineDiffRow,
  type WordDiffSegment,
} from '../../lib/diff.js'

type EditInput = {
  path?: string
  file_path?: string
  old_string?: string
  oldText?: string
  new_string?: string
  newText?: string
  replace_all?: boolean
}

type WriteInput = {
  path?: string
  file_path?: string
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
  const path = filePathOf(input)
  const oldLines = (input.old_string ?? input.oldText ?? '').split('\n')
  const newLines = (input.new_string ?? input.newText ?? '').split('\n')
  const rows = diffLines(oldLines, newLines, EDIT_CONTEXT_LINES)
  const { added, deleted } = countAddDel(rows)
  const replaceAll = input.replace_all === true
  const changedHunks = rows.filter((row) => row.kind !== 'context' && row.kind !== 'gap').length
  return (
    <div
      className="mt-1.5 basis-full overflow-hidden rounded border border-amber-200 bg-card dark:border-amber-900/60"
      data-testid="diff-preview"
    >
      <div className="flex items-center justify-between gap-2 border-b border-border/50 bg-muted px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground" data-testid="diff-preview-header">
        <span className="min-w-0 truncate font-mono normal-case text-foreground">{path}</span>
        <span className="flex items-center gap-2">
          <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-800 dark:bg-amber-950/50 dark:text-amber-200">modified</span>
          <span className="font-mono text-emerald-700 dark:text-emerald-300">+{added}</span>
          <span className="font-mono text-rose-700 dark:text-rose-300">-{deleted}</span>
          <span>{changedHunks} changed</span>
          <span>{replaceAll ? 'edit · replace_all' : 'edit'}</span>
        </span>
      </div>
      <ScrollArea className="max-h-80">
        <pre className="whitespace-pre px-0 py-1 font-mono text-[11px] leading-snug">
          {rows.map((row, i) => (
            <DiffLineRow key={i} row={row} />
          ))}
        </pre>
      </ScrollArea>
    </div>
  )
}

function WritePreview({ input }: { input: WriteInput }): JSX.Element {
  const path = filePathOf(input)
  const content = typeof input.content === 'string' ? input.content : ''
  const bytes = new TextEncoder().encode(content).byteLength
  const lines = content.split('\n')
  const truncated = lines.length > WRITE_PREVIEW_LINES
  const shown = truncated ? lines.slice(0, WRITE_PREVIEW_LINES) : lines
  return (
    <div
      className="mt-1.5 basis-full overflow-hidden rounded border border-emerald-200 bg-card dark:border-emerald-900/60"
      data-testid="diff-preview"
    >
      <div className="flex items-center justify-between gap-2 border-b border-border/50 bg-muted px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground" data-testid="diff-preview-header">
        <span className="min-w-0 truncate font-mono normal-case text-foreground">{path}</span>
        <span className="flex items-center gap-2">
          <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-200">created/overwrite</span>
          write · {formatBytes(bytes)}
          {truncated ? ` · showing ${WRITE_PREVIEW_LINES} of ${lines.length} lines` : ''}
        </span>
      </div>
      <ScrollArea className="max-h-80">
        <pre className="whitespace-pre py-1 pr-2 font-mono text-[11px] leading-snug">
          {shown.map((line, i) => (
            <span key={i} className="flex">
              <GutterCell newNo={i + 1} />
              <span className="pl-1 text-emerald-700 dark:text-emerald-300">+ {line}</span>
            </span>
          ))}
          {truncated ? (
            <span className="mt-1 block px-2 text-muted-foreground italic">
              …{lines.length - WRITE_PREVIEW_LINES} more lines
            </span>
          ) : null}
        </pre>
      </ScrollArea>
    </div>
  )
}

function DiffLineRow({ row }: { row: LineDiffRow }): JSX.Element {
  const [open, setOpen] = useState(false)
  if (row.kind === 'gap') {
    return (
      <span className="flex flex-col border-y border-border/40 bg-muted/40 text-[10px] uppercase tracking-wider text-muted-foreground">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="flex items-center gap-2 px-2 py-0.5 text-left hover:bg-muted"
          data-testid="diff-gap-toggle"
        >
        {open ? <ChevronDown className="h-3 w-3" aria-hidden="true" /> : <ChevronRight className="h-3 w-3" aria-hidden="true" />}
        <span className="flex-1 border-t border-dashed border-border/60" aria-hidden="true" />
        <span>⋯ {row.count} unchanged line{row.count === 1 ? '' : 's'} ⋯</span>
        <span className="flex-1 border-t border-dashed border-border/60" aria-hidden="true" />
        </button>
        {open ? <span className="px-2 pb-1 text-[10px] normal-case tracking-normal">Collapsed unchanged context is hidden to keep the approval diff compact.</span> : null}
      </span>
    )
  }
  if (row.kind === 'context') {
    return (
      <span className="flex text-foreground dark:text-muted-foreground">
        <GutterCell oldNo={row.oldNo} newNo={row.newNo} />
        <span className="pl-2 pr-2">{row.text || ' '}</span>
      </span>
    )
  }
  if (row.kind === 'add') {
    return (
      <span className="flex bg-emerald-50 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200">
        <GutterCell newNo={row.newNo} sign="+" />
        <span className="pl-2 pr-2">{row.text || ' '}</span>
      </span>
    )
  }
  if (row.kind === 'del') {
    return (
      <span className="flex bg-rose-50 text-rose-800 dark:bg-rose-950/40 dark:text-rose-200">
        <GutterCell oldNo={row.oldNo} sign="-" />
        <span className="pl-2 pr-2">{row.text || ' '}</span>
      </span>
    )
  }
  const segments = diffWords(row.before, row.after)
  return (
    <>
      <span className="flex bg-rose-50 text-rose-800 dark:bg-rose-950/40 dark:text-rose-200">
        <GutterCell oldNo={row.oldNo} sign="-" />
        <span className="pl-2 pr-2">
          <WordDiffLine segments={segments} side="before" />
        </span>
      </span>
      <span className="flex bg-emerald-50 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200">
        <GutterCell newNo={row.newNo} sign="+" />
        <span className="pl-2 pr-2">
          <WordDiffLine segments={segments} side="after" />
        </span>
      </span>
    </>
  )
}

function filePathOf(input: { path?: string; file_path?: string }): string {
  if (typeof input.path === 'string' && input.path.length > 0) return input.path
  if (typeof input.file_path === 'string' && input.file_path.length > 0) return input.file_path
  return '(no path)'
}

function WordDiffLine({
  segments,
  side,
}: {
  segments: readonly WordDiffSegment[]
  side: 'before' | 'after'
}): JSX.Element {
  return (
    <>
      {segments.map((seg, i) => {
        if (seg.kind === 'equal') return <span key={i}>{seg.text}</span>
        if (side === 'before' && seg.kind === 'del') {
          return (
            <span
              key={i}
              className="bg-rose-200/70 text-rose-950 dark:bg-rose-500/40 dark:text-rose-50"
            >
              {seg.text}
            </span>
          )
        }
        if (side === 'after' && seg.kind === 'add') {
          return (
            <span
              key={i}
              className="bg-emerald-200/70 text-emerald-950 dark:bg-emerald-500/40 dark:text-emerald-50"
            >
              {seg.text}
            </span>
          )
        }
        return null
      })}
    </>
  )
}

function GutterCell({
  oldNo,
  newNo,
  sign,
}: {
  oldNo?: number
  newNo?: number
  sign?: '+' | '-'
}): JSX.Element {
  const bg =
    sign === '+'
      ? 'bg-emerald-100/70 dark:bg-emerald-900/50'
      : sign === '-'
        ? 'bg-rose-100/70 dark:bg-rose-900/50'
        : 'bg-muted/40'
  return (
    <span
      className={cn(
        'sticky left-0 z-10 flex flex-none select-none items-center gap-1 border-r border-border/40 px-1.5 text-[10px] text-muted-foreground',
        bg,
      )}
      aria-hidden="true"
    >
      <span className="w-6 text-right tabular-nums">{oldNo ?? ''}</span>
      <span className="w-6 text-right tabular-nums">{newNo ?? ''}</span>
      <span className="w-2 text-center font-mono text-[11px] text-foreground/70">
        {sign ?? ' '}
      </span>
    </span>
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}
