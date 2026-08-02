import { ToolError } from '../tools/registry.js'

export type ExactReplacement = {
  readonly oldString: string
  readonly newString: string
  readonly replaceAll: boolean
}

export function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0
  let count = 0
  let idx = 0
  while (true) {
    const next = haystack.indexOf(needle, idx)
    if (next === -1) return count
    count++
    idx = next + needle.length
  }
}

export function applyExactReplacements(
  original: string,
  edits: readonly ExactReplacement[],
): { text: string; counts: number[] } {
  let text = original
  const counts: number[] = []
  const appliedNewStrings: string[] = []
  edits.forEach((edit, index) => {
    if (edit.oldString.length === 0) throw new ToolError('EINVAL', `edits[${index}].old_string must be non-empty`)
    if (edit.oldString === edit.newString) throw new ToolError('EINVAL', `edits[${index}] old_string equals new_string; nothing to do`)
    const oldStringToCheck = edit.oldString.replace(/\n+$/, '')
    if (oldStringToCheck.length > 0 && appliedNewStrings.some((s) => s.includes(oldStringToCheck))) {
      throw new ToolError('ECHAIN', `edits[${index}].old_string matches text introduced by an earlier edit; split the operation or use apply_file_patch`)
    }
    const occurrences = countOccurrences(text, edit.oldString)
    if (occurrences === 0) {
      const candidates = nearestLineCandidates(text, edit.oldString)
      throw new ToolError('ENOTFOUND', `edits[${index}].old_string not found.${candidates.length ? ` Similar current line(s): ${candidates.join(', ')}.` : ''} Read the file again and retry with exact indentation and no line numbers.`)
    }
    if (!edit.replaceAll && occurrences > 1) {
      throw new ToolError('EAMBIG', `edits[${index}].old_string matches ${occurrences} times; set replace_all=true or provide more surrounding context`)
    }
    text = edit.replaceAll
      ? text.split(edit.oldString).join(edit.newString)
      : replaceFirst(text, edit.oldString, edit.newString)
    counts.push(edit.replaceAll ? occurrences : 1)
    appliedNewStrings.push(edit.newString)
  })
  return { text, counts }
}

function nearestLineCandidates(text: string, expected: string): string[] {
  const needle = expected.split('\n').find((line) => line.trim().length > 0)?.trim() ?? ''
  if (!needle) return []
  const needleWords = new Set(needle.toLowerCase().split(/\W+/u).filter(Boolean))
  return text.split('\n').map((line, index) => { const words = new Set(line.toLowerCase().split(/\W+/u).filter(Boolean)); const overlap = [...needleWords].filter((word) => words.has(word)).length; return { line: index + 1, overlap } }).filter((item) => item.overlap > 0).sort((a, b) => b.overlap - a.overlap).slice(0, 3).map((item) => `line ${item.line}`)
}

function replaceFirst(text: string, oldString: string, newString: string): string {
  const idx = text.indexOf(oldString)
  return text.slice(0, idx) + newString + text.slice(idx + oldString.length)
}
