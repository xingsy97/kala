import { z } from 'zod'

import { IdentifierSchema, NonEmptyStringSchema, RelativeArtifactPathSchema } from './common.js'
import { EvaluationRunSpecSchema } from './run-spec.js'

const ARTIFACT_PATH_PLACEHOLDERS = new Set([
  'taskPackId',
  'runId',
  'taskId',
  'agentVariantId',
  'repeatIndex',
  'trialId',
])

export const RunTemplateArtifactPathSchema = RelativeArtifactPathSchema.superRefine((path, context) => {
  for (const match of path.matchAll(/\{([^{}]+)\}/gu)) {
    if (!ARTIFACT_PATH_PLACEHOLDERS.has(match[1]!)) {
      context.addIssue({ code: 'custom', message: 'unsupported artifact path placeholder: ' + match[1] })
    }
  }
  if (path.replace(/\{[^{}]+\}/gu, '').match(/[{}]/u)) {
    context.addIssue({ code: 'custom', message: 'artifact path template contains an unmatched brace' })
  }
})

export const EvaluationRunTemplateBuilderSchema = z.object({
  taskIds: z.array(IdentifierSchema).min(1),
  artifactAllowlistPathTemplates: z.array(RunTemplateArtifactPathSchema),
}).strict().superRefine((builder, context) => {
  if (new Set(builder.taskIds).size !== builder.taskIds.length) {
    context.addIssue({ code: 'custom', path: ['taskIds'], message: 'run template task IDs must be unique' })
  }
})

export const EvaluationRunTemplateSchema = z.object({
  schemaVersion: z.literal(1),
  templateId: IdentifierSchema,
  label: NonEmptyStringSchema,
  description: NonEmptyStringSchema,
  kind: z.enum(['smoke', 'benchmark']),
  recommended: z.boolean().default(false),
  builder: EvaluationRunTemplateBuilderSchema,
  spec: EvaluationRunSpecSchema,
}).strict().superRefine((template, context) => {
  if (template.builder.taskIds.length !== template.spec.taskPack.evaluatedSlice.selectedItems) {
    context.addIssue({
      code: 'custom',
      path: ['builder', 'taskIds'],
      message: 'run template task count must match the immutable evaluated slice',
    })
  }
})

export const EvaluationRunTemplatesSchema = z.array(EvaluationRunTemplateSchema)
  .superRefine((templates, context) => {
    const identifiers = new Set<string>()
    for (let index = 0; index < templates.length; index += 1) {
      const identifier = templates[index]!.templateId
      if (identifiers.has(identifier)) {
        context.addIssue({ code: 'custom', path: [index, 'templateId'], message: 'duplicate run template: ' + identifier })
      }
      identifiers.add(identifier)
    }
  })

export type EvaluationRunTemplate = z.infer<typeof EvaluationRunTemplateSchema>
