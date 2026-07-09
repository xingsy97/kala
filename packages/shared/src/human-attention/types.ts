import type { AgentEvent, Effect } from '@agent-kernel/kernel'

export type HumanAttentionLevel = 'engaged' | 'watching' | 'drifting' | 'absent'

export type HumanAttentionEvaluator = 'heuristic' | 'llm'

export type HumanAttentionDimensions = {
  inputQuality: number
  reviewDepth: number
  correctionQuality: number
  riskAwareness: number
  continuity: number
  riskExposure: number
}

export type HumanAttentionReasonKind =
  | 'specific_intent'
  | 'specific_constraints'
  | 'reviewed_recent_output'
  | 'corrected_agent_assumption'
  | 'risk_awareness'
  | 'continuity'
  | 'continue_only'
  | 'stale_review'
  | 'high_agent_activity'
  | 'risky_approval_mode'
  | 'high_risk_action'
  | 'insufficient_evidence'

export type HumanAttentionReason = {
  kind: HumanAttentionReasonKind
  severity: 'info' | 'warning' | 'critical'
  message: string
  evidence?: string
}

export type HumanAttentionPoint = {
  sessionId: string
  messageCursor: number
  score: number
  level: HumanAttentionLevel
  confidence: number
  dimensions: HumanAttentionDimensions
  reasons: readonly HumanAttentionReason[]
  evaluatedAt: string
  evaluator: HumanAttentionEvaluator
}

export type HumanAttentionTimeline = {
  sessionId: string
  points: readonly HumanAttentionPoint[]
  latest: HumanAttentionPoint | null
}

export type HumanAttentionTimelineEntry = {
  seq: number
  ts: string
  event: AgentEvent
  effects?: readonly Effect[]
}

export type HumanAttentionOptions = {
  lookbackEvents?: number
  now?: () => string
}
