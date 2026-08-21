import type { SessionSummary } from '@agent-kernel/shared'

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u

export type ExplicitEvaluationReference = { runId?: string; defectId?: string }

export function resolveEvaluationPlatformUrl(configured?: string): string | undefined {
  const candidate = configured?.trim()
  if (!candidate) return undefined
  try {
    const url = candidate.startsWith('/') && !candidate.startsWith('//')
      ? new URL(candidate, typeof window === 'undefined' ? 'http://localhost' : window.location.origin)
      : new URL(candidate)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    return url.toString().replace(/\/$/u, '')
  } catch { return undefined }
}

export function explicitEvaluationReference(location: Pick<Location, 'search'>, sessionId: string): ExplicitEvaluationReference | undefined {
  const parameters = new URLSearchParams(location.search)
  if (parameters.get('evaluationSessionId') !== sessionId) return undefined
  const runId = validIdentifier(parameters.get('evaluationRunId'))
  const defectId = validIdentifier(parameters.get('evaluationDefectId'))
  return runId || defectId ? { ...(runId ? { runId } : {}), ...(defectId ? { defectId } : {}) } : undefined
}

export function evaluationReferenceUrl(reference: ExplicitEvaluationReference, platformUrl: string): string {
  const url = new URL(reference.defectId ? '/defects' : '/runs', platformUrl + '/')
  if (reference.runId) url.searchParams.set('runId', reference.runId)
  if (reference.defectId) url.searchParams.set('findingId', reference.defectId)
  return url.toString()
}

export function governedSessionTaskCandidate(sessionId: string, summary?: SessionSummary, selectedModel?: string | null): Record<string, unknown> {
  return {
    schemaVersion: 1, kind: 'agent-evaluation-task-candidate-reference', candidateId: 'session-' + safeId(sessionId),
    sourceClassification: 'private_workspace', publicTaskPack: false,
    provenance: { kind: 'product_session', sessionRef: 'product-session:' + sessionId, ...(summary?.workspaceId ? { workspaceRef: 'product-workspace:' + summary.workspaceId } : {}), createdAt: summary?.createdAt ?? null, lastActivityAt: summary?.lastEventAt ?? null },
    candidateMetadata: { eventCount: summary?.eventCount ?? 0, modelRef: selectedModel ?? summary?.preferences?.selectedModel ?? null, contentIncluded: false, workspacePathIncluded: false },
    governance: { publicationStatus: 'private_only', requiresExplicitOperatorReview: true, redactionStatus: 'not_reviewed', provenanceApprovalStatus: 'not_reviewed' },
  }
}

function validIdentifier(value: string | null): string | undefined { return value && IDENTIFIER.test(value) ? value : undefined }
function safeId(value: string): string { return value.replace(/[^A-Za-z0-9._:-]/gu, '-').slice(0, 120) || 'session' }
