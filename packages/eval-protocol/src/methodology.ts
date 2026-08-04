import { z } from 'zod'

import { IdentifierSchema, NonEmptyStringSchema } from './common.js'

export const CAPABILITY_VECTOR_COMPONENTS = [
  'taskSuccess', 'codeUnderstanding', 'instructionFollowing', 'toolGrounding', 'recovery', 'contextRetention',
  'memoryQuality', 'planning', 'testIntegrity', 'efficiency', 'reproducibility',
] as const

const CapabilityComponentSchema = z.object({
  score: z.number().min(0).max(1), methodologyRef: NonEmptyStringSchema, evidenceRefs: z.array(NonEmptyStringSchema).min(1),
  detectorIds: z.array(IdentifierSchema), verifierIds: z.array(IdentifierSchema),
}).strict().superRefine((component, ctx) => {
  if (component.detectorIds.length === 0 && component.verifierIds.length === 0) ctx.addIssue({ code: 'custom', message: 'capability component requires an explicit detector or verifier' })
})

export const CapabilityVectorSchema = z.object({
  schemaVersion: z.literal(1), methodologyVersion: NonEmptyStringSchema, runId: IdentifierSchema, agentVariantId: IdentifierSchema,
  components: z.object(Object.fromEntries(CAPABILITY_VECTOR_COMPONENTS.map((name) => [name, CapabilityComponentSchema])) as Record<typeof CAPABILITY_VECTOR_COMPONENTS[number], typeof CapabilityComponentSchema>).strict(),
}).strict()

export type CapabilityVector = z.infer<typeof CapabilityVectorSchema>
