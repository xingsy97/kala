import { z } from 'zod'

import { AgentBackendIdSchema } from './agent-backend.js'
import { IdentifierSchema, NonEmptyStringSchema, Sha256Schema } from './common.js'
import { NormalizedFailureSchema } from './failure.js'
import { SandboxProviderKindSchema } from './sandbox.js'

export const RunStateSchema = z.enum([
  'draft', 'validating', 'preparing', 'running', 'verifying', 'analyzing', 'reporting', 'completed',
  'blocked', 'failed', 'cancelled', 'interrupted',
])
export const TrialStateSchema = z.enum([
  'queued', 'leased', 'environment_preparing', 'agent_running', 'artifacts_collecting', 'verifying', 'analyzing', 'completed',
  'blocked', 'timeout', 'cancelled', 'agent_error', 'environment_error', 'verifier_error', 'indeterminate',
])

export type RunState = z.infer<typeof RunStateSchema>
export type TrialState = z.infer<typeof TrialStateSchema>

export const RUN_TERMINAL_STATES = ['completed', 'failed', 'cancelled'] as const satisfies readonly RunState[]
export const TRIAL_TERMINAL_STATES = [
  'completed', 'blocked', 'timeout', 'cancelled', 'agent_error', 'environment_error', 'verifier_error', 'indeterminate',
] as const satisfies readonly TrialState[]

const RUN_TRANSITIONS: Readonly<Record<RunState, readonly RunState[]>> = {
  draft: ['validating', 'cancelled'],
  validating: ['preparing', 'blocked', 'failed', 'cancelled', 'interrupted'],
  preparing: ['running', 'blocked', 'failed', 'cancelled', 'interrupted'],
  running: ['verifying', 'blocked', 'failed', 'cancelled', 'interrupted'],
  verifying: ['analyzing', 'failed', 'cancelled', 'interrupted'],
  analyzing: ['reporting', 'failed', 'cancelled', 'interrupted'],
  reporting: ['completed', 'failed', 'cancelled', 'interrupted'],
  completed: [],
  blocked: ['validating', 'cancelled'],
  failed: ['validating'],
  cancelled: [],
  interrupted: ['validating', 'cancelled'],
}

const TRIAL_TRANSITIONS: Readonly<Record<TrialState, readonly TrialState[]>> = {
  queued: ['leased', 'blocked', 'cancelled'],
  leased: ['queued', 'environment_preparing', 'blocked', 'timeout', 'environment_error', 'cancelled', 'indeterminate'],
  environment_preparing: ['queued', 'agent_running', 'blocked', 'environment_error', 'timeout', 'cancelled', 'indeterminate'],
  agent_running: ['artifacts_collecting', 'agent_error', 'timeout', 'cancelled', 'indeterminate'],
  artifacts_collecting: ['verifying', 'environment_error', 'timeout', 'cancelled', 'indeterminate'],
  verifying: ['analyzing', 'verifier_error', 'timeout', 'cancelled', 'indeterminate'],
  analyzing: ['completed', 'environment_error', 'verifier_error', 'timeout', 'cancelled', 'indeterminate'],
  completed: [],
  blocked: ['queued'],
  timeout: ['queued'],
  cancelled: ['queued'],
  agent_error: ['queued'],
  environment_error: ['queued'],
  verifier_error: ['queued'],
  indeterminate: ['queued'],
}

export function isTerminalRunState(state: RunState): boolean {
  return (RUN_TERMINAL_STATES as readonly RunState[]).includes(state)
}

export function isTerminalTrialState(state: TrialState): boolean {
  return (TRIAL_TERMINAL_STATES as readonly TrialState[]).includes(state)
}

export function assertRunStateTransition(current: RunState | undefined, next: RunState): void {
  if (current === undefined) {
    if (next !== 'draft') throw new Error('first run state must be draft')
    return
  }
  if (!RUN_TRANSITIONS[current].includes(next)) throw new Error('invalid run state transition: ' + current + ' -> ' + next)
}

export function assertTrialStateTransition(current: TrialState, next: TrialState): void {
  if (!TRIAL_TRANSITIONS[current].includes(next)) throw new Error('invalid trial state transition: ' + current + ' -> ' + next)
}

const EventEnvelopeSchema = z.object({
  schemaVersion: z.literal(1),
  sequence: z.number().int().nonnegative(),
  at: z.string().datetime(),
  runId: IdentifierSchema,
  producer: z.enum(['control-plane', 'worker', 'analyzer']),
  leaseId: IdentifierSchema.optional(),
  failure: NormalizedFailureSchema.optional(),
})

const RunStateEventSchema = EventEnvelopeSchema.extend({
  type: z.literal('run.state'),
  trialId: z.never().optional(),
  producer: z.literal('control-plane'),
  leaseId: z.never().optional(),
  data: z.object({ state: RunStateSchema, reason: NonEmptyStringSchema.optional() }).strict(),
}).strict()

const TrialCreatedEventSchema = EventEnvelopeSchema.extend({
  type: z.literal('trial.created'),
  trialId: IdentifierSchema,
  producer: z.literal('control-plane'),
  leaseId: z.never().optional(),
  data: z.object({
    trialId: IdentifierSchema,
    taskId: IdentifierSchema,
    agentVariantId: IdentifierSchema,
    backendId: AgentBackendIdSchema,
    sandboxProvider: SandboxProviderKindSchema,
    repeatIndex: z.number().int().nonnegative(),
  }).strict(),
}).strict().superRefine((event, ctx) => {
  if (event.trialId !== event.data.trialId) ctx.addIssue({ code: 'custom', path: ['data', 'trialId'], message: 'trial event identity mismatch' })
})

const TrialStateEventSchema = EventEnvelopeSchema.extend({
  type: z.literal('trial.state'),
  trialId: IdentifierSchema,
  data: z.object({
    trialId: IdentifierSchema,
    state: TrialStateSchema,
    reason: NonEmptyStringSchema.optional(),
    retryNotBefore: z.string().datetime().optional(),
    requestedBy: IdentifierSchema.optional(),
    resultHash: Sha256Schema.optional(),
    leaseId: IdentifierSchema.optional(),
  }).strict(),
}).strict().superRefine((event, ctx) => {
  if (event.trialId !== event.data.trialId) ctx.addIssue({ code: 'custom', path: ['data', 'trialId'], message: 'trial event identity mismatch' })
  if (event.producer === 'worker' && !event.leaseId) ctx.addIssue({ code: 'custom', path: ['leaseId'], message: 'Worker trial events require lease authority' })
  if (event.data.leaseId && event.data.leaseId !== event.leaseId) ctx.addIssue({ code: 'custom', path: ['data', 'leaseId'], message: 'trial event lease identity mismatch' })
  if (event.data.retryNotBefore && event.data.state !== 'queued') ctx.addIssue({ code: 'custom', path: ['data', 'retryNotBefore'], message: 'retryNotBefore is valid only for queued trials' })
})

const LeaderboardPublishedEventSchema = EventEnvelopeSchema.extend({
  type: z.literal('leaderboard.published'),
  trialId: z.never().optional(),
  producer: z.literal('control-plane'),
  leaseId: z.never().optional(),
  data: z.object({ entryIds: z.array(IdentifierSchema).min(1) }).strict(),
}).strict()

const CommandRequestedEventSchema = EventEnvelopeSchema.extend({
  type: z.literal('command.requested'),
  trialId: z.never().optional(),
  producer: z.literal('control-plane'),
  leaseId: z.never().optional(),
  data: z.object({ commandType: NonEmptyStringSchema, commandId: IdentifierSchema }).strict(),
}).strict()

export const EvaluationEventSchema = z.discriminatedUnion('type', [
  RunStateEventSchema,
  TrialCreatedEventSchema,
  TrialStateEventSchema,
  LeaderboardPublishedEventSchema,
  CommandRequestedEventSchema,
])

export const CommittedAcknowledgementSchema = z.object({
  schemaVersion: z.literal(1),
  idempotencyKey: IdentifierSchema,
  commandId: IdentifierSchema,
  committedSequence: z.number().int().nonnegative(),
  committedAt: z.string().datetime(),
  projectionVersion: z.number().int().nonnegative(),
}).strict()

export type EvaluationEvent = z.infer<typeof EvaluationEventSchema>
export type CommittedAcknowledgement = z.infer<typeof CommittedAcknowledgementSchema>
export type ReplayedEvaluationState = {
  runId: string
  runState: RunState
  trials: Readonly<Record<string, { state: TrialState; taskId: string; agentVariantId: string; repeatIndex: number }>>
}

export function assertMonotonicEvents(events: readonly EvaluationEvent[]): void {
  for (let index = 0; index < events.length; index += 1) {
    if (events[index]!.sequence !== index) throw new Error('event sequence is not contiguous at index ' + String(index))
    if (index > 0 && events[index]!.runId !== events[0]!.runId) throw new Error('event stream mixes multiple run IDs')
  }
}

export function replayEvaluationEvents(input: readonly unknown[]): ReplayedEvaluationState {
  const events = input.map((event) => EvaluationEventSchema.parse(event))
  if (events.length === 0) throw new Error('cannot replay an empty evaluation event stream')
  assertMonotonicEvents(events)
  let runState: RunState | undefined
  const trials = new Map<string, { state: TrialState; taskId: string; agentVariantId: string; repeatIndex: number }>()
  for (const event of events) {
    if (event.type === 'run.state') {
      assertRunStateTransition(runState, event.data.state)
      runState = event.data.state
    } else if (event.type === 'trial.created') {
      if (runState === undefined) throw new Error('trial cannot be created before the run state exists')
      if (trials.has(event.trialId)) throw new Error('duplicate trial ID in event stream: ' + event.trialId)
      trials.set(event.trialId, { state: 'queued', taskId: event.data.taskId, agentVariantId: event.data.agentVariantId, repeatIndex: event.data.repeatIndex })
    } else if (event.type === 'trial.state') {
      const trial = trials.get(event.trialId)
      if (!trial) throw new Error('trial state event references an unknown trial: ' + event.trialId)
      assertTrialStateTransition(trial.state, event.data.state)
      trial.state = event.data.state
    }
  }
  if (runState === undefined) throw new Error('event stream has no run state')
  return { runId: events[0]!.runId, runState, trials: Object.fromEntries([...trials.entries()].map(([id, trial]) => [id, { ...trial }])) }
}
