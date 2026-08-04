import { createHash } from 'node:crypto'

import { DetectorValidationReportSchema, canonicalJson, type AnalyzerInput, type DetectorValidationCaseMetadata, type DetectorValidationReport } from '@agent-kernel/eval-protocol'
import { calibratedDetectorConfidence, DETECTOR_VERSIONS, detect, type RequiredDetectorId } from './detectors.js'

export type DetectorValidationCase = { caseId: string; detectorId: RequiredDetectorId; expectedFinding: boolean; input: AnalyzerInput; metadata?: DetectorValidationCaseMetadata }
type ScoredCase = { testCase: DetectorValidationCase; actual: boolean; probability: number }

export function validateDetector(detectorId: RequiredDetectorId, cases: readonly DetectorValidationCase[], generatedAt: string, corpusId = 'required-detectors-seeded-v1', corpusVersion = '1'): DetectorValidationReport {
  const detectorCases = cases.filter((testCase) => testCase.detectorId === detectorId)
  const selected = detectorCases.some((entry) => entry.metadata) ? detectorCases.filter((entry) => entry.metadata?.split === 'holdout') : detectorCases
  if (selected.length === 0) throw new Error('validation corpus has no holdout cases for detector: ' + detectorId)
  const scored: ScoredCase[] = selected.map((testCase) => {
    const findings = detect(detectorId, testCase.input)
    const actual = findings.length > 0
    const classConfidence = findings[0]?.confidence ?? calibratedDetectorConfidence(detectorId, testCase.input)
    return { testCase, actual, probability: actual ? classConfidence : 1 - classConfidence }
  })
  const truePositive = scored.filter((entry) => entry.actual && entry.testCase.expectedFinding).length
  const falsePositive = scored.filter((entry) => entry.actual && !entry.testCase.expectedFinding).length
  const trueNegative = scored.filter((entry) => !entry.actual && !entry.testCase.expectedFinding).length
  const falseNegative = scored.filter((entry) => !entry.actual && entry.testCase.expectedFinding).length
  const precision = ratio(truePositive, truePositive + falsePositive)
  const recall = ratio(truePositive, truePositive + falseNegative)
  const f1 = precision + recall === 0 ? 0 : 2 * precision * recall / (precision + recall)
  const corpusManifestHash = createHash('sha256').update(canonicalJson(selected.map(({ caseId, detectorId: id, expectedFinding, input, metadata }) => ({ caseId, detectorId: id, expectedFinding, inputManifestHash: input.inputManifestHash, metadata })))).digest('hex')
  const groups = [...new Set(selected.map((entry) => entry.metadata?.groupId ?? entry.caseId))]
  const seed = Number.parseInt(corpusManifestHash.slice(0, 8), 16)
  const confidenceIntervals = bootstrap(scored, groups, seed, 1000)
  const brier = scored.reduce((sum, entry) => sum + (entry.probability - Number(entry.testCase.expectedFinding)) ** 2, 0) / scored.length
  const bins = 10
  const ece = expectedCalibrationError(scored, bins)
  const annotations = selected.map((entry) => entry.metadata?.annotation).filter((entry) => entry !== undefined)
  const doubleAnnotated = annotations.filter((entry) => entry.labels.length > 1)
  const annotation = {
    annotatedCases: annotations.length, doubleAnnotatedCases: doubleAnnotated.length,
    agreement: doubleAnnotated.length === 0 ? 0 : doubleAnnotated.filter((entry) => new Set(entry.labels).size === 1).length / doubleAnnotated.length,
    adjudicatedCases: annotations.filter((entry) => entry.adjudicatorId !== undefined).length,
  }
  return DetectorValidationReportSchema.parse({ schemaVersion: 1, corpusId, corpusVersion, corpusManifestHash, detectorId, detectorVersion: DETECTOR_VERSIONS[detectorId], cases: selected.length, truePositive, falsePositive, trueNegative, falseNegative, precision, recall, f1, confidenceIntervals, calibration: { brier, ece, bins }, annotation, generatedAt })
}

function ratio(numerator: number, denominator: number): number { return denominator === 0 ? 0 : numerator / denominator }

function bootstrap(scored: readonly ScoredCase[], groups: readonly string[], seed: number, samples: number) {
  let state = seed || 1
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 0x100000000 }
  const values = { precision: [] as number[], recall: [] as number[], f1: [] as number[] }
  for (let sample = 0; sample < samples; sample += 1) {
    const drawn = Array.from({ length: groups.length }, () => groups[Math.floor(random() * groups.length)]!)
    const rows = drawn.flatMap((group) => scored.filter((entry) => (entry.testCase.metadata?.groupId ?? entry.testCase.caseId) === group))
    const tp = rows.filter((entry) => entry.actual && entry.testCase.expectedFinding).length
    const fp = rows.filter((entry) => entry.actual && !entry.testCase.expectedFinding).length
    const fn = rows.filter((entry) => !entry.actual && entry.testCase.expectedFinding).length
    const precision = ratio(tp, tp + fp), recall = ratio(tp, tp + fn)
    values.precision.push(precision); values.recall.push(recall); values.f1.push(precision + recall === 0 ? 0 : 2 * precision * recall / (precision + recall))
  }
  const interval = (items: number[]) => { items.sort((a, b) => a - b); return { lower: items[Math.floor(samples * 0.025)]!, upper: items[Math.floor(samples * 0.975)]! } }
  return { method: 'group-bootstrap' as const, confidenceLevel: 0.95 as const, samples, seed, precision: interval(values.precision), recall: interval(values.recall), f1: interval(values.f1) }
}

function expectedCalibrationError(scored: readonly ScoredCase[], bins: number): number {
  let result = 0
  for (let index = 0; index < bins; index += 1) {
    const lower = index / bins, upper = (index + 1) / bins
    const entries = scored.filter((entry) => entry.probability >= lower && (index === bins - 1 ? entry.probability <= upper : entry.probability < upper))
    if (entries.length === 0) continue
    const confidence = entries.reduce((sum, entry) => sum + entry.probability, 0) / entries.length
    const frequency = entries.filter((entry) => entry.testCase.expectedFinding).length / entries.length
    result += entries.length / scored.length * Math.abs(confidence - frequency)
  }
  return result
}
