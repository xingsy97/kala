#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import process from 'node:process'

const args = parseArgs(process.argv.slice(2))
const result = JSON.parse(await readFile(args.result, 'utf8'))
const invalidReasons = []

if (!result || typeof result !== 'object' || Array.isArray(result)) invalidReasons.push('result_not_object')
if (!nonEmptyString(result.evaluated_model)) invalidReasons.push('missing_evaluated_model')
if (!nonEmptyString(result.judge_model)) invalidReasons.push('missing_judge_model')
if (!Array.isArray(result.rubrics)) invalidReasons.push('missing_rubrics')

const rubrics = Array.isArray(result.rubrics) ? result.rubrics : []
const seenRubricIndexes = new Set()
let computedTotalScore = 0
let computedMaxScore = 0
let computedPassedCount = 0

for (const [position, rubric] of rubrics.entries()) {
  const rubricId = rubric?.index ?? position
  const prefix = `rubric_${rubricId}`
  if (!rubric || typeof rubric !== 'object' || Array.isArray(rubric)) {
    invalidReasons.push(`${prefix}:not_object`)
    continue
  }
  if (!Number.isInteger(rubric.index)) invalidReasons.push(`${prefix}:missing_integer_index`)
  if (seenRubricIndexes.has(rubric.index)) invalidReasons.push(`${prefix}:duplicate_index`)
  seenRubricIndexes.add(rubric.index)
  if (!nonEmptyString(rubric.rubric)) invalidReasons.push(`${prefix}:missing_rubric_text`)

  const weight = Number(rubric.weight)
  if (!Number.isFinite(weight) || weight < 0) invalidReasons.push(`${prefix}:invalid_weight`)
  else computedMaxScore += weight

  const rubricResult = rubric.result
  if (!rubricResult || typeof rubricResult !== 'object' || Array.isArray(rubricResult)) {
    invalidReasons.push(`${prefix}:missing_result`)
    continue
  }

  const passed = rubricResult.passed
  if (typeof passed !== 'boolean') invalidReasons.push(`${prefix}:passed_not_boolean`)
  else if (passed) computedPassedCount += 1

  const score = Number(rubricResult.score)
  if (!Number.isFinite(score)) invalidReasons.push(`${prefix}:score_not_number`)
  else {
    computedTotalScore += score
    if (Number.isFinite(weight) && (score < 0 || score > weight)) invalidReasons.push(`${prefix}:score_out_of_range`)
    if (passed === true && score !== weight) invalidReasons.push(`${prefix}:passed_score_must_equal_weight`)
    if (passed === false && score !== 0) invalidReasons.push(`${prefix}:failed_score_must_be_zero`)
  }

  const criteria = Array.isArray(rubricResult.criteria_results) ? rubricResult.criteria_results : null
  if (!criteria) invalidReasons.push(`${prefix}:missing_criteria_results`)
  const criteriaCount = Number(rubricResult.criteria_count)
  if (!Number.isInteger(criteriaCount) || criteriaCount < 0) invalidReasons.push(`${prefix}:invalid_criteria_count`)
  if (criteria && Number.isInteger(criteriaCount) && criteria.length !== criteriaCount) invalidReasons.push(`${prefix}:criteria_count_mismatch`)

  let criteriaPassed = 0
  const seenCriterionIndexes = new Set()
  for (const [criterionPosition, criterion] of (criteria ?? []).entries()) {
    const criterionId = criterion?.index ?? criterionPosition
    const criterionPrefix = `${prefix}_criterion_${criterionId}`
    if (!criterion || typeof criterion !== 'object' || Array.isArray(criterion)) {
      invalidReasons.push(`${criterionPrefix}:not_object`)
      continue
    }
    if (!Number.isInteger(criterion.index)) invalidReasons.push(`${criterionPrefix}:missing_integer_index`)
    if (seenCriterionIndexes.has(criterion.index)) invalidReasons.push(`${criterionPrefix}:duplicate_index`)
    seenCriterionIndexes.add(criterion.index)
    if (!nonEmptyString(criterion.criterion)) invalidReasons.push(`${criterionPrefix}:missing_criterion_text`)
    if (typeof criterion.passed !== 'boolean') invalidReasons.push(`${criterionPrefix}:passed_not_boolean`)
    else if (criterion.passed) criteriaPassed += 1
    const reasoning = String(criterion.reasoning ?? '')
    if (!nonEmptyString(reasoning)) invalidReasons.push(`${criterionPrefix}:missing_reasoning`)
    if (isInfrastructureFailure(reasoning)) invalidReasons.push(`${criterionPrefix}:${reasoning}`)
  }

  const reportedCriteriaPassed = Number(rubricResult.criteria_passed)
  if (!Number.isInteger(reportedCriteriaPassed) || reportedCriteriaPassed < 0) invalidReasons.push(`${prefix}:invalid_criteria_passed`)
  else if (criteria && reportedCriteriaPassed !== criteriaPassed) invalidReasons.push(`${prefix}:criteria_passed_mismatch`)
  if (criteria && typeof passed === 'boolean' && passed !== criteria.every((criterion) => criterion.passed === true)) invalidReasons.push(`${prefix}:rubric_passed_mismatch`)

  const overall = String(rubricResult.overall_reasoning ?? '')
  if (!nonEmptyString(overall)) invalidReasons.push(`${prefix}:missing_overall_reasoning`)
  if (isInfrastructureFailure(overall)) invalidReasons.push(`${prefix}:${overall}`)
}

const maxScore = Number(result.max_score ?? 0)
const totalScore = Number(result.total_score ?? 0)
const passedCount = Number(result.passed_count ?? 0)
const totalCount = Number(result.total_count ?? 0)
if (!Number.isFinite(maxScore) || maxScore <= 0) invalidReasons.push('invalid_max_score')
if (!Number.isFinite(totalScore) || totalScore < 0) invalidReasons.push('invalid_total_score')
if (Number.isFinite(totalScore) && Number.isFinite(maxScore) && totalScore > maxScore) invalidReasons.push('total_score_out_of_range')
if (Number.isFinite(totalScore) && Math.abs(totalScore - computedTotalScore) > 1e-9) invalidReasons.push('total_score_mismatch')
if (Number.isFinite(maxScore) && Math.abs(maxScore - computedMaxScore) > 1e-9) invalidReasons.push('max_score_mismatch')
if (!Number.isInteger(passedCount) || passedCount < 0) invalidReasons.push('invalid_passed_count')
else if (passedCount !== computedPassedCount) invalidReasons.push('passed_count_mismatch')
if (!Number.isInteger(totalCount) || totalCount <= 0) invalidReasons.push('invalid_total_count')
else if (totalCount !== rubrics.length) invalidReasons.push('total_count_mismatch')
const parsedPassRate = parsePassRate(result.pass_rate)
if (parsedPassRate === null) invalidReasons.push('invalid_pass_rate')
else if (Number.isInteger(totalCount) && totalCount > 0 && Math.abs(parsedPassRate - passedCount / totalCount) > 0.011) invalidReasons.push('pass_rate_mismatch')

const valid = invalidReasons.length === 0
const summary = {
  schema_version: 1,
  validator_version: 2,
  result: args.result,
  valid,
  evaluated_model: result.evaluated_model ?? null,
  judge_model: result.judge_model ?? null,
  total_score: Number.isFinite(totalScore) ? totalScore : null,
  max_score: Number.isFinite(maxScore) ? maxScore : null,
  normalized_score: valid ? totalScore / maxScore : null,
  pass_rate: result.pass_rate ?? null,
  passed_count: Number.isFinite(passedCount) ? passedCount : null,
  total_count: Number.isFinite(totalCount) ? totalCount : null,
  rubric_count: rubrics.length,
  invalid_reason_count: invalidReasons.length,
  invalid_reasons: invalidReasons.slice(0, 20),
}

if (args.output) await writeFile(args.output, `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
console.log(JSON.stringify(summary, null, 2))
if (!valid && args.failInvalid) process.exit(2)

function isInfrastructureFailure(text) {
  return /Failed to get judge response|No module named|API Exit Code|No judge API key|Connection error|Authentication|Unauthorized|timed out/i.test(text)
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function parsePassRate(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value < 0) return null
    return value > 1 ? value / 100 : value
  }
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  if (trimmed.endsWith('%')) {
    const parsed = Number(trimmed.slice(0, -1))
    return Number.isFinite(parsed) && parsed >= 0 ? parsed / 100 : null
  }
  const parsed = Number(trimmed)
  if (!Number.isFinite(parsed) || parsed < 0) return null
  return parsed > 1 ? parsed / 100 : parsed
}

function parseArgs(argv) {
  const result = value(argv, '--result')
  if (!result) fail('missing --result')
  return {
    result: resolve(result),
    output: value(argv, '--output') ? resolve(value(argv, '--output')) : undefined,
    failInvalid: argv.includes('--fail-invalid'),
  }
}

function value(argv, name) {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === name) return argv[i + 1]
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1)
  }
  return undefined
}

function fail(message) {
  console.error(message)
  process.exit(1)
}
