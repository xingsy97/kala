import assert from 'node:assert/strict'
import test from 'node:test'

import { describeTestWorkerBudget, selectTestWorkers } from './test-worker-budget.mjs'

const GIB = 1024 ** 3

test('selects the measured local optimum for a large development machine', () => {
  assert.equal(selectTestWorkers({
    cpuCount: 32,
    memoryBytes: 46 * GIB,
    packageJobs: 4,
  }), 8)
})

test('shares CPU and memory across the two heavy packages', () => {
  assert.equal(selectTestWorkers({
    cpuCount: 8,
    memoryBytes: 8 * GIB,
    packageJobs: 4,
  }), 4)
})

test('uses the available CPU for serial CI package execution', () => {
  assert.equal(selectTestWorkers({
    cpuCount: 4,
    memoryBytes: 16 * GIB,
    packageJobs: 1,
  }), 4)
})

test('honors memory and explicit worker caps', () => {
  assert.equal(selectTestWorkers({
    cpuCount: 32,
    memoryBytes: 4 * GIB,
    packageJobs: 1,
  }), 2)
  assert.equal(selectTestWorkers({
    cpuCount: 32,
    memoryBytes: 64 * GIB,
    packageJobs: 1,
    maxWorkers: 6,
  }), 6)
})

test('reports the selected resource budget', () => {
  assert.equal(describeTestWorkerBudget({
    cpuCount: 4,
    memoryBytes: 16 * GIB,
    packageJobs: 1,
    maxWorkers: 8,
    workers: 4,
  }), 'cpus=4 memory=16.0GiB packageJobs=1 maxWorkers=8 selectedWorkers=4')
})
