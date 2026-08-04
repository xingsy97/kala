import { RegressionGateDecisionSchema, type RegressionGateDecision, type RegressionRules } from '@agent-kernel/eval-protocol'

export type PairedObservation = {
  taskId: string
  repeatIndex: number
  baseline: { passed: boolean; costUsd?: number; latencyMs?: number; criticalDefects?: number; testGaming?: boolean; infrastructureFailure?: boolean; evidenceComplete?: boolean; evidenceRef: string }
  candidate: { passed: boolean; costUsd?: number; latencyMs?: number; criticalDefects?: number; testGaming?: boolean; infrastructureFailure?: boolean; evidenceComplete?: boolean; evidenceRef: string }
}

export function decideRegressionGate(input: {
  gateId: string
  baselineConfigHash: string
  candidateConfigHash: string
  observations: readonly PairedObservation[]
  rules: RegressionRules
}): RegressionGateDecision {
  if (input.observations.length === 0) throw new Error('regression gate requires paired observations')
  const byTask = new Map<string, PairedObservation[]>()
  for (const observation of input.observations) {
    const key = observation.taskId
    const values = byTask.get(key) ?? []
    if (values.some((value) => value.repeatIndex === observation.repeatIndex)) throw new Error('duplicate paired task repeat: ' + key + ':' + String(observation.repeatIndex))
    values.push(observation); byTask.set(key, values)
  }
  const infrastructureFailures = [...new Set(input.observations.flatMap((observation) => observation.baseline.infrastructureFailure || observation.candidate.infrastructureFailure ? [observation.taskId] : []))].sort()
  const flakyTasks = [...byTask.entries()].filter(([, values]) => mixed(values.map((value) => value.baseline.passed)) || mixed(values.map((value) => value.candidate.passed))).map(([taskId]) => taskId).sort()
  const excluded = new Set([...infrastructureFailures, ...flakyTasks])
  const eligible = [...byTask.entries()].filter(([taskId]) => !excluded.has(taskId)).map(([taskId, values]) => ({ taskId, values, baseline: mean(values.map((value) => Number(value.baseline.passed))), candidate: mean(values.map((value) => Number(value.candidate.passed))) }))
  const repeats = Math.max(...[...byTask.values()].map((values) => values.length))
  const baselineSuccessRate = mean(eligible.map((value) => value.baseline))
  const candidateSuccessRate = mean(eligible.map((value) => value.candidate))
  const successRateDelta = candidateSuccessRate - baselineSuccessRate
  const pairedWins = eligible.filter((value) => value.baseline < value.candidate).length
  const pairedLosses = eligible.filter((value) => value.baseline > value.candidate).length
  const pairedTies = eligible.length - pairedWins - pairedLosses
  const deltas = eligible.map((value) => value.candidate - value.baseline)
  const interval = bootstrapConfidenceInterval(deltas, input.rules.confidenceLevel, input.gateId)
  const flakeRate = ratio(flakyTasks.length, byTask.size)
  const newCriticalDefects = Math.max(0, sum(input.observations, (value) => value.candidate.criticalDefects ?? 0) - sum(input.observations, (value) => value.baseline.criticalDefects ?? 0))
  const testGamingRate = ratio(input.observations.filter((value) => value.candidate.testGaming).length, input.observations.length)
  const costIncreasePct = percentIncrease(p95(input.observations.map((value) => value.baseline.costUsd).filter(number)), p95(input.observations.map((value) => value.candidate.costUsd).filter(number)))
  const evidenceCompleteness = {
    baseline: ratio(input.observations.filter((value) => value.baseline.evidenceComplete !== false && value.baseline.evidenceRef.length > 0).length, input.observations.length),
    candidate: ratio(input.observations.filter((value) => value.candidate.evidenceComplete !== false && value.candidate.evidenceRef.length > 0).length, input.observations.length),
    completePairs: input.observations.filter((value) => value.baseline.evidenceComplete !== false && value.candidate.evidenceComplete !== false && value.baseline.evidenceRef.length > 0 && value.candidate.evidenceRef.length > 0).length,
    totalPairs: input.observations.length,
  }
  const repeatedRunVariance = {
    baseline: mean([...byTask.values()].map((values) => populationVariance(values.map((value) => Number(value.baseline.passed))))),
    candidate: mean([...byTask.values()].map((values) => populationVariance(values.map((value) => Number(value.candidate.passed))))),
    taskCount: byTask.size,
  }
  const pareto = paretoSummary(input.observations, baselineSuccessRate, candidateSuccessRate)
  const taskDeltas = eligible.map((value) => ({ taskId: value.taskId, baseline: value.baseline, candidate: value.candidate, delta: value.candidate - value.baseline, repeats: value.values.length })).sort((left, right) => left.taskId.localeCompare(right.taskId))
  const violations = [
    violation('success-rate-drop', Math.max(0, -successRateDelta * 100), input.rules.maxSuccessRateDropPp),
    violation('new-critical-defects', newCriticalDefects, input.rules.maxNewCriticalDefects),
    violation('test-gaming-rate', testGamingRate, input.rules.maxTestGamingRate),
    violation('p95-cost-increase', costIncreasePct, input.rules.maxP95CostIncreasePct),
  ].filter((value): value is NonNullable<typeof value> => value !== undefined)
  const incomplete = eligible.length === 0 || infrastructureFailures.length > 0 || flakeRate > input.rules.allowedFlakeRate
  const decision = incomplete ? 'indeterminate' : violations.length > 0 ? 'block' : 'pass'
  return RegressionGateDecisionSchema.parse({
    schemaVersion: 1, gateId: input.gateId, baselineConfigHash: input.baselineConfigHash, candidateConfigHash: input.candidateConfigHash,
    pairedTasks: byTask.size, repeats, confidenceLevel: input.rules.confidenceLevel, flakyTasks, infrastructureFailures, violations, decision,
    evidenceRefs: [...new Set(input.observations.flatMap((value) => [value.baseline.evidenceRef, value.candidate.evidenceRef]))].sort(),
    statistics: { baselineSuccessRate, candidateSuccessRate, successRateDelta, pairedWins, pairedLosses, pairedTies, mcnemarPValue: exactMcNemar(pairedWins, pairedLosses), confidenceInterval: { level: input.rules.confidenceLevel, ...interval, method: 'paired-bootstrap', samples: 10_000 }, repeatedRunVariance, evidenceCompleteness, pareto, taskDeltas, flakeRate },
  })
}

function exactMcNemar(wins: number, losses: number): number {
  const n = wins + losses
  if (n === 0) return 1
  const k = Math.min(wins, losses)
  let probability = 0
  for (let index = 0; index <= k; index += 1) probability += combination(n, index) * Math.pow(0.5, n)
  return Math.min(1, probability * 2)
}
function combination(n: number, k: number): number { let value = 1; for (let index = 1; index <= k; index += 1) value = value * (n - k + index) / index; return value }
function bootstrapConfidenceInterval(values: readonly number[], level: number, seedText: string): { lower: number; upper: number } {
  if (values.length === 0) return { lower: 0, upper: 0 }
  if (values.length === 1) return { lower: values[0]!, upper: values[0]! }
  const random = seededRandom(seedText)
  const means = Array.from({ length: 10_000 }, () => mean(Array.from({ length: values.length }, () => values[Math.floor(random() * values.length)]!))).sort((left, right) => left - right)
  const tail = (1 - level) / 2
  return { lower: means[Math.floor(tail * (means.length - 1))]!, upper: means[Math.ceil((1 - tail) * (means.length - 1))]! }
}
function seededRandom(text: string): () => number {
  let state = 2166136261
  for (const character of text) state = Math.imul(state ^ character.charCodeAt(0), 16777619) >>> 0
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 0x1_0000_0000 }
}
function paretoSummary(observations: readonly PairedObservation[], baselineQuality: number, candidateQuality: number) {
  const baselineCost = averageOptional(observations.map((value) => value.baseline.costUsd))
  const candidateCost = averageOptional(observations.map((value) => value.candidate.costUsd))
  const baselineLatency = averageOptional(observations.map((value) => value.baseline.latencyMs))
  const candidateLatency = averageOptional(observations.map((value) => value.candidate.latencyMs))
  const baseline = { quality: baselineQuality, costUsd: baselineCost, latencyMs: baselineLatency }
  const candidate = { quality: candidateQuality, costUsd: candidateCost, latencyMs: candidateLatency }
  if ([baselineCost, candidateCost, baselineLatency, candidateLatency].some((value) => value === null)) return { relation: 'insufficient_evidence' as const, baseline, candidate }
  const candidateNoWorse = candidateQuality >= baselineQuality && candidateCost! <= baselineCost! && candidateLatency! <= baselineLatency!
  const baselineNoWorse = baselineQuality >= candidateQuality && baselineCost! <= candidateCost! && baselineLatency! <= candidateLatency!
  const candidateStrict = candidateQuality > baselineQuality || candidateCost! < baselineCost! || candidateLatency! < baselineLatency!
  const baselineStrict = baselineQuality > candidateQuality || baselineCost! < candidateCost! || baselineLatency! < candidateLatency!
  return { relation: candidateNoWorse && candidateStrict ? 'candidate_dominates' as const : baselineNoWorse && baselineStrict ? 'baseline_dominates' as const : candidateNoWorse && baselineNoWorse ? 'equivalent' as const : 'tradeoff' as const, baseline, candidate }
}
function p95(values: readonly number[]): number { if (!values.length) return 0; const sorted = [...values].sort((a, b) => a - b); return sorted[Math.ceil(sorted.length * .95) - 1]! }
function percentIncrease(baseline: number, candidate: number): number { if (baseline === 0) return candidate === 0 ? 0 : Number.POSITIVE_INFINITY; return (candidate - baseline) / baseline * 100 }
function violation(rule: string, observed: number, threshold: number) { return observed > threshold ? { rule, observed, threshold } : undefined }
function mixed(values: readonly boolean[]): boolean { return values.some(Boolean) && values.some((value) => !value) }
function ratio(numerator: number, denominator: number): number { return denominator === 0 ? 0 : numerator / denominator }
function mean(values: readonly number[]): number { return values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length }
function populationVariance(values: readonly number[]): number { const average = mean(values); return mean(values.map((value) => Math.pow(value - average, 2))) }
function averageOptional(values: readonly (number | undefined)[]): number | null { const present = values.filter(number); return present.length === values.length ? mean(present) : null }
function sum(values: readonly PairedObservation[], select: (value: PairedObservation) => number): number { return values.reduce((total, value) => total + select(value), 0) }
function number(value: number | undefined): value is number { return value !== undefined && Number.isFinite(value) }
