import { z } from 'zod'

import { NonEmptyStringSchema } from './common.js'

export const POLICY_STATUSES = ['granted', 'denied', 'unknown', 'unreviewed'] as const
export const PolicyStatusSchema = z.enum(POLICY_STATUSES)
export const PolicyGrantSchema = z.object({
  status: PolicyStatusSchema,
  basis: NonEmptyStringSchema.optional(),
}).strict()

export const SourceProvenanceSchema = z.object({
  status: PolicyStatusSchema,
  sourceRefs: z.array(NonEmptyStringSchema),
}).strict().superRefine((value, ctx) => {
  if (value.status === 'granted' && value.sourceRefs.length === 0) ctx.addIssue({ code: 'custom', path: ['sourceRefs'], message: 'granted source provenance requires at least one source reference' })
})

export const CatalogUsagePolicySchema = z.object({
  license: PolicyGrantSchema,
  permissions: z.object({ evaluation: PolicyGrantSchema, training: PolicyGrantSchema }).strict(),
  sourceProvenance: SourceProvenanceSchema,
  publication: z.object({
    artifact: PolicyGrantSchema,
    report: PolicyGrantSchema,
    leaderboard: PolicyGrantSchema,
    redistribution: PolicyGrantSchema,
  }).strict(),
}).strict()

export const POLICY_OPERATIONS = ['run_admission', 'artifact_publication', 'report_publication', 'leaderboard_publication'] as const
export type PolicyOperation = typeof POLICY_OPERATIONS[number]
export type PolicyStatus = z.infer<typeof PolicyStatusSchema>
export type PolicyGrant = z.infer<typeof PolicyGrantSchema>
export type CatalogUsagePolicy = z.infer<typeof CatalogUsagePolicySchema>

export type CatalogPolicyDecision = {
  allowed: boolean
  operation: PolicyOperation
  purpose: 'evaluation' | 'training'
  denials: Array<{ subject: 'dataset' | 'task_pack'; dimension: string; status: PolicyStatus }>
}

export function decideCatalogPolicy(input: {
  operation: PolicyOperation
  purpose?: 'evaluation' | 'training'
  dataset: CatalogUsagePolicy
  taskPack: CatalogUsagePolicy
}): CatalogPolicyDecision {
  const purpose = input.purpose ?? 'evaluation'
  const checks: Array<[string, (policy: CatalogUsagePolicy) => PolicyGrant]> = [
    ['license', (policy) => policy.license],
    ['permission.' + purpose, (policy) => policy.permissions[purpose]],
    ['sourceProvenance', (policy) => ({ status: policy.sourceProvenance.status })],
  ]
  if (input.operation !== 'run_admission') {
    const target = input.operation === 'artifact_publication' ? 'artifact' : input.operation === 'report_publication' ? 'report' : 'leaderboard'
    checks.push(['publication.' + target, (policy) => policy.publication[target]])
    checks.push(['publication.redistribution', (policy) => policy.publication.redistribution])
  }
  const denials: CatalogPolicyDecision['denials'] = []
  for (const [subject, policy] of [['dataset', input.dataset], ['task_pack', input.taskPack]] as const) {
    for (const [dimension, select] of checks) {
      const status = select(policy).status
      if (status !== 'granted') denials.push({ subject, dimension, status })
    }
  }
  return { allowed: denials.length === 0, operation: input.operation, purpose, denials }
}
