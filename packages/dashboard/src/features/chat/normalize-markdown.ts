const WORD_CHARACTER = /[\p{L}\p{N}]/u
export const EMPHASIS_ADJACENCY_MARKER = '\uFEFF\uE000ak-emphasis-adjacency\uE001'

type MarkdownAstNode = {
  type?: string
  value?: string
  children?: MarkdownAstNode[]
}

/** Remove the parser-only delimiter repair marker before hast/React nodes exist. */
export function remarkStripEmphasisAdjacencyMarker(): (tree: MarkdownAstNode) => void {
  return (tree) => {
    const visit = (node: MarkdownAstNode): void => {
      if (node.type === 'text' && typeof node.value === 'string') {
        node.value = node.value.split(EMPHASIS_ADJACENCY_MARKER).join('')
      }
      node.children?.forEach(visit)
    }
    visit(tree)
  }
}

/**
 * Repair a CommonMark delimiter edge case produced frequently by models:
 * `**label:**value`. A parser-only marker makes the closing delimiter
 * right-flanking without adding visible spacing.
 *
 * This deliberately scans source rather than applying a global regexp. Fenced
 * and inline code, link labels/destinations, and escaped delimiters are copied
 * byte-for-byte. Ambiguous delimiter runs are left unchanged.
 */
export function normalizeMarkdownEmphasisAdjacency(source: string): string {
  let output = ''
  let index = 0
  let fence: { marker: '`' | '~'; length: number } | null = null
  let inlineTicks = 0
  let bracketDepth = 0
  let linkDestinationDepth = 0
  let strongOpen = false
  let lineStart = true

  while (index < source.length) {
    const character = source[index]!

    if (lineStart && inlineTicks === 0 && bracketDepth === 0 && linkDestinationDepth === 0) {
      const lineRemainder = source.slice(index)
      const definitionMatch = /^( {0,3}\[[^\]\r\n]+\]:[^\r\n]*)/u.exec(lineRemainder)
      if (!fence && definitionMatch) {
        output += definitionMatch[1]
        index += definitionMatch[1]!.length
        lineStart = false
        continue
      }
      const fenceMatch = /^( {0,3})(`{3,}|~{3,})([^\r\n]*)/u.exec(lineRemainder)
      if (fenceMatch) {
        const marker = fenceMatch[2]![0] as '`' | '~'
        const length = fenceMatch[2]!.length
        const suffix = fenceMatch[3]!
        if (!fence && (marker === '~' || !suffix.includes('`'))) fence = { marker, length }
        else if (fence?.marker === marker && length >= fence.length && /^\s*$/u.test(suffix)) fence = null
        const consumed = fenceMatch[1]!.length + fenceMatch[2]!.length
        output += source.slice(index, index + consumed)
        index += consumed
        lineStart = false
        continue
      }
    }

    if (character === '\n') {
      output += character
      index += 1
      lineStart = true
      continue
    }
    lineStart = false

    if (fence) {
      output += character
      index += 1
      continue
    }
    if (character === '\\') {
      output += source.slice(index, index + 2)
      index += Math.min(2, source.length - index)
      continue
    }
    if (character === '`') {
      let run = 1
      while (source[index + run] === '`') run += 1
      output += source.slice(index, index + run)
      if (inlineTicks === 0) inlineTicks = run
      else if (run === inlineTicks) inlineTicks = 0
      index += run
      continue
    }
    if (inlineTicks > 0) {
      output += character
      index += 1
      continue
    }
    if (character === '<') {
      const close = source.indexOf('>', index + 1)
      if (close !== -1) {
        output += source.slice(index, close + 1)
        index = close + 1
        continue
      }
    }

    if (character === '[') bracketDepth += 1
    if (character === ']' && bracketDepth > 0) bracketDepth -= 1
    if (character === '(' && source[index - 1] === ']' && bracketDepth === 0) linkDestinationDepth = 1
    else if (character === '(' && linkDestinationDepth > 0) linkDestinationDepth += 1
    if (character === ')' && linkDestinationDepth > 0) linkDestinationDepth -= 1

    if (bracketDepth === 0 && linkDestinationDepth === 0 && character === '*') {
      let run = 1
      while (source[index + run] === '*') run += 1
      if (run !== 2) {
        output += source.slice(index, index + run)
        index += run
        continue
      }
      const previous = source[index - 1] ?? ''
      const next = source[index + 2] ?? ''
      output += '**'
      if (strongOpen && previous !== '' && !/\s/u.test(previous)) {
        strongOpen = false
        if (WORD_CHARACTER.test(next)) output += EMPHASIS_ADJACENCY_MARKER
      } else if (!strongOpen && next !== '' && !/\s/u.test(next)) {
        strongOpen = true
      }
      index += 2
      continue
    }

    output += character
    index += 1
  }

  return output
}
