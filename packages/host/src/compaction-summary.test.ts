import { describe, expect, it } from 'vitest'

import { validateCompactionSummary } from '@agent-kernel/shared/enhancement'

describe('validateCompactionSummary', () => {
  it('reports ok when all required sections are present with content', () => {
    const summary = `# Compacted Context
## User Intent And Constraints
Fix the failing test.
## Repository And Runtime State
Node 20, agent-kernel monorepo.
## Decisions And Rationale
Chose approach A over B because it is faster.
## Work Completed
Edited src/foo.ts, ran tests.
## Open Work
Push the branch and open PR.
`
    const result = validateCompactionSummary(summary)
    expect(result.ok).toBe(true)
    expect(result.missing).toEqual([])
    expect(result.empty).toEqual([])
    expect(result.reasonCodes).toContain('schema_ok')
    expect(result.sections.map((s) => s.status).every((s) => s === 'present')).toBe(true)
  })

  it('flags missing sections with a reason code', () => {
    const summary = `# Compacted Context
## User Intent And Constraints
Fix bug.
## Work Completed
Wrote patch.
`
    const result = validateCompactionSummary(summary)
    expect(result.ok).toBe(false)
    expect(result.missing).toEqual(['repository_state', 'decisions', 'open_work'])
    expect(result.reasonCodes).toContain('missing_sections')
  })

  it('flags present-but-empty sections separately from missing', () => {
    const summary = `## User Intent And Constraints
Fix bug.
## Repository And Runtime State
## Decisions And Rationale
Chose A.
## Work Completed
Wrote patch.
## Open Work
Push PR.
`
    const result = validateCompactionSummary(summary)
    expect(result.empty).toEqual(['repository_state'])
    expect(result.missing).toEqual([])
    expect(result.ok).toBe(false)
    expect(result.reasonCodes).toContain('empty_sections')
  })

  it('accepts common section aliases', () => {
    const summary = `## Intent
Do X.
## Runtime State
Node 20.
## Rationale
Because Y.
## Progress
Did A.
## Next Steps
Do B.
`
    const result = validateCompactionSummary(summary)
    expect(result.ok).toBe(true)
    expect(result.missing).toEqual([])
  })

  it('marks empty summaries with a dedicated reason code', () => {
    const result = validateCompactionSummary('   \n  ')
    expect(result.ok).toBe(false)
    expect(result.reasonCodes).toContain('empty_summary')
    expect(result.missing.length).toBeGreaterThan(0)
  })
})
