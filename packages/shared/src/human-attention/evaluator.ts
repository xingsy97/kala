import type { MessageContent } from '@agent-kernel/kernel'

import type {
  HumanAttentionDimensions,
  HumanAttentionOptions,
  HumanAttentionPoint,
  HumanAttentionReason,
  HumanAttentionTimeline,
  HumanAttentionTimelineEntry,
} from './types.js'

const DEFAULT_LOOKBACK_EVENTS = 24

const CONTINUE_ONLY = /^(?:继续|continue|go on|proceed|ok|okay|嗯|好|做吧|开始吧|继续做|接着|接着做|部署一下|build and deploy|deploy)$/i
const REVIEW_TERMS = /(review|diff|screenshot|\bui\b|test|typecheck|verify|logs?|output|trace|evidence|confirm|audit|检查|审查|截图|测试|验证|日志|证据|确认|审计|对齐|显示|文案)/i
const CORRECTION_TERMS = /(wrong|incorrect|not what|instead|actually|you checked|should|must|fix|regression|不对|错|不是|应该|必须|修复|回归|之前|刚才|你.*本地|ssh|box)/i
const RISK_TERMS = /(deploy|restart|delete|schema|migration|commit|build|bundle|rollback|running session|approval|force|password|token|max token|context|不要部署|重启|删除|迁移|提交|构建|回滚|运行状态|确认|风险|密码|上下文)/i
const CONSTRAINT_TERMS = /(do not|don't|must|should|before|after|only|never|without|scope|one commit|per task|不要|不能|必须|应该|先|再|只|不要.*部署|每个.*commit|范围|确认后)/i
const READ_ONLY_TOOL = /^(?:rg|sed|cat|ls|find|grep|head|tail|wc|pwd)$/i
const HIGH_RISK_TOOL = /\b(apply_patch|git|deploy|scp|ssh|rsync|rm|mv|chmod|pnpm|npm|yarn|build|test|vitest|tsc|restart|docker|kubectl)\b/i
const VERY_HIGH_RISK = /\b(deploy|scp|rsync|rm\s+-rf|delete|migration|restart|force|git\s+push|kubectl|docker)\b/i

type AnchorState = {
  constraints: number
  riskAwareness: number
  continuity: number
}

type ReviewState = {
  lastSubstantiveSeq: number | null
  lastReviewSeq: number | null
}

export function buildHumanAttentionTimeline(
  sessionId: string,
  entries: readonly HumanAttentionTimelineEntry[],
  options: HumanAttentionOptions = {},
): HumanAttentionTimeline {
  const sorted = [...entries].sort((a, b) => a.seq - b.seq)
  const points: HumanAttentionPoint[] = []
  const anchors: AnchorState = { constraints: 0, riskAwareness: 0, continuity: 0 }
  const review: ReviewState = { lastSubstantiveSeq: null, lastReviewSeq: null }
  const now = options.now ?? (() => new Date().toISOString())
  const lookback = options.lookbackEvents ?? DEFAULT_LOOKBACK_EVENTS

  for (let index = 0; index < sorted.length; index += 1) {
    const entry = sorted[index]!
    if (entry.event.kind === 'user_message') {
      const text = humanText(entry.event.text, entry.event.content)
      const quality = scoreHumanText(text)
      anchors.constraints = Math.max(0, Math.min(100, anchors.constraints * 0.92 + quality.constraintQuality * 0.25))
      anchors.riskAwareness = Math.max(0, Math.min(100, anchors.riskAwareness * 0.92 + quality.riskAwareness * 0.25))
      anchors.continuity = Math.max(0, Math.min(100, anchors.continuity * 0.92 + quality.continuity * 0.25))
      if (quality.substantive) review.lastSubstantiveSeq = entry.seq
      if (quality.reviewDepth >= 45 || quality.correctionQuality >= 45) review.lastReviewSeq = entry.seq
    }

    if (shouldCreatePoint(entry, sorted[index + 1])) {
      const window = sorted.slice(Math.max(0, index + 1 - lookback), index + 1)
      points.push(evaluatePoint({ sessionId, cursor: entry.seq, entries: sorted.slice(0, index + 1), window, anchors, review, evaluatedAt: now() }))
    }
  }

  return { sessionId, points, latest: points.at(-1) ?? null }
}

export function humanAttentionLevel(score: number): HumanAttentionPoint['level'] {
  if (score >= 75) return 'engaged'
  if (score >= 50) return 'watching'
  if (score >= 30) return 'drifting'
  return 'absent'
}

function evaluatePoint(input: {
  sessionId: string
  cursor: number
  entries: readonly HumanAttentionTimelineEntry[]
  window: readonly HumanAttentionTimelineEntry[]
  anchors: AnchorState
  review: ReviewState
  evaluatedAt: string
}): HumanAttentionPoint {
  const humanMessages = input.window.filter(isUserMessageEntry)
  const humanScores = humanMessages.map((entry) => scoreHumanText(humanText(entry.event.text, entry.event.content)))
  const avg = (pick: (score: ReturnType<typeof scoreHumanText>) => number, fallback: number): number => {
    if (humanScores.length === 0) return fallback
    return humanScores.reduce((sum, score) => sum + pick(score), 0) / humanScores.length
  }
  const risk = riskExposure(input.entries, input.review.lastReviewSeq ?? input.review.lastSubstantiveSeq)
  const recentContinueOnly = humanScores.filter((score) => score.continueOnly).length
  const latestHuman = humanScores.at(-1)
  const blendLatest = (value: number, latest: number | undefined): number => latest === undefined ? value : Math.max(value, latest)
  const inputQuality = Math.max(blendLatest(avg((score) => score.intentQuality, 35), latestHuman?.intentQuality), input.anchors.constraints * 0.78)
  const reviewDepth = blendLatest(avg((score) => score.reviewDepth, input.review.lastReviewSeq === null ? 20 : 35), latestHuman?.reviewDepth)
  const correctionQuality = blendLatest(avg((score) => score.correctionQuality, 20), latestHuman?.correctionQuality)
  const riskAwareness = Math.max(blendLatest(avg((score) => score.riskAwareness, 30), latestHuman?.riskAwareness), input.anchors.riskAwareness * 0.78)
  const continuity = Math.max(blendLatest(avg((score) => score.continuity, 25), latestHuman?.continuity), input.anchors.continuity * 0.72)
  const dimensions: HumanAttentionDimensions = {
    inputQuality: round(inputQuality),
    reviewDepth: round(reviewDepth),
    correctionQuality: round(correctionQuality),
    riskAwareness: round(riskAwareness),
    continuity: round(continuity),
    riskExposure: round(risk.score),
  }
  const semanticQuality =
    dimensions.inputQuality * 0.32 +
    dimensions.reviewDepth * 0.22 +
    dimensions.correctionQuality * 0.18 +
    dimensions.riskAwareness * 0.20 +
    dimensions.continuity * 0.08
  const reviewBonus = input.review.lastReviewSeq !== null && input.review.lastReviewSeq >= input.cursor - 8 ? 14 : 0
  const continuePenalty = Math.min(20, recentContinueOnly * 7)
  const stalenessPenalty = input.review.lastSubstantiveSeq === null
    ? 10
    : Math.min(18, Math.max(0, input.cursor - input.review.lastSubstantiveSeq - 16) * 0.75)
  const attentionMitigation = Math.min(0.55, (semanticQuality + reviewBonus) / 180)
  const riskPenalty = Math.min(42, risk.score * (0.36 - attentionMitigation * 0.18))
  const rawScore = semanticQuality + reviewBonus - continuePenalty - stalenessPenalty - riskPenalty
  const score = clampScore(Math.max(rawScore, lowRiskFreshTaskFloor({ risk, review: input.review, cursor: input.cursor, recentContinueOnly })))
  return {
    sessionId: input.sessionId,
    messageCursor: input.cursor,
    score,
    level: humanAttentionLevel(score),
    confidence: confidenceFor(humanMessages.length, risk.events),
    dimensions,
    reasons: reasonsFor({ score, dimensions, risk, recentContinueOnly, review: input.review, cursor: input.cursor, humanScores }),
    evaluatedAt: input.evaluatedAt,
    evaluator: 'heuristic',
  }
}

function lowRiskFreshTaskFloor(input: {
  risk: ReturnType<typeof riskExposure>
  review: ReviewState
  cursor: number
  recentContinueOnly: number
}): number {
  if (input.recentContinueOnly > 1) return 0
  if (input.review.lastSubstantiveSeq === null) return 0
  if (input.cursor - input.review.lastSubstantiveSeq > 10) return 0
  if (input.risk.highRisk > 0) return 0
  if (input.risk.score < 8) return input.recentContinueOnly === 0 ? 38 : 32
  if (input.risk.score < 18 && input.risk.events <= 8) return 32
  return 0
}

function shouldCreatePoint(entry: HumanAttentionTimelineEntry, next: HumanAttentionTimelineEntry | undefined): boolean {
  if (entry.event.kind === 'user_message') return true
  if (entry.event.kind === 'llm_response' || entry.event.kind === 'llm_error') return true
  if (entry.event.kind === 'tool_result') return next?.event.kind !== 'tool_result'
  if (entry.effects?.some((effect) => effect.kind === 'call_tool' || effect.kind === 'request_approval')) return true
  return false
}

function isUserMessageEntry(entry: HumanAttentionTimelineEntry): entry is HumanAttentionTimelineEntry & { event: Extract<HumanAttentionTimelineEntry['event'], { kind: 'user_message' }> } {
  return entry.event.kind === 'user_message'
}

function scoreHumanText(text: string): {
  intentQuality: number
  constraintQuality: number
  reviewDepth: number
  correctionQuality: number
  riskAwareness: number
  continuity: number
  substantive: boolean
  continueOnly: boolean
} {
  const normalized = text.trim()
  const continueOnly = CONTINUE_ONLY.test(normalized)
  const lengthScore = Math.min(35, Math.max(0, normalized.length - 8) * 0.7)
  const constraint = CONSTRAINT_TERMS.test(normalized) ? 35 : 0
  const review = REVIEW_TERMS.test(normalized) ? 35 : 0
  const correction = CORRECTION_TERMS.test(normalized) ? 40 : 0
  const risk = RISK_TERMS.test(normalized) ? 38 : 0
  const continuity = /\b(previous|earlier|again|still|上次|之前|刚才|仍然|还是|又|按照|你说的)\b/i.test(normalized) ? 35 : 0
  const specificity = /[A-Za-z0-9_./:-]{6,}|[一-龥]{4,}/.test(normalized) ? 18 : 0
  const intentQuality = continueOnly ? 18 : 35 + lengthScore + specificity + Math.min(18, constraint)
  return {
    intentQuality: clampDimension(intentQuality),
    constraintQuality: clampDimension(20 + constraint + specificity),
    reviewDepth: clampDimension(15 + review + correction * 0.35),
    correctionQuality: clampDimension(20 + correction + continuity * 0.25),
    riskAwareness: clampDimension(18 + risk + constraint * 0.25),
    continuity: clampDimension(15 + continuity + constraint * 0.15),
    substantive: !continueOnly && (normalized.length >= 10 || specificity > 0 || constraint > 0 || review > 0 || correction > 0 || risk > 0),
    continueOnly,
  }
}

function riskExposure(entries: readonly HumanAttentionTimelineEntry[], sinceSeq: number | null): { score: number; events: number; highRisk: number; evidence: string[] } {
  let score = 0
  let events = 0
  let highRisk = 0
  const evidence: string[] = []
  for (const entry of entries) {
    if (sinceSeq !== null && entry.seq <= sinceSeq) continue
    if (entry.event.kind === 'llm_response') {
      const toolCalls = entry.event.message.content.filter((part) => part.type === 'tool_call')
      if (toolCalls.length > 0) {
        score += toolCalls.reduce((sum, call) => sum + toolRiskWeight(call.name, call.input) * 0.45, 0)
        events += toolCalls.length
        evidence.push(`${toolCalls.length} tool call${toolCalls.length === 1 ? '' : 's'} proposed`)
      }
    }
    if (entry.event.kind === 'tool_result') {
      score += entry.event.ok ? 0.4 : 4
      events += 1
    }
    for (const effect of entry.effects ?? []) {
      if (effect.kind === 'call_tool') {
        const weight = toolRiskWeight(effect.name, effect.input)
        score += weight
        events += 1
        if (weight >= 14) highRisk += 1
      }
      if (effect.kind === 'request_approval') {
        score += 7
        events += 1
      }
    }
    if (entry.event.kind === 'approval_mode_changed' && entry.event.mode === 'allow_all') {
      score += 20
      highRisk += 1
      evidence.push('approval mode changed to allow_all')
    }
  }
  return { score: Math.min(100, score), events, highRisk, evidence }
}

function toolRiskWeight(name: string, input: unknown): number {
  const text = `${name} ${JSON.stringify(input)}`
  if (READ_ONLY_TOOL.test(name)) return 0.3
  if (VERY_HIGH_RISK.test(text)) return 14
  if (HIGH_RISK_TOOL.test(text)) return 8
  return 4
}

function reasonsFor(input: {
  score: number
  dimensions: HumanAttentionDimensions
  risk: ReturnType<typeof riskExposure>
  recentContinueOnly: number
  review: ReviewState
  cursor: number
  humanScores: readonly ReturnType<typeof scoreHumanText>[]
}): HumanAttentionReason[] {
  const reasons: HumanAttentionReason[] = []
  if (input.humanScores.length === 0) reasons.push({ kind: 'insufficient_evidence', severity: 'warning', message: 'No recent human input in the evaluation window.' })
  if (input.dimensions.inputQuality >= 70) reasons.push({ kind: 'specific_intent', severity: 'info', message: 'Recent human input includes specific intent or scope.' })
  if (input.dimensions.reviewDepth >= 60) reasons.push({ kind: 'reviewed_recent_output', severity: 'info', message: 'Recent input includes concrete review or verification language.' })
  if (input.dimensions.correctionQuality >= 55 || input.humanScores.some((score) => score.correctionQuality >= 55)) reasons.push({ kind: 'corrected_agent_assumption', severity: 'info', message: 'Human corrected agent assumptions or behavior.' })
  if (input.dimensions.riskAwareness >= 60) reasons.push({ kind: 'risk_awareness', severity: 'info', message: 'Human input mentions testing, deployment, schema, restart, or similar risk.' })
  if (input.recentContinueOnly > 0) reasons.push({ kind: 'continue_only', severity: 'warning', message: 'Recent input delegates continuation without new constraints.', evidence: `${input.recentContinueOnly} continue-only message${input.recentContinueOnly === 1 ? '' : 's'}` })
  if (input.risk.score >= 45) reasons.push({ kind: 'high_agent_activity', severity: input.risk.score >= 75 ? 'critical' : 'warning', message: 'Agent activity has accumulated since the last substantive review.', evidence: `${input.risk.events} risk-weighted event${input.risk.events === 1 ? '' : 's'}` })
  if (input.risk.highRisk > 0) reasons.push({ kind: 'high_risk_action', severity: 'critical', message: 'High-risk tool or operation was detected in this session window.' })
  if (input.review.lastSubstantiveSeq !== null && input.cursor - input.review.lastSubstantiveSeq > 18) reasons.push({ kind: 'stale_review', severity: 'warning', message: 'No recent substantive human review after continued session activity.' })
  return reasons
    .sort((a, b) => reasonPriority(a.kind) - reasonPriority(b.kind))
    .slice(0, 5)
}

function reasonPriority(kind: HumanAttentionReason['kind']): number {
  if (kind === 'high_risk_action') return 0
  if (kind === 'high_agent_activity') return 1
  if (kind === 'continue_only') return 2
  if (kind === 'corrected_agent_assumption') return 3
  if (kind === 'reviewed_recent_output') return 4
  if (kind === 'risk_awareness') return 5
  return 10
}

function humanText(text: string | undefined, content: readonly MessageContent[] | undefined): string {
  if (text && text.trim()) return text
  return (content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('\n')
}

function confidenceFor(humanMessages: number, riskEvents: number): number {
  return Math.max(0.25, Math.min(0.95, 0.35 + humanMessages * 0.12 + Math.min(0.25, riskEvents * 0.025)))
}

function clampDimension(value: number): number {
  return round(Math.max(0, Math.min(100, value)))
}

function clampScore(value: number): number {
  return round(Math.max(0, Math.min(100, value)))
}

function round(value: number): number {
  return Math.round(value)
}
