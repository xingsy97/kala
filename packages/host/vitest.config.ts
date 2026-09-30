import { defineConfig } from 'vitest/config'

const requestedTestWorkers = Number(process.env.KALA_TEST_WORKERS ?? 1)
const testWorkers = Number.isSafeInteger(requestedTestWorkers) && requestedTestWorkers > 0
  ? requestedTestWorkers
  : 1

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    fileParallelism: testWorkers > 1,
    pool: 'forks',
    singleFork: testWorkers === 1,
    maxWorkers: testWorkers,
  },
})
