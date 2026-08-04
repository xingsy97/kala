import { z } from 'zod'

import { IdentifierSchema, NonEmptyStringSchema, RelativeArtifactPathSchema, Sha256Schema } from './common.js'
import { CatalogUsagePolicySchema } from './catalog-policy.js'

export const DatasetVersionRefSchema = z.object({
  datasetId: IdentifierSchema,
  displayName: NonEmptyStringSchema,
  version: NonEmptyStringSchema,
  sourceRevision: NonEmptyStringSchema,
  manifestHash: Sha256Schema,
  taskIdsHash: Sha256Schema,
  split: NonEmptyStringSchema.optional(),
  totalItems: z.number().int().positive(),
  officialBenchmark: z.boolean(),
  policy: CatalogUsagePolicySchema,
}).strict()

export const EvaluatedSliceSelectionSpecSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('full'), taskIdsHash: Sha256Schema }).strict(),
  z.object({ kind: z.literal('official_subset'), officialSubsetId: IdentifierSchema, taskIdsHash: Sha256Schema }).strict(),
  z.object({ kind: z.literal('named_subset'), namedSubsetId: IdentifierSchema, taskIdsHash: Sha256Schema }).strict(),
  z.object({ kind: z.literal('explicit_ids'), taskIdsHash: Sha256Schema }).strict(),
  z.object({
    kind: z.literal('sampled'),
    taskIdsHash: Sha256Schema,
    sample: z.object({ count: z.number().int().positive(), seed: z.number().int(), stratification: NonEmptyStringSchema }).strict(),
    filters: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  }).strict(),
])

export const EvaluatedSliceSchema = z.object({
  sliceId: IdentifierSchema,
  dataset: DatasetVersionRefSchema,
  selectionKind: z.enum(['full', 'official_subset', 'named_subset', 'explicit_ids', 'sampled']),
  selectionSpec: EvaluatedSliceSelectionSpecSchema,
  selectedItems: z.number().int().positive(),
  coverageRatio: z.number().min(0).max(1),
  taskIdsManifestRef: RelativeArtifactPathSchema,
  sliceManifestHash: Sha256Schema,
}).strict().superRefine((slice, ctx) => {
  if (slice.selectionSpec.kind !== slice.selectionKind) {
    ctx.addIssue({ code: 'custom', path: ['selectionSpec', 'kind'], message: 'selectionSpec kind must match selectionKind' })
  }
  if (slice.selectedItems > slice.dataset.totalItems) {
    ctx.addIssue({ code: 'custom', path: ['selectedItems'], message: 'selectedItems cannot exceed totalItems' })
  }
  const expectedCoverage = slice.selectedItems / slice.dataset.totalItems
  if (Math.abs(slice.coverageRatio - expectedCoverage) > 1e-12) {
    ctx.addIssue({ code: 'custom', path: ['coverageRatio'], message: 'coverageRatio must equal selectedItems / totalItems' })
  }
  if (slice.selectionKind === 'full' && slice.selectedItems !== slice.dataset.totalItems) {
    ctx.addIssue({ code: 'custom', path: ['selectionKind'], message: 'full selection requires every dataset item' })
  }
  if (slice.selectionKind === 'full' && slice.selectionSpec.kind === 'full' && slice.selectionSpec.taskIdsHash !== slice.dataset.taskIdsHash) {
    ctx.addIssue({ code: 'custom', path: ['selectionSpec', 'taskIdsHash'], message: 'full selection task IDs must match the complete dataset catalog' })
  }
  if (slice.selectionKind !== 'full' && slice.selectedItems >= slice.dataset.totalItems) {
    ctx.addIssue({ code: 'custom', path: ['selectedItems'], message: 'a subset must contain fewer items than its parent dataset' })
  }
  if (slice.selectionKind === 'sampled' && slice.selectionSpec.kind === 'sampled' && slice.selectionSpec.sample.count !== slice.selectedItems) {
    ctx.addIssue({ code: 'custom', path: ['selectionSpec', 'sample', 'count'], message: 'sample count must equal selectedItems' })
  }
})

export type DatasetVersionRef = z.infer<typeof DatasetVersionRefSchema>
export type EvaluatedSlice = z.infer<typeof EvaluatedSliceSchema>
export type EvaluatedSliceSelectionSpec = z.infer<typeof EvaluatedSliceSelectionSpecSchema>

export function formatEvaluatedSliceLabel(slice: EvaluatedSlice): string {
  const coverage = String(slice.selectedItems) + '/' + String(slice.dataset.totalItems)
  switch (slice.selectionSpec.kind) {
    case 'full': return slice.dataset.displayName + ' · full · ' + coverage
    case 'official_subset': return slice.dataset.displayName + ' · official subset "' + slice.selectionSpec.officialSubsetId + '" · ' + coverage + ' parent coverage'
    case 'named_subset': return slice.dataset.displayName + ' · named subset "' + slice.selectionSpec.namedSubsetId + '" · ' + coverage
    case 'explicit_ids': return slice.dataset.displayName + ' · custom subset · ' + coverage
    case 'sampled': {
      const sample = slice.selectionSpec.sample
      const selectedFilters = slice.selectionSpec.filters
      const filters = Object.keys(selectedFilters).sort().map((key) => key + '=' + String(selectedFilters[key])).join(',') || 'none'
      return slice.dataset.displayName + ' · sampled subset · ' + coverage + ' · seed ' + String(sample.seed) + ' · stratified by ' + sample.stratification + ' · filters ' + filters
    }
  }
}
