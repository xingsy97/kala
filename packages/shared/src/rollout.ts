/**
 * RL rollout sidecar record — indexes the ledger, trace, token segments, and
 * reward artifacts that make one training rollout. The sidecar itself is
 * small and easy to move around; the heavy data lives in the referenced
 * artifacts.
 */

import { randomUUID } from 'node:crypto'

export type RolloutSidecar = {
  rollout_id: string
  session_id: string
  task_id: string
  framework_target: 'slime' | 'verl' | 'trl' | 'openrlhf' | 'unknown'
  event_log_ref: string
  trace_ref?: string
  token_segments_ref?: string
  reward_ref?: string
  model?: string
  weight_version?: string
  metadata: Record<string, unknown>
}

export function createRolloutSidecar(input: {
  sessionId: string
  taskId: string
  frameworkTarget: RolloutSidecar['framework_target']
  eventLogRef: string
  traceRef?: string
  tokenSegmentsRef?: string
  rewardRef?: string
  model?: string
  weightVersion?: string
  metadata?: Record<string, unknown>
  rolloutId?: string
}): RolloutSidecar {
  return {
    rollout_id: input.rolloutId ?? `rollout_${randomUUID()}`,
    session_id: input.sessionId,
    task_id: input.taskId,
    framework_target: input.frameworkTarget,
    event_log_ref: input.eventLogRef,
    ...(input.traceRef ? { trace_ref: input.traceRef } : {}),
    ...(input.tokenSegmentsRef ? { token_segments_ref: input.tokenSegmentsRef } : {}),
    ...(input.rewardRef ? { reward_ref: input.rewardRef } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.weightVersion ? { weight_version: input.weightVersion } : {}),
    metadata: input.metadata ?? {},
  }
}
