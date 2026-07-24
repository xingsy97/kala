/**
 * DiffPreview renders a compact preview of file-mutating tool calls so users
 * can approve or reject them with full context.
 *
 *  - `edit` / `replace_in_file { path, old_string, new_string }`: line-based diff (old vs new
 *    strings only; not full file context). Adjacent del+add pairs collapse
 *    into `replace` rows so intra-line word diff can highlight only the
 *    changed substring.
 *  - `replace_many_in_file { path, edits }`: one diff preview per exact replacement.
 *  - `write` / `write_file { path, content }`: head-of-file preview + byte count.
 *  - `apply_file_patch { patch }`: patch text preview with add/delete tone.
 *
 * Non-mutating tools return null; the parent falls back to the JSON view.
 *
 * Syntax highlighting via shiki is a planned follow-up; the design in
 * docs/dashboard/advanced-debugger-features.md calls for build-time preload
 * with dual-theme CSS variables, which is enough moving parts to warrant
 * its own task. For now we render plaintext with add/del/replace tone.
 */

import { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'

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

type MultiEditInput = {
  path?: string
  file_path?: string
  edits?: unknown
}

type PatchInput = {
  patch?: string
}

const WRITE_PREVIEW_LINES = 40
const EDIT_CONTEXT_LINES = 3
const PATCH_PREVIEW_LINES = 120

export function hasDiffPreviewForTool(toolName: string): boolean {
  return toolName === 'edit' ||
    toolName === 'write' ||
    toolName === 'write_file' ||
    toolName === 'replace_in_file' ||
    toolName === 'replace_many_in_file' ||
    toolName === 'apply_file_patch'
}

export function DiffPreview({
  toolName,
  input,
}: {
  toolName: string
  input: Record<string, unknown>
}): JSX.Element | null {
  if (toolName === 'edit') return <EditDiff input={input as EditInput} label="edit" />
  if (toolName === 'replace_in_file') return <EditDiff input={input as EditInput} label="replace_in_file" />
  if (toolName === 'replace_many_in_file') return <MultiEditDiff input={input as MultiEditInput} />
  if (toolName === 'write' || toolName === 'write_file') return <WritePreview input={input as WriteInput} label={toolName} />
  if (toolName === 'apply_file_patch') return <PatchPreview input={input as PatchInput} />
  return null
}

function EditDiff({ input, label }: { input: EditInput; label: string }): JSX.Element {
  const { t } = useTranslation()
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
      <div className="flex min-w-0 items-center justify-between gap-2 border-b border-border/50 bg-muted px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground" data-testid="diff-preview-header">
        <span className="min-w-0 truncate font-mono normal-case text-foreground">{path}</span>
        <span className="flex shrink-0 items-center gap-2">
          <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-800 dark:bg-amber-950/50 dark:text-amber-200">{t('chat.diff.modified')}</span>
          <span className="font-mono text-emerald-700 dark:text-emerald-300">+{added}</span>
          <span className="font-mono text-rose-700 dark:text-rose-300">-{deleted}</span>
          <span>{t('chat.diff.changed', { count: changedHunks })}</span>
          <span>{replaceAll ? `${label} · replace_all` : label}</span>
        </span>
      </div>
      <ScrollArea className="max-h-80 max-w-full">
        <pre className="min-w-max whitespace-pre px-0 py-1 font-mono text-[11px] leading-snug">
          {rows.map((row, i) => (
            <DiffLineRow key={i} row={row} />
          ))}
        </pre>
      </ScrollArea>
    </div>
  )
}

function WritePreview({ input, label }: { input: WriteInput; label: string }): JSX.Element {
  const { t } = useTranslation()
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
      <div className="flex min-w-0 items-center justify-between gap-2 border-b border-border/50 bg-muted px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground" data-testid="diff-preview-header">
        <span className="min-w-0 truncate font-mono normal-case text-foreground">{path}</span>
        <span className="flex shrink-0 items-center gap-2">
          <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-200">{t('chat.diff.createdOverwrite')}</span>
          {label} · {formatBytes(bytes)}
          {truncated ? t('chat.diff.showingLines', { shown: WRITE_PREVIEW_LINES, total: lines.length }) : ''}
        </span>
      </div>
      <ScrollArea className="max-h-80 max-w-full">
        <pre className="min-w-max whitespace-pre py-1 pr-2 font-mono text-[11px] leading-snug">
          {shown.map((line, i) => (
            <span key={i} className="flex">
              <GutterCell newNo={i + 1} />
              <span className="pl-1 text-emerald-700 dark:text-emerald-300">+ {line}</span>
            </span>
          ))}
          {truncated ? (
            <span className="mt-1 block px-2 text-muted-foreground italic">
              ...{t('chat.diff.moreLines', { count: lines.length - WRITE_PREVIEW_LINES })}
            </span>
          ) : null}
        </pre>
      </ScrollArea>
    </div>
  )
}

function MultiEditDiff({ input }: { input: MultiEditInput }): JSX.Element {
  const path = filePathOf(input)
  const edits = Array.isArray(input.edits) ? input.edits.filter(isEditItem) : []
  if (edits.length === 0) {
    return <PatchLikePreview title="replace_many_in_file" subtitle={path} text="(no edits)" />
  }
  return (
    <div className="mt-1.5 basis-full overflow-hidden rounded border border-amber-200 bg-card dark:border-amber-900/60" data-testid="diff-preview">
      <div className="flex min-w-0 items-center justify-between gap-2 border-b border-border/50 bg-muted px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground" data-testid="diff-preview-header">
        <span className="min-w-0 truncate font-mono normal-case text-foreground">{path}</span>
        <span className="flex shrink-0 items-center gap-2">
          <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-800 dark:bg-amber-950/50 dark:text-amber-200">modified</span>
          <span>replace_many_in_file · {edits.length} edit{edits.length === 1 ? '' : 's'}</span>
        </span>
      </div>
      <ScrollArea className="max-h-80 max-w-full">
        <div className="min-w-max space-y-2 px-0 py-1 font-mono text-[11px] leading-snug">
          {edits.map((edit, index) => (
            <div key={index} className="border-b border-border/30 pb-1 last:border-b-0">
              <div className="px-2 pb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                edit {index + 1}{edit.replace_all === true ? ' · replace_all' : ''}
              </div>
              {diffLines(edit.old_string.split('\n'), edit.new_string.split('\n'), EDIT_CONTEXT_LINES).map((row, i) => (
                <DiffLineRow key={i} row={row} />
              ))}
            </div>
          ))}
        </div>
      </ScrollArea>
    </div>
  )
}

function PatchPreview({ input }: { input: PatchInput }): JSX.Element {
  const patch = typeof input.patch === 'string' ? input.patch : ''
  return <PatchLikePreview title="apply_file_patch" subtitle={patchSummary(patch)} text={patch || '(empty patch)'} />
}

function PatchLikePreview({ title, subtitle, text }: { title: string; subtitle: string; text: string }): JSX.Element {
  const lines = text.split('\n')
  const truncated = lines.length > PATCH_PREVIEW_LINES
  const shown = truncated ? lines.slice(0, PATCH_PREVIEW_LINES) : lines
  return (
    <div className="mt-1.5 basis-full overflow-hidden rounded border border-sky-200 bg-card dark:border-sky-900/60" data-testid="diff-preview">
      <div className="flex min-w-0 items-center justify-between gap-2 border-b border-border/50 bg-muted px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground" data-testid="diff-preview-header">
        <span className="min-w-0 truncate font-mono normal-case text-foreground">{subtitle}</span>
        <span className="flex shrink-0 items-center gap-2">
          <span className="rounded bg-sky-100 px-1.5 py-0.5 text-sky-800 dark:bg-sky-950/50 dark:text-sky-200">patch</span>
          <span>{title}</span>
        </span>
      </div>
      <ScrollArea className="max-h-80 max-w-full">
        <pre className="min-w-max whitespace-pre py-1 pr-2 font-mono text-[11px] leading-snug">
          {shown.map((line, i) => (
            <span key={i} className={cn('block px-2', patchLineClass(line))}>{line || ' '}</span>
          ))}
          {truncated ? (
            <span className="mt-1 block px-2 text-muted-foreground italic">
              ...{lines.length - PATCH_PREVIEW_LINES} more lines
            </span>
          ) : null}
        </pre>
      </ScrollArea>
    </div>
  )
}

function DiffLineRow({ row }: { row: LineDiffRow }): JSX.Element {
  const { t } = useTranslation()
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
        <span>... {t('chat.diff.unchangedLine', { count: row.count })} ...</span>
        <span className="flex-1 border-t border-dashed border-border/60" aria-hidden="true" />
        </button>
        {open ? <span className="px-2 pb-1 text-[10px] normal-case tracking-normal">{t('chat.diff.compactNote')}</span> : null}
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

type EditItem = {
  old_string: string
  new_string: string
  replace_all?: boolean
}

function isEditItem(value: unknown): value is EditItem {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.old_string === 'string' && typeof record.new_string === 'string'
}

function patchSummary(patch: string): string {
  const firstPath = patch.split('\n').map((line) => {
    const add = /^\*\*\* Add File: (.+)$/.exec(line)
    if (add) return add[1]
    const update = /^\*\*\* Update File: (.+)$/.exec(line)
    if (update) return update[1]
    const del = /^\*\*\* Delete File: (.+)$/.exec(line)
    if (del) return del[1]
    return undefined
  }).find((value): value is string => typeof value === 'string' && value.length > 0)
  if (firstPath) return firstPath
  return 'patch'
}

function patchLineClass(line: string): string {
  if (line.startsWith('+') && !line.startsWith('+++')) return 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200'
  if (line.startsWith('-') && !line.startsWith('---')) return 'bg-rose-50 text-rose-800 dark:bg-rose-950/40 dark:text-rose-200'
  if (line.startsWith('***')) return 'bg-sky-50 text-sky-900 dark:bg-sky-950/40 dark:text-sky-200'
  if (line.startsWith('@@')) return 'bg-muted text-muted-foreground'
  return 'text-foreground dark:text-muted-foreground'
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
