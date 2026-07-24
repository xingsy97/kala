export type DiffStats = {
  readonly additions: number
  readonly deletions: number
  readonly diff: string
}

const MAX_DIFF_CHARS = 80_000

export function createUnifiedDiff(path: string, before: string, after: string): DiffStats {
  const beforeLines = splitDiffLines(before)
  const afterLines = splitDiffLines(after)
  const body = renderLineDiff(beforeLines, afterLines)
  const { additions, deletions } = countDiffBodyChanges(body)

  let diff = `--- ${path}\n+++ ${path}\n`
  diff += `@@ -1,${beforeLines.length} +1,${afterLines.length} @@\n`
  diff += body
  if (diff.length > MAX_DIFF_CHARS) {
    diff = `${diff.slice(0, MAX_DIFF_CHARS)}\n... diff truncated ...`
  }
  return { additions, deletions, diff }
}

function splitDiffLines(text: string): string[] {
  if (text.length === 0) return []
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

function renderLineDiff(before: readonly string[], after: readonly string[]): string {
  const rawRows = lineDiffRows(before, after)
  const changedIndexes = new Set<number>()
  for (let i = 0; i < rawRows.length; i++) {
    if (rawRows[i]!.kind !== 'context') changedIndexes.add(i)
  }
  if (changedIndexes.size === 0) return rawRows.map((row) => ` ${row.text}`).join('\n')

  const keep = new Set<number>()
  for (const index of changedIndexes) {
    for (let offset = -3; offset <= 3; offset++) {
      const keepIndex = index + offset
      if (keepIndex >= 0 && keepIndex < rawRows.length) keep.add(keepIndex)
    }
  }

  const lines: string[] = []
  let skipped = 0
  for (let i = 0; i < rawRows.length; i++) {
    if (!keep.has(i)) {
      skipped++
      continue
    }
    if (skipped > 0) {
      lines.push(' ...')
      skipped = 0
    }
    const row = rawRows[i]!
    lines.push(`${row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' '}${row.text}`)
  }
  if (skipped > 0) lines.push(' ...')
  return lines.join('\n')
}

type LineDiffRow =
  | { kind: 'context'; text: string }
  | { kind: 'add'; text: string }
  | { kind: 'del'; text: string }

function lineDiffRows(before: readonly string[], after: readonly string[]): LineDiffRow[] {
  const m = before.length
  const n = after.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i]![j] = before[i] === after[j]
        ? dp[i + 1]![j + 1]! + 1
        : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
    }
  }

  const rows: LineDiffRow[] = []
  let i = 0
  let j = 0
  while (i < m && j < n) {
    if (before[i] === after[j]) {
      rows.push({ kind: 'context', text: before[i]! })
      i++
      j++
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      rows.push({ kind: 'del', text: before[i]! })
      i++
    } else {
      rows.push({ kind: 'add', text: after[j]! })
      j++
    }
  }
  while (i < m) {
    rows.push({ kind: 'del', text: before[i]! })
    i++
  }
  while (j < n) {
    rows.push({ kind: 'add', text: after[j]! })
    j++
  }
  return rows
}

function countDiffBodyChanges(body: string): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  for (const line of body.split('\n')) {
    if (line.startsWith('+')) additions++
    else if (line.startsWith('-')) deletions++
  }
  return { additions, deletions }
}
