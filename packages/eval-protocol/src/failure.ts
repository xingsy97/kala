import { z } from 'zod'

import { IdentifierSchema, NonEmptyStringSchema } from './common.js'

export const FailureCategorySchema = z.enum([
  'agent_failure',
  'invalid_action',
  'unmet_precondition',
  'environment_failure',
  'provider_failure',
  'verifier_failure',
  'cancelled',
  'timeout',
  'indeterminate_side_effect',
])

export const FailureResponsibilitySchema = z.enum([
  'agent',
  'model',
  'platform',
  'provider',
  'environment',
  'verifier',
  'operator',
  'indeterminate',
])

export const NormalizedFailureSchema = z.object({
  schemaVersion: z.literal(1),
  category: FailureCategorySchema,
  responsibility: FailureResponsibilitySchema,
  code: IdentifierSchema,
  summary: NonEmptyStringSchema,
  retryable: z.boolean(),
  observedStateSufficientForRecovery: z.boolean(),
  evidenceRefs: z.array(NonEmptyStringSchema).min(1),
}).strict().superRefine((failure, ctx) => {
  const allowed: Readonly<Record<FailureCategory, readonly FailureResponsibility[]>> = {
    agent_failure: ['agent', 'model'],
    invalid_action: ['agent', 'model'],
    unmet_precondition: ['agent', 'platform', 'operator'],
    environment_failure: ['environment', 'platform'],
    provider_failure: ['provider'],
    verifier_failure: ['verifier'],
    cancelled: ['operator', 'platform'],
    timeout: ['agent', 'model', 'platform', 'provider', 'environment', 'verifier', 'indeterminate'],
    indeterminate_side_effect: ['indeterminate'],
  }
  if (!allowed[failure.category].includes(failure.responsibility)) {
    ctx.addIssue({ code: 'custom', path: ['responsibility'], message: 'failure responsibility is incompatible with category ' + failure.category })
  }
  if (failure.category === 'indeterminate_side_effect' && failure.retryable) {
    ctx.addIssue({ code: 'custom', path: ['retryable'], message: 'indeterminate side effects cannot be blindly retried' })
  }
})

export type FailureCategory = z.infer<typeof FailureCategorySchema>
export type FailureResponsibility = z.infer<typeof FailureResponsibilitySchema>
export type NormalizedFailure = z.infer<typeof NormalizedFailureSchema>

export type ResponsibilityDecisionInput = {
  category: FailureCategory
  origin: 'agent' | 'model' | 'platform' | 'provider' | 'environment' | 'verifier' | 'operator' | 'unknown'
  observedStateSufficientForRecovery: boolean
  sideEffectMayHaveOccurred: boolean
  retryRequested: boolean
}

export type ResponsibilityDecision = {
  category: FailureCategory
  responsibility: FailureResponsibility
  observedStateSufficientForRecovery: boolean
  retryable: boolean
}

/**
 * Canonical responsibility policy. Agent/model attribution is allowed only
 * when the observation was sufficient to choose a safer recovery action.
 */
export function decideFailureResponsibility(input: ResponsibilityDecisionInput): ResponsibilityDecision {
  if (input.sideEffectMayHaveOccurred && !input.observedStateSufficientForRecovery) {
    return { category: 'indeterminate_side_effect', responsibility: 'indeterminate', observedStateSufficientForRecovery: false, retryable: false }
  }
  const responsibility = responsibilityFor(input.category, input.origin)
  if ((responsibility === 'agent' || responsibility === 'model') && !input.observedStateSufficientForRecovery) {
    return { category: 'indeterminate_side_effect', responsibility: 'indeterminate', observedStateSufficientForRecovery: false, retryable: false }
  }
  const decision = { category: input.category, responsibility, observedStateSufficientForRecovery: input.observedStateSufficientForRecovery, retryable: input.retryRequested }
  NormalizedFailureSchema.parse({ schemaVersion: 1, ...decision, code: 'RESPONSIBILITY_DECISION', summary: 'responsibility policy validation', evidenceRefs: ['responsibility-policy'] })
  return decision
}

function responsibilityFor(category: FailureCategory, origin: ResponsibilityDecisionInput['origin']): FailureResponsibility {
  switch (category) {
    case 'agent_failure':
    case 'invalid_action': return origin === 'model' ? 'model' : 'agent'
    case 'unmet_precondition': return origin === 'operator' ? 'operator' : origin === 'agent' || origin === 'model' ? 'agent' : 'platform'
    case 'environment_failure': return origin === 'platform' ? 'platform' : 'environment'
    case 'provider_failure': return 'provider'
    case 'verifier_failure': return 'verifier'
    case 'cancelled': return origin === 'operator' ? 'operator' : 'platform'
    case 'timeout': return ['agent', 'model', 'platform', 'provider', 'environment', 'verifier'].includes(origin) ? origin as FailureResponsibility : 'indeterminate'
    case 'indeterminate_side_effect': return 'indeterminate'
  }
}
