/**
 * Compaction summary schema validation.
 *
 * The `compact_replaced` event replaces the old transcript prefix with one
 * synthetic system message whose body is the summarizer LLM output. If that
 * body silently drops required sections (User Intent, Repository/Runtime
 * State, Decisions, Work Completed, Open Work), the agent loses information it
 * cannot recover from replay. This module scores summaries against the schema
 * so the host can label bad summaries and (optionally) retry, without adding
 * validation state to the kernel.
 *
 * Pure text validation only — no kernel, no filesystem. Callers persist the
 * report as an observability artifact and decide policy.
 */

export type CompactionSummarySection =
  | 'user_intent'
  | 'repository_state'
  | 'decisions'
  | 'work_completed'
  | 'open_work'

export type CompactionSummarySectionStatus = 'present' | 'missing' | 'empty'

export type CompactionSummarySectionResult = {
  section: CompactionSummarySection
  status: CompactionSummarySectionStatus
  headingMatched?: string
  bodyChars: number
}

export type CompactionSummaryValidation = {
  ok: boolean
  sections: readonly CompactionSummarySectionResult[]
  missing: readonly CompactionSummarySection[]
  empty: readonly CompactionSummarySection[]
  reasonCodes: readonly string[]
  totalChars: number
}

const SECTION_ALIASES: Record<CompactionSummarySection, readonly string[]> = {
  user_intent: ['user intent', 'user intent and constraints', 'intent'],
  repository_state: [
    'repository and runtime state',
    'repository state',
    'runtime state',
    'environment',
    'project state',
  ],
  decisions: ['decisions', 'decisions and rationale', 'rationale'],
  work_completed: [
    'work completed',
    'completed work',
    'progress',
    'changes',
  ],
  open_work: ['open work', 'remaining work', 'next steps', 'todo', 'open tasks'],
}

const REQUIRED_SECTIONS: readonly CompactionSummarySection[] = [
  'user_intent',
  'repository_state',
  'decisions',
  'work_completed',
  'open_work',
]

export function validateCompactionSummary(summary: string): CompactionSummaryValidation {
  const trimmed = summary.trim()
  const headings = extractHeadings(trimmed)
  const results: CompactionSummarySectionResult[] = []
  for (const section of REQUIRED_SECTIONS) {
    const match = findHeadingForSection(section, headings, trimmed)
    if (!match) {
      results.push({ section, status: 'missing', bodyChars: 0 })
      continue
    }
    results.push({
      section,
      status: match.bodyChars === 0 ? 'empty' : 'present',
      headingMatched: match.rawHeading,
      bodyChars: match.bodyChars,
    })
  }
  const missing = results.filter((r) => r.status === 'missing').map((r) => r.section)
  const empty = results.filter((r) => r.status === 'empty').map((r) => r.section)
  const reasonCodes: string[] = []
  if (trimmed.length === 0) reasonCodes.push('empty_summary')
  if (missing.length > 0) reasonCodes.push('missing_sections')
  if (empty.length > 0) reasonCodes.push('empty_sections')
  if (missing.length === 0 && empty.length === 0 && trimmed.length > 0) reasonCodes.push('schema_ok')
  return {
    ok: trimmed.length > 0 && missing.length === 0 && empty.length === 0,
    sections: results,
    missing,
    empty,
    reasonCodes,
    totalChars: trimmed.length,
  }
}

type HeadingSpan = {
  level: number
  rawHeading: string
  normalized: string
  headingStart: number
  bodyStart: number
}

function extractHeadings(text: string): readonly HeadingSpan[] {
  const spans: HeadingSpan[] = []
  const regex = /^(#{1,6})\s+(.+?)\s*$/gm
  let match: RegExpExecArray | null
  while ((match = regex.exec(text)) !== null) {
    const heading = match[2] ?? ''
    spans.push({
      level: (match[1] ?? '').length,
      rawHeading: heading,
      normalized: normalize(heading),
      headingStart: match.index,
      bodyStart: match.index + match[0].length,
    })
  }
  return spans
}

function findHeadingForSection(
  section: CompactionSummarySection,
  headings: readonly HeadingSpan[],
  text: string,
): { rawHeading: string; bodyChars: number } | undefined {
  const aliases = SECTION_ALIASES[section]
  for (let i = 0; i < headings.length; i++) {
    const heading = headings[i]!
    const normalizedHeading = heading.normalized
    const matched = aliases.some((alias) => {
      const normAlias = normalize(alias)
      return normalizedHeading === normAlias || normalizedHeading.includes(normAlias)
    })
    if (!matched) continue
    const next = headings[i + 1]
    const bodyEnd = next ? next.headingStart : text.length
    const bodyText = text.slice(heading.bodyStart, bodyEnd).trim()
    return { rawHeading: heading.rawHeading, bodyChars: bodyText.length }
  }
  return undefined
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
