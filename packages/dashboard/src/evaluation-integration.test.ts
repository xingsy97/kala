import { describe, expect, it } from 'vitest'

import type { SessionSummary } from '@agent-kernel/shared'

import {
  evaluationReferenceUrl,
  explicitEvaluationReference,
  governedSessionTaskCandidate,
  resolveEvaluationPlatformUrl,
} from './evaluation-integration.js'

describe('evaluation integration', () => {
  it('requires an explicit public URL', () => {
    expect(resolveEvaluationPlatformUrl()).toBeUndefined()
    expect(resolveEvaluationPlatformUrl('https://evaluation.example.test/root/')).toBe('https://evaluation.example.test/root')
  })

  it('rejects non-HTTP and malformed configured URLs', () => {
    for (const configured of ['javascript:alert(1)', 'file:///tmp/evaluation', 'not a URL']) {
      expect(resolveEvaluationPlatformUrl(configured)).toBeUndefined()
    }
  })

  it('creates links only from an explicit reference scoped to the same session', () => {
    const matching = { search: '?evaluationSessionId=session-1&evaluationRunId=run-1&evaluationDefectId=finding-1' }
    expect(explicitEvaluationReference(matching, 'session-1')).toEqual({ runId: 'run-1', defectId: 'finding-1' })
    expect(explicitEvaluationReference(matching, 'session-2')).toBeUndefined()
    expect(explicitEvaluationReference({ search: '?evaluationSessionId=session-1&evaluationRunId=../unsafe' }, 'session-1')).toBeUndefined()

    expect(evaluationReferenceUrl({ runId: 'run-1', defectId: 'finding-1' }, 'https://evaluation.example.test')).toBe(
      'https://evaluation.example.test/defects?runId=run-1&findingId=finding-1',
    )
  })

  it('exports only a governed reference without session content or workspace paths', () => {
    const summary = {
      sessionId: 'session/unsafe',
      workspaceId: 'workspace-1',
      workspaceName: 'private-machine',
      currentCwd: '/private/project',
      firstUserMessage: 'private prompt',
      eventCount: 12,
      createdAt: '2026-07-01T00:00:00.000Z',
      lastEventAt: '2026-07-02T00:00:00.000Z',
    } as SessionSummary

    const candidate = governedSessionTaskCandidate(summary.sessionId, summary, 'model-1')
    expect(candidate).toMatchObject({
      candidateId: 'session-session-unsafe',
      sourceClassification: 'private_workspace',
      publicTaskPack: false,
      candidateMetadata: { contentIncluded: false, workspacePathIncluded: false },
      governance: {
        requiresExplicitOperatorReview: true,
        redactionStatus: 'not_reviewed',
        provenanceApprovalStatus: 'not_reviewed',
      },
    })
    const serialized = JSON.stringify(candidate)
    expect(serialized).not.toContain(summary.currentCwd)
    expect(serialized).not.toContain(summary.firstUserMessage)
    expect(serialized).not.toContain(summary.workspaceName)
  })
})
