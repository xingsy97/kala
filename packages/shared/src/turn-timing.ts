export type TurnTimingStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
export type TimingSpanKind = 'llm' | 'tool' | 'approval' | 'compaction' | 'retry' | 'recovery'

export type CompletedTimingSpan = {
  spanId: string
  turnId: string
  kind: TimingSpanKind
  component: 'host' | 'executor'
  startedAt: string
  completedAt: string
  durationMs: number
  status: 'succeeded' | 'failed' | 'cancelled' | 'interrupted'
  callId?: string
  executorDurationMs?: number
  firstTokenMs?: number
}

export type TurnTimingSummary = {
  turnId: string
  status: TurnTimingStatus
  startedAt: string
  completedAt?: string
  wallDurationMs: number
  estimated: boolean
  queueDurationMs: number
  activeDurationMs: number
  approvalWaitMs: number
  llm: { wallDurationMs: number; requestCount: number; firstTokenMs?: number }
  tools: { wallDurationMs: number; aggregateDurationMs: number; callCount: number; peakConcurrency: number; partial: boolean }
  compactionDurationMs: number
  retryDurationMs: number
  recoveryDurationMs: number
}

export type EventTimingMetadata = {
  turnId: string
  turnStartedAt?: string
  span?: CompletedTimingSpan
  summary?: TurnTimingSummary
}

export function nonNegativeDuration(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0
}
