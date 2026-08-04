import {
  DefectDetectorDescriptorSchema,
  DefectFindingSchema,
  defineDefectDetectorPlugin,
  type AnalyzerInput,
  type DefectDetector,
  type DefectFinding,
} from '@agent-kernel/eval-sdk'

const descriptor = DefectDetectorDescriptorSchema.parse({ schemaVersion: 1, protocolVersions: [1], id: 'example:sample-error-detector', version: '1.0.0', capabilities: ['analyze'] })

class SampleErrorDetector implements DefectDetector<AnalyzerInput, never, never> {
  readonly descriptor = descriptor

  async analyze(input: AnalyzerInput): Promise<DefectFinding[]> {
    const firstError = input.events.find((event) => event.kind === 'error')
    if (!firstError) return []
    return [DefectFindingSchema.parse({
      schemaVersion: 1,
      findingId: 'sample-error-' + input.trialId,
      detectorId: descriptor.id,
      detectorVersion: descriptor.version,
      runId: input.runId,
      trialId: input.trialId,
      category: 'unknown',
      severity: 'medium',
      confidence: 1,
      firstDivergenceSequence: firstError.sequence,
      evidenceRefs: [firstError.nativeEventRef ?? 'normalized-events.jsonl#' + String(firstError.sequence)],
      status: 'detected',
    })]
  }
}

export const evaluationPlugins = [defineDefectDetectorPlugin({
  kind: 'defect-detector', descriptor, create: () => new SampleErrorDetector(),
})]
