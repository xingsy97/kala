import { availableParallelism, totalmem } from 'node:os'

const GIB = 1024 ** 3
const MIB = 1024 ** 2

export function selectTestWorkers({
  cpuCount = availableParallelism(),
  memoryBytes = totalmem(),
  packageJobs = 1,
  maxWorkers = 8,
} = {}) {
  const cpus = positiveInteger(cpuCount, 'cpuCount')
  const memory = positiveInteger(memoryBytes, 'memoryBytes')
  const jobs = positiveInteger(packageJobs, 'packageJobs')
  const maximum = positiveInteger(maxWorkers, 'maxWorkers')
  const concurrentHeavyPackages = Math.min(jobs, 2)
  const cpuBudget = Math.max(1, Math.floor(cpus / concurrentHeavyPackages))
  const usableMemory = Math.max(768 * MIB, memory - 2 * GIB)
  const totalMemoryWorkers = Math.max(1, Math.floor(usableMemory / (768 * MIB)))
  const memoryBudget = Math.max(1, Math.floor(totalMemoryWorkers / concurrentHeavyPackages))
  return Math.max(1, Math.min(maximum, cpuBudget, memoryBudget))
}

export function describeTestWorkerBudget({
  cpuCount = availableParallelism(),
  memoryBytes = totalmem(),
  packageJobs = 1,
  maxWorkers = 8,
  workers = selectTestWorkers({ cpuCount, memoryBytes, packageJobs, maxWorkers }),
} = {}) {
  return `cpus=${cpuCount} memory=${(memoryBytes / GIB).toFixed(1)}GiB packageJobs=${packageJobs} maxWorkers=${maxWorkers} selectedWorkers=${workers}`
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive integer`)
  }
  return value
}
