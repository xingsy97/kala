/**
 * Line-and-word diff helpers used by DiffPreview.
 *
 * Two layers:
 *
 *  - `diffLines(oldLines, newLines, context)` — LCS-based line diff, then
 *    collapse >context-line unchanged runs into `gap` markers. Pairs
 *    consecutive `del`+`add` rows into a `replace` row so word-diff can
 *    render both halves aligned.
 *  - `diffWords(before, after)` — same LCS shape but at word granularity,
 *    used by the UI to color intra-line insertions and deletions on top of
 *    the line-level tone.
 *
 * Kept in `lib/` (not the component) so unit tests can exercise the
 * algorithms without pulling in React / JSDOM.
 */

export type LineDiffRow =
  | { kind: 'context'; text: string; oldNo: number; newNo: number }
  | { kind: 'add'; text: string; newNo: number }
  | { kind: 'del'; text: string; oldNo: number }
  | { kind: 'replace'; before: string; after: string; oldNo: number; newNo: number }
  | { kind: 'gap'; count: number }

export type WordDiffSegment =
  | { kind: 'equal'; text: string }
  | { kind: 'add'; text: string }
  | { kind: 'del'; text: string }

export function diffLines(
  oldLines: readonly string[],
  newLines: readonly string[],
  context: number,
): LineDiffRow[] {
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
  const raw: LineDiffRow[] = []
  let i = 0
  let j = 0
  while (i < m && j < n) {
    if (oldLines[i] === newLines[j]) {
      raw.push({ kind: 'context', text: oldLines[i]!, oldNo: i + 1, newNo: j + 1 })
      i++
      j++
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      raw.push({ kind: 'del', text: oldLines[i]!, oldNo: i + 1 })
      i++
    } else {
      raw.push({ kind: 'add', text: newLines[j]!, newNo: j + 1 })
      j++
    }
  }
  while (i < m) {
    raw.push({ kind: 'del', text: oldLines[i]!, oldNo: i + 1 })
    i++
  }
  while (j < n) {
    raw.push({ kind: 'add', text: newLines[j]!, newNo: j + 1 })
    j++
  }
  return collapseContext(pairReplacements(raw), context)
}

/**
 * Collapse adjacent `del` + `add` rows into a single `replace` row so the
 * renderer can show them side-by-side and highlight only the substrings
 * that actually differ.
 */
function pairReplacements(rows: readonly LineDiffRow[]): LineDiffRow[] {
  const out: LineDiffRow[] = []
  for (let k = 0; k < rows.length; k++) {
    const cur = rows[k]!
    const next = rows[k + 1]
    if (cur.kind === 'del' && next?.kind === 'add') {
      out.push({
        kind: 'replace',
        before: cur.text,
        after: next.text,
        oldNo: cur.oldNo,
        newNo: next.newNo,
      })
      k++
      continue
    }
    out.push(cur)
  }
  return out
}

function collapseContext(rows: readonly LineDiffRow[], context: number): LineDiffRow[] {
  const changeIdx = new Set<number>()
  for (let k = 0; k < rows.length; k++) {
    if (rows[k]!.kind !== 'context') changeIdx.add(k)
  }
  if (changeIdx.size === 0) {
    // All-context: keep the first `context` rows so the reader gets a
    // taste of the file, avoiding an empty preview when nothing changed.
    return rows.slice(0, context)
  }
  const keep = new Set<number>()
  for (const idx of changeIdx) {
    for (let d = -context; d <= context; d++) {
      const k = idx + d
      if (k >= 0 && k < rows.length) keep.add(k)
    }
  }
  const out: LineDiffRow[] = []
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

const WORD_TOKEN_RE = /(\s+|\w+|[^\s\w]+)/g

function tokenize(text: string): string[] {
  return text.match(WORD_TOKEN_RE) ?? []
}

export function diffWords(before: string, after: string): WordDiffSegment[] {
  const a = tokenize(before)
  const b = tokenize(after)
  const m = a.length
  const n = b.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
    }
  }
  const raw: WordDiffSegment[] = []
  let i = 0
  let j = 0
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      raw.push({ kind: 'equal', text: a[i]! })
      i++
      j++
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      raw.push({ kind: 'del', text: a[i]! })
      i++
    } else {
      raw.push({ kind: 'add', text: b[j]! })
      j++
    }
  }
  while (i < m) {
    raw.push({ kind: 'del', text: a[i]! })
    i++
  }
  while (j < n) {
    raw.push({ kind: 'add', text: b[j]! })
    j++
  }
  return coalesce(raw)
}

function coalesce(segments: readonly WordDiffSegment[]): WordDiffSegment[] {
  const out: WordDiffSegment[] = []
  for (const seg of segments) {
    const last = out[out.length - 1]
    if (last && last.kind === seg.kind) {
      last.text += seg.text
    } else {
      out.push({ ...seg })
    }
  }
  return out
}

export function countAddDel(rows: readonly LineDiffRow[]): { added: number; deleted: number } {
  let added = 0
  let deleted = 0
  for (const row of rows) {
    if (row.kind === 'add') added++
    else if (row.kind === 'del') deleted++
    else if (row.kind === 'replace') {
      added++
      deleted++
    }
  }
  return { added, deleted }
}
