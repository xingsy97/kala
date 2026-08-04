/**
 * Fetches a resolved sub-agent policy artifact
 * `subagent-policies/<parentSessionId>/<parentCallId>.json` from the host
 * artifact store. Returns null when no artifact is available; that is the
 * expected case for sub-agents launched without a `role` policy.
 */

import { useQuery } from '@tanstack/react-query'

export type SubAgentPolicyView = {
  role?: 'research' | 'test' | 'review'
  objective?: string
  allowedTools?: readonly string[]
  maxTurns?: number
  timeoutMs?: number
  expectedOutput?: string
  maxDepth?: number
  resolvedDepth?: number
  maxFanOut?: number
  concurrentSiblingCount?: number
  reasons: readonly string[]
}

type PolicyArtifact = {
  schemaVersion?: number
  policy?: {
    role?: string
    objective?: string
    allowedTools?: unknown
    maxTurns?: unknown
    timeoutMs?: unknown
    expectedOutput?: unknown
    maxDepth?: unknown
    resolvedDepth?: unknown
    maxFanOut?: unknown
    concurrentSiblingCount?: unknown
    reasons?: unknown
  }
}

type ContentResponse = { body?: unknown }

export function useSubAgentPolicy(opts: {
  parentSessionId: string
  parentCallId: string
}): SubAgentPolicyView | null {
  const { parentSessionId, parentCallId } = opts

  const query = useQuery({
    queryKey: ['subagent-policy', parentSessionId, parentCallId],
    queryFn: async (): Promise<SubAgentPolicyView | null> => {
      const relativePath = `subagent-policies/${parentSessionId}/${parentCallId}.json`
      const res = await fetch(`/artifacts/content?path=${encodeURIComponent(relativePath)}`, { cache: 'no-store' })
      if (!res.ok) return null
      const body = (await res.json().catch(() => null)) as ContentResponse | null
      if (!body || typeof body !== 'object') return null
      const artifact = body.body as PolicyArtifact | undefined
      const raw = artifact?.policy
      if (!raw) return null
      return normalize(raw)
    },
    enabled: Boolean(parentSessionId) && Boolean(parentCallId),
    staleTime: 60_000,
  })

  return query.data ?? null
}

function normalize(raw: Required<PolicyArtifact>['policy']): SubAgentPolicyView {
  const reasons = Array.isArray(raw.reasons)
    ? raw.reasons.filter((v): v is string => typeof v === 'string')
    : []
  const allowedTools = Array.isArray(raw.allowedTools)
    ? raw.allowedTools.filter((v): v is string => typeof v === 'string')
    : undefined
  const view: SubAgentPolicyView = { reasons }
  if (isRole(raw.role)) view.role = raw.role
  if (typeof raw.objective === 'string' && raw.objective.length > 0) view.objective = raw.objective
  if (allowedTools && allowedTools.length > 0) view.allowedTools = allowedTools
  if (typeof raw.maxTurns === 'number' && Number.isFinite(raw.maxTurns)) view.maxTurns = raw.maxTurns
  if (typeof raw.timeoutMs === 'number' && Number.isFinite(raw.timeoutMs)) view.timeoutMs = raw.timeoutMs
  if (typeof raw.expectedOutput === 'string' && raw.expectedOutput.length > 0) view.expectedOutput = raw.expectedOutput
  if (typeof raw.maxDepth === 'number' && Number.isFinite(raw.maxDepth)) view.maxDepth = raw.maxDepth
  if (typeof raw.resolvedDepth === 'number' && Number.isFinite(raw.resolvedDepth)) view.resolvedDepth = raw.resolvedDepth
  if (typeof raw.maxFanOut === 'number' && Number.isFinite(raw.maxFanOut)) view.maxFanOut = raw.maxFanOut
  if (
    typeof raw.concurrentSiblingCount === 'number' &&
    Number.isFinite(raw.concurrentSiblingCount)
  ) {
    view.concurrentSiblingCount = raw.concurrentSiblingCount
  }
  return view
}

function isRole(value: unknown): value is SubAgentPolicyView['role'] {
  return value === 'research' || value === 'test' || value === 'review'
}
