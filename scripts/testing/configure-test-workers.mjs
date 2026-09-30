#!/usr/bin/env node

import { appendFileSync } from 'node:fs'
import { availableParallelism, totalmem } from 'node:os'

import { describeTestWorkerBudget, selectTestWorkers } from './test-worker-budget.mjs'

const cpuCount = availableParallelism()
const memoryBytes = totalmem()
const packageJobs = parsePositiveInteger(process.env.KALA_TEST_JOBS ?? '1', 'KALA_TEST_JOBS')
const maxWorkers = parsePositiveInteger(process.env.KALA_TEST_MAX_WORKERS ?? '8', 'KALA_TEST_MAX_WORKERS')
const workers = process.env.KALA_TEST_WORKERS
  ? parsePositiveInteger(process.env.KALA_TEST_WORKERS, 'KALA_TEST_WORKERS')
  : selectTestWorkers({ cpuCount, memoryBytes, packageJobs, maxWorkers })

console.log(`Test worker budget: ${describeTestWorkerBudget({
  cpuCount,
  memoryBytes,
  packageJobs,
  maxWorkers,
  workers,
})}`)

if (process.env.GITHUB_ENV) {
  appendFileSync(process.env.GITHUB_ENV, `KALA_TEST_WORKERS=${workers}\n`, 'utf8')
} else {
  console.log(`KALA_TEST_WORKERS=${workers}`)
}

function parsePositiveInteger(value, name) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new TypeError(`${name} must be a positive integer`)
  }
  return parsed
}
